/**
 * NodePalette — the left sidebar listing every node type.
 *
 * Nodes can be added two ways, because dragging is awkward on touch:
 *   - drag a palette item onto the canvas (HTML5 drag & drop), or
 *   - click it, which drops the node at the next free spot.
 */
import { PALETTE_GROUPS, NODE_TYPE_LIST, definitionFor } from '../lib/nodeRegistry';
import type { NodeTypeId } from '../lib/document';

export interface NodePaletteProps {
  onAdd(type: NodeTypeId, clientPoint?: { x: number; y: number }): void;
  /** Node types already present, for singleton warnings. */
  presentTypes: readonly NodeTypeId[];
  disabled: boolean;
}

const ACCENT: Record<string, string> = {
  sky: 'text-sky-400 border-sky-500/40 bg-sky-500/10',
  violet: 'text-violet-400 border-violet-500/40 bg-violet-500/10',
  amber: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
  emerald: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
  cyan: 'text-cyan-400 border-cyan-500/40 bg-cyan-500/10',
  indigo: 'text-indigo-400 border-indigo-500/40 bg-indigo-500/10',
};

export function NodePalette({ onAdd, presentTypes, disabled }: NodePaletteProps): JSX.Element {
  return (
    <aside className="strand-scroll flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-800 bg-zinc-950/60 p-3">
      <div>
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          Node library
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          Drag onto the canvas, or click to drop at the next free slot.
        </p>
      </div>

      {PALETTE_GROUPS.map((group) => {
        const items = NODE_TYPE_LIST.filter((definition) => definition.category === group.category);
        if (items.length === 0) return null;

        return (
          <section key={group.category} className="flex flex-col gap-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              {group.label}
            </h3>

            {items.map((definition) => {
              const alreadyPresent = definition.singleton && presentTypes.includes(definition.type);
              return (
                <button
                  key={definition.type}
                  type="button"
                  draggable={!disabled}
                  disabled={disabled}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/strand-node', definition.type);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => onAdd(definition.type)}
                  title={alreadyPresent ? `${definition.label} is already in the graph` : definition.blurb}
                  className="group flex cursor-grab items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5 text-left transition hover:border-zinc-700 hover:bg-zinc-900 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className={`grid size-7 shrink-0 place-items-center rounded-md border text-sm ${
                      ACCENT[definition.accent] ?? ACCENT['sky']
                    }`}
                    aria-hidden="true"
                  >
                    {definition.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-zinc-100">
                        {definition.label}
                      </span>
                      {definition.live ? (
                        <span className="rounded-full border border-indigo-500/40 bg-indigo-500/15 px-1.5 text-[9px] uppercase tracking-wide text-indigo-300">
                          live
                        </span>
                      ) : null}
                      {alreadyPresent ? (
                        <span className="rounded-full border border-zinc-700 px-1.5 text-[9px] uppercase tracking-wide text-zinc-500">
                          in use
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">
                      {definition.blurb}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        );
      })}

      <p className="mt-auto text-[10px] leading-relaxed text-zinc-600">
        Tip: connect nodes by clicking an output port (right edge) then an input port (left edge).
      </p>
    </aside>
  );
}

export { definitionFor };
