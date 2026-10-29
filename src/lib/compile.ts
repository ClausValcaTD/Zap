/**
 * Compiles a serialisable {@link WorkflowDocument} into the live
 * `WorkflowDefinition` the engine executes.
 *
 * Also hosts the graph-edit helpers (add/connect/remove) and the real-time
 * validation used by the canvas: every proposed edge is run through the
 * engine's own `GraphResolver`, so the builder can never accept a connection
 * the engine would later reject.
 */
import { CycleDetectedError, GraphResolver } from '../workflow-engine';
import type { WorkflowDefinition, WorkflowNode } from '../workflow-engine';
import type { DocumentEdge, DocumentNode, NodeTypeId, WorkflowDocument } from './document';
import { createEdgeId, createId, parseDocument } from './document';
import { definitionFor, withDefaults } from './nodeRegistry';
import type { AppSettings } from './settings';

export interface CompileOptions {
  settings: AppSettings;
  simulate: boolean;
}

/** Thrown when a document references a node type the registry does not know. */
export class UnknownNodeTypeError extends Error {
  constructor(type: string) {
    super(`Unknown node type "${type}". It may come from a newer version of Strand.`);
    this.name = 'UnknownNodeTypeError';
  }
}

/** Turns a document into an executable definition. */
export function compileDocument(
  document: WorkflowDocument,
  options: CompileOptions,
): WorkflowDefinition {
  const nodes: WorkflowNode[] = document.nodes.map((node) => {
    const definition = definitionFor(node.type);
    if (!definition) throw new UnknownNodeTypeError(node.type);
    const config = withDefaults(node.type, node.config);
    return definition.build(node.id, node.name || definition.label, config, options.settings, options.simulate);
  });

  return {
    id: document.id,
    name: document.name,
    nodes,
    edges: document.edges.map((edge) => ({ source: edge.source, target: edge.target })),
  };
}

/* -------------------------------------------------------------------------- *
 * Real-time validation
 * -------------------------------------------------------------------------- */

export interface ValidationIssue {
  readonly nodeId: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

/**
 * Checks a proposed edge against the engine's cycle detector.
 * Returns `null` when the edge is safe, or a message explaining the rejection.
 */
export function validateNewEdge(
  document: WorkflowDocument,
  source: string,
  target: string,
): string | null {
  if (source === target) return 'A node cannot connect to itself.';

  if (document.edges.some((edge) => edge.source === source && edge.target === target)) {
    return 'That connection already exists.';
  }

  const probe: WorkflowDocument = {
    ...document,
    edges: [...document.edges, { id: '__probe__', source, target }],
  };

  try {
    // Reuse the engine's resolver as the single source of truth for legality.
    GraphResolver.resolve(shapeOf(probe));
    return null;
  } catch (error) {
    if (error instanceof CycleDetectedError) {
      const path = error.cyclePath.join(' → ');
      return `Cannot connect: creates circular dependency! (${path})`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

/** A definition-shaped object with no executors, for validation only. */
function shapeOf(document: WorkflowDocument): WorkflowDefinition {
  return {
    id: document.id,
    name: document.name,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      execute: () => ({}),
    })),
    edges: document.edges.map((edge) => ({ source: edge.source, target: edge.target })),
  };
}

/** Non-blocking advisories shown in the properties drawer. */
export function auditDocument(document: WorkflowDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const triggers = document.nodes.filter((node) => {
    const definition = definitionFor(node.type);
    return definition?.category === 'trigger';
  });
  if (triggers.length === 0) {
    issues.push({
      nodeId: '',
      severity: 'warning',
      message: 'No trigger node. The workflow has no entry point.',
    });
  }

  const outgoing = new Map<string, number>();
  for (const edge of document.edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }

  for (const node of document.nodes) {
    const definition = definitionFor(node.type);
    if (!definition) {
      issues.push({ nodeId: node.id, severity: 'error', message: `Unknown type "${node.type}".` });
      continue;
    }

    // A node with no parents and no children is inert.
    const hasIncoming = document.edges.some((edge) => edge.target === node.id);
    const hasOutgoing = (outgoing.get(node.id) ?? 0) > 0;
    if (!hasIncoming && !hasOutgoing && document.nodes.length > 1) {
      issues.push({
        nodeId: node.id,
        severity: 'warning',
        message: `"${node.name}" is not connected to anything.`,
      });
    }

    // Non-trigger nodes that nothing feeds will never run.
    if (definition.category !== 'trigger' && !hasIncoming) {
      issues.push({
        nodeId: node.id,
        severity: 'warning',
        message: `"${node.name}" has no incoming connection and will never run.`,
      });
    }

    if (definition.category === 'trigger' && hasIncoming) {
      issues.push({
        nodeId: node.id,
        severity: 'warning',
        message: `"${node.name}" is a trigger but has incoming connections.`,
      });
    }

    // Required-config sanity checks.
    if (node.type === 'filter') {
      const config = withDefaults(node.type, node.config);
      if (!String(config['field'] ?? '').trim()) {
        issues.push({ nodeId: node.id, severity: 'error', message: 'Condition field is empty.' });
      }
    }
    if (node.type === 'code') {
      const config = withDefaults(node.type, node.config);
      if (!String(config['source'] ?? '').trim()) {
        issues.push({ nodeId: node.id, severity: 'error', message: 'Snippet is empty.' });
      }
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- *
 * Graph edit helpers (pure functions returning new documents)
 * -------------------------------------------------------------------------- */

export interface NewNodeSpec {
  readonly type: NodeTypeId;
  readonly x: number;
  readonly y: number;
  /** Optional override; defaults to the type label, de-duplicated. */
  readonly name?: string;
}

export function addNode(document: WorkflowDocument, spec: NewNodeSpec): {
  document: WorkflowDocument;
  node: DocumentNode;
} {
  const definition = definitionFor(spec.type);
  const typeLabel = definition?.label ?? spec.type;

  // De-duplicate the display name so two "LLM Completion" nodes stay distinct.
  const existing = new Set(document.nodes.map((node) => node.name));
  let name = spec.name ?? typeLabel;
  if (existing.has(name)) {
    let suffix = 2;
    while (existing.has(`${typeLabel} ${suffix}`)) suffix += 1;
    name = `${typeLabel} ${suffix}`;
  }

  const node: DocumentNode = {
    id: createId(spec.type),
    type: spec.type,
    name,
    x: Math.round(spec.x),
    y: Math.round(spec.y),
    config: {},
  };

  return { document: { ...document, nodes: [...document.nodes, node] }, node };
}

export function removeNode(document: WorkflowDocument, nodeId: string): WorkflowDocument {
  return {
    ...document,
    nodes: document.nodes.filter((node) => node.id !== nodeId),
    edges: document.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  };
}

export function updateNode(
  document: WorkflowDocument,
  nodeId: string,
  patch: Partial<Pick<DocumentNode, 'name' | 'x' | 'y' | 'config'>>,
): WorkflowDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
  };
}

export function addEdge(
  document: WorkflowDocument,
  source: string,
  target: string,
): WorkflowDocument {
  const edge: DocumentEdge = { id: createEdgeId(), source, target };
  return { ...document, edges: [...document.edges, edge] };
}

export function removeEdge(document: WorkflowDocument, edgeId: string): WorkflowDocument {
  return { ...document, edges: document.edges.filter((edge) => edge.id !== edgeId) };
}

/** Topological levels for layout; tolerant of an invalid graph. */
export function safeLevels(document: WorkflowDocument): string[][] {
  try {
    return GraphResolver.resolve(shapeOf(document)).levels.map((level) => [...level]);
  } catch {
    return [document.nodes.map((node) => node.id)];
  }
}

/** Auto-arranges nodes left-to-right by dependency level. */
export function autoLayout(document: WorkflowDocument): WorkflowDocument {
  const levels = safeLevels(document);
  const columnGap = 268;
  const rowGap = 130;
  const padX = 48;
  const padY = 40;

  const positions = new Map<string, { x: number; y: number }>();
  levels.forEach((level, column) => {
    level.forEach((id, row) => {
      positions.set(id, { x: padX + column * columnGap, y: padY + row * rowGap });
    });
  });

  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, x: position.x, y: position.y } : node;
    }),
  };
}

/** Re-exported so callers can round-trip imported JSON. */
export { parseDocument };
