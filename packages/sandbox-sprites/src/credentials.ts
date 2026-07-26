/**
 * Interactive Sprites credential setup. Two values are needed — an org token
 * and the org slug it belongs to — both persisted to `~/.agentbox/secrets.env`
 * (the canonical store, matching daytona / hetzner / vercel / e2b).
 *
 * Why paste rather than reuse the `sprite` CLI's own credentials: the CLI keeps
 * its token in the OS keychain behind `~/.sprites/keyring`, which is a
 * directory, not a parseable file. We do read the CLI's `~/.sprites/sprites.json`
 * for the *org slug* though — it is plain JSON and knowing the user's current
 * org lets us offer it as the prompt default instead of making them type it.
 *
 * Non-interactive callers (no TTY): silent no-op, so scripted/CI runs surface
 * the SDK's own "not configured" error instead of hanging on a prompt.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { hostOpenCommand, writeManagedSecrets, type CredSetResult } from '@agentbox/sandbox-core';
import { cancel, confirm, intro, isCancel, log, note, outro, password, text } from '@clack/prompts';
import { ensureSpritesEnvLoaded, reloadSpritesEnv } from './env-loader.js';
import { hasUsableCredentials, resetSpritesClient } from './sdk.js';

// Ctrl+C at a prompt resolves with the cancel symbol; turn that into a real
// quit so the command never silently continues as if the user answered "No".
function exitOnCancel<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel('Cancelled.');
    process.exit(130);
  }
  return v as T;
}

const TOKENS_URL = 'https://sprites.dev';

/**
 * Keys we manage in `~/.agentbox/secrets.env`. On reconfigure we strip prior
 * values for these before appending so the file never accumulates duplicates.
 */
const MANAGED_KEYS = ['SPRITES_TOKEN', 'SPRITES_ORG'] as const;

export interface EnsureSpritesCredentialsOptions {
  /** Re-prompt even when valid credentials are already present (`agentbox sprites login`). */
  force?: boolean;
}

export async function ensureSpritesCredentials(
  opts: EnsureSpritesCredentialsOptions = {},
): Promise<void> {
  ensureSpritesEnvLoaded();

  if (!opts.force && hasUsableCredentials()) return;
  if (!process.stdin.isTTY) return;

  const cliOrg = readSpriteCliOrg();

  intro('Fly.io Sprites setup');
  note(
    `AgentBox needs a Sprites org token to provision sandboxes.\n` +
      `Get one with \`sprite org auth\` (the Sprites CLI) or from ${TOKENS_URL}, then paste it below.\n` +
      `The token is stored in \`~/.agentbox/secrets.env\` (mode 0600) — no .env.local harvesting.`,
    'Credentials required',
  );

  const openIt = exitOnCancel(
    await confirm({
      message: `Open ${TOKENS_URL} to create a token?`,
      initialValue: cliOrg === undefined,
    }),
  );
  if (openIt) openDashboard();

  const token = exitOnCancel(
    await password({
      message: 'Paste your Sprites org token',
      validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
    }),
  );

  const org = exitOnCancel(
    await text({
      message: 'Sprites organization slug',
      ...(cliOrg !== undefined ? { initialValue: cliOrg, placeholder: cliOrg } : {}),
      validate: (v) => (v && v.trim().length > 0 ? undefined : 'Cannot be empty'),
    }),
  );

  persistCredentials({ token: token.trim(), org: org.trim() });
  reloadSpritesEnv();
  resetSpritesClient();
  log.success(`Sprites credentials saved to ${secretsPath()}`);
  outro('Setup complete.');
}

function persistCredentials(creds: { token: string; org: string }): void {
  writeManagedSecrets(MANAGED_KEYS, { SPRITES_TOKEN: creds.token, SPRITES_ORG: creds.org });
}

/**
 * Non-interactive credential set (the headless path the hub drives). Takes
 * `{ token, org }`, persists both, and reports status. Sprites has no cheap
 * read-only auth probe, so — like the interactive flow — we only require the
 * values to be non-empty; a bad token surfaces on the first sprite create.
 */
export function setSpritesCredentials(fields: Record<string, string>): CredSetResult {
  const token = (fields.token ?? '').trim();
  const org = (fields.org ?? '').trim();
  if (!token) {
    return { ok: false, error: 'token is required', status: { configured: false } };
  }
  if (!org) {
    return { ok: false, error: 'org is required', status: { configured: false } };
  }
  persistCredentials({ token, org });
  resetSpritesClient();
  const cred = readSpritesCredStatus();
  return { ok: true, status: { configured: cred.auth !== 'none', label: cred.auth } };
}

/**
 * Best-effort read of the `sprite` CLI's currently-selected org from
 * `~/.sprites/sprites.json`. Purely a prompt convenience — never a credential
 * source (the token itself lives in the OS keychain, not this file).
 */
export function readSpriteCliOrg(): string | undefined {
  const path = resolve(homedir(), '.sprites', 'sprites.json');
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    const org = (raw as { current_selection?: { org?: unknown } }).current_selection?.org;
    return typeof org === 'string' && org.length > 0 ? org : undefined;
  } catch {
    return undefined;
  }
}

function openDashboard(): void {
  import('node:child_process')
    .then(({ spawnSync }) => {
      const r = spawnSync(hostOpenCommand(), [TOKENS_URL], { stdio: 'ignore' });
      if (r.status !== 0) {
        log.warn(`Could not auto-open the browser — visit ${TOKENS_URL} manually.`);
      }
    })
    .catch(() => {
      log.warn(`Could not auto-open the browser — visit ${TOKENS_URL} manually.`);
    });
}

export function secretsPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

export interface SpritesCredStatus {
  /** `token` once BOTH a token and an org are present — either alone can't provision. */
  auth: 'token' | 'none';
  token?: string;
  org?: string;
  source: 'env' | 'secrets.env' | 'none';
}

export function readSpritesCredStatus(): SpritesCredStatus {
  const shellHad = process.env.SPRITES_TOKEN !== undefined;
  ensureSpritesEnvLoaded();
  const token = process.env.SPRITES_TOKEN;
  const org = process.env.SPRITES_ORG;
  if (!token || !org) {
    return {
      auth: 'none',
      source: 'none',
      ...(token ? { token } : {}),
      ...(org ? { org } : {}),
    };
  }
  return { auth: 'token', token, org, source: shellHad ? 'env' : 'secrets.env' };
}

export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${'*'.repeat(8)}${value.slice(-4)}`;
}
