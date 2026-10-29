/**
 * Template interpolation for node configs.
 *
 * Node executors receive the merged outputs of their parents as a keyed bag:
 *
 *   { webhook: {...}, currency: {...}, fraud: {...} }
 *
 * Templates reference values with `{{ ... }}`. Two resolution strategies are
 * supported, because both are natural to write:
 *
 *   {{ webhook.orderId }}   // explicit: parent id, then a path into it
 *   {{ orderId }}           // shorthand: first match across all parents
 *
 * The shorthand keeps simple prompts readable while the explicit form stays
 * available whenever two parents expose the same key.
 */

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Reads a dotted path out of a value, returning `undefined` if absent. */
export function readPath(scope: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current: unknown = scope;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Resolves a single reference against the merged input bag.
 *
 * Explicit parent-id references win. Otherwise every parent is searched for the
 * first segment of the path, so `{{ orderId }}` finds the value regardless of
 * which parent produced it.
 */
export function resolveReference(scope: Record<string, unknown>, reference: string): unknown {
  const path = reference.trim();
  if (!path) return undefined;

  const [head, ...rest] = path.split('.');
  if (head === undefined) return undefined;

  // Explicit form: the head names a parent.
  if (Object.prototype.hasOwnProperty.call(scope, head)) {
    const base = scope[head];
    return rest.length === 0 ? base : readPath(base, rest.join('.'));
  }

  // Shorthand: search each parent for the head, then follow the rest.
  for (const parent of Object.values(scope)) {
    if (parent === null || typeof parent !== 'object') continue;
    const record = parent as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, head)) continue;
    return rest.length === 0 ? record[head] : readPath(record[head], rest.join('.'));
  }

  return undefined;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Substitutes every `{{ token }}` in `template`. Unknown tokens become ''. */
export function interpolate(template: string, scope: Record<string, unknown>): string {
  return template.replace(TOKEN, (_match, reference: string) =>
    stringify(resolveReference(scope, reference)),
  );
}

/**
 * Interpolates a template that is expected to hold a JSON object, returning the
 * parsed value. Used by nodes whose output is a structured payload.
 */
export function interpolateJson(
  template: string,
  scope: Record<string, unknown>,
): unknown {
  const text = interpolate(template, scope);
  return text.trim() ? JSON.parse(text) : {};
}

/** Lists the distinct `{{ ... }}` references used by a template. */
export function listReferences(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    if (match[1]) found.add(match[1].trim());
  }
  return [...found];
}
