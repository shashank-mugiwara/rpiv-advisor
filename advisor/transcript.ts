/**
 * transcript — render the branch Message[] (same array execute.ts already
 * builds for completeSimple) into a flat text prompt for the advisor
 * subagent. Subagents take a single `prompt: string`, not a raw Message[],
 * so this is the seam between "forward the live branch" and "brief a fresh
 * agent" — thinking blocks are dropped (the subagent has no use for the
 * executor's private reasoning trace, only what it said/did/saw).
 */

import type { Message } from "@earendil-works/pi-ai";

function textOf(content: { type: string; text?: string }[]): string {
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function renderTranscript(messages: Message[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : textOf(m.content as { type: string; text?: string }[]);
			if (text.trim()) parts.push(`## User\n${text}`);
		} else if (m.role === "assistant") {
			const text = textOf(m.content.filter((c) => c.type === "text"));
			if (text.trim()) parts.push(`## Executor\n${text}`);
			for (const c of m.content) {
				if (c.type === "toolCall") {
					parts.push(`### Tool call: ${c.name}\n${JSON.stringify(c.arguments)}`);
				}
			}
		} else if (m.role === "toolResult") {
			const text = textOf(m.content);
			parts.push(`### Tool result: ${m.toolName}${m.isError ? " (error)" : ""}\n${text}`);
		}
	}
	return parts.join("\n\n");
}
