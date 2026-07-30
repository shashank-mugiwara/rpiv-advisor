# Fork Changelog — shashank-mugiwara/rpiv-advisor

Fork of [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) v2.2.0.

## v2.2.0-fork.3 (2026-08-07)

### Changes

- Checked upstream `@juicesharp/rpiv-advisor` on npm — still 2.2.0, same base this fork was cut from. No upstream diff to merge.
- `package.json` `peerDependencies` pinned from `"*"` to `">=0.83.0"` for `@earendil-works/pi-ai`/`pi-coding-agent`/`pi-tui`, matching the installed pi-coding-agent version (`pi --version` → 0.83.0; all three peer packages resolve to 0.83.0 in `node_modules`).

## v2.2.0-fork.2 (2026-08-07)

### Changes

- **New: advisor runs as a tool-using subagent when `@tintinweb/pi-subagents` is loaded.**
  - `advisor/subagent.ts` (new) — bridges to pi-subagents' documented cross-extension
    RPC over `pi.events` (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:completed`/
    `subagents:failed`). `isSubagentsAvailable()` pings with a 300ms timeout so a session
    without pi-subagents falls back instead of hanging.
  - `advisor/transcript.ts` (new) — renders the branch `Message[]` (same array built for
    `completeSimple`) into a flat text prompt, since subagents take `prompt: string` not a
    raw message array. Thinking blocks are dropped; text/toolCall/toolResult are kept.
  - `advisor/execute.ts` — tries the subagent path first (`isSubagentsAvailable` →
    `runAdvisorSubagent`); falls through to the original toolless `completeSimple` call
    unchanged when pi-subagents isn't loaded. No change to the `/advisor` model/effort
    gating — that still governs whether the tool is active at all.
  - `~/.pi/agent/agents/advisor.md` (new, global, not in this repo) — custom agent type
    the subagent spawns as. Full executor toolset (no `tools:` restriction), model pinned
    to `anthropic/claude-opus-5`, `thinking: high`, `max_turns: 40`,
    `exclude_extensions: rpiv-advisor` (prevents the subagent recursively calling `advisor()`
    on itself).

### Why

The original design is a single toolless completion call — cheap, but the advisor can only
reason about what the transcript claims, not verify it. Running as a subagent with real
tools (read/grep/bash/memory_search/...) lets it check the file, run the failing command,
or grep the other callers before answering — stronger judgment at the cost of a slower,
multi-turn, non-free call per `advisor()` invocation.

## v2.2.0-fork.1 (2026-08-07)

### Changes

- Initial fork checkpoint — no logic changes yet. `package.json`: name, version, repository/homepage/bugs URLs updated to point at this repo.

### Why

Forked to customize the advisor system prompt (`prompts/advisor-system.txt`) and/or the surrounding logic (`advisor/*.ts`) without waiting on upstream. Enhancements land in later commits here.

### Upstream

Upstream source: `juicesharp/rpiv-mono` → `packages/rpiv-advisor`.
To pull upstream changes: diff the updated files from the npm package against this repo, re-apply fork-specific changes, bump the fork version, and push a new commit.
