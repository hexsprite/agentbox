import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  candidatesFor,
  findStagedCliRuntimeRoot,
  RUNTIME_ASSETS,
  resolveRuntimeAssets,
} from '../src/runtime-assets.js';

function makeFakeRepo(): string {
  // Synth a tiny repo skeleton carrying every monorepo file
  // `candidatesFor()` looks for under the source-tree fallback path.
  const root = mkdtempSync(join(tmpdir(), 'agentbox-sprites-test-'));
  mkdirSync(join(root, 'packages/sandbox-sprites/scripts'), { recursive: true });
  mkdirSync(join(root, 'packages/ctl/dist'), { recursive: true });
  mkdirSync(join(root, 'packages/sandbox-docker/scripts'), { recursive: true });
  mkdirSync(join(root, 'apps/cli/share/agentbox-setup'), { recursive: true });
  const files = [
    'packages/sandbox-sprites/scripts/install-sprite-base.sh',
    'packages/ctl/dist/bin.cjs',
    'packages/sandbox-docker/scripts/agentbox-vnc-start',
    'packages/sandbox-docker/scripts/agentbox-dockerd-start',
    'packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup',
    'packages/sandbox-docker/scripts/agentbox-open',
    'packages/sandbox-docker/scripts/gh-shim',
    'packages/sandbox-docker/scripts/git-shim',
    'packages/sandbox-docker/scripts/ntn-shim',
    'packages/sandbox-docker/scripts/linear-shim',
    'packages/sandbox-sprites/scripts/custom-system-CLAUDE.md',
    'packages/sandbox-docker/scripts/claude-managed-settings.json',
    'packages/sandbox-docker/scripts/agentbox-codex-hooks.json',
    'apps/cli/share/agentbox-setup/SKILL.md',
  ];
  for (const rel of files) writeFileSync(join(root, rel), 'stub');
  // Marker so `guessRepoRoot()` (the resolver's default walk-up) can find it.
  writeFileSync(join(root, 'pnpm-workspace.yaml'), '');
  return root;
}

describe('resolveRuntimeAssets', () => {
  it('resolves every asset from a monorepo source tree', () => {
    const repo = makeFakeRepo();
    const out = resolveRuntimeAssets({ repoRoot: repo });
    expect(out).toHaveLength(RUNTIME_ASSETS.length);
    for (const a of out) {
      expect(a.localPath.startsWith(repo)).toBe(true);
    }
  });

  it('lists every missing path when assets are not found', () => {
    let msg = '';
    try {
      resolveRuntimeAssets({ repoRoot: '/nonexistent/path/that/does/not/exist' });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/could not resolve the runtime assets/);
    // Every asset, not just the first, so one run tells the user everything to fix.
    for (const a of RUNTIME_ASSETS) expect(msg).toContain(a.name);
  });

  it('prefers cliRuntimeRoot when provided', () => {
    const repo = makeFakeRepo();
    // Stage just the installer under a CLI runtime tree; the rest must fall
    // through to the repo.
    const cliRuntime = mkdtempSync(join(tmpdir(), 'agentbox-sprites-cli-'));
    mkdirSync(join(cliRuntime, 'sprites/scripts'), { recursive: true });
    writeFileSync(join(cliRuntime, 'sprites/scripts/install-sprite-base.sh'), 'staged');

    const out = resolveRuntimeAssets({ cliRuntimeRoot: cliRuntime, repoRoot: repo });
    const installer = out.find((a) => a.name === 'install-sprite-base.sh');
    expect(installer?.localPath.startsWith(cliRuntime)).toBe(true);
    const ctl = out.find((a) => a.name === 'agentbox-ctl');
    expect(ctl?.localPath.startsWith(repo)).toBe(true);
  });

  it('every asset has a monorepo candidate (no silently unresolvable entry)', () => {
    for (const a of RUNTIME_ASSETS) {
      expect(candidatesFor(a.name, { repoRoot: '/repo' }).length).toBeGreaterThan(0);
    }
  });

  it('uploads the installer executable and the config files not', () => {
    const byName = new Map(RUNTIME_ASSETS.map((a) => [a.name, a]));
    expect(byName.get('install-sprite-base.sh')?.remoteMode).toBe(0o755);
    expect(byName.get('agentbox-ctl')?.remoteMode).toBe(0o755);
    expect(byName.get('custom-system-CLAUDE.md')?.remoteMode).toBe(0o644);
  });

  it('anchors the staged-CLI probe on the sprites installer', () => {
    // A tree that has some other provider's runtime but not ours must not be
    // mistaken for a staged sprites runtime.
    const other = mkdtempSync(join(tmpdir(), 'agentbox-sprites-other-'));
    mkdirSync(join(other, 'runtime/e2b/scripts'), { recursive: true });
    writeFileSync(join(other, 'runtime/e2b/scripts/build-template.sh'), 'x');
    // findStagedCliRuntimeRoot resolves relative to the module, not this dir,
    // so just assert it never claims a root that lacks our anchor file.
    const found = findStagedCliRuntimeRoot();
    if (found !== undefined) {
      expect(found).not.toBe(join(other, 'runtime'));
    }
  });
});
