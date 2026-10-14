/**
 * One step a transcript records, in the shape of the hook event that reports it live
 * (`hook_event_name` plus that event's fields, without `session_id`), so the feed maps
 * history and live events the same way (D11).
 */
export type TranscriptEntry = Readonly<Record<string, unknown>> & {
  readonly hook_event_name: string;
};

/**
 * Reads a session's history from its agent transcript, once, for the feed backfill (M3,
 * 04 W11). The Claude Code adapter is `adapters/claude-code/transcript.ts`.
 */
export interface TranscriptTailer {
  /**
   * The steps the transcript at `path` records, oldest first, rebuilt from its last bytes.
   * Never rejects: an unreadable file, a path outside the agent's transcript folder or a
   * malformed line yields fewer entries (04 risk 5).
   */
  history(path: string): Promise<readonly TranscriptEntry[]>;
}
