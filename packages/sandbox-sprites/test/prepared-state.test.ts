/**
 * `~/.agentbox/sprites-prepared.json` round-trip. The helpers resolve the path
 * from `homedir()`, so each test points HOME at a scratch dir.
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  preparedStatePath,
  readPreparedState,
  updatePreparedState,
  writePreparedState,
} from '../src/prepared-state.js';

const SAVED_HOME = process.env.HOME;

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'agentbox-sprites-prep-'));
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED_HOME;
});

describe('prepared state', () => {
  it('reports an empty schema-1 state when the file is absent', () => {
    expect(readPreparedState()).toEqual({ schema: 1 });
  });

  it('round-trips a base record', () => {
    writePreparedState({
      schema: 1,
      base: {
        contextSha256: 'abc123',
        spriteCliVersion: 'sprite version v0.0.1-rc46',
        cliVersion: '0.27.1',
        createdAt: '2026-07-26T00:00:00.000Z',
      },
    });
    const got = readPreparedState();
    expect(got.base?.contextSha256).toBe('abc123');
    expect(got.base?.spriteCliVersion).toBe('sprite version v0.0.1-rc46');
    expect(got.base?.cliVersion).toBe('0.27.1');
  });

  // An unknown schema means a future CLI wrote it (or the file is corrupt).
  // Reading it as empty makes the next `prepare` overwrite cleanly instead of
  // acting on a shape this code doesn't understand.
  it('treats an unknown schema as needing a rebuild', () => {
    mkdirSync(join(process.env.HOME!, '.agentbox'), { recursive: true });
    writeFileSync(
      preparedStatePath(),
      JSON.stringify({ schema: 99, base: { contextSha256: 'zzz', createdAt: 'x' } }),
    );
    expect(readPreparedState()).toEqual({ schema: 1 });
  });

  it('treats malformed JSON as needing a rebuild rather than throwing', () => {
    mkdirSync(join(process.env.HOME!, '.agentbox'), { recursive: true });
    writeFileSync(preparedStatePath(), '{not json');
    expect(readPreparedState()).toEqual({ schema: 1 });
  });

  it('updates one field without a manual read/merge/write', () => {
    writePreparedState({
      schema: 1,
      base: { contextSha256: 'one', createdAt: '2026-07-26T00:00:00.000Z' },
    });
    updatePreparedState((s) => {
      if (s.base) s.base.contextSha256 = 'two';
    });
    expect(readPreparedState().base?.contextSha256).toBe('two');
  });

  // Nothing here is an image reference, because there is no image — the record
  // exists to answer "did the runtime you'd install drift from your CLI build".
  it('stores no image or snapshot ref', () => {
    writePreparedState({
      schema: 1,
      base: { contextSha256: 'abc', createdAt: '2026-07-26T00:00:00.000Z' },
    });
    const raw: unknown = JSON.parse(readFileSync(preparedStatePath(), 'utf8'));
    const base = (raw as { base: Record<string, unknown> }).base;
    expect(base).not.toHaveProperty('imageRef');
    expect(base).not.toHaveProperty('templateId');
    expect(base).not.toHaveProperty('snapshotName');
  });

  it('writes under ~/.agentbox with the provider-scoped filename', () => {
    expect(preparedStatePath()).toBe(join(process.env.HOME!, '.agentbox', 'sprites-prepared.json'));
  });
});
