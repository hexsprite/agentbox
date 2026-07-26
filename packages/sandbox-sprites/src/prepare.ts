/**
 * `agentbox prepare --provider sprites` — validate, fingerprint, persist. It
 * does NOT bake, because there is nothing on Sprites to bake into.
 *
 * Every other provider's `prepare` produces a reusable artifact: a docker
 * image, a Hetzner/DigitalOcean snapshot, a Vercel snapshot, an E2B template.
 * `CreateSprite` accepts a name, a size, env, labels and URL settings — no
 * image, no rootfs, no create-from-checkpoint — and Sprites' checkpoints roll a
 * single sprite back in place rather than producing something a new sprite can
 * boot from. So the base install runs per box instead (see
 * scripts/install-sprite-base.sh), and this command is a preflight:
 *
 *   1. Credentials resolve (token + org).
 *   2. The `sprite` CLI is installed — attach and the relay bridge tunnel both
 *      shell out to it, so a missing binary is a broken provider, not a
 *      degraded one.
 *   3. The runtime assets a box would be installed with all resolve, and
 *      fingerprint them.
 *   4. Persist the fingerprint to `~/.agentbox/sprites-prepared.json`.
 *
 * Step 3 is the part that earns its keep: it turns "your CLI build and your box
 * runtime have drifted" into a doctor row, exactly like the baked providers,
 * and it's the key the deferred warm pool matches pooled sprites on.
 *
 * We deliberately do NOT create a throwaway sprite to test-drive the install.
 * That would be billable, slow, and prove nothing a real create doesn't — the
 * install runs on every create anyway, where its failure is visible and
 * actionable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider } from '@agentbox/core';
import { claudeInstallFingerprint, computeContextSha256, readCliStamp } from '@agentbox/sandbox-core';
import { ensureSpritesCredentials } from './credentials.js';
import { resolveOrg, resolveToken } from './sdk.js';
import { findSpriteCli, spriteCliEnv } from './sprite-cli.js';
import { preparedStatePath, readPreparedState, writePreparedState } from './prepared-state.js';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';

const execFileAsync = promisify(execFile);

export interface PrepareSpritesOptions {
  /** Force a re-check even when an up-to-date fingerprint is recorded. */
  force?: boolean;
  /** CLI runtime tree (set by the CLI to its dist neighbor). */
  cliRuntimeRoot?: string;
  /** Repo root for the dev fallback (defaults to a cwd-walk). */
  repoRoot?: string;
  /** How the per-box install would install Claude Code, when the base lacks it. */
  claudeInstall?: 'native' | 'npm';
  onLog?: (line: string) => void;
}

export interface PrepareSpritesResult {
  /** The fingerprint recorded for the runtime assets. */
  contextSha256: string;
  /** `sprite` CLI version string, when it could be read. */
  spriteCliVersion?: string;
  /** True when nothing changed and the recorded state was already current. */
  upToDate: boolean;
}

/** Read `sprite --version`. Returns undefined when the CLI can't be run. */
export async function readSpriteCliVersion(): Promise<string | undefined> {
  const bin = findSpriteCli();
  if (!bin) return undefined;
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], {
      env: process.env,
      timeout: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function prepareSprites(
  opts: PrepareSpritesOptions = {},
): Promise<PrepareSpritesResult> {
  const log = opts.onLog ?? ((): void => {});

  await ensureSpritesCredentials();
  // Throw early and actionably rather than at the first create.
  resolveToken();
  const org = resolveOrg();
  log(`sprites: credentials OK (org ${org})`);

  const bin = findSpriteCli();
  if (!bin) {
    throw new Error(
      'the `sprite` CLI is required by the sprites provider but was not found on PATH.\n' +
        'Interactive attach (`sprite console`) and the host→box relay tunnel (`sprite proxy`) ' +
        'both shell out to it. Install it with ' +
        '`curl -fsSL https://sprites.dev/install.sh | sh`, then re-run.',
    );
  }
  const spriteCliVersion = await readSpriteCliVersion();
  log(`sprites: found the sprite CLI at ${bin}${spriteCliVersion ? ` (${spriteCliVersion})` : ''}`);
  // Prove the CLI accepts the credentials AgentBox is configured with, not
  // whichever org `sprite use` happens to point at — a mismatch here surfaces
  // later as a baffling "sprite not found" during attach.
  try {
    await execFileAsync(bin, ['list'], { env: spriteCliEnv(), timeout: 20_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `sprites: the \`sprite\` CLI could not list sprites for org ${org} with the configured ` +
        `token — attach and the bridge tunnel will fail.\n${msg}`,
    );
  }

  const assets = resolveRuntimeAssets({
    cliRuntimeRoot: opts.cliRuntimeRoot ?? findStagedCliRuntimeRoot(),
    ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
  });
  const contextSha256 = claudeInstallFingerprint(
    await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
    opts.claudeInstall ?? 'native',
  );
  log(`sprites: resolved ${String(assets.length)} runtime assets (${contextSha256.slice(0, 12)})`);

  const existing = readPreparedState().base;
  if (!opts.force && existing?.contextSha256 === contextSha256) {
    log(`sprites: already up to date (${preparedStatePath()})`);
    return {
      contextSha256,
      ...(spriteCliVersion ? { spriteCliVersion } : {}),
      upToDate: true,
    };
  }

  const stamp = readCliStamp();
  writePreparedState({
    schema: 1,
    base: {
      contextSha256,
      ...(spriteCliVersion ? { spriteCliVersion } : {}),
      ...(stamp.cliVersion ? { cliVersion: stamp.cliVersion } : {}),
      ...(stamp.cliCommit ? { cliCommit: stamp.cliCommit } : {}),
      createdAt: new Date().toISOString(),
    },
  });
  log(`sprites: recorded ${preparedStatePath()}`);
  log(
    'sprites: nothing was baked — Sprites has no reusable base image, so the runtime installs ' +
      'inside each box at create time (~2 min). This collapses to a single call once Fly ships ' +
      'fork-from-sprite.',
  );

  return {
    contextSha256,
    ...(spriteCliVersion ? { spriteCliVersion } : {}),
    upToDate: false,
  };
}

/** `Provider.prepare` adapter. */
export const prepareSpritesProvider: NonNullable<Provider['prepare']> = async (opts) => {
  await prepareSprites({
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.claudeInstall ? { claudeInstall: opts.claudeInstall } : {}),
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
  });
  // No snapshot name to pin: there is no artifact.
  return {};
};
