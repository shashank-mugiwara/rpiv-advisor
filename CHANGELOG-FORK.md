# Fork Changelog — shashank-mugiwara/rpiv-advisor

Fork of [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) v2.2.0.

## v2.2.0-fork.4 (2026-07-31)

### Changes

Hardening of the subagent path, from an external audit of fork.3:

- **Bounded waits** (`advisor/subagent.ts`) — the spawn reply now times out after 5s and
  the completion wait after 15 minutes (watchdog emits `subagents:rpc:stop` and surfaces
  an error). Previously both promises were unbounded: a pi-subagents reload or manager
  crash mid-consult hung the executor's `advisor` tool call forever. The abort signal is
  now also honored during the spawn phase, not just the wait phase.
- **Empty results surface as errors** (`advisor/execute.ts`) — a subagent that completes
  with no result text now returns the `ERR_EMPTY_RESPONSE` envelope instead of a silently
  blank tool result. Deliberately no R6.4-style retry on this path: respawning a full
  tool-using agent is not a cheap second attempt.
- **Auth preflight skipped on the subagent path** (`advisor/execute.ts`) — the subagent
  runs its own model from `agents/advisor.md`, so credentials for the configured
  completeSimple model are checked only on the fallback path. A broken login for a
  provider the consult never uses no longer blocks it.
- **Honest attribution + usage accounting** (`advisor/execute.ts`, `advisor/messages.ts`) —
  subagent results are labeled `subagent:advisor` instead of the configured (never-run)
  completeSimple model, and the terminal event's lifetime accounting (`tokens`,
  `toolUses`, `durationMs`) is recorded in `details.subagent`, so per-consult spend is
  visible in the session record.
- **Guidance retuned for subagent economics** (`advisor/register.ts`) — the default
  promptGuidelines told the executor to consult at least twice per multi-step task,
  cadence written for the cheap toolless call. They now lead with the cost ("a full
  tool-using reviewer agent — minutes of wall clock"), scope the approach-consult to
  multi-step/high-stakes work, and scope the done-consult to risky or
  uncertainly-verified work. The description drops "stronger reviewer model" (the
  executor and advisor can be the same model — the value is fresh context plus
  tool-grounded verification, plus memory-palace lessons).
- **`agents/advisor.md` now versioned here** — the agent definition the subagent spawns
  as was previously only a live file at `~/.pi/agent/agents/advisor.md`, invisible to the
  git pin; a fresh machine silently degraded to the fallback path. Install by copying it
  to `~/.pi/agent/agents/advisor.md`. The prompt also gained an "Institutional memory"
  section: the advisor now searches the shared memory palace (mempalace CLI, including
  `--topic lessons`) and reads the Obsidian vault's per-project `Rules.md`/`Tasks.md`
  before answering, and cites the lesson/rule that shaped a verdict.

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
