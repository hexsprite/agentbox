/**
 * Sprites env auto-loader. The `@fly/sprites` SDK takes its token as a
 * constructor argument rather than reading the environment, so `sdk.ts` reads
 * these keys itself — this module just seeds them from
 * `~/.agentbox/secrets.env` (written by `agentbox sprites login`) so the
 * provider Just Works after a one-time login. Same pattern as the daytona /
 * hetzner / vercel / e2b env-loaders.
 *
 * Lookup order (first wins; process.env is never overwritten):
 *   1. `process.env` (already set in the shell).
 *   2. `~/.agentbox/secrets.env` — written by `agentbox sprites login`.
 *
 * Project-level `.env` / `.env.local` are intentionally NOT consulted: those
 * files belong to the app code being developed. Put host credentials in
 * `~/.agentbox/secrets.env` (or the shell env).
 *
 * Note we deliberately do NOT read `~/.sprites/keyring` — the `sprite` CLI
 * stores its org token in the OS keychain behind that directory, not in a
 * parseable file. `agentbox sprites login` asks the user to paste a token
 * instead (it does read `~/.sprites/sprites.json` to offer the configured org
 * as a default — see credentials.ts).
 *
 * Only SPRITES-prefixed keys are imported; the rest of the file is left alone.
 * Idempotent and side-effect-free after the first call.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const SPRITES_KEYS = ['SPRITES_TOKEN', 'SPRITES_ORG', 'SPRITES_API_URL'] as const;

let loaded = false;

export function ensureSpritesEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importSpritesFromFile(resolve(homedir(), '.agentbox', 'secrets.env'), SPRITES_KEYS);
}

/**
 * Force a re-read of `~/.agentbox/secrets.env`. Used by the interactive
 * `agentbox sprites login` flow after it persists the token, so the same
 * process can pick it up without a restart.
 */
export function reloadSpritesEnv(): void {
  loaded = false;
  ensureSpritesEnvLoaded();
}

function importSpritesFromFile(path: string, keys: readonly string[]): void {
  if (!existsSync(path)) return;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(body);
  for (const key of keys) {
    if (process.env[key] !== undefined) continue;
    const value = parsed[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
}

/**
 * Minimal `.env` parser: handles `KEY=value`, `KEY="value"`, `KEY='value'`,
 * `export KEY=value`, blank lines, and `#` comments. No variable interpolation
 * — predictable over feature-complete (matches the daytona / vercel / e2b
 * loaders).
 */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
