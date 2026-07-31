/**
 * register — the advisor tool registration: zero-param schema, curated
 * description / promptSnippet / promptGuidelines, and an execute that delegates
 * to executeAdvisor. The guidance overrides are read from persisted config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateGuidanceFields } from "@juicesharp/rpiv-config";
import { Type } from "typebox";
import { loadAdvisorConfig } from "./config.js";
import { executeAdvisor } from "./execute.js";
import { ADVISOR_TOOL_NAME, TOOL_LABEL } from "./messages.js";

const AdvisorParams = Type.Object({});

const ADVISOR_DESCRIPTION =
	"Consult an independent reviewer for guidance. When you need a second " +
	"judgment — a complex decision, an ambiguous failure, a problem you're " +
	"circling without progress — consult the advisor, then resume. The advisor " +
	"is a fresh agent with real tools: it verifies claims against actual files " +
	"and commands, and checks the shared memory palace for lessons from past " +
	"sessions, instead of trusting the transcript. Takes NO parameters — when " +
	"you call advisor(), your entire conversation history is automatically " +
	"forwarded. The advisor sees the task, every tool call you've made, every " +
	"result you've seen.";

export const DEFAULT_PROMPT_SNIPPET =
	"Consult the advisor — an independent tool-using reviewer — at genuine decision points: when stuck, before committing to an approach on complex work, or before declaring risky work done";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Each `advisor` call spawns a full tool-using reviewer agent — minutes of wall clock and real token cost, not a quick side-call. Consult at genuine decision points, not ritually; one well-timed consult beats several reflexive ones.",
	"Call `advisor` before committing to an approach on multi-step or high-stakes work — before writing, before building on an assumption. Skip it for orientation (finding files, fetching a source, seeing what's there) and for short reactive tasks where the next action is dictated by tool output you just read.",
	"Call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
	"Call `advisor` before declaring done only when the work is risky, hard to reverse, or its verification is uncertain — not after routine tasks that already verified cleanly. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
	"Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
	"If you've already retrieved data pointing one way and the advisor points another, don't silently switch — surface the conflict in one more `advisor` call (\"I found X, you suggest Y, which constraint breaks the tie?\"). A reconcile call is cheaper than committing to the wrong branch.",
	"After each `advisor` result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase the plan, correction, or stop signal. The user often cannot see collapsed tool results; do not keep the advisor's words only in silent tool context.",
];

export function registerAdvisorTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadAdvisorConfig().guidance);
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: TOOL_LABEL,
		description: ADVISOR_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: AdvisorParams,

		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			return executeAdvisor(ctx, pi, signal, onUpdate);
		},
	});
}
