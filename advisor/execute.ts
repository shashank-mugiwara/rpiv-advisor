/**
 * execute — the advisor side-call. Curates the executor's branch (inventory
 * prefix + tail massaging), invokes the advisor model via completeSimple with
 * no tools, and returns a structured tool result. Every result branch (success
 * / abort / error / empty) and the pre-call error paths funnel through
 * buildAdvisorResult so the envelope is built in exactly one place.
 */

import type { AssistantMessage, Message, StopReason, TextContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall } from "./context.js";
import { getInventoryMessage } from "./inventory.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	errNoApiKeyDetail,
	msgConsulting,
	SUBAGENT_ADVISOR_LABEL,
} from "./messages.js";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "./pi-compat.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";
import { isSubagentsAvailable, runAdvisorSubagent, type SubagentUsage } from "./subagent.js";
import { renderTranscript } from "./transcript.js";

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	/** Set only on the subagent path: the advisor agent's real lifetime spend
	 *  (pi-subagents' terminal-event accounting), which `usage` cannot carry —
	 *  `Usage` is a single completion's ledger with cost breakdowns we don't have. */
	subagent?: SubagentUsage;
}

// Extract the advisor's text content from a completeSimple response: concatenate
// every text part, trim. Thinking/toolCall parts are ignored. Returns "" when the
// model returned no text content — the empty-response class R6.4 retries once
// before surfacing. Pure so both attempts share one extraction path.
function advisorTextFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

// Single result-envelope builder — every executeAdvisor branch and the pre-call
// error paths funnel through here. `effort` is snapshotted once at executeAdvisor
// entry and threaded through every call so the returned details.effort always
// matches the value sent as `reasoning` to completeSimple, even if module-level
// state is mutated during the await window.
function buildAdvisorResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	subagent?: SubagentUsage;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	if (opts.subagent !== undefined) details.subagent = opts.subagent;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot effort once at entry — every result envelope and the API call
	// itself use this same value so a concurrent setAdvisorEffort() during the
	// await window cannot desync details.effort from the `reasoning` actually sent.
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	// Live-read every call — advisor runs mid-turn so any message_end snapshot
	// is always one turn stale. buildSessionContext() preserves Pi's resolved
	// LLM context, including compaction summaries and branch summaries, instead
	// of replaying raw pre-compaction branch messages. convertToLlm is
	// pass-through for user/assistant/toolResult (messages.js:111-114), so
	// element refs are stable across calls via the session store.
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(stripInflightAdvisorCall(convertToLlm(sessionMessages)));
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	// Prefer the tool-using advisor subagent (fork addition) when pi-subagents
	// is loaded in this session — it can verify claims against real files/
	// commands instead of trusting the transcript. Checked BEFORE the auth
	// preflight: the subagent runs its own model from agents/advisor.md, so
	// credentials for the configured completeSimple model are irrelevant here —
	// a broken login for that provider must not block a consult that never uses
	// it. Falls back to the original toolless completeSimple path below when
	// unavailable, so the fork degrades to upstream behavior.
	if (await isSubagentsAvailable(pi.events)) {
		// Effort is deliberately absent from this path's envelopes: the
		// configured completeSimple effort is not what the subagent runs with
		// (its thinking level lives in agents/advisor.md).
		onUpdate?.({
			content: [{ type: "text", text: msgConsulting(SUBAGENT_ADVISOR_LABEL, undefined) }],
			details: { advisorModel: SUBAGENT_ADVISOR_LABEL },
		});
		const prompt = renderTranscript(messages);
		const subResult = await runAdvisorSubagent(pi.events, prompt, signal);
		if ("errorMessage" in subResult) {
			return buildErrorResult(SUBAGENT_ADVISOR_LABEL, undefined, errCallFailed(subResult.errorMessage), subResult.errorMessage);
		}
		const subagent: SubagentUsage = {
			tokens: subResult.tokens,
			toolUses: subResult.toolUses,
			durationMs: subResult.durationMs,
		};
		// No R6.4 retry here, unlike the completeSimple path: an agent that ran
		// to completion and produced no result text is a real failure, not the
		// transient-empty class — and "retrying" would respawn a multi-minute,
		// tool-using agent. Surface it as the empty-response error instead of
		// handing the executor a silently blank result.
		if (!subResult.text.trim()) {
			return buildAdvisorResult({
				text: ERR_EMPTY_RESPONSE,
				effort: undefined,
				advisorLabel: SUBAGENT_ADVISOR_LABEL,
				errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				subagent,
			});
		}
		return buildAdvisorResult({ text: subResult.text, effort: undefined, advisorLabel: SUBAGENT_ADVISOR_LABEL, subagent });
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildErrorResult(advisorLabel, effort, errMisconfigured(advisorLabel, auth.error), auth.error);
	}
	if (!auth.apiKey) {
		return buildErrorResult(advisorLabel, effort, errNoApiKey(advisorLabel), errNoApiKeyDetail(advisor.provider));
	}

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	try {
		// Prefer Pi's auth-aware runtime facade. Unlike the global compatibility
		// function, it runs request preparation and applies credential-derived
		// fields such as GitHub Copilot's OAuth-specific baseUrl. Do not pass the
		// preflight key/headers to this path: explicit overrides would bypass that
		// resolution and reintroduce the endpoint mismatch.
		const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
		const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
		const requestOptions = runtimeCompleteSimple
			? { signal, reasoning: effort }
			: { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort };

		// Single dispatch point — both attempts reuse the SAME `messages` and
		// `requestOptions`, so the retry cannot diverge from attempt 1. `tools: []`
		// reaffirms the "never calls tools" contract even when `messages` contains
		// prior toolCall/toolResult blocks (btw.ts:235).
		const callAdvisor = (): Promise<AssistantMessage> =>
			completeSimple(advisor, { systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] }, requestOptions);

		// Build the terminal envelope for an aborted/error stopReason, or return
		// undefined when the attempt produced a normal stop whose text (or lack of
		// text) the caller must still resolve. Aborted/error short-circuit and are
		// NEVER retried — they are not the empty-response class R6.4 targets.
		const stopReasonEnvelope = (r: AssistantMessage): AgentToolResult<AdvisorDetails> | undefined => {
			if (r.stopReason === "aborted") {
				return buildAdvisorResult({
					text: ERR_CALL_ABORTED,
					effort,
					advisorLabel,
					usage: r.usage,
					stopReason: r.stopReason,
					errorMessage: r.errorMessage ?? ERR_ABORTED_DETAIL,
				});
			}
			if (r.stopReason === "error") {
				return buildAdvisorResult({
					text: errCallFailed(r.errorMessage),
					effort,
					advisorLabel,
					usage: r.usage,
					stopReason: r.stopReason,
					errorMessage: r.errorMessage,
				});
			}
			return undefined;
		};

		let response = await callAdvisor();

		// Aborted/error short-circuit on the first attempt — no retry.
		const firstTerminal = stopReasonEnvelope(response);
		if (firstTerminal) return firstTerminal;

		let advisorText = advisorTextFromResponse(response);

		// R6.4: a transient empty advisor response (normal stop, no text) gets
		// exactly ONE retry with identical inputs before surfacing as a terminal
		// error. Bounded to a single second call — never a `while`/loop — so a
		// persistent-empty provider cannot hot-loop. The retry reuses the SAME
		// pre-computed `messages`/`requestOptions` (no re-derivation that could
		// diverge from attempt 1), then applies the same three-way route.
		if (!advisorText) {
			response = await callAdvisor();

			const retryTerminal = stopReasonEnvelope(response);
			if (retryTerminal) return retryTerminal;

			advisorText = advisorTextFromResponse(response);
			if (!advisorText) {
				return buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				});
			}
		}

		return buildAdvisorResult({
			text: advisorText,
			effort,
			advisorLabel,
			usage: response.usage,
			stopReason: response.stopReason,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	}
}
