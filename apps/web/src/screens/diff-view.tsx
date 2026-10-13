import { MAX_DIFF_LINES } from '@remote-control/protocol';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import { diffKey } from '../realtime/realtime-store.js';

// A changed file's diff (M2-02, 05 W11), fetched only when the file is opened (D21).
// Monospace, no syntax highlighting, long lines scroll sideways inside the block.

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly string[];
}

/** The hunks of an agent patch: `@@` headers, each followed by its lines. */
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: { header: string; lines: string[] }[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) hunks.push({ header: line, lines: [] });
    else hunks.at(-1)?.lines.push(line);
  }
  return hunks;
}

function lineClass(line: string): string {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** Consecutive lines of one kind as one text block: far fewer nodes to render. */
function runsOf(lines: readonly string[]): { kind: string; text: string }[] {
  const runs: { kind: string; lines: string[] }[] = [];
  for (const line of lines) {
    const kind = lineClass(line);
    const last = runs.at(-1);
    if (last?.kind === kind) last.lines.push(line);
    else runs.push({ kind, lines: [line] });
  }
  return runs.map((run) => ({ kind: run.kind, text: `${run.lines.join('\n')}\n` }));
}

function Hunk({ hunk, lines }: { readonly hunk: DiffHunk; readonly lines: readonly string[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="diff-hunk">
      <button
        type="button"
        className="diff-header"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {hunk.header}
      </button>
      {open && (
        <pre className="diff">
          {runsOf(lines).map((run, index) => (
            <span key={index} className={run.kind}>
              {run.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

/** Asks for the diff when shown and renders at most `MAX_DIFF_LINES` lines of it. */
export function DiffView(props: {
  readonly machineId: string;
  readonly sessionId: string;
  readonly file: string;
}) {
  const { machineId, sessionId, file } = props;
  const { phone } = useAppState();
  const view = useStore(
    phone.realtime,
    (state) => state.diffs[diffKey(machineId, sessionId, file)],
  );
  useEffect(() => {
    phone.diff(machineId, sessionId, file);
  }, [phone, machineId, sessionId, file]);
  if (view === undefined || view.status === 'loading') {
    return <p className="meta diff-status">Loading the diff…</p>;
  }
  if (view.status === 'unavailable' || view.patch === undefined) {
    return <p className="meta diff-status">The diff is not available.</p>;
  }
  const hunks = parseHunks(view.patch);
  if (hunks.length === 0) return <p className="meta diff-status">No changes to show.</p>;
  let budget = MAX_DIFF_LINES;
  let hidden = 0;
  const shown = hunks.map((hunk) => {
    const lines = hunk.lines.slice(0, Math.max(0, budget));
    hidden += hunk.lines.length - lines.length;
    budget -= lines.length;
    return lines;
  });
  return (
    <div className="diff-view">
      {view.truncated === true && (
        <p className="meta">Only the latest changes are shown; older ones were left out.</p>
      )}
      {hunks.map((hunk, index) => (
        <Hunk key={index} hunk={hunk} lines={shown[index]!} />
      ))}
      {hidden > 0 && <p className="meta">{hidden} more lines not shown.</p>}
    </div>
  );
}
