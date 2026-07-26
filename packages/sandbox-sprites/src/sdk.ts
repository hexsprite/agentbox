/**
 * Thin wrapper around the `@fly/sprites` SDK. Resolves the org token + org
 * slug once and re-exports the SDK surface the rest of the package uses from a
 * single place (so tests can mock `./sdk.js` instead of the package).
 *
 * Two things worth knowing about this SDK:
 *
 *   - It takes the token as a constructor argument and reads nothing from the
 *     environment, so `resolveToken()` is the only place credentials are read.
 *   - Its `package.json` declares `engines.node >= 24` while AgentBox's floor
 *     is 20.10. The only post-20.10 APIs it actually uses are
 *     `AbortSignal.any` (Node 20.3+) and the global `WebSocket`, and the
 *     WebSocket paths live entirely in `proxy.js` / `control.js` — modules
 *     this provider never touches. Everything we call (client CRUD,
 *     `execFileHTTP`, the filesystem API) is plain `fetch`. So the engine
 *     field is aspirational for our usage and no Node floor change is needed.
 */

import { SpritesClient } from '@fly/sprites';
import { ensureSpritesEnvLoaded } from './env-loader.js';

export { SpritesClient };
export type {
  Sprite,
  SpriteConfig,
  SpriteInfo,
  SpriteList,
  CreateSpriteOptions,
  ExecOptions,
  ExecResult,
  HTTPExecOptions,
  ListOptions,
  Dirent,
  Stats,
} from '@fly/sprites';

/** Default Sprites control-plane API. Override with `SPRITES_API_URL`. */
export const DEFAULT_SPRITES_API_URL = 'https://api.sprites.dev';

const LOGIN_HINT =
  'Run `agentbox sprites login` to paste an org token (from `sprite org auth`, ' +
  'or https://sprites.dev), or set SPRITES_TOKEN + SPRITES_ORG in the environment / ' +
  '~/.agentbox/secrets.env.';

/**
 * Return the configured Sprites org token. Throws an actionable error when
 * nothing is configured. Idempotent — env-loader caches itself after first call.
 */
export function resolveToken(): string {
  ensureSpritesEnvLoaded();
  const token = process.env.SPRITES_TOKEN;
  if (!token) {
    throw new Error(`Sprites credentials not configured.\n${LOGIN_HINT}`);
  }
  return token;
}

/**
 * Return the configured Sprites org slug (e.g. `jordan-baker`). Required: it
 * is part of both the `sprite` CLI argv used for attach and the org scoping of
 * every listing call, and there is no "default org" to fall back to.
 */
export function resolveOrg(): string {
  ensureSpritesEnvLoaded();
  const org = process.env.SPRITES_ORG;
  if (!org) {
    throw new Error(`Sprites organization not configured (SPRITES_ORG).\n${LOGIN_HINT}`);
  }
  return org;
}

/** Base URL of the Sprites control plane. */
export function resolveApiUrl(): string {
  ensureSpritesEnvLoaded();
  return process.env.SPRITES_API_URL ?? DEFAULT_SPRITES_API_URL;
}

/** True when both a token and an org are configured. Used by the credential gate. */
export function hasUsableCredentials(): boolean {
  ensureSpritesEnvLoaded();
  return Boolean(process.env.SPRITES_TOKEN) && Boolean(process.env.SPRITES_ORG);
}

let cached: { client: SpritesClient; token: string; baseURL: string } | undefined;

/**
 * Get a `SpritesClient` for the configured credentials. Cached across calls
 * (the client is a stateless fetch wrapper) but re-created when the token or
 * API URL changes, so `agentbox sprites login` takes effect in-process.
 */
export function spritesClient(): SpritesClient {
  const token = resolveToken();
  const baseURL = resolveApiUrl();
  if (cached && cached.token === token && cached.baseURL === baseURL) return cached.client;
  const client = new SpritesClient(token, { baseURL });
  cached = { client, token, baseURL };
  return client;
}

/** Drop the memoized client. Called after a credential rotation; also used by tests. */
export function resetSpritesClient(): void {
  cached = undefined;
}
