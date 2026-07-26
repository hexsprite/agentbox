/**
 * Resolver for the runtime payload uploaded into a sprite before
 * `install-sprite-base.sh` runs. Same idea as the e2b/vercel resolvers: a flat
 * list of files to push, each resolved from either the staged CLI runtime tree
 * or the monorepo source tree.
 *
 * Lookup order per file:
 *   1. The CLI's staged runtime tree: `<cliRoot>/sprites/...`.
 *   2. The monorepo source tree (dev fallback) under `packages/`.
 *
 * Any missing file throws a clear error naming the paths tried.
 *
 * The one structural difference from every other provider: these assets are
 * uploaded on EVERY create rather than once at bake time, because Sprites has
 * no reusable base image (see scripts/install-sprite-base.sh). They still get
 * fingerprinted the same way — `prepare` records the hash so doctor can flag a
 * runtime that drifted from the CLI build, and so the deferred warm pool has a
 * key to match sprites on.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

export function findStagedCliRuntimeRoot(): string | undefined {
  const candidates = [resolve(SELF, '..', 'runtime'), resolve(SELF, '..', '..', 'runtime')];
  for (const c of candidates) {
    if (existsSync(resolve(c, 'sprites', 'scripts', 'install-sprite-base.sh'))) return c;
  }
  return undefined;
}

export interface RuntimeAsset {
  /** Logical name (used in error messages + log lines). */
  name: string;
  /** Absolute path inside the sprite. install-sprite-base.sh reads them from here. */
  remotePath: string;
  /** File mode to apply after upload. */
  remoteMode: number;
}

/**
 * Where each asset lands inside the sprite. The installer reads them from
 * these fixed paths and `install`s them into place.
 */
export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { name: 'install-sprite-base.sh', remotePath: '/tmp/agentbox-install-sprite-base.sh', remoteMode: 0o755 },
  { name: 'agentbox-ctl', remotePath: '/tmp/agentbox-ctl', remoteMode: 0o755 },
  { name: 'agentbox-dockerd-start', remotePath: '/tmp/agentbox-dockerd-start', remoteMode: 0o755 },
  { name: 'agentbox-vnc-start', remotePath: '/tmp/agentbox-vnc-start', remoteMode: 0o755 },
  { name: 'agentbox-checkpoint-cleanup', remotePath: '/tmp/agentbox-checkpoint-cleanup', remoteMode: 0o755 },
  { name: 'agentbox-open', remotePath: '/tmp/agentbox-open', remoteMode: 0o755 },
  { name: 'gh-shim', remotePath: '/tmp/agentbox-gh-shim', remoteMode: 0o755 },
  { name: 'git-shim', remotePath: '/tmp/agentbox-git-shim', remoteMode: 0o755 },
  { name: 'ntn-shim', remotePath: '/tmp/agentbox-ntn-shim', remoteMode: 0o755 },
  { name: 'linear-shim', remotePath: '/tmp/agentbox-linear-shim', remoteMode: 0o755 },
  { name: 'custom-system-CLAUDE.md', remotePath: '/tmp/agentbox-custom-CLAUDE.md', remoteMode: 0o644 },
  { name: 'claude-managed-settings.json', remotePath: '/tmp/agentbox-managed-settings.json', remoteMode: 0o644 },
  { name: 'agentbox-codex-hooks.json', remotePath: '/tmp/agentbox-codex-hooks.json', remoteMode: 0o644 },
  { name: 'agentbox-setup-skill.md', remotePath: '/tmp/agentbox-setup-skill.md', remoteMode: 0o644 },
] as const;

export interface ResolvedAsset extends RuntimeAsset {
  localPath: string;
}

export function candidatesFor(
  name: string,
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): string[] {
  const cliRoot = opts.cliRuntimeRoot;
  const monorepo = opts.repoRoot ?? guessRepoRoot();

  const monorepoRelative: Record<string, string[]> = {
    'install-sprite-base.sh': ['packages/sandbox-sprites/scripts/install-sprite-base.sh'],
    'agentbox-ctl': ['packages/ctl/dist/bin.cjs'],
    'agentbox-dockerd-start': ['packages/sandbox-docker/scripts/agentbox-dockerd-start'],
    'agentbox-vnc-start': ['packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-checkpoint-cleanup': ['packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['packages/sandbox-docker/scripts/git-shim'],
    'ntn-shim': ['packages/sandbox-docker/scripts/ntn-shim'],
    'linear-shim': ['packages/sandbox-docker/scripts/linear-shim'],
    'custom-system-CLAUDE.md': ['packages/sandbox-sprites/scripts/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['apps/cli/share/agentbox-setup/SKILL.md'],
  };

  const cliRelative: Record<string, string[]> = {
    'install-sprite-base.sh': ['sprites/scripts/install-sprite-base.sh'],
    'agentbox-ctl': ['sprites/ctl.cjs'],
    'agentbox-dockerd-start': ['sprites/agentbox-dockerd-start', 'docker/packages/sandbox-docker/scripts/agentbox-dockerd-start'],
    'agentbox-vnc-start': ['sprites/agentbox-vnc-start', 'docker/packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-checkpoint-cleanup': ['sprites/agentbox-checkpoint-cleanup', 'docker/packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['sprites/agentbox-open', 'docker/packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['sprites/gh-shim', 'docker/packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['sprites/git-shim', 'docker/packages/sandbox-docker/scripts/git-shim'],
    'ntn-shim': ['sprites/ntn-shim', 'docker/packages/sandbox-docker/scripts/ntn-shim'],
    'linear-shim': ['sprites/linear-shim', 'docker/packages/sandbox-docker/scripts/linear-shim'],
    'custom-system-CLAUDE.md': ['sprites/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['sprites/claude-managed-settings.json', 'docker/packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['sprites/agentbox-codex-hooks.json', 'docker/packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['sprites/agentbox-setup-skill.md', 'docker/apps/cli/share/agentbox-setup/SKILL.md'],
  };

  const out: string[] = [];
  if (cliRoot) {
    for (const rel of cliRelative[name] ?? []) out.push(resolve(cliRoot, rel));
  }
  for (const rel of monorepoRelative[name] ?? []) out.push(resolve(monorepo, rel));
  return out;
}

export function resolveRuntimeAssets(
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): ResolvedAsset[] {
  const out: ResolvedAsset[] = [];
  const missing: Array<{ name: string; tried: string[] }> = [];
  for (const asset of RUNTIME_ASSETS) {
    const cands = candidatesFor(asset.name, opts);
    const hit = cands.find((p) => existsSync(p));
    if (!hit) {
      missing.push({ name: asset.name, tried: cands });
      continue;
    }
    out.push({ ...asset, localPath: hit });
  }
  if (missing.length > 0) {
    const lines = missing.flatMap((m) => [`  - ${m.name}: tried`, ...m.tried.map((p) => `      ${p}`)]);
    throw new Error(
      `sprites: could not resolve the runtime assets a box needs:\n` +
        lines.join('\n') +
        `\n\nIf running from the monorepo, ensure \`pnpm -w build\` has run so packages/ctl/dist/bin.cjs exists.`,
    );
  }
  return out;
}

function guessRepoRoot(): string {
  let cur = SELF;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(cur, 'pnpm-workspace.yaml'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return SELF;
}
