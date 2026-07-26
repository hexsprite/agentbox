/**
 * Locating and driving the `sprite` CLI binary.
 *
 * Two things need the real CLI rather than the SDK:
 *
 *   - **attach** — `sprite console` is a working PTY client; reimplementing it
 *     over the SDK would be another 200-line helper process (see
 *     sandbox-e2b/src/attach-helper.ts for what that costs).
 *   - **the bridge tunnel** — a sprite's public URL reaches exactly ONE
 *     in-sprite port (8080, fixed — verified live 2026-07-26: killing the 8080
 *     listener makes the URL 502 rather than fall through to another port). The
 *     host relay's bridge lives on 8788, so it needs a local forward, and
 *     `sprite proxy` is that. See sprite-proxy.ts.
 *
 * So the CLI is a genuine host prerequisite for this provider, checked by
 * `agentbox doctor --provider sprites`.
 *
 * Credentials: the CLI keeps its own token in the OS keychain, but it also
 * honours `SPRITE_TOKEN` / `SPRITE_ORG` / `SPRITE_URL` from the environment
 * (verified against v0.0.1-rc43). We always pass those explicitly so the CLI
 * and the SDK act on the SAME credentials — the ones in
 * `~/.agentbox/secrets.env` — rather than whichever org the user's `sprite use`
 * happens to point at.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { resolveApiUrl, resolveOrg, resolveToken } from './sdk.js';

/** Where the Sprites installer puts the binary when it isn't on PATH. */
const FALLBACK_PATHS = ['.local/bin/sprite'] as const;

/**
 * Absolute path to the `sprite` binary, or `undefined` when it isn't
 * installed. Searches PATH first, then the installer's default location.
 */
export function findSpriteCli(): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, 'sprite');
    if (existsSync(candidate)) return candidate;
  }
  for (const rel of FALLBACK_PATHS) {
    const candidate = resolve(homedir(), rel);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Like `findSpriteCli`, but throws an actionable error when it's missing. */
export function requireSpriteCli(): string {
  const bin = findSpriteCli();
  if (!bin) {
    throw new Error(
      'the `sprite` CLI is required by the sprites provider but was not found on PATH.\n' +
        'Install it with `curl -fsSL https://sprites.dev/install.sh | sh` ' +
        '(it lands in ~/.local/bin), then re-run. ' +
        '`agentbox doctor --provider sprites` re-checks.',
    );
  }
  return bin;
}

/**
 * Environment for a `sprite` CLI invocation: the caller's env plus the
 * credentials AgentBox is configured with. Note the singular `SPRITE_` prefix
 * — that's the CLI's spelling; the SDK-facing vars this package stores are
 * `SPRITES_*`.
 */
export function spriteCliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SPRITE_TOKEN: resolveToken(),
    SPRITE_ORG: resolveOrg(),
    SPRITE_URL: resolveApiUrl(),
  };
}

/** Common `-o <org> -s <sprite>` selector every sprite subcommand takes. */
export function spriteSelector(spriteName: string): string[] {
  return ['-o', resolveOrg(), '-s', spriteName];
}
