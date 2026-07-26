/**
 * Credential resolution. `ensureSpritesEnvLoaded` reads
 * `~/.agentbox/secrets.env` only when a key is absent from `process.env`, so
 * setting the vars here makes these tests independent of the developer's own
 * host state — except for the "unset" cases, which have to survive a host that
 * DOES have credentials configured. Those delete the vars and re-import the
 * module with a HOME that has no secrets file.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SAVED = { ...process.env };

function restore(): void {
  for (const k of ['SPRITES_TOKEN', 'SPRITES_ORG', 'SPRITES_API_URL', 'HOME']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
}

/**
 * Import a fresh copy of the module graph. The env-loader latches after its
 * first call, so every case needs its own module instance.
 */
async function freshSdk(): Promise<typeof import('../src/sdk.js')> {
  vi.resetModules();
  return import('../src/sdk.js');
}

describe('resolveToken / resolveOrg', () => {
  beforeEach(() => {
    // Point HOME at an empty dir so the loader can't pick up the developer's
    // real ~/.agentbox/secrets.env and mask an "unset" case.
    process.env.HOME = mkdtempSync(join(tmpdir(), 'agentbox-sprites-'));
  });
  afterEach(restore);

  it('returns the configured token and org', async () => {
    process.env.SPRITES_TOKEN = 'tok_abc';
    process.env.SPRITES_ORG = 'jordan-baker';
    const sdk = await freshSdk();
    expect(sdk.resolveToken()).toBe('tok_abc');
    expect(sdk.resolveOrg()).toBe('jordan-baker');
  });

  it('throws an actionable error naming `agentbox sprites login` when the token is unset', async () => {
    delete process.env.SPRITES_TOKEN;
    process.env.SPRITES_ORG = 'jordan-baker';
    const sdk = await freshSdk();
    expect(() => sdk.resolveToken()).toThrow(/agentbox sprites login/);
    expect(() => sdk.resolveToken()).toThrow(/SPRITES_TOKEN/);
  });

  it('throws naming SPRITES_ORG when only the org is missing', async () => {
    process.env.SPRITES_TOKEN = 'tok_abc';
    delete process.env.SPRITES_ORG;
    const sdk = await freshSdk();
    expect(() => sdk.resolveOrg()).toThrow(/SPRITES_ORG/);
  });

  it('reports usable credentials only when BOTH token and org are set', async () => {
    process.env.SPRITES_TOKEN = 'tok_abc';
    delete process.env.SPRITES_ORG;
    expect((await freshSdk()).hasUsableCredentials()).toBe(false);

    process.env.SPRITES_ORG = 'jordan-baker';
    expect((await freshSdk()).hasUsableCredentials()).toBe(true);
  });

  it('defaults the API URL and honours SPRITES_API_URL', async () => {
    process.env.SPRITES_TOKEN = 'tok_abc';
    process.env.SPRITES_ORG = 'o';
    delete process.env.SPRITES_API_URL;
    const a = await freshSdk();
    expect(a.resolveApiUrl()).toBe(a.DEFAULT_SPRITES_API_URL);

    process.env.SPRITES_API_URL = 'https://api.example.test';
    expect((await freshSdk()).resolveApiUrl()).toBe('https://api.example.test');
  });
});

describe('spritesClient', () => {
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'agentbox-sprites-'));
  });
  afterEach(restore);

  it('memoizes the client for the same token + base URL', async () => {
    process.env.SPRITES_TOKEN = 'tok_abc';
    process.env.SPRITES_ORG = 'o';
    const sdk = await freshSdk();
    expect(sdk.spritesClient()).toBe(sdk.spritesClient());
  });

  it('re-creates the client after the token rotates (so `login` takes effect in-process)', async () => {
    process.env.SPRITES_TOKEN = 'tok_abc';
    process.env.SPRITES_ORG = 'o';
    const sdk = await freshSdk();
    const first = sdk.spritesClient();
    process.env.SPRITES_TOKEN = 'tok_xyz';
    expect(sdk.spritesClient()).not.toBe(first);
  });
});
