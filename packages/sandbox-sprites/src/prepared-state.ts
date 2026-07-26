/**
 * Persisted record of what `agentbox prepare --provider sprites` validated.
 * Lives at `~/.agentbox/sprites-prepared.json`.
 *
 * This is the one provider whose `prepare` does NOT bake anything, because
 * Sprites has nothing to bake into: no image, no rootfs, no
 * create-from-checkpoint. So there is no `imageRef` here — the record carries
 * the *fingerprint of the runtime assets a box would be installed with*, plus
 * the CLI version that produced them.
 *
 * That is still worth persisting, for three reasons:
 *   - `agentbox doctor` can tell you your box runtime drifted from your CLI
 *     build, which is the same question `base freshness` answers elsewhere.
 *   - `prepare` stays a real preflight (credentials, the `sprite` binary, the
 *     assets actually resolving) rather than a no-op that lies about success.
 *   - the deferred warm pool keys pooled sprites on exactly this fingerprint.
 *
 * Schema versioned so future shape changes can migrate; only `schema: 1` is
 * accepted today.
 */

import {
  claudeInstallFingerprint,
  computeContextSha256,
  preparedStatePathFor,
  readPreparedStateRaw,
  writePreparedStateRaw,
} from '@agentbox/sandbox-core';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';

const SCHEMA = 1 as const;

export interface PreparedSpritesBase {
  /** Deterministic SHA-256 of the runtime assets a box gets installed with. */
  contextSha256: string;
  /** `sprite` CLI version seen at prepare time (attach + the bridge tunnel need it). */
  spriteCliVersion?: string;
  /** CLI version that produced these assets (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
  /** ISO timestamp of the last successful prepare. */
  createdAt: string;
}

export interface PreparedSpritesState {
  schema: typeof SCHEMA;
  /** Absent until the first `agentbox prepare --provider sprites`. */
  base?: PreparedSpritesBase;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('sprites');
}

export function readPreparedState(): PreparedSpritesState {
  const raw = readPreparedStateRaw('sprites');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedSpritesState>;
  if (parsed.schema !== SCHEMA) {
    // Unknown/missing schema: refuse to read — the next prepare overwrites it.
    return { schema: SCHEMA };
  }
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedState(state: PreparedSpritesState): void {
  writePreparedStateRaw('sprites', state);
}

/** Update one field of the state without forcing callers to read/merge/write. */
export function updatePreparedState(mutate: (s: PreparedSpritesState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * Compute the CURRENT fingerprint of the runtime assets a sprites box would be
 * installed with. Side-effect-free. Returns `undefined` when the assets can't
 * be resolved (dev tree without `pnpm -w build`) so the CLI degrades to "can't
 * tell, don't nag" rather than flagging a false stale.
 *
 * Must produce a byte-identical hash to the one `prepare` writes — both go
 * through the same `resolveRuntimeAssets` + `computeContextSha256` chain.
 */
export async function currentSpritesBaseFingerprintLive(
  claudeInstall: 'native' | 'npm' = 'native',
): Promise<string | undefined> {
  try {
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    return claudeInstallFingerprint(
      await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
      claudeInstall,
    );
  } catch {
    return undefined;
  }
}
