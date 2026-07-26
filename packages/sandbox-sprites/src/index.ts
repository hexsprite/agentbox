/**
 * The Fly.io Sprites sandbox provider. A thin `CloudBackend` over the
 * `@fly/sprites` SDK, composed via `@agentbox/sandbox-cloud`'s
 * `createCloudProvider` for everything provider-agnostic (workspace seeding,
 * ctl launch, state, relay polling).
 *
 * Three capabilities are overridden on top of the cloud scaffold:
 *   - `prepare`     — validate + fingerprint rather than bake, because Sprites
 *                     has no reusable base image to bake into (see prepare.ts).
 *   - `buildAttach` — `sprite console` is a shell, not an SSH-shaped
 *                     "connect and run this command", so the shared builder's
 *                     `-t <cmd>` append doesn't fit (see build-attach.ts).
 *   - `baseFingerprint` — reports the runtime-asset hash the per-box install
 *                     would use, so `agentbox doctor` can still flag drift.
 *
 * NO `checkpoint` override, deliberately: Sprites' checkpoints restore in place
 * into the sprite that made them, so there is nothing for a new box to boot
 * from. The backend omits `createSnapshot`, which makes the scaffold's
 * `checkpoint.create` raise its own clear "doesn't support snapshots" error.
 *
 * `launchDockerd: true` — the base install lays down docker.io and the shared
 * `agentbox-dockerd-start`, and the scaffold starts it on every create/resume.
 */

import type { Provider } from '@agentbox/core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import type { ProviderModule } from '@agentbox/sandbox-core';
import { spritesBackend, DEFAULT_BOX_IMAGE_REF } from './backend.js';
import { buildSpritesAttach } from './build-attach.js';
import { ensureSpritesCredentials, setSpritesCredentials } from './credentials.js';
import { prepareSpritesProvider } from './prepare.js';
import { currentSpritesBaseFingerprintLive } from './prepared-state.js';
import { doctorChecks, readCredStatusSummary } from './provider-module.js';

const cloudProvider = createCloudProvider(spritesBackend, {
  // Advisory metadata for BoxRecord stats / the dashboard pane. Unlike e2b
  // these ARE honoured per create — `createSprite` takes a config — so
  // `--size 4-8-40` reaches the platform (see parseSpritesSize).
  defaultResources: { cpu: 2, memory: 4, disk: 20 },
  launchDockerd: true,
});

export const spritesProvider: Provider = {
  ...cloudProvider,
  prepare: prepareSpritesProvider,
  buildAttach: buildSpritesAttach,
  baseFingerprint: () => currentSpritesBaseFingerprintLive(),
};

/** Uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: spritesProvider,
  backend: spritesBackend,
  ensureCredentials: ensureSpritesCredentials,
  readCredStatus: readCredStatusSummary,
  setCredentials: (fields) => Promise.resolve(setSpritesCredentials(fields)),
  currentBaseFingerprintLive: (claudeInstall) => currentSpritesBaseFingerprintLive(claudeInstall),
  doctorChecks,
};

export { spritesBackend, DEFAULT_BOX_IMAGE_REF };
export { AGENTBOX_LABEL, buildExecArgv, mapState, parseSpritesSize, safeSpriteName } from './backend.js';
export { ensureSpritesEnvLoaded, reloadSpritesEnv, SPRITES_KEYS } from './env-loader.js';
export {
  ensureSpritesCredentials,
  setSpritesCredentials,
  readSpritesCredStatus,
  readSpriteCliOrg,
  secretsPath,
  maskKey,
  type EnsureSpritesCredentialsOptions,
  type SpritesCredStatus,
} from './credentials.js';
export {
  RUNTIME_ASSETS,
  candidatesFor,
  resolveRuntimeAssets,
  findStagedCliRuntimeRoot,
  type RuntimeAsset,
  type ResolvedAsset,
} from './runtime-assets.js';
export {
  prepareSprites,
  prepareSpritesProvider,
  readSpriteCliVersion,
  type PrepareSpritesOptions,
  type PrepareSpritesResult,
} from './prepare.js';
export {
  currentSpritesBaseFingerprintLive,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
  updatePreparedState,
  type PreparedSpritesState,
  type PreparedSpritesBase,
} from './prepared-state.js';
export { buildSpritesAttach } from './build-attach.js';
export { findSpriteCli, requireSpriteCli, spriteCliEnv, spriteSelector } from './sprite-cli.js';
export { installSpriteBase, type InstallSpriteBaseArgs } from './install.js';
