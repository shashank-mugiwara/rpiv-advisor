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
const ADVISOR_AGENT_TYPE = "advisor";

interface RpcReply<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
}

interface CompletedEvent {
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
): Promise<{ text: string } | { errorMessage: string }> {
	const requestId = `advisor-spawn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	const spawnReply = await new Promise<RpcReply<{ id: string }>>((resolve) => {
		const unsub = events.on(`subagents:rpc:spawn:reply:${requestId}`, (raw) => {
			unsub();
			resolve(raw as RpcReply<{ id: string }>);
		});
		events.emit("subagents:rpc:spawn", {
			requestId,
			type: ADVISOR_AGENT_TYPE,
			prompt,
			options: { description: "Advisor consult", run_in_background: true },
		});
	});

	if (!spawnReply.success || !spawnReply.data?.id) {
		return { errorMessage: spawnReply.error ?? "advisor subagent spawn failed" };
	}
	const agentId = spawnReply.data.id;

	return new Promise((resolve) => {
		const unsubCompleted = events.on("subagents:completed", (raw) => {
			const event = raw as CompletedEvent;
			if (event.id !== agentId) return;
			cleanup();
			resolve({ text: event.result ?? "" });
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
			unsubCompleted();
			unsubFailed();
			signal?.removeEventListener("abort", onAbort);
		}
	});
}
