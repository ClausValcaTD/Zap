/**
 * `useWorkflowRunner` — bridges the engine's lifecycle hooks into React state.
 *
 * The engine is imperative and hook-based; React is declarative. This hook is
 * the single place that reconciles the two: it compiles the current document
 * into a runnable definition, subscribes the hooks, and mirrors node statuses
 * plus per-node I/O into state that the canvas and inspector render.
 *
 * Because the document is the source of truth, a graph the user just wired up
 * executes through exactly the same path as a built-in template.
 */
import { useCallback, useRef, useState } from 'react';
import { WorkflowEngine } from '../workflow-engine';
import type { NodeOutput, WorkflowResult } from '../workflow-engine';
import { compileDocument } from './compile';
import type { WorkflowDocument } from './document';
import type { AppSettings } from './settings';

export type NodeStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped';
export type StatusMap = Record<string, NodeStatus>;

export interface NodeRecord {
  /** Merged parent outputs handed to the node. */
  inputs?: unknown;
  output?: NodeOutput;
  error?: string;
  durationMs?: number;
  startedAt?: number;
  /** Set when the node pruned its branch (a successful, conditional stop). */
  pruned?: string;
}

export type LogLevel =
  | 'start'
  | 'success'
  | 'error'
  | 'skipped'
  | 'pruned'
  | 'info'
  | 'result';

export interface LogEntry {
  id: number;
  at: number;
  /** Milliseconds since run start, for the `+0.42s` prefix. */
  offsetMs: number;
  level: LogLevel;
  nodeId?: string;
  message: string;
}

const MAX_LOG_ENTRIES = 400;

export interface RunRequest {
  document: WorkflowDocument;
  settings: AppSettings;
  simulate: boolean;
}

export interface WorkflowRunner {
  statuses: StatusMap;
  records: Record<string, NodeRecord>;
  log: LogEntry[];
  running: boolean;
  result: WorkflowResult | null;
  selected: string | null;
  select(id: string | null): void;
  run(request: RunRequest): Promise<void>;
  reset(): void;
}

export function useWorkflowRunner(): WorkflowRunner {
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [records, setRecords] = useState<Record<string, NodeRecord>>({});
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Run-scoped mutable state. Refs keep the hooks from triggering renders.
  const logIdRef = useRef(0);
  const runStartRef = useRef(0);
  const nodeStartRef = useRef<Record<string, number>>({});
  const runningRef = useRef(false);

  const pushLog = useCallback(
    (level: LogLevel, message: string, nodeId?: string): void => {
      const now = Date.now();
      const entry: LogEntry = {
        id: (logIdRef.current += 1),
        at: now,
        offsetMs: runStartRef.current ? now - runStartRef.current : 0,
        level,
        message,
        ...(nodeId ? { nodeId } : {}),
      };
      setLog((previous) => {
        const next = [...previous, entry];
        return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
      });
    },
    [],
  );

  const run = useCallback(
    async (request: RunRequest): Promise<void> => {
      if (runningRef.current) return;
      runningRef.current = true;

      const { document, settings, simulate } = request;

      let compiled;
      try {
        compiled = compileDocument(document, { settings, simulate });
      } catch (error) {
        runningRef.current = false;
        pushLog('error', error instanceof Error ? error.message : String(error));
        return;
      }

      // The engine resolves each node's inputs internally. Wrapping `execute`
      // is the least invasive way to capture them for the inspector without
      // widening the engine's public surface.
      const capturedInputs: Record<string, unknown> = {};
      const definition = {
        ...compiled,
        nodes: compiled.nodes.map((node) => ({
          ...node,
          execute: async (
            inputs: Parameters<typeof node.execute>[0],
            context: Parameters<typeof node.execute>[1],
          ) => {
            capturedInputs[node.id] = inputs;
            return node.execute(inputs, context);
          },
        })),
      };

      runStartRef.current = Date.now();
      nodeStartRef.current = {};
      logIdRef.current = 0;

      setLog([]);
      setResult(null);
      setRecords({});
      setRunning(true);
      setStatuses(Object.fromEntries(definition.nodes.map((node) => [node.id, 'idle'])));

      const durationFor = (nodeId: string): number => {
        const startedAt = nodeStartRef.current[nodeId] ?? Date.now();
        return Date.now() - startedAt;
      };

      const engine = new WorkflowEngine({
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        hooks: {
          onNodeStart: (node) => {
            nodeStartRef.current[node.id] = Date.now();
            setStatuses((previous) => ({ ...previous, [node.id]: 'running' }));
            pushLog('start', `${node.name ?? node.id} started`, node.id);
          },
          onNodeSuccess: (node, output) => {
            const durationMs = durationFor(node.id);
            setStatuses((previous) => ({ ...previous, [node.id]: 'success' }));
            setRecords((previous) => ({
              ...previous,
              [node.id]: {
                ...previous[node.id],
                inputs: capturedInputs[node.id],
                output,
                durationMs,
                startedAt: nodeStartRef.current[node.id],
              },
            }));
            pushLog('success', `${node.name ?? node.id} succeeded in ${durationMs}ms`, node.id);
          },
          onNodeError: (node, error) => {
            const durationMs = durationFor(node.id);
            setStatuses((previous) => ({ ...previous, [node.id]: 'error' }));
            setRecords((previous) => ({
              ...previous,
              [node.id]: {
                ...previous[node.id],
                inputs: capturedInputs[node.id],
                error: error.message,
                durationMs,
                startedAt: nodeStartRef.current[node.id],
              },
            }));
            pushLog('error', `${node.name ?? node.id} failed: ${error.message}`, node.id);
          },
          onBranchPruned: (node, reason) => {
            setRecords((previous) => ({
              ...previous,
              [node.id]: { ...previous[node.id], pruned: reason },
            }));
            pushLog('pruned', `${node.name ?? node.id}: ${reason}`, node.id);
          },
          onNodeSkipped: (node, cause) => {
            setStatuses((previous) => ({ ...previous, [node.id]: 'skipped' }));
            setRecords((previous) => ({
              ...previous,
              [node.id]: { ...previous[node.id], error: cause, durationMs: 0 },
            }));
            pushLog('skipped', `${node.name ?? node.id} skipped (${cause})`, node.id);
          },
          onWorkflowComplete: (workflowResult) => {
            setResult(workflowResult);
            pushLog(
              'result',
              `Workflow ${workflowResult.status} in ${workflowResult.durationMs}ms` +
                (workflowResult.skipped.length
                  ? ` · skipped: ${workflowResult.skipped.join(', ')}`
                  : ''),
            );
          },
        },
      });

      try {
        await engine.run(definition);
      } catch (error) {
        pushLog('error', error instanceof Error ? error.message : String(error));
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [pushLog],
  );

  const reset = useCallback((): void => {
    setStatuses({});
    setRecords({});
    setLog([]);
    setResult(null);
    runStartRef.current = 0;
    logIdRef.current = 0;
    nodeStartRef.current = {};
  }, []);

  const select = useCallback((id: string | null): void => {
    setSelected(id);
  }, []);

  return { statuses, records, log, running, result, selected, select, run, reset };
}
