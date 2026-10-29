/**
 * WorkflowCanvas — renders the document as draggable cards joined by SVG
 * Bézier curves, and hosts all direct-manipulation graph editing:
 *
 *   - drag a node body to move it (persisted back into the document)
 *   - click an output port, then an input port, to create an edge
 *   - click an edge to select it, then press Delete / the ✕ to remove it
 *   - drop a palette item anywhere to add a node at that point
 *
 * Node colour and animation are driven purely by the live status map, so
 * parallel branches visibly pulse at the same time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { definitionFor } from '../lib/nodeRegistry';
import type { DocumentNode, NodeTypeId, WorkflowDocument } from '../lib/document';
import type { StatusMap } from '../lib/useWorkflowRunner';

export const CARD_WIDTH = 208;
export const CARD_HEIGHT = 92;

export interface WorkflowCanvasProps {
  document: WorkflowDocument;
  statuses: StatusMap;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  /** Node id whose output port is armed for connection, if any. */
  pendingSource: string | null;
  onSelectNode(id: string | null): void;
  onSelectEdge(id: string | null): void;
  onMoveNode(id: string, x: number, y: number): void;
  onArmSource(id: string | null): void;
  onConnect(source: string, target: string): void;
  onAddNodeAt(type: NodeTypeId, x: number, y: number): void;
  onDeleteEdge(id: string): void;
}

/** Cubic Bézier from the right edge of `from` to the left edge of `to`. */
function bezier(from: DocumentNode, to: DocumentNode): string {
  const x1 = from.x + CARD_WIDTH;
  const y1 = from.y + CARD_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + CARD_HEIGHT / 2;
  const curve = Math.max(48, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
}

const EDGE_STROKE: Record<string, string> = {
  idle: '#3f3f46',
  running: '#38bdf8',
  success: '#22c55e',
  error: '#ef4444',
  skipped: '#52525b',
};

const CARD_STATE: Record<string, string> = {
  idle: 'border-zinc-700 bg-zinc-900',
  running: 'border-sky-400 bg-zinc-900 strand-running',
  success: 'border-green-500 bg-zinc-900 shadow-[0_0_14px_rgba(34,197,94,0.22)]',
  error: 'border-red-500 bg-zinc-900 shadow-[0_0_14px_rgba(239,68,68,0.28)]',
  skipped: 'border-dashed border-zinc-600 bg-zinc-900 opacity-45',
};

export function WorkflowCanvas(props: WorkflowCanvasProps): JSX.Element {
  const {
    document: workflow,
    statuses,
    selectedNodeId,
    selectedEdgeId,
    pendingSource,
    onSelectNode,
    onSelectEdge,
    onMoveNode,
    onArmSource,
    onConnect,
    onAddNodeAt,
    onDeleteEdge,
  } = props;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const nodeById = useMemo(() => {
    const map = new Map<string, DocumentNode>();
    for (const node of workflow.nodes) map.set(node.id, node);
    return map;
  }, [workflow.nodes]);

  // Canvas extent grows with the content so scrolling always reaches every node.
  const extent = useMemo(() => {
    const maxX = workflow.nodes.reduce((acc, node) => Math.max(acc, node.x + CARD_WIDTH), 0);
    const maxY = workflow.nodes.reduce((acc, node) => Math.max(acc, node.y + CARD_HEIGHT), 0);
    return { width: Math.max(1200, maxX + 160), height: Math.max(620, maxY + 160) };
  }, [workflow.nodes]);

  /** Converts a client point to canvas coordinates. */
  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const rect = scrollRef.current?.getBoundingClientRect();
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    return {
      x: clientX - (rect?.left ?? 0) + scrollLeft,
      y: clientY - (rect?.top ?? 0) + scrollTop,
    };
  }, []);

  // Pointer-driven node dragging. Listening on window keeps the drag alive even
  // when the cursor outruns the card.
  useEffect(() => {
    if (!drag) return;

    const onMove = (event: PointerEvent): void => {
      const point = toCanvasPoint(event.clientX, event.clientY);
      onMoveNode(drag.id, point.x - drag.offsetX, point.y - drag.offsetY);
    };
    const onUp = (): void => setDrag(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, onMoveNode, toCanvasPoint]);

  // Delete removes the selected edge; Escape clears any pending connection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if (event.key === 'Escape') {
        onArmSource(null);
        onSelectEdge(null);
        return;
      }
      if (typing) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeId) {
        event.preventDefault();
        onDeleteEdge(selectedEdgeId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEdgeId, onDeleteEdge, onArmSource, onSelectEdge]);

  return (
    <div
      ref={scrollRef}
      className="strand-scroll relative flex-1 overflow-auto"
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const type = event.dataTransfer.getData('application/strand-node');
        if (!type) return;
        const point = toCanvasPoint(event.clientX, event.clientY);
        onAddNodeAt(type as NodeTypeId, point.x - CARD_WIDTH / 2, point.y - CARD_HEIGHT / 2);
      }}
      onClick={(event) => {
        // A click on empty canvas clears selection and any armed port.
        if (event.target === event.currentTarget) {
          onSelectNode(null);
          onSelectEdge(null);
          onArmSource(null);
        }
      }}
    >
      <div
        className={`strand-canvas relative transition-shadow ${
          dragOver ? 'ring-2 ring-inset ring-sky-500/40' : ''
        }`}
        style={{ width: extent.width, height: extent.height }}
      >
        <svg
          className="pointer-events-none absolute inset-0"
          width={extent.width}
          height={extent.height}
        >
          <defs>
            <marker
              id="strand-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
            </marker>
          </defs>

          {workflow.edges.map((edge) => {
            const from = nodeById.get(edge.source);
            const to = nodeById.get(edge.target);
            if (!from || !to) return null;

            const sourceStatus = statuses[edge.source] ?? 'idle';
            const targetStatus = statuses[edge.target] ?? 'idle';
            const active = sourceStatus === 'success';
            const broken = targetStatus === 'skipped' || targetStatus === 'error';
            const isSelected = selectedEdgeId === edge.id;
            const stroke = isSelected
              ? '#6366f1'
              : broken
                ? EDGE_STROKE['error']!
                : active
                  ? EDGE_STROKE['running']!
                  : EDGE_STROKE['idle']!;

            return (
              <g key={edge.id}>
                {/* Wide invisible hit area so thin edges are still clickable. */}
                <path
                  d={bezier(from, to)}
                  stroke="transparent"
                  strokeWidth={16}
                  fill="none"
                  className="pointer-events-auto cursor-pointer"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectEdge(edge.id);
                    onSelectNode(null);
                  }}
                />
                <path
                  d={bezier(from, to)}
                  stroke={stroke}
                  strokeWidth={isSelected || active ? 2.5 : 1.5}
                  fill="none"
                  markerEnd="url(#strand-arrow)"
                  className={active && !broken ? 'strand-edge-active' : ''}
                />
              </g>
            );
          })}
        </svg>

        {workflow.nodes.map((node) => {
          const status = statuses[node.id] ?? 'idle';
          const definition = definitionFor(node.type);
          const isSelected = selectedNodeId === node.id;
          const isArmed = pendingSource === node.id;
          const canReceive = pendingSource !== null && pendingSource !== node.id;

          return (
            <div
              key={node.id}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => {
                // Only drag from the card body, never from a port.
                if ((event.target as HTMLElement).closest('[data-port]')) return;
                if (event.button !== 0) return;
                const point = toCanvasPoint(event.clientX, event.clientY);
                setDrag({ id: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y });
                onSelectNode(node.id);
                onSelectEdge(null);
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectNode(node.id);
                onSelectEdge(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSelectNode(node.id);
              }}
              className={`absolute cursor-grab touch-none select-none rounded-xl border-2 p-3 text-left transition-colors active:cursor-grabbing ${
                CARD_STATE[status] ?? CARD_STATE['idle']
              } ${isSelected ? 'outline outline-2 outline-offset-2 outline-indigo-500' : ''} ${
                canReceive ? 'ring-2 ring-amber-400/70' : ''
              }`}
              style={{ left: node.x, top: node.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
            >
              {/* Input port — only meaningful while a source is armed. */}
              <span
                data-port="in"
                role="button"
                aria-label="Input port"
                onClick={(event) => {
                  event.stopPropagation();
                  if (pendingSource) onConnect(pendingSource, node.id);
                }}
                className={`absolute -left-2 top-1/2 size-4 -translate-y-1/2 rounded-full border-2 border-zinc-900 transition ${
                  canReceive ? 'cursor-pointer bg-amber-400' : 'bg-zinc-600'
                }`}
              />

              {/* Output port — arms this node as a connection source. */}
              <span
                data-port="out"
                role="button"
                aria-label="Output port"
                onClick={(event) => {
                  event.stopPropagation();
                  onArmSource(isArmed ? null : node.id);
                  onSelectNode(node.id);
                }}
                className={`absolute -right-2 top-1/2 size-4 -translate-y-1/2 cursor-pointer rounded-full border-2 border-zinc-900 transition ${
                  isArmed ? 'bg-sky-400' : 'bg-zinc-500 hover:bg-sky-400'
                }`}
              />

              <span className="text-[9px] uppercase tracking-widest text-zinc-500">
                {definition?.category ?? 'node'}
              </span>
              <span className="mt-0.5 block truncate text-[13px] font-semibold text-zinc-100">
                {node.name}
              </span>
              <span className="mt-1 block font-mono text-[10px] text-zinc-500">
                {status === 'running' ? 'running…' : status}
              </span>
              {definition?.live ? (
                <span className="absolute right-2 top-2 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-1.5 text-[9px] uppercase tracking-wide text-indigo-300">
                  live
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
