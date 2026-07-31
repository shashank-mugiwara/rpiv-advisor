/**
 * subagent — advisor-as-subagent bridge to @tintinweb/pi-subagents' documented
 * cross-extension RPC (pi.events: subagents:rpc:ping/spawn, subagents:completed/
 * failed). Lets the "advisor" custom agent type (~/.pi/agent/agents/advisor.md)
 * run with real tools instead of the toolless completeSimple side-call.
 *
 * Fully optional dependency: nothing here imports pi-subagents. If it isn't
 * loaded in this session, isSubagentsAvailable() times out fast and execute.ts
 * falls back to the original completeSimple path — the fork degrades to
 * upstream behavior rather than hard-erroring when the package is absent.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

const READY_TIMEOUT_MS = 300;
// The ping already proved pi-subagents is bound, so a spawn reply is normally
// immediate — 5s covers a loaded event loop without letting a mid-session
// extension reload strand the executor's tool call.
const SPAWN_REPLY_TIMEOUT_MS = 5_000;
// Watchdog on the completion wait. The advisor agent is bounded by max_turns,
// but if the manager dies without emitting a terminal event, nothing else ever
// resolves this promise. 15 minutes comfortably exceeds a long consult.
const COMPLETION_TIMEOUT_MS = 15 * 60_000;
const ADVISOR_AGENT_TYPE = "advisor";

interface RpcReply<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
}

/** Lifetime accounting pi-subagents attaches to its terminal events —
 *  `tokens` is omitted when the agent errored before any message_end. */
export interface SubagentUsage {
	tokens?: { input: number; output: number; total: number };
	toolUses?: number;
	durationMs?: number;
}

interface CompletedEvent extends SubagentUsage {
	id: string;
	result?: string;
}

interface FailedEvent {
	id: string;
	error?: string;
}

/** Race a `subagents:ready` ping against a short timeout — cheap per-call
 *  check so a session without pi-subagents (or one still booting it) falls
 *  back instead of hanging. `subagents:rpc:ping` answers immediately once
 *  bound, so a real "yes" always beats the timeout comfortably. */
export function isSubagentsAvailable(events: EventBus): Promise<boolean> {
	return new Promise((resolve) => {
		const requestId = `advisor-ping-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsub();
			resolve(false);
		}, READY_TIMEOUT_MS);
		const unsub = events.on(`subagents:rpc:ping:reply:${requestId}`, () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsub();
			resolve(true);
		});
		events.emit("subagents:rpc:ping", { requestId });
	});
}

/**
 * Spawn the `advisor` custom agent type with the rendered transcript as its
 * prompt, and wait for its terminal event. Runs as a background spawn (the
 * RPC spawn call returns only `{ id }` synchronously either way — foreground
 * vs background only changes the caller's own UI blocking, not whether we
 * must listen for completion), so this always awaits `subagents:completed` /
 * `subagents:failed` filtered by the returned id.
 */
export async function runAdvisorSubagent(
	events: EventBus,
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<({ text: string } & SubagentUsage) | { errorMessage: string }> {
	const requestId = `advisor-spawn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	if (signal?.aborted) {
		return { errorMessage: "Advisor call was cancelled before it completed." };
	}

	// Spawn phase — bounded and abortable. Without the timeout, a pi-subagents
	// reload between the ping and this emit leaves the reply channel unbound and
	// this promise pending forever; the executor's tool call would hang with no
	// way out (the abort listener used to be wired only in the wait phase).
	const spawnReply = await new Promise<RpcReply<{ id: string }> | "timeout" | "aborted">((resolve) => {
		let settled = false;
		const settle = (value: RpcReply<{ id: string }> | "timeout" | "aborted") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsub();
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const timer = setTimeout(() => settle("timeout"), SPAWN_REPLY_TIMEOUT_MS);
		const onAbort = () => settle("aborted");
		const unsub = events.on(`subagents:rpc:spawn:reply:${requestId}`, (raw) => {
			settle(raw as RpcReply<{ id: string }>);
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		events.emit("subagents:rpc:spawn", {
			requestId,
			type: ADVISOR_AGENT_TYPE,
			prompt,
			options: { description: "Advisor consult", run_in_background: true },
		});
	});

	if (spawnReply === "timeout") {
		return { errorMessage: `advisor subagent spawn got no reply within ${SPAWN_REPLY_TIMEOUT_MS}ms` };
	}
	if (spawnReply === "aborted") {
		return { errorMessage: "Advisor call was cancelled before it completed." };
	}
	if (!spawnReply.success || !spawnReply.data?.id) {
		return { errorMessage: spawnReply.error ?? "advisor subagent spawn failed" };
	}
	const agentId = spawnReply.data.id;

	// Wait phase — also bounded. The agent itself is capped by max_turns, but if
	// the manager crashes without emitting a terminal event nothing else ever
	// resolves this promise; the watchdog stops the agent and surfaces an error.
	return new Promise((resolve) => {
		const watchdog = setTimeout(() => {
			cleanup();
			events.emit("subagents:rpc:stop", { requestId: `${requestId}-stop`, agentId });
			resolve({
				errorMessage: `advisor subagent did not complete within ${COMPLETION_TIMEOUT_MS / 60_000} minutes`,
			});
		}, COMPLETION_TIMEOUT_MS);
		const unsubCompleted = events.on("subagents:completed", (raw) => {
			const event = raw as CompletedEvent;
			if (event.id !== agentId) return;
			cleanup();
			resolve({
				text: event.result ?? "",
				tokens: event.tokens,
				toolUses: event.toolUses,
				durationMs: event.durationMs,
			});
		});
		const unsubFailed = events.on("subagents:failed", (raw) => {
			const event = raw as FailedEvent;
			if (event.id !== agentId) return;
			cleanup();
			resolve({ errorMessage: event.error ?? "advisor subagent failed" });
		});
		const onAbort = () => {
			cleanup();
			events.emit("subagents:rpc:stop", { requestId: `${requestId}-stop`, agentId });
			resolve({ errorMessage: "Advisor call was cancelled before it completed." });
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		function cleanup() {
			clearTimeout(watchdog);
			unsubCompleted();
			unsubFailed();
			signal?.removeEventListener("abort", onAbort);
		}
	});
}
