# ADR 0014 — Transcript backfill: our own small parser, not agenthropic's

Status: accepted (M3 backlog, 04 W11 and 07 W5, 2026-10-14)
Deviates from: ROADMAP D11 and M3 ("the agenthropic parser is an optional backfill behind a flag")

## Context

D11 builds the session feed from hook payloads only, because Claude Code's transcript JSONL
is internal and unstable (04 §2.6, R15). So the feed starts empty for a session the agent
first sees mid-way: one that began before the agent started, or before the hooks were
installed. M3 lists a backfill from the transcript, behind a flag, using the agenthropic
parser.

That parser does not fit as a dependency:

- `@agenthropic/core` is a private repo with no published package, so `remotectl` could not
  depend on it from npm.
- It rebuilds the full subagent tree, token usage and dollar cost. The thin session view
  (D21) needs only the last prompt, the last answer, up to 20 steps and the changed files.
- Its fixture corpus is the part worth reusing. The fixtures are synthetic, so they can be
  copied.

## Decision

- **Port.** `TranscriptTailer.history(path)` returns, oldest first, the steps a transcript
  records, in the shape of the hook events that report them live (`UserPromptSubmit`,
  `PostToolUse`, `Stop`, `PreCompact`). The feed maps them with the same `mapHookEvent` as
  live events, so history and live events always look the same. The port never rejects.
- **Adapter.** `adapters/claude-code/transcript.ts` is our own parser, about 150 lines. It
  reads the main thread only (`isSidechain` lines are skipped) and skips meta, compaction
  summary and wrapped user lines (`<command-name>…`). A tool call counts once its
  `tool_result` is written. A turn ends at the next prompt, or at the end of the text when
  it settled on assistant text with nothing running. A malformed or unknown line is
  counted and skipped, never thrown.
- **Flag.** `transcripts.backfill` in `config.json`, off by default. When it is off, nothing
  reads a transcript and D11 holds as written.
- **When.** A backfill runs once, on the first Claude Code hook of a session that the feed
  has not seen. Live events that arrive during the read are buffered. Live and history are
  then merged at the latest point where the live events continue the history. History
  steps whose hooks have not arrived yet are shown at once, and their hooks are skipped when
  they come. The phone gets the rebuilt session from a snapshot with a new `feedSeq`.
- **Reading.** The path comes from a hook payload, so the tailer reads only a `.jsonl` file
  whose `realpath` is inside `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`).
  It reads at most the last 4 MiB and drops the cut first line.
- **Privacy.** History stays on the computer until it is sealed to the phone like any feed
  event (I1, I3). The agent logs only `transcript_read` with counts, `transcript_skipped`
  with a reason code and `transcript_failed` with an error code. It never logs a path or a
  line.
- **Fixtures.** The ten agenthropic main transcripts are copied verbatim into
  `adapters/claude-code/fixtures/transcripts/`. Tests run them through the parser and the
  fixture privacy pattern (07 §5.4). There is no dependency on `@agenthropic/core`.

## Consequences

- A format change in Claude Code can break the backfill. When it does, the backfill yields
  fewer steps and the live feed keeps working. R15 still holds, because the flag is off by
  default.
- Subagent activity, usage and cost are not backfilled. Those are agenthropic's job, not
  this view's.
- The merge matches events by kind and visible text. In rare cases an identical step that
  runs again right after the read is skipped once. A step can also show twice if its hook
  arrives before the read but the transcript does not hold it yet.
- If agenthropic ever publishes its parser, a second adapter behind the same port can
  replace this one without touching the feed.
