/**
 * LogPanel — the global execution log. Newest entries sit at the bottom and
 * the view auto-scrolls, matching a terminal tail.
 */
import { useEffect, useRef } from 'react';
import type { LogEntry, LogLevel } from '../lib/useWorkflowRunner';

const LEVEL_CLASS: Record<LogLevel, string> = {
  start: 'text-sky-400',
  success: 'text-green-400',
  error: 'text-red-400',
  skipped: 'text-zinc-500',
  pruned: 'text-amber-400',
  info: 'text-zinc-400',
  result: 'text-indigo-300',
};

export interface LogPanelProps {
  entries: LogEntry[];
  running: boolean;
  onClear(): void;
}

export function LogPanel({ entries, running, onClear }: LogPanelProps): JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden border-t border-zinc-800 bg-zinc-950/60">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            Execution log
          </h2>
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
              running ? 'border-sky-500/50 text-sky-400' : 'border-zinc-700 text-zinc-500'
            }`}
          >
            {running ? 'running' : 'idle'}
          </span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded px-2 py-0.5 text-[10px] uppercase tracking-widest text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          Clear
        </button>
      </header>

      <div className="strand-scroll min-h-0 flex-1 overflow-y-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed">
        {entries.length === 0 ? (
          <p className="px-1 py-1 text-zinc-600">No events yet. Press Run workflow to start.</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="grid grid-cols-[64px_52px_58px_minmax(0,1fr)] gap-2 py-px"
            >
              <span className="text-zinc-600">
                {new Date(entry.at).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              <span className="text-zinc-600">+{(entry.offsetMs / 1000).toFixed(2)}s</span>
              <span className={`text-[10px] uppercase tracking-wide ${LEVEL_CLASS[entry.level]}`}>
                {entry.level}
              </span>
              <span className="break-words text-zinc-300">{entry.message}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
