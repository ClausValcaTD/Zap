/**
 * Shared helpers for the real-world node executors.
 */

/** Small, typed HTTP error so the engine surfaces a readable node failure. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(url: string, status: number, body: string) {
    const snippet = body.length > 300 ? `${body.slice(0, 300)}...` : body;
    super(`HTTP ${status} from ${url}${snippet ? ` -> ${snippet}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * `fetch` with JSON encode/decode, an abort timeout, and non-2xx -> throw.
 * The timeout is important for UI work: a hung request must not freeze a node
 * in the `running` state forever.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 30_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw new HttpError(url, response.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** Narrows an unknown value to a JSON object without a cast. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
