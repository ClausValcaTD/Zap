/**
 * The workflow *document* — the editable, serialisable form of a graph.
 *
 * This is deliberately separate from the engine's `WorkflowDefinition`, which
 * carries live `execute` functions and cannot be serialised. A document holds
 * only plain data; {@link compileDocument} turns it into a runnable definition.
 */
import type { WorkflowDefinition } from '../workflow-engine';

export type NodeTypeId =
  | 'webhook'
  | 'manual'
  | 'ai'
  | 'filter'
  | 'code'
  | 'telegram'
  | 'discord';

export interface DocumentNode {
  readonly id: string;
  readonly type: NodeTypeId;
  /** User-editable display name; falls back to the type's label. */
  readonly name: string;
  /** Manual canvas position in canvas coordinates. */
  readonly x: number;
  readonly y: number;
  /** Type-specific configuration, validated by the node registry. */
  readonly config: Record<string, unknown>;
}

export interface DocumentEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface WorkflowDocument {
  /** Bumped when the on-disk shape changes, so old saves can be migrated. */
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly DocumentNode[];
  readonly edges: readonly DocumentEdge[];
}

export const DOCUMENT_VERSION = 1;

let sequence = 0;

/** Short, collision-resistant id. Deterministic prefix aids debugging. */
export function createId(prefix: string): string {
  sequence += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${sequence.toString(36)}${random}`;
}

export function createEdgeId(): string {
  return createId('edge');
}

/** Deep-clones a document so edits never mutate React state in place. */
export function cloneDocument(document: WorkflowDocument): WorkflowDocument {
  return structuredClone(document);
}

/**
 * Validates an untrusted value (imported JSON, a template, a localStorage
 * entry) into a `WorkflowDocument`. Throws a readable error rather than
 * letting a malformed graph reach the engine.
 */
export function parseDocument(value: unknown): WorkflowDocument {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Workflow must be a JSON object.');
  }
  const record = value as Record<string, unknown>;

  const nodes = record['nodes'];
  const edges = record['edges'];
  if (!Array.isArray(nodes)) throw new Error('Workflow is missing a "nodes" array.');
  if (!Array.isArray(edges)) throw new Error('Workflow is missing an "edges" array.');

  const parsedNodes: DocumentNode[] = nodes.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Node at index ${index} is not an object.`);
    }
    const node = raw as Record<string, unknown>;
    const id = node['id'];
    const type = node['type'];
    if (typeof id !== 'string' || !id) {
      throw new Error(`Node at index ${index} is missing a string "id".`);
    }
    if (typeof type !== 'string') {
      throw new Error(`Node "${id}" is missing a string "type".`);
    }
    return {
      id,
      type: type as NodeTypeId,
      name: typeof node['name'] === 'string' ? node['name'] : id,
      x: typeof node['x'] === 'number' ? node['x'] : 0,
      y: typeof node['y'] === 'number' ? node['y'] : 0,
      config:
        typeof node['config'] === 'object' && node['config'] !== null
          ? (node['config'] as Record<string, unknown>)
          : {},
    };
  });

  const knownIds = new Set(parsedNodes.map((node) => node.id));
  const parsedEdges: DocumentEdge[] = edges.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Edge at index ${index} is not an object.`);
    }
    const edge = raw as Record<string, unknown>;
    const source = edge['source'];
    const target = edge['target'];
    if (typeof source !== 'string' || typeof target !== 'string') {
      throw new Error(`Edge at index ${index} needs string "source" and "target".`);
    }
    if (!knownIds.has(source) || !knownIds.has(target)) {
      throw new Error(`Edge ${source} -> ${target} references a missing node.`);
    }
    return {
      id: typeof edge['id'] === 'string' ? edge['id'] : createEdgeId(),
      source,
      target,
    };
  });

  return {
    version: DOCUMENT_VERSION,
    id: typeof record['id'] === 'string' ? record['id'] : createId('wf'),
    name: typeof record['name'] === 'string' ? record['name'] : 'Untitled workflow',
    nodes: parsedNodes,
    edges: parsedEdges,
  };
}

/** The graph shape the engine consumes, derived from a document. */
export function toDefinitionShape(
  document: WorkflowDocument,
): Omit<WorkflowDefinition, 'nodes'> & { nodes: readonly { id: string }[] } {
  return {
    id: document.id,
    name: document.name,
    nodes: document.nodes.map((node) => ({ id: node.id })),
    edges: document.edges.map((edge) => ({ source: edge.source, target: edge.target })),
  };
}
