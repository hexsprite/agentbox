/**
 * Bounded retry wrapper for Sprites SDK calls — mirrors `withE2bRetry` /
 * `withVercelRetry` in shape and intent. The Sprites API rate-limits sprite
 * creation (`sprite_creation_rate_limited`) and caps concurrent sprites
 * (`concurrent_sprite_limit_exceeded`), and can return transient 5xx.
 *
 * Non-idempotent ops (`provision`/`createSprite`) pass `retryOnAmbiguous:
 * false` so a timeout after the request reached the origin doesn't create a
 * duplicate billable sprite.
 */

export interface WithRetryOptions {
  method: string;
  /** Per-attempt timeout (ms). Default 30_000. */
  attemptTimeoutMs?: number;
  /** Backoff before attempts 2, 3, … (ms). Default [1000, 2000, 4000]. */
  backoffMs?: readonly number[];
  /**
   * Retry on errors where we can't be sure the server applied the request
   * (connection failures, per-attempt timeouts, 5xx). Set false for
   * non-idempotent operations where a retry could create a duplicate resource.
   */
  retryOnAmbiguous: boolean;
  /** Override the default stderr retry sink (used by tests). */
  onRetry?: (line: string) => void;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 4000];
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

class AttemptTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`sprites ${method}: per-attempt timeout after ${String(ms)}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

export function isAttemptTimeout(err: unknown): err is AttemptTimeoutError {
  return err instanceof AttemptTimeoutError;
}

/** HTTP status code dug out of whatever error shape the SDK throws. */
function statusCodeOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  for (const key of ['statusCode', 'status'] as const) {
    const v = (err as Record<string, unknown>)[key];
    if (typeof v === 'number') return v;
  }
  const resp = (err as { response?: { status?: unknown } }).response;
  if (resp && typeof resp.status === 'number') return resp.status;
  return undefined;
}

/** The SDK's machine-readable `APIError.errorCode`, when present. */
function errorCodeOf(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const v = (err as { errorCode?: unknown }).errorCode;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Seconds the API asked us to wait, from `APIError.getRetryAfterSeconds()`
 * (JSON `retry_after` preferred, `Retry-After` header as fallback). Returns
 * undefined when the error carries no hint.
 */
export function retryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const fn = (err as { getRetryAfterSeconds?: unknown }).getRetryAfterSeconds;
  if (typeof fn === 'function') {
    const secs: unknown = (fn as () => unknown).call(err);
    if (typeof secs === 'number' && Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  for (const key of ['retryAfterSeconds', 'retryAfterHeader'] as const) {
    const v = (err as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v * 1000;
  }
  return undefined;
}

export function isRetriable(err: unknown, allowAmbiguous: boolean): boolean {
  if (err instanceof AttemptTimeoutError) return allowAmbiguous;

  // Sprites' own rate limits. `sprite_creation_rate_limited` is a per-minute
  // window that genuinely clears, so it's retriable even for a create — the
  // request was REJECTED, so retrying can't duplicate anything.
  // `concurrent_sprite_limit_exceeded` needs a human to destroy a sprite; no
  // amount of waiting inside one command fixes it.
  const code = errorCodeOf(err);
  if (code === 'sprite_creation_rate_limited') return true;
  if (code === 'concurrent_sprite_limit_exceeded') return false;

  const status = statusCodeOf(err);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status === 404 || status === 401 || status === 403) return false;
    if (status >= 500 && status <= 599) return allowAmbiguous;
    return false;
  }

  // Raw fetch / undici errors. Node wraps low-level errors in `{ cause }`.
  if (err && typeof err === 'object') {
    const candidates: unknown[] = [err, (err as { cause?: unknown }).cause];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const ec = (c as { code?: unknown }).code;
      if (
        ec === 'ECONNRESET' ||
        ec === 'ETIMEDOUT' ||
        ec === 'ECONNABORTED' ||
        ec === 'EAI_AGAIN' ||
        ec === 'ECONNREFUSED' ||
        ec === 'ENOTFOUND' ||
        ec === 'UND_ERR_SOCKET' ||
        ec === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        return allowAmbiguous;
      }
    }
  }
  return false;
}

export async function withSpritesRetry<T>(
  opts: WithRetryOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const maxAttempts = backoff.length + 1;
  const timeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const log = opts.onRetry ?? defaultRetryLog;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await raceTimeout(fn(), timeoutMs, opts.method);
    } catch (err) {
      const last = attempt === maxAttempts;
      if (last || !isRetriable(err, opts.retryOnAmbiguous)) throw err;
      // Honour the API's own Retry-After over our backoff table when it asks
      // for longer — a rate-limit window doesn't care about our schedule.
      const planned = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 4000;
      const asked = retryAfterMs(err);
      const delay = asked !== undefined ? Math.max(planned, asked) : planned;
      log(
        `sprites ${opts.method}: attempt ${String(attempt)} failed (${errorSummary(err)}); retrying in ${String(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw new Error(`withSpritesRetry: exhausted attempts for ${opts.method}`);
}

function defaultRetryLog(line: string): void {
  process.stderr.write(`\n[sprites-retry] ${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function raceTimeout<T>(p: Promise<T>, ms: number, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AttemptTimeoutError(method, ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    const status = statusCodeOf(err);
    return status !== undefined
      ? `${err.name}(${String(status)}): ${truncate(err.message)}`
      : `${err.name}: ${truncate(err.message)}`;
  }
  return truncate(String(err));
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
