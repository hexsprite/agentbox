import { describe, expect, it } from 'vitest';
import { isRetriable, retryAfterMs, withSpritesRetry } from '../src/retry.js';

describe('isRetriable', () => {
  it('retries a 429', () => {
    expect(isRetriable({ statusCode: 429 }, false)).toBe(true);
  });

  // The creation rate limit is a per-minute window that clears on its own, and
  // it is a REJECTION — nothing was created — so retrying can't duplicate a
  // billable sprite even on the non-idempotent create path.
  it('retries a creation rate limit even when ambiguity is disallowed', () => {
    expect(isRetriable({ errorCode: 'sprite_creation_rate_limited' }, false)).toBe(true);
  });

  // The concurrent cap needs a human to destroy a sprite. Retrying inside one
  // command just burns the backoff budget and then fails anyway.
  it('never retries the concurrent-sprite cap', () => {
    expect(isRetriable({ errorCode: 'concurrent_sprite_limit_exceeded', statusCode: 429 }, true)).toBe(
      false,
    );
  });

  it('never retries auth or not-found failures', () => {
    expect(isRetriable({ statusCode: 401 }, true)).toBe(false);
    expect(isRetriable({ statusCode: 403 }, true)).toBe(false);
    expect(isRetriable({ statusCode: 404 }, true)).toBe(false);
  });

  it('retries 5xx only when ambiguity is allowed', () => {
    expect(isRetriable({ statusCode: 503 }, true)).toBe(true);
    expect(isRetriable({ statusCode: 503 }, false)).toBe(false);
  });

  it('does not retry other 4xx', () => {
    expect(isRetriable({ statusCode: 400 }, true)).toBe(false);
    expect(isRetriable({ statusCode: 422 }, true)).toBe(false);
  });

  it('retries connection-level errors when ambiguity is allowed', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']) {
      expect(isRetriable({ code }, true)).toBe(true);
      expect(isRetriable({ code }, false)).toBe(false);
    }
  });

  it('unwraps a connection error nested under `cause`', () => {
    expect(isRetriable(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), true)).toBe(
      true,
    );
  });

  it('does not retry an unrecognised error', () => {
    expect(isRetriable(new Error('something odd'), true)).toBe(false);
  });
});

describe('retryAfterMs', () => {
  it('prefers the SDK accessor', () => {
    expect(retryAfterMs({ getRetryAfterSeconds: () => 7 })).toBe(7000);
  });

  it('falls back to the raw fields', () => {
    expect(retryAfterMs({ retryAfterSeconds: 3 })).toBe(3000);
    expect(retryAfterMs({ retryAfterHeader: 5 })).toBe(5000);
  });

  it('ignores absent or nonsensical values', () => {
    expect(retryAfterMs({})).toBeUndefined();
    expect(retryAfterMs({ retryAfterSeconds: 0 })).toBeUndefined();
    expect(retryAfterMs({ retryAfterSeconds: Number.NaN })).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });
});

describe('withSpritesRetry', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const out = await withSpritesRetry({ method: 'test', retryOnAmbiguous: true }, async () => {
      calls++;
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const out = await withSpritesRetry(
      { method: 'test', retryOnAmbiguous: true, backoffMs: [1, 1], onRetry: () => {} },
      async () => {
        calls++;
        if (calls < 3) throw { statusCode: 503 };
        return 'ok';
      },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up immediately on a non-retriable error', async () => {
    let calls = 0;
    await expect(
      withSpritesRetry(
        { method: 'test', retryOnAmbiguous: true, backoffMs: [1, 1], onRetry: () => {} },
        async () => {
          calls++;
          throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
        },
      ),
    ).rejects.toThrow(/unauthorized/);
    expect(calls).toBe(1);
  });

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withSpritesRetry(
        { method: 'test', retryOnAmbiguous: true, backoffMs: [1], onRetry: () => {} },
        async () => {
          calls++;
          throw Object.assign(new Error('boom'), { statusCode: 500 });
        },
      ),
    ).rejects.toThrow(/boom/);
    expect(calls).toBe(2);
  });

  it('does not retry at all when the backoff table is empty (the create path)', async () => {
    let calls = 0;
    await expect(
      withSpritesRetry(
        { method: 'provision', retryOnAmbiguous: false, backoffMs: [] },
        async () => {
          calls++;
          throw Object.assign(new Error('boom'), { statusCode: 500 });
        },
      ),
    ).rejects.toThrow(/boom/);
    expect(calls).toBe(1);
  });

  it('waits at least as long as the API asked', async () => {
    const waits: number[] = [];
    let calls = 0;
    const started = Date.now();
    await withSpritesRetry(
      {
        method: 'test',
        retryOnAmbiguous: true,
        backoffMs: [1],
        onRetry: (line) => {
          waits.push(Number.parseInt(/retrying in (\d+)ms/.exec(line)?.[1] ?? '0', 10));
        },
      },
      async () => {
        calls++;
        if (calls < 2) throw { statusCode: 429, retryAfterSeconds: 0.05 };
        return 'ok';
      },
    );
    // The planned backoff was 1ms; the API asked for 50ms and wins.
    expect(waits).toEqual([50]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('surfaces a per-attempt timeout as retriable when ambiguity is allowed', async () => {
    let calls = 0;
    const out = await withSpritesRetry(
      {
        method: 'test',
        retryOnAmbiguous: true,
        attemptTimeoutMs: 20,
        backoffMs: [1],
        onRetry: () => {},
      },
      async () => {
        calls++;
        if (calls < 2) await new Promise((r) => setTimeout(r, 200));
        return 'ok';
      },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });
});
