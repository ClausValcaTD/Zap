/**
 * workflow-engine.ts
 * -----------------------------------------------------------------------------
 * A dependency-free, browser-native workflow execution engine.
 *
 * Design goals
 *  - Strict, serialisable graph model (`WorkflowNode` / `WorkflowEdge`).
 *  - Deterministic topological ordering via Kahn's algorithm, with a precise
 *    `CycleDetectedError` that names the offending cycle path.
 *  - Level-synchronous concurrency: every node whose dependencies are satisfied
 *    is scheduled in the same microtask wave, so independent branches overlap
 *    instead of running one after another.
 *  - Fail-fast, branch-isolated error handling: a failing node marks its whole
 *    downstream cone `skipped` while unrelated branches are allowed to finish.
 *  - A small lifecycle emitter (`onNodeStart` / `onNodeSuccess` / `onNodeError`
 *    / `onWorkflowComplete`) suitable for driving a canvas UI.
 *
 * Runtime notes
 *  - No Node.js built-ins are used (no `process`, no `node:*`), so the module
 *    runs unchanged in a browser bundler.
 *  - The module has no side effects on import; the runnable demo is guarded by
 *    a `isMain` check.
 * -----------------------------------------------------------------------------
 */

/* ========================================================================== *
 * 1. Core data structures
 * ========================================================================== */

/** Lifecycle state of a single node during (and after) a run. */
export type NodeExecutionStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error'
  | 'skipped';

/**
 * Convenience alias for a node payload. Nodes are typically JSON-shaped, but
 * the engine never inspects payloads, so callers may widen this to `unknown`.
 */
export type NodeOutput = Record<string, unknown>;

/**
 * The resolved output bag a node receives. Keys are the ids of the node's
 * direct parent dependencies; values are whatever those parents returned.
 */
export type NodeInputs = Readonly<Record<string, unknown>>;

/** Per-run shared context, threaded into every `execute` call. */
export interface ExecutionContext {
  /** Correlation id for the whole run. */
  readonly runId: string;
  /** Arbitrary, mutable bag for cross-cutting state (auth, caches, ...). */
  readonly state: Record<string, unknown>;
  /**
   * Run-level cancellation signal. The engine sets `aborted` as soon as any
   * node fails; long-running nodes should poll `isAborted()` cooperatively.
   */
  readonly signal: { aborted: boolean };
  /** Cooperative cancellation check. */
  isAborted(): boolean;
  /** Structured log sink (defaults to `console.debug`). */
  readonly logger: Logger;
  /** The engine instance driving this run. */
  readonly engine: WorkflowEngine;
  /** Live, read-only view of node statuses (useful for UI snapshots). */
  readonly statuses: Readonly<Record<string, NodeExecutionStatus>>;
}

/** Minimal logging surface; swap for a real logger in production. */
export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** The async work a node performs. May be sync or async. */
export type NodeExecutor = (
  inputs: NodeInputs,
  context: ExecutionContext,
) => Promise<NodeOutput> | NodeOutput;

/** A single unit of work in the graph. */
export interface WorkflowNode {
  /** Unique, non-empty identifier within a workflow. */
  readonly id: string;
  /** Human-readable label for the UI (defaults to `id` when rendering). */
  readonly name?: string;
  /** Arbitrary, serialisable node configuration (kept for the editor/UI). */
  readonly config?: Record<string, unknown>;
  /** The work to perform. */
  readonly execute: NodeExecutor;
  /**
   * Hard timeout in milliseconds. When exceeded the node fails with a
   * `NodeTimeoutError`; omitted means "wait indefinitely".
   */
  readonly timeoutMs?: number;
}

/** A directed dependency edge: `source` must complete before `target` runs. */
export interface WorkflowEdge {
  readonly source: string;
  readonly target: string;
  /**
   * Optional output projection. When present, only these keys of the source
   * output are forwarded to the target, and they are namespaced under
   * `edge.label ?? edge.source`. Omitted means "forward the whole output".
   */
  readonly label?: string;
  readonly map?: readonly string[];
}

/** A complete graph definition accepted by {@link WorkflowEngine}. */
export interface WorkflowDefinition {
  readonly id?: string;
  readonly name?: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

/** Lifecycle hook surface. Every hook is optional. */
export interface WorkflowHooks {
  onNodeStart?(node: WorkflowNode, context: ExecutionContext): void;
  onNodeSuccess?(node: WorkflowNode, output: NodeOutput, context: ExecutionContext): void;
  onNodeError?(node: WorkflowNode, error: Error, context: ExecutionContext): void;
  onNodeSkipped?(node: WorkflowNode, cause: string, context: ExecutionContext): void;
  /**
   * Fired when a node prunes its branch via {@link BranchPruned}. Distinct from
   * `onNodeSkipped` because the node itself succeeded; only its descendants
   * were skipped.
   */
  onBranchPruned?(node: WorkflowNode, reason: string, context: ExecutionContext): void;
  onWorkflowComplete?(result: WorkflowResult): void;
}

/** Terminal outcome for a run. */
export type WorkflowStatus = 'success' | 'error';

/** Snapshot of a finished (or failed) run. */
export interface WorkflowResult {
  readonly runId: string;
  readonly status: WorkflowStatus;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  readonly statuses: Readonly<Record<string, NodeExecutionStatus>>;
  /** Outputs of every node that succeeded. */
  readonly outputs: Readonly<Record<string, NodeOutput>>;
  /** Errors of every node that failed. */
  readonly errors: Readonly<Record<string, Error>>;
  /** Ids of nodes that were skipped because an ancestor failed. */
  readonly skipped: readonly string[];
}

/** Serialisable per-node snapshot for UI rendering. */
export interface NodeRunReport {
  readonly id: string;
  readonly name: string;
  readonly status: NodeExecutionStatus;
  readonly durationMs?: number;
  readonly error?: string;
}

/* ========================================================================== *
 * 2. Errors
 * ========================================================================== */

/** Base class so callers can `instanceof` a single engine error family. */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown by {@link GraphResolver} when the dependency graph is not a DAG.
 * `cyclePath` contains the offending nodes in traversal order.
 */
export class CycleDetectedError extends WorkflowError {
  readonly cyclePath: readonly string[];

  constructor(cyclePath: readonly string[], message?: string) {
    const path = cyclePath.join(' -> ');
    super(
      message ??
        `CycleDetectedError: circular dependency detected in workflow: ${path}`,
    );
    this.cyclePath = Object.freeze([...cyclePath]);
  }
}

/** Thrown when a graph references an unknown node id. */
export class InvalidGraphError extends WorkflowError {}

/** Thrown when a node exceeds its configured `timeoutMs`. */
export class NodeTimeoutError extends WorkflowError {
  readonly nodeId: string;
  readonly timeoutMs: number;

  constructor(nodeId: string, timeoutMs: number) {
    super(`Node "${nodeId}" timed out after ${timeoutMs}ms`);
    this.nodeId = nodeId;
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when a node's `execute` throws a non-`Error` value. */
export class NodeExecutionError extends WorkflowError {
  readonly nodeId: string;
  override readonly cause: unknown;

  constructor(nodeId: string, cause: unknown) {
    const detail =
      cause instanceof Error ? cause.message : JSON.stringify(cause);
    super(`Node "${nodeId}" failed: ${detail}`);
    this.nodeId = nodeId;
    this.cause = cause;
  }
}

/**
 * Thrown by an executor to prune its own branch without failing the run.
 *
 * This is how conditional nodes work: a Filter node that evaluates to `false`
 * throws `BranchPruned`, the engine records it as a *success* (the node did its
 * job — it reached a decision) and marks the entire downstream cone `skipped`.
 * Unrelated branches keep running, exactly as with a hard failure.
 */
export class BranchPruned extends WorkflowError {
  /** Human-readable explanation, surfaced in the UI and the log. */
  readonly reason: string;
  /** Output recorded for the pruning node (e.g. the condition's verdict). */
  readonly output: NodeOutput;

  constructor(reason: string, output: NodeOutput = {}) {
    super(reason);
    this.reason = reason;
    this.output = output;
  }
}

/* ========================================================================== *
 * 3. Internal utilities
 * ========================================================================== */

const DEFAULT_LOGGER: Logger = {
  debug: (m, meta) => console.debug(`[workflow] ${m}`, meta ?? ''),
  info: (m, meta) => console.info(`[workflow] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[workflow] ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`[workflow] ${m}`, meta ?? ''),
};

function toError(value: unknown, nodeId: string): Error {
  if (value instanceof Error) return value;
  return new NodeExecutionError(nodeId, value);
}

/** Rejects with {@link NodeTimeoutError} if `promise` does not settle in time. */
function withTimeout<T>(
  promise: Promise<T>,
  nodeId: string,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new NodeTimeoutError(nodeId, timeoutMs)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Projects a parent output through an edge's optional `map`, returning the
 * slice the child should see. Exported for unit testing.
 */
export function projectEdgeOutput(
  edge: WorkflowEdge,
  parentOutput: NodeOutput,
): NodeOutput {
  if (!edge.map || edge.map.length === 0) return parentOutput;
  const projected: NodeOutput = {};
  for (const key of edge.map) {
    if (key in parentOutput) projected[key] = parentOutput[key];
  }
  return projected;
}

/* ========================================================================== *
 * 4. Graph resolution (topological sort + cycle detection)
 * ========================================================================== */

/** Result of resolving a graph into a schedulable, level-grouped plan. */
export interface ExecutionPlan {
  /** Node ids grouped by dependency depth; all nodes in a level may run in parallel. */
  readonly levels: readonly (readonly string[])[];
  /** node id -> direct parent (dependency) ids. */
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  /** node id -> direct child (dependent) ids. */
  readonly dependents: Readonly<Record<string, readonly string[]>>;
}

/** Stateless graph algorithms. */
export class GraphResolver {
  /**
   * Kahn's algorithm. Produces depth-grouped levels and throws
   * {@link CycleDetectedError} (naming the cycle) when the graph is not a DAG.
   */
  static resolve(definition: WorkflowDefinition): ExecutionPlan {
    const nodeIds: string[] = [];
    const seen = new Set<string>();

    for (const node of definition.nodes) {
      if (!node.id) throw new InvalidGraphError('Every node requires a non-empty id');
      if (seen.has(node.id)) {
        throw new InvalidGraphError(`Duplicate node id "${node.id}"`);
      }
      seen.add(node.id);
      nodeIds.push(node.id);
    }

    const dependencies = new Map<string, string[]>();
    const dependents = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    for (const id of nodeIds) {
      dependencies.set(id, []);
      dependents.set(id, []);
      inDegree.set(id, 0);
    }

    for (const edge of definition.edges) {
      if (!seen.has(edge.source)) {
        throw new InvalidGraphError(`Edge references unknown source node "${edge.source}"`);
      }
      if (!seen.has(edge.target)) {
        throw new InvalidGraphError(`Edge references unknown target node "${edge.target}"`);
      }
      if (edge.source === edge.target) {
        throw new CycleDetectedError(
          [edge.source, edge.target],
          `CycleDetectedError: node "${edge.source}" depends on itself`,
        );
      }
      dependents.get(edge.source)!.push(edge.target);
      dependencies.get(edge.target)!.push(edge.source);
      inDegree.set(edge.target, inDegree.get(edge.target)! + 1);
    }

    // Kahn's algorithm, level by level. Nodes enter a level only once every
    // predecessor has been emitted, which is exactly the parallelism boundary.
    const levels: string[][] = [];
    let frontier = nodeIds.filter((id) => inDegree.get(id) === 0);
    let processed = 0;

    while (frontier.length > 0) {
      levels.push(frontier);
      processed += frontier.length;

      const next: string[] = [];
      for (const id of frontier) {
        for (const child of dependents.get(id)!) {
          const remaining = inDegree.get(child)! - 1;
          inDegree.set(child, remaining);
          if (remaining === 0) next.push(child);
        }
      }
      frontier = next;
    }

    if (processed !== nodeIds.length) {
      throw new CycleDetectedError(GraphResolver.findCycle(definition, nodeIds));
    }

    return {
      levels,
      dependencies: Object.fromEntries(
        [...dependencies].map(([id, deps]) => [id, Object.freeze([...deps])]),
      ),
      dependents: Object.fromEntries(
        [...dependents].map(([id, kids]) => [id, Object.freeze([...kids])]),
      ),
    };
  }

  /**
   * Iterative (stack-safe) DFS that recovers a concrete cycle path for the
   * error message. Only called on the failure path, so the extra pass is free.
   */
  static findCycle(definition: WorkflowDefinition, nodeIds: readonly string[]): string[] {
    const children = new Map<string, string[]>();
    for (const id of nodeIds) children.set(id, []);
    for (const edge of definition.edges) {
      children.get(edge.source)?.push(edge.target);
    }

    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));

    for (const root of nodeIds) {
      if (color.get(root) !== WHITE) continue;

      const path: string[] = [];
      const stack: Array<{ id: string; childIndex: number }> = [
        { id: root, childIndex: 0 },
      ];
      color.set(root, GRAY);
      path.push(root);

      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const kids = children.get(frame.id) ?? [];

        if (frame.childIndex >= kids.length) {
          color.set(frame.id, BLACK);
          stack.pop();
          path.pop();
          continue;
        }

        const child = kids[frame.childIndex++]!;
        const childColor = color.get(child) ?? WHITE;

        if (childColor === GRAY) {
          // Found a back-edge: the cycle is the current path from `child`.
          const start = path.indexOf(child);
          return [...path.slice(start), child];
        }
        if (childColor === WHITE) {
          color.set(child, GRAY);
          path.push(child);
          stack.push({ id: child, childIndex: 0 });
        }
      }
    }

    // Kahn's algorithm guarantees a cycle exists, so this is unreachable in
    // practice; kept as a defensive fallback.
    return [...nodeIds];
  }
}

/* ========================================================================== *
 * 5. Async execution engine
 * ========================================================================== */

export interface WorkflowEngineOptions {
  hooks?: WorkflowHooks;
  logger?: Logger;
  /**
   * Maximum number of nodes executing simultaneously. `Infinity` (default)
   * lets every node in a level start at once.
   */
  concurrency?: number;
  /** Optional id factory, useful for deterministic tests. */
  generateRunId?: () => string;
}

let runCounter = 0;
function defaultRunId(): string {
  runCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `run_${Date.now().toString(36)}_${runCounter}_${random}`;
}

/**
 * Executes a {@link WorkflowDefinition} with level-synchronous parallelism and
 * branch-isolated failure propagation.
 */
export class WorkflowEngine {
  private readonly hooks: WorkflowHooks;
  private readonly logger: Logger;
  private readonly concurrency: number;
  private readonly generateRunId: () => string;

  constructor(options: WorkflowEngineOptions = {}) {
    this.hooks = options.hooks ?? {};
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.concurrency = options.concurrency ?? Number.POSITIVE_INFINITY;
    this.generateRunId = options.generateRunId ?? defaultRunId;
  }

  /** Runs a workflow to completion. Never rejects; inspect `result.status`. */
  async run(definition: WorkflowDefinition): Promise<WorkflowResult> {
    const plan = GraphResolver.resolve(definition);
    const runId = this.generateRunId();

    const nodesById = new Map<string, WorkflowNode>(
      definition.nodes.map((node) => [node.id, node]),
    );
    const statuses: Record<string, NodeExecutionStatus> = {};
    const outputs: Record<string, NodeOutput> = {};
    const errors: Record<string, Error> = {};
    const skipped: string[] = [];

    for (const node of definition.nodes) statuses[node.id] = 'idle';

    const signal = { aborted: false };
    const context: ExecutionContext = {
      runId,
      state: {},
      signal,
      isAborted: () => signal.aborted,
      logger: this.logger,
      engine: this,
      statuses,
    };

    const startedAt = Date.now();
    const settled = new Set<string>();

    // Depth-first over the downstream cone. Marks each reachable node skipped
    // unless it has already settled; a node may be reached from several failed
    // ancestors, and `settled` keeps the hook firing at most once per node.
    const skipDownstream = (rootId: string, cause: string): void => {
      const stack = [...(plan.dependents[rootId] ?? [])];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (settled.has(id)) continue;
        settled.add(id);

        statuses[id] = 'skipped';
        skipped.push(id);
        const node = nodesById.get(id)!;
        this.hooks.onNodeSkipped?.(node, cause, context);
        this.logger.warn(`skip ${id}`, { cause });
        stack.push(...(plan.dependents[id] ?? []));
      }
    };

    for (const level of plan.levels) {
      const runnable = level.filter((id) => !settled.has(id));
      if (runnable.length === 0) continue;

      await this.runLevel(
        runnable,
        plan,
        nodesById,
        statuses,
        outputs,
        errors,
        settled,
        context,
        skipDownstream,
      );
    }

    const status: WorkflowStatus = Object.keys(errors).length === 0 ? 'success' : 'error';
    const result: WorkflowResult = {
      runId,
      status,
      durationMs: Date.now() - startedAt,
      statuses: { ...statuses },
      outputs: { ...outputs },
      errors: { ...errors },
      skipped: [...skipped],
    };

    this.hooks.onWorkflowComplete?.(result);
    return result;
  }

  /**
   * Executes one dependency level. All nodes in the level are already
   * unblocked, so they are started together and awaited with `Promise.all` —
   * this is where independent branches overlap.
   */
  private async runLevel(
    level: readonly string[],
    plan: ExecutionPlan,
    nodesById: ReadonlyMap<string, WorkflowNode>,
    statuses: Record<string, NodeExecutionStatus>,
    outputs: Record<string, NodeOutput>,
    errors: Record<string, Error>,
    settled: Set<string>,
    context: ExecutionContext,
    skipDownstream: (rootId: string, cause: string) => void,
  ): Promise<void> {
    const queue = [...level];
    const workers = Array.from(
      { length: Math.max(1, Math.min(this.concurrency, queue.length)) },
      () =>
        this.worker(
          queue,
          plan,
          nodesById,
          statuses,
          outputs,
          errors,
          settled,
          context,
          skipDownstream,
        ),
    );
    await Promise.all(workers);
  }

  /** Pull-based worker so `concurrency` can bound simultaneous execution. */
  private async worker(
    queue: string[],
    plan: ExecutionPlan,
    nodesById: ReadonlyMap<string, WorkflowNode>,
    statuses: Record<string, NodeExecutionStatus>,
    outputs: Record<string, NodeOutput>,
    errors: Record<string, Error>,
    settled: Set<string>,
    context: ExecutionContext,
    skipDownstream: (rootId: string, cause: string) => void,
  ): Promise<void> {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) return;
      await this.executeNode(
        id,
        plan,
        nodesById,
        statuses,
        outputs,
        errors,
        settled,
        context,
        skipDownstream,
      );
    }
  }

  /**
   * Runs a single node. A failure never propagates out of this method: it is
   * converted into an `error` status plus a downstream skip sweep, so sibling
   * promises in the same `Promise.all` are never rejected and unrelated
   * branches keep running.
   */
  private async executeNode(
    id: string,
    plan: ExecutionPlan,
    nodesById: ReadonlyMap<string, WorkflowNode>,
    statuses: Record<string, NodeExecutionStatus>,
    outputs: Record<string, NodeOutput>,
    errors: Record<string, Error>,
    settled: Set<string>,
    context: ExecutionContext,
    skipDownstream: (rootId: string, cause: string) => void,
  ): Promise<void> {
    if (settled.has(id)) return;
    settled.add(id);

    const node = nodesById.get(id);
    if (!node) return;

    const inputs = this.collectInputs(id, plan, outputs);

    statuses[id] = 'running';
    this.hooks.onNodeStart?.(node, context);
    this.logger.debug(`start ${id}`, { inputs });

    try {
      const raw = node.execute(inputs, context);
      const output = await withTimeout(Promise.resolve(raw), id, node.timeoutMs);

      outputs[id] = output ?? {};
      statuses[id] = 'success';
      this.hooks.onNodeSuccess?.(node, outputs[id]!, context);
      this.logger.info(`success ${id}`);
    } catch (caught) {
      // A pruned branch is a *successful* decision, not a failure: the node
      // ran, reached a verdict, and asked for its downstream cone to be
      // skipped. Unrelated branches continue untouched.
      if (caught instanceof BranchPruned) {
        outputs[id] = caught.output;
        statuses[id] = 'success';
        this.hooks.onNodeSuccess?.(node, outputs[id]!, context);
        this.hooks.onBranchPruned?.(node, caught.reason, context);
        this.logger.info(`pruned ${id}`, { reason: caught.reason });
        skipDownstream(id, caught.reason);
        return;
      }

      const error = toError(caught, id);
      errors[id] = error;
      statuses[id] = 'error';
      context.signal.aborted = true;
      this.hooks.onNodeError?.(node, error, context);
      this.logger.error(`error ${id}`, { message: error.message });
      skipDownstream(id, `upstream node "${id}" failed: ${error.message}`);
    }
  }

  /**
   * Merges the outputs of every direct parent into a single input bag keyed by
   * parent id. Edges with a `map` contribute only their projected slice.
   */
  private collectInputs(
    id: string,
    plan: ExecutionPlan,
    outputs: Record<string, NodeOutput>,
  ): NodeInputs {
    const parents = plan.dependencies[id] ?? [];
    const inputs: Record<string, unknown> = {};
    for (const parentId of parents) {
      const parentOutput = outputs[parentId];
      if (parentOutput === undefined) continue;
      inputs[parentId] = parentOutput;
    }
    return inputs;
  }

  /**
   * Merges parent outputs using per-edge projections. Use this when a graph
   * defines `map`/`label` on edges; the default `collectInputs` forwards whole
   * outputs keyed by parent id.
   */
  static mergeEdgeInputs(
    edges: readonly WorkflowEdge[],
    targetId: string,
    outputs: Readonly<Record<string, NodeOutput>>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const edge of edges) {
      if (edge.target !== targetId) continue;
      const parentOutput = outputs[edge.source];
      if (parentOutput === undefined) continue;
      merged[edge.label ?? edge.source] = projectEdgeOutput(edge, parentOutput);
    }
    return merged;
  }

  /** Convenience for UI layers: a flat, ordered snapshot of the last run. */
  static toReport(
    definition: WorkflowDefinition,
    result: WorkflowResult,
  ): NodeRunReport[] {
    return definition.nodes.map((node) => {
      const error = result.errors[node.id];
      return {
        id: node.id,
        name: node.name ?? node.id,
        status: result.statuses[node.id] ?? 'idle',
        ...(error ? { error: error.message } : {}),
      };
    });
  }
}

/* ========================================================================== *
 * 6. Runnable demo
 * ========================================================================== */

const isMain = (() => {
  const entry = (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1];
  if (typeof entry !== 'string') return false;
  return /workflow-engine\.(ts|js|mjs)$/.test(entry);
})();

if (isMain) {
  void runDemo();
}

/** The four-node order pipeline described in the brief. */
async function runDemo(): Promise<void> {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const banner = (label: string): void => console.log(`\n=== ${label} ===`);
  const fmt = (ms: number): string => `${ms.toFixed(0)}ms`;

  /** Node 1 — Mock Webhook: emits a fresh order payload. */
  const mockWebhook: WorkflowNode = {
    id: 'webhook',
    name: 'Mock Webhook',
    execute: async () => {
      await sleep(30);
      return {
        orderId: `ORD-${Math.floor(Math.random() * 9000 + 1000)}`,
        amount: 199.99,
        currency: 'USD',
        customer: 'ada@example.com',
        country: 'US',
      };
    },
  };

  /** Node 2 — Currency Converter: async math transform, depends on node 1. */
  const currencyConverter: WorkflowNode = {
    id: 'currency',
    name: 'Currency Converter',
    execute: async (inputs) => {
      const order = inputs['webhook'] as {
        orderId: string;
        amount: number;
        currency: string;
      };
      await sleep(45);
      const rate = 0.92; // USD -> EUR
      return {
        orderId: order.orderId,
        amountOriginal: order.amount,
        from: order.currency,
        to: 'EUR',
        amountConverted: Number((order.amount * rate).toFixed(2)),
        rate,
      };
    },
  };

  /** Node 3 — Fraud Check: risk scoring, depends on node 1. */
  const fraudCheck: WorkflowNode = {
    id: 'fraud',
    name: 'Fraud Check',
    execute: async (inputs) => {
      const order = inputs['webhook'] as {
        orderId: string;
        amount: number;
        country: string;
      };
      await sleep(60);
      const riskScore =
        (order.amount > 150 ? 40 : 10) + (order.country === 'US' ? 5 : 45);
      return {
        orderId: order.orderId,
        riskScore,
        decision: riskScore >= 50 ? 'review' : 'approve',
      };
    },
  };

  /** Node 4 — Order Dispatcher: merges both branches, depends on 2 & 3. */
  const orderDispatcher: WorkflowNode = {
    id: 'dispatch',
    name: 'Order Dispatcher',
    execute: async (inputs) => {
      const conversion = inputs['currency'] as {
        orderId: string;
        amountConverted: number;
        to: string;
      };
      const fraud = inputs['fraud'] as {
        orderId: string;
        decision: string;
        riskScore: number;
      };
      await sleep(25);

      // Both parents are merged into one input bag; they agree on the order id.
      const orderId = conversion.orderId;
      const dispatched = fraud.decision === 'approve';
      console.log(
        `[dispatcher] order ${orderId}: ` +
          `${conversion.amountConverted} ${conversion.to}, ` +
          `risk=${fraud.riskScore} (${fraud.decision}) -> ` +
          `${dispatched ? 'DISPATCHED' : 'HELD FOR REVIEW'}`,
      );
      return { orderId, dispatched, handledAt: Date.now() };
    },
  };

  const workflow: WorkflowDefinition = {
    id: 'order-pipeline',
    name: 'Order Pipeline',
    nodes: [mockWebhook, currencyConverter, fraudCheck, orderDispatcher],
    edges: [
      { source: 'webhook', target: 'currency' },
      { source: 'webhook', target: 'fraud' },
      { source: 'currency', target: 'dispatch' },
      { source: 'fraud', target: 'dispatch' },
    ],
  };

  const engine = new WorkflowEngine({
    concurrency: Number.POSITIVE_INFINITY,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    hooks: {
      onNodeStart: (node) => console.log(`  -> start   ${node.name ?? node.id}`),
      onNodeSuccess: (node) => console.log(`  ok success ${node.name ?? node.id}`),
      onNodeError: (node, error) =>
        console.log(`  !! error   ${node.name ?? node.id}: ${error.message}`),
      onNodeSkipped: (node, cause) =>
        console.log(`  -- skipped ${node.name ?? node.id} (${cause})`),
    },
  });

  banner('Run A: happy path (nodes 2 & 3 run in parallel)');
  const happy = await engine.run(workflow);
  banner('Run A result');
  console.log(WorkflowEngine.toReport(workflow, happy));
  console.log(`status=${happy.status} duration=${fmt(happy.durationMs)}`);

  banner('Run B: fraud check throws -> dispatch must be skipped');
  const failing: WorkflowNode = {
    ...fraudCheck,
    execute: async () => {
      await sleep(20);
      throw new Error('fraud provider unreachable');
    },
  };
  const failingWorkflow: WorkflowDefinition = {
    ...workflow,
    nodes: [mockWebhook, currencyConverter, failing, orderDispatcher],
  };
  const failed = await engine.run(failingWorkflow);
  banner('Run B result');
  console.log(WorkflowEngine.toReport(failingWorkflow, failed));
  console.log(`status=${failed.status} skipped=[${failed.skipped.join(', ')}]`);

  banner('Run C: cycle detection');
  try {
    await engine.run({
      id: 'cyclic',
      nodes: [mockWebhook, currencyConverter, fraudCheck],
      edges: [
        { source: 'webhook', target: 'currency' },
        { source: 'currency', target: 'fraud' },
        { source: 'fraud', target: 'currency' },
      ],
    });
  } catch (error) {
    if (error instanceof CycleDetectedError) {
      console.log(`caught ${error.name}: path=${error.cyclePath.join(' -> ')}`);
      console.log(error.message);
    } else {
      throw error;
    }
  }
}

export { runDemo };
