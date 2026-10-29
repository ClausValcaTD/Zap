/**
 * Node registry — one declarative definition per node type.
 *
 * Each entry bundles the palette metadata, the editable config schema, the
 * executor factory, and the JSON path(s) to any credential it needs. Adding a
 * node type to Strand means adding one object here; nothing else in the app
 * needs to change.
 */
import { BranchPruned } from '../workflow-engine';
import type { NodeInputs, WorkflowNode } from '../workflow-engine';
import type { AppSettings } from './settings';
import { fetchJson, asRecord } from './http';
import { interpolate } from './template';
import type { NodeTypeId } from './document';

export type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'code' | 'json';

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldSchema {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly help?: string;
  readonly placeholder?: string;
  /** Rendered only when this predicate passes (simple conditional fields). */
  readonly visibleWhen?: (config: Record<string, unknown>) => boolean;
  readonly options?: readonly FieldOption[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface NodeDefinition {
  readonly type: NodeTypeId;
  readonly label: string;
  readonly category: 'trigger' | 'ai' | 'logic' | 'code' | 'action';
  readonly blurb: string;
  /** One-line summary of what the node does, shown in the palette. */
  readonly icon: string;
  readonly accent: string;
  readonly fields: readonly FieldSchema[];
  readonly defaults: Record<string, unknown>;
  /** Credential paths in `AppSettings` this node cannot run without. */
  readonly requires?: readonly (keyof AppSettings)[];
  /** True when the node performs a real network call. */
  readonly live?: boolean;
  /** At most one trigger is meaningful per workflow. */
  readonly singleton?: boolean;
  build(
    nodeId: string,
    name: string,
    config: Record<string, unknown>,
    settings: AppSettings,
    simulate: boolean,
  ): WorkflowNode;
}

/* -------------------------------------------------------------------------- *
 * Helpers shared by executors
 * -------------------------------------------------------------------------- */

/** Cooperative delay so a cancelled run does not hold the UI in `running`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(config: Record<string, unknown>, key: string, fallback = ''): string {
  const value = config[key];
  return typeof value === 'string' ? value : fallback;
}

function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Merges every parent's output into a single flat view for template lookup.
 * Later parents win on key collisions; the explicit `{{ parentId.field }}` form
 * remains available whenever that matters.
 */
export function flattenInputs(inputs: NodeInputs): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const value of Object.values(inputs)) {
    if (value && typeof value === 'object') Object.assign(flat, value as object);
  }
  return flat;
}

/** Scope for template resolution: parents first, then a flattened overlay. */
function scopeFor(inputs: NodeInputs): Record<string, unknown> {
  return { ...flattenInputs(inputs), ...inputs };
}

const SAMPLE_ORDERS = [
  {
    orderId: 'ORD-1042',
    amount: 249.99,
    currency: 'USD',
    customer: 'ada@example.com',
    country: 'US',
    subject: 'Refund not received after 10 days',
    message: 'I was charged twice for order ORD-1042 and support has not replied.',
  },
  {
    orderId: 'ORD-7731',
    amount: 1890.5,
    currency: 'USD',
    customer: 'grace@example.com',
    country: 'NG',
    subject: 'Payment failed but card charged',
    message: 'My card was charged but the order never confirmed. Very frustrated.',
  },
];

/* -------------------------------------------------------------------------- *
 * OpenAI-compatible chat completion (shared by the AI node)
 * -------------------------------------------------------------------------- */

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

async function callChatCompletion(
  settings: AppSettings,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
): Promise<string> {
  if (!settings.aiApiKey.trim()) {
    throw new Error(
      'No AI API key configured. Add one in Settings (stored only in your browser).',
    );
  }
  const baseUrl = settings.aiBaseUrl.trim().replace(/\/+$/, '');
  const model = settings.aiModel.trim() || 'gpt-4o-mini';

  const response = await fetchJson<ChatCompletion>(`${baseUrl}/chat/completions`, {
    method: 'POST',
    timeoutMs: 40_000,
    headers: {
      Authorization: `Bearer ${settings.aiApiKey.trim()}`,
      'HTTP-Referer': location.origin,
      'X-Title': 'Strand Workflow Builder',
    },
    body: {
      model,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    },
  });

  if (response.error?.message) throw new Error(`Provider error: ${response.error.message}`);
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('The AI provider returned an empty completion.');
  return content;
}

/* -------------------------------------------------------------------------- *
 * Custom JS execution
 * -------------------------------------------------------------------------- */

export interface CodeRunResult {
  output: Record<string, unknown>;
  /** Console lines the snippet produced, surfaced in the inspector. */
  logs: string[];
}

/**
 * Runs a user snippet inside an async function body with `inputs`, `flat` and
 * `context` in scope.
 *
 * SECURITY: this is arbitrary code execution, by design — it is the product
 * feature. It runs in the page's own origin with the page's own privileges, so
 * it can read `localStorage` (including any stored API keys) and make network
 * calls. It is sandboxed only against accidental scope leakage, not against a
 * malicious author. Do not paste snippets from untrusted sources, and do not
 * host this playground on an origin that holds credentials you care about.
 */
export async function runUserCode(
  source: string,
  inputs: NodeInputs,
  context: unknown,
): Promise<CodeRunResult> {
  const logs: string[] = [];
  const capture = (...parts: unknown[]): void => {
    logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  };
  const sandboxConsole = {
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
  };

  const flat = flattenInputs(inputs);
  const AsyncFunction = Object.getPrototypeOf(async function () {
    /* prototype probe */
  }).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction('inputs', 'flat', 'context', 'console', source);
  } catch (error) {
    throw new Error(
      `Snippet failed to compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const returned = await fn(inputs, flat, context, sandboxConsole);

  if (returned === undefined) {
    throw new Error('Snippet returned nothing. Use `return { ...flat, yourField: value }`.');
  }
  if (returned === null || typeof returned !== 'object') {
    throw new Error('Snippet must return an object.');
  }
  return { output: returned as Record<string, unknown>, logs };
}

/* -------------------------------------------------------------------------- *
 * Filter evaluation
 * -------------------------------------------------------------------------- */

export type FilterOperator =
  | '>'
  | '>='
  | '<'
  | '<='
  | '=='
  | '!='
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'truthy'
  | 'falsy';

export const FILTER_OPERATORS: readonly FieldOption[] = [
  { value: '>', label: 'greater than (>)' },
  { value: '>=', label: 'greater or equal (>=)' },
  { value: '<', label: 'less than (<)' },
  { value: '<=', label: 'less or equal (<=)' },
  { value: '==', label: 'equals (==)' },
  { value: '!=', label: 'not equals (!=)' },
  { value: 'contains', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'truthy', label: 'is truthy' },
  { value: 'falsy', label: 'is falsy' },
];

/** Coerces a literal to a number when both sides look numeric. */
function compare(left: unknown, right: unknown): number {
  const leftNumber = typeof left === 'number' ? left : Number(left);
  const rightNumber = typeof right === 'number' ? right : Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return String(left).localeCompare(String(right));
}

export function evaluateCondition(
  actual: unknown,
  operator: FilterOperator,
  expected: unknown,
): boolean {
  switch (operator) {
    case '>':
      return compare(actual, expected) > 0;
    case '>=':
      return compare(actual, expected) >= 0;
    case '<':
      return compare(actual, expected) < 0;
    case '<=':
      return compare(actual, expected) <= 0;
    case '==':
      return compare(actual, expected) === 0;
    case '!=':
      return compare(actual, expected) !== 0;
    case 'contains':
      return String(actual ?? '').includes(String(expected ?? ''));
    case 'startsWith':
      return String(actual ?? '').startsWith(String(expected ?? ''));
    case 'endsWith':
      return String(actual ?? '').endsWith(String(expected ?? ''));
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- *
 * Telegram + Discord senders
 * -------------------------------------------------------------------------- */

interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: { message_id?: number };
}

async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<{ messageId: number | null }> {
  const data = await fetchJson<TelegramResponse>(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      timeoutMs: 15_000,
      body: {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
    },
  );
  if (!data.ok) {
    throw new Error(`Telegram rejected the message: ${data.description ?? 'unknown error'}`);
  }
  return { messageId: data.result?.message_id ?? null };
}

async function sendDiscord(
  webhookUrl: string,
  content: string,
): Promise<{ messageId: string | null }> {
  const data = await fetchJson<{ id?: string; message?: string }>(webhookUrl, {
    method: 'POST',
    timeoutMs: 15_000,
    // `allowed_mentions.parse: []` prevents accidental @everyone pings from
    // interpolated user content.
    body: { content, allowed_mentions: { parse: [] } },
  });
  if (data.message) throw new Error(`Discord rejected the message: ${data.message}`);
  return { messageId: data.id ?? null };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* -------------------------------------------------------------------------- *
 * The registry
 * -------------------------------------------------------------------------- */

export const NODE_DEFINITIONS: Record<NodeTypeId, NodeDefinition> = {
  /* ------------------------------- triggers ------------------------------ */

  webhook: {
    type: 'webhook',
    label: 'Webhook Trigger',
    category: 'trigger',
    blurb: 'Starts the workflow from an inbound HTTP request body.',
    icon: '⇢',
    accent: 'sky',
    singleton: true,
    defaults: { payloadJson: '', latencyMs: 400 },
    fields: [
      {
        key: 'payloadJson',
        label: 'Sample payload (JSON)',
        kind: 'textarea',
        help: 'Leave blank to generate a random sample order on each run.',
        placeholder: '{ "orderId": "ORD-1", "amount": 199.99 }',
      },
      {
        key: 'latencyMs',
        label: 'Simulated latency (ms)',
        kind: 'number',
        min: 0,
        max: 10_000,
        step: 50,
      },
    ],
    build: (id, name, config) => ({
      id,
      name,
      execute: async () => {
        await delay(num(config, 'latencyMs', 400));
        const payload = str(config, 'payloadJson').trim();
        if (payload) {
          const parsed: unknown = JSON.parse(payload);
          return {
            ...asRecord(parsed),
            receivedAt: new Date().toISOString(),
            source: 'manual-input',
          };
        }
        const sample = SAMPLE_ORDERS[Math.floor(Math.random() * SAMPLE_ORDERS.length)]!;
        return { ...sample, receivedAt: new Date().toISOString(), source: 'simulated-webhook' };
      },
    }),
  },

  manual: {
    type: 'manual',
    label: 'Manual Trigger',
    category: 'trigger',
    blurb: 'Emits a fixed payload when you press Run. Useful for testing.',
    icon: '▶',
    accent: 'sky',
    singleton: true,
    defaults: { payloadJson: '{\n  "message": "Hello from Strand"\n}', latencyMs: 0 },
    fields: [
      {
        key: 'payloadJson',
        label: 'Payload (JSON)',
        kind: 'textarea',
        help: 'The object every downstream node receives.',
      },
      { key: 'latencyMs', label: 'Simulated latency (ms)', kind: 'number', min: 0, max: 10_000, step: 50 },
    ],
    build: (id, name, config) => ({
      id,
      name,
      execute: async () => {
        await delay(num(config, 'latencyMs', 0));
        const raw = str(config, 'payloadJson', '{}');
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        return { ...asRecord(parsed), triggeredAt: new Date().toISOString(), source: 'manual' };
      },
    }),
  },

  /* ---------------------------------- ai --------------------------------- */

  ai: {
    type: 'ai',
    label: 'LLM Completion',
    category: 'ai',
    blurb: 'Sends a system + user prompt to an OpenAI-compatible endpoint.',
    icon: '✦',
    accent: 'violet',
    live: true,
    requires: ['aiApiKey'],
    defaults: {
      systemPrompt:
        'You are an operations assistant. Summarise the payload in two short sentences. Be concise and specific.',
      userPrompt: 'Payload:\n{{ json }}',
      temperature: 0.2,
      passThrough: 'true',
    },
    fields: [
      {
        key: 'systemPrompt',
        label: 'System prompt',
        kind: 'textarea',
        help: 'Sets the model’s role and tone.',
      },
      {
        key: 'userPrompt',
        label: 'User prompt template',
        kind: 'textarea',
        help: 'Use {{ field }} or {{ parentId.field }} to inject values.',
        placeholder: 'Summarise order {{ orderId }} for {{ customer }}',
      },
      {
        key: 'temperature',
        label: 'Temperature',
        kind: 'number',
        min: 0,
        max: 2,
        step: 0.1,
        help: '0 is deterministic, 2 is very creative.',
      },
      {
        key: 'passThrough',
        label: 'Forward upstream data',
        kind: 'select',
        options: [
          { value: 'true', label: 'Yes — keep parent fields in the output' },
          { value: 'false', label: 'No — emit only the completion' },
        ],
        help: 'Keeping parent fields lets downstream nodes read the original payload.',
      },
    ],
    build: (id, name, config, settings, simulate) => ({
      id,
      name,
      timeoutMs: 45_000,
      execute: async (inputs, context) => {
        const scope = scopeFor(inputs);
        const systemPrompt = str(config, 'systemPrompt');
        const userPrompt = interpolate(str(config, 'userPrompt'), scope);
        const temperature = num(config, 'temperature', 0.2);
        const passThrough = config['passThrough'] !== 'false' && config['passThrough'] !== false;
        const upstream = passThrough ? flattenInputs(inputs) : {};

        if (simulate) {
          await delay(1100);
          const preview = userPrompt.slice(0, 160).replace(/\s+/g, ' ').trim();
          context.logger.info('simulated llm completion');
          const completion = `Simulated summary of: ${preview}`;
          return {
            ...upstream,
            model: 'simulated-llm',
            provider: 'offline',
            temperature,
            promptUsed: preview,
            completion,
            text: completion,
            generatedAt: new Date().toISOString(),
          };
        }

        const completion = await callChatCompletion(settings, systemPrompt, userPrompt, temperature);
        return {
          ...upstream,
          model: settings.aiModel,
          provider: settings.aiProvider,
          temperature,
          promptUsed: userPrompt,
          completion,
          text: completion,
          generatedAt: new Date().toISOString(),
        };
      },
    }),
  },

  /* -------------------------------- logic -------------------------------- */

  filter: {
    type: 'filter',
    label: 'If Condition',
    category: 'logic',
    blurb: 'Continues only when the condition passes; otherwise prunes the branch.',
    icon: '◈',
    accent: 'amber',
    defaults: { field: 'amount', operator: '>', value: '100', passThrough: true },
    fields: [
      {
        key: 'field',
        label: 'Field',
        kind: 'text',
        help: 'Dotted path into the merged inputs, e.g. amount or webhook.amount.',
        placeholder: 'amount',
      },
      {
        key: 'operator',
        label: 'Operator',
        kind: 'select',
        options: FILTER_OPERATORS,
      },
      {
        key: 'value',
        label: 'Value',
        kind: 'text',
        placeholder: '100',
        visibleWhen: (config) => !['truthy', 'falsy'].includes(String(config['operator'])),
      },
      {
        key: 'passThrough',
        label: 'Forward upstream data on pass',
        kind: 'select',
        options: [
          { value: 'true', label: 'Yes — pass parents through unchanged' },
          { value: 'false', label: 'No — emit only the verdict' },
        ],
      },
    ],
    build: (id, name, config) => ({
      id,
      name,
      execute: async (inputs) => {
        const scope = scopeFor(inputs);
        const field = str(config, 'field', 'amount');
        const operator = str(config, 'operator', '>') as FilterOperator;
        const rawValue = config['value'];
        const actual = scope[field] ?? scopeFor(inputs)[field];

        // Numbers compare numerically; everything else falls back to strings.
        const expected =
          typeof rawValue === 'string' && rawValue.trim() !== '' && Number.isFinite(Number(rawValue))
            ? Number(rawValue)
            : rawValue;

        const passed = evaluateCondition(actual, operator, expected);
        const verdict = {
          passed,
          field,
          operator,
          actual: actual ?? null,
          expected: expected ?? null,
          reason: `${field} ${operator} ${String(expected)} → ${passed ? 'passed' : 'blocked'}`,
        };

        if (!passed) {
          throw new BranchPruned(`Condition not met: ${verdict.reason}`, verdict);
        }

        const passThrough = config['passThrough'] !== 'false' && config['passThrough'] !== false;
        return passThrough ? { ...flattenInputs(inputs), ...verdict } : { ...verdict };
      },
    }),
  },

  /* --------------------------------- code -------------------------------- */

  code: {
    type: 'code',
    label: 'Custom JS Function',
    category: 'code',
    blurb: 'Runs your own async snippet with the inputs in scope.',
    icon: '⌘',
    accent: 'emerald',
    defaults: {
      source: '// inputs: parents keyed by id · flat: all parents merged\n// Return an object to pass downstream.\nreturn { ...flat, customField: true };',
    },
    fields: [
      {
        key: 'source',
        label: 'Snippet',
        kind: 'code',
        help: 'Async function body. `inputs`, `flat`, `context`, and `console` are in scope.',
      },
    ],
    build: (id, name, config) => ({
      id,
      name,
      timeoutMs: 15_000,
      execute: async (inputs, context) => {
        const source = str(config, 'source');
        if (!source.trim()) throw new Error('Snippet is empty.');
        const result = await runUserCode(source, inputs, context);
        for (const line of result.logs) context.logger.info(`snippet: ${line}`);
        return { ...result.output, ...(result.logs.length ? { _logs: result.logs } : {}) };
      },
    }),
  },

  /* ------------------------------- actions ------------------------------- */

  telegram: {
    type: 'telegram',
    label: 'Telegram Dispatcher',
    category: 'action',
    blurb: 'Posts a message to a Telegram chat via the Bot API.',
    icon: '✈',
    accent: 'cyan',
    live: true,
    requires: ['telegramToken', 'telegramChatId'],
    defaults: {
      messageTemplate: '<b>Strand alert</b>\n{{ completion }}',
      latencyMs: 0,
    },
    fields: [
      {
        key: 'messageTemplate',
        label: 'Message template',
        kind: 'textarea',
        help: 'HTML is allowed. Supports {{ field }} substitution.',
      },
      { key: 'latencyMs', label: 'Simulated latency (ms)', kind: 'number', min: 0, max: 10_000, step: 50 },
    ],
    build: (id, name, config, settings, simulate) => ({
      id,
      name,
      timeoutMs: 20_000,
      execute: async (inputs, context) => {
        const scope = scopeFor(inputs);
        const text = interpolate(str(config, 'messageTemplate'), scope) || '(empty message)';

        if (simulate) {
          await delay(num(config, 'latencyMs', 500) || 500);
          return {
            delivered: false,
            simulated: true,
            channel: 'telegram',
            chatId: settings.telegramChatId || 'offline-demo',
            messageId: null,
            characters: text.length,
            preview: text,
            sentAt: new Date().toISOString(),
          };
        }

        const token = settings.telegramToken.trim();
        const chatId = settings.telegramChatId.trim();
        if (!token) throw new Error('No Telegram bot token configured.');
        if (!chatId) throw new Error('No Telegram chat id configured.');

        const { messageId } = await sendTelegram(token, chatId, text);
        context.logger.info('telegram message sent', { messageId });
        return {
          delivered: true,
          simulated: false,
          channel: 'telegram',
          chatId,
          messageId,
          characters: text.length,
          preview: text,
          sentAt: new Date().toISOString(),
        };
      },
    }),
  },

  discord: {
    type: 'discord',
    label: 'Discord Webhook',
    category: 'action',
    blurb: 'Posts a message to a Discord channel webhook.',
    icon: '◉',
    accent: 'indigo',
    live: true,
    requires: ['discordWebhookUrl'],
    defaults: {
      messageTemplate: '**Strand alert**\n{{ completion }}',
      latencyMs: 0,
    },
    fields: [
      {
        key: 'messageTemplate',
        label: 'Message template',
        kind: 'textarea',
        help: 'Discord markdown is allowed. Supports {{ field }} substitution.',
      },
      { key: 'latencyMs', label: 'Simulated latency (ms)', kind: 'number', min: 0, max: 10_000, step: 50 },
    ],
    build: (id, name, config, settings, simulate) => ({
      id,
      name,
      timeoutMs: 20_000,
      execute: async (inputs, context) => {
        const scope = scopeFor(inputs);
        const text = interpolate(str(config, 'messageTemplate'), scope) || '(empty message)';

        if (simulate) {
          await delay(num(config, 'latencyMs', 500) || 500);
          return {
            delivered: false,
            simulated: true,
            channel: 'discord',
            messageId: null,
            characters: text.length,
            preview: text,
            sentAt: new Date().toISOString(),
          };
        }

        const webhookUrl = settings.discordWebhookUrl.trim();
        if (!webhookUrl) throw new Error('No Discord webhook URL configured.');

        const { messageId } = await sendDiscord(webhookUrl, text);
        context.logger.info('discord message sent', { messageId });
        return {
          delivered: true,
          simulated: false,
          channel: 'discord',
          messageId,
          characters: text.length,
          preview: text,
          sentAt: new Date().toISOString(),
        };
      },
    }),
  },
};

export const NODE_TYPE_LIST: readonly NodeDefinition[] = Object.values(NODE_DEFINITIONS);

/** Palette grouping, in display order. */
export const PALETTE_GROUPS: readonly {
  category: NodeDefinition['category'];
  label: string;
}[] = [
  { category: 'trigger', label: 'Triggers' },
  { category: 'ai', label: 'AI' },
  { category: 'logic', label: 'Logic' },
  { category: 'code', label: 'Code' },
  { category: 'action', label: 'Actions' },
];

export function definitionFor(type: string): NodeDefinition | undefined {
  return NODE_DEFINITIONS[type as NodeTypeId];
}

/** Merges a node's stored config over its type defaults. */
export function withDefaults(
  type: NodeTypeId,
  config: Record<string, unknown>,
): Record<string, unknown> {
  return { ...NODE_DEFINITIONS[type].defaults, ...config };
}

/** Human-readable credential requirement for the UI. */
export function missingCredentials(
  definition: NodeDefinition,
  settings: AppSettings,
): string[] {
  if (!definition.requires) return [];
  return definition.requires.filter((key) => !String(settings[key] ?? '').trim()) as string[];
}

/** Builds an HTML-safe message body for Telegram-style escaping. */
export { escapeHtml };
