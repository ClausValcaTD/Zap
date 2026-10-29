/**
 * Pre-built workflow templates and document persistence.
 *
 * Templates are plain documents, so they exercise exactly the same compile path
 * as a user-built graph — there is no privileged "built-in" execution route.
 */
import type { DocumentEdge, DocumentNode, NodeTypeId, WorkflowDocument } from './document';
import { DOCUMENT_VERSION, createId, parseDocument } from './document';
import { withDefaults } from './nodeRegistry';

interface TemplateNodeSpec {
  readonly key: string;
  readonly type: NodeTypeId;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly config?: Record<string, unknown>;
}

interface TemplateEdgeSpec {
  readonly from: string;
  readonly to: string;
}

interface TemplateSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly nodes: readonly TemplateNodeSpec[];
  readonly edges: readonly TemplateEdgeSpec[];
}

const TEMPLATE_SPECS: readonly TemplateSpec[] = [
  {
    id: 'ecommerce-fraud',
    name: 'E-Commerce Fraud & Dispatch',
    description:
      'Webhook → parallel Currency + Fraud checks → LLM briefing → Telegram dispatch.',
    nodes: [
      {
        key: 'webhook',
        type: 'webhook',
        name: 'Webhook Trigger',
        x: 48,
        y: 168,
        config: { payloadJson: '', latencyMs: 400 },
      },
      { key: 'currency', type: 'code', name: 'Currency Converter', x: 316, y: 72 },
      {
        key: 'fraud',
        type: 'code',
        name: 'Fraud Check',
        x: 316,
        y: 268,
        config: {
          source:
            '// Scores risk from the order amount and country, then always continues.\n' +
            'const amount = Number(flat.amount ?? 0);\n' +
            'const country = String(flat.country ?? "US");\n' +
            'const riskScore = (amount > 1000 ? 45 : amount > 150 ? 25 : 10) + (country === "US" ? 5 : 40);\n' +
            'const signals = [amount > 1000 ? "high value" : "standard value", country === "US" ? "domestic" : `cross-border (${country})`];\n' +
            'return { ...flat, riskScore, decision: riskScore >= 50 ? "review" : "approve", signals, reason: `risk ${riskScore}` };',
        },
      },
      {
        key: 'ai',
        type: 'ai',
        name: 'Order Briefing',
        x: 584,
        y: 168,
        config: {
          systemPrompt:
            'You are an operations assistant. Summarise this order for a fulfilment channel in two short sentences: the customer, the total value, and any risk worth a human check.',
          userPrompt:
            'Order {{ orderId }} for {{ customer }} — {{ amount }} {{ currency }} ({{ amountConverted }} EUR). Risk verdict: {{ reason }}. Details: {{ json }}',
          temperature: 0.2,
        },
      },
      {
        key: 'telegram',
        type: 'telegram',
        name: 'Telegram Dispatcher',
        x: 852,
        y: 168,
        config: {
          messageTemplate:
            '<b>Order briefing</b>\n<b>Order:</b> <code>{{ orderId }}</code>\n\n{{ completion }}',
        },
      },
    ],
    edges: [
      { from: 'webhook', to: 'currency' },
      { from: 'webhook', to: 'fraud' },
      { from: 'currency', to: 'ai' },
      { from: 'fraud', to: 'ai' },
      { from: 'ai', to: 'telegram' },
    ],
  },
  {
    id: 'support-triage',
    name: 'AI Support Ticket Triage',
    description:
      'Webhook → LLM sentiment analysis → If Negative → Telegram alert. Non-negative tickets stop at the condition.',
    nodes: [
      {
        key: 'webhook',
        type: 'webhook',
        name: 'Ticket Webhook',
        x: 48,
        y: 120,
        config: {
          payloadJson: JSON.stringify(
            {
              ticketId: 'TCK-4821',
              customer: 'ada@example.com',
              subject: 'Refund not received after 10 days',
              message: 'I was charged twice and support has not replied. Very frustrated.',
              sentiment: 'negative',
            },
            null,
            2,
          ),
          latencyMs: 300,
        },
      },
      {
        key: 'ai',
        type: 'ai',
        name: 'Sentiment Analysis',
        x: 316,
        y: 120,
        config: {
          systemPrompt:
            'You are a support triage assistant. Explain in one sentence why this ticket reads as negative, and suggest the single most useful next action for the support team.',
          userPrompt: 'Subject: {{ subject }}\nMessage: {{ message }}',
          temperature: 0,
          passThrough: 'true',
        },
      },
      {
        key: 'filter',
        type: 'filter',
        name: 'If Negative',
        x: 584,
        y: 120,
        config: { field: 'sentiment', operator: '==', value: 'negative', passThrough: 'true' },
      },
      {
        key: 'telegram',
        type: 'telegram',
        name: 'Escalation Alert',
        x: 852,
        y: 120,
        config: {
          messageTemplate:
            '<b>Negative ticket</b>\n<code>{{ ticketId }}</code> from {{ customer }}\n\n{{ completion }}',
        },
      },
    ],
    edges: [
      { from: 'webhook', to: 'ai' },
      { from: 'ai', to: 'filter' },
      { from: 'filter', to: 'telegram' },
    ],
  },
  {
    id: 'webhook-fanout',
    name: 'Custom JS Starter',
    description: 'Webhook → your own JS snippet → Discord webhook. A blank canvas to build on.',
    nodes: [
      { key: 'webhook', type: 'webhook', name: 'Webhook Trigger', x: 48, y: 120 },
      {
        key: 'code',
        type: 'code',
        name: 'Shape Payload',
        x: 316,
        y: 120,
        config: {
          source:
            '// `flat` is every parent output merged; `inputs` is keyed by parent id.\n' +
            'const amount = Number(flat.amount ?? 0);\n' +
            'return {\n' +
            '  ...flat,\n' +
            '  tier: amount > 1000 ? "high" : "standard",\n' +
            '  summary: `Order ${flat.orderId ?? "?"} is ${amount.toFixed(2)} (${amount > 1000 ? "high" : "standard"} tier)`,\n' +
            '};',
        },
      },
      {
        key: 'discord',
        type: 'discord',
        name: 'Discord Webhook',
        x: 584,
        y: 120,
        config: { messageTemplate: '**New order**\n{{ summary }}' },
      },
    ],
    edges: [
      { from: 'webhook', to: 'code' },
      { from: 'code', to: 'discord' },
    ],
  },
];

export interface WorkflowTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  build(): WorkflowDocument;
}

/** Materialises a template spec into a fresh document with real ids. */
function materialise(spec: TemplateSpec): WorkflowDocument {
  const idByKey = new Map<string, string>();

  const nodes: DocumentNode[] = spec.nodes.map((node) => {
    const id = createId(node.type);
    idByKey.set(node.key, id);
    return {
      id,
      type: node.type,
      name: node.name,
      x: node.x,
      y: node.y,
      // Merge over the type defaults so a template only states what it changes.
      config: withDefaults(node.type, node.config ?? {}),
    };
  });

  const edges: DocumentEdge[] = spec.edges.map((edge) => ({
    id: createId('edge'),
    source: idByKey.get(edge.from)!,
    target: idByKey.get(edge.to)!,
  }));

  return { version: DOCUMENT_VERSION, id: createId('wf'), name: spec.name, nodes, edges };
}

export const TEMPLATES: readonly WorkflowTemplate[] = TEMPLATE_SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  description: spec.description,
  build: () => materialise(spec),
}));

export function templateById(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/* -------------------------------------------------------------------------- *
 * Persistence
 * -------------------------------------------------------------------------- */

const AUTOSAVE_KEY = 'zap.workflow.document.v1';

export function saveDocument(document: WorkflowDocument): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(document));
  } catch {
    /* storage disabled (private mode) — the session still works in memory */
  }
}

/** Loads the autosaved document, or the default template on first visit. */
export function loadDocument(): WorkflowDocument {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return parseDocument(JSON.parse(raw));
  } catch {
    /* corrupted save — fall through to the default */
  }
  return TEMPLATES[0]!.build();
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** Serialises a document for download. */
export function exportDocument(document: WorkflowDocument): string {
  return JSON.stringify(document, null, 2);
}

/** Triggers a browser download of the workflow JSON. */
export function downloadDocument(document: WorkflowDocument): void {
  const blob = new Blob([exportDocument(document)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = 'workflow.json';
  anchor.click();
  URL.revokeObjectURL(url);
}
