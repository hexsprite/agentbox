/**
 * The per-box base install driver. Sprites has no reusable image, so this runs
 * on EVERY create — its ordering and failure behaviour matter more than they
 * would for a once-per-bake script.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CloudExecOptions, CloudExecResult } from '@agentbox/core';
import { RUNTIME_ASSETS } from '../src/runtime-assets.js';

function makeFakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentbox-sprites-install-'));
  mkdirSync(join(root, 'packages/sandbox-sprites/scripts'), { recursive: true });
  mkdirSync(join(root, 'packages/ctl/dist'), { recursive: true });
  mkdirSync(join(root, 'packages/sandbox-docker/scripts'), { recursive: true });
  mkdirSync(join(root, 'apps/cli/share/agentbox-setup'), { recursive: true });
  for (const rel of [
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
  ]) {
    writeFileSync(join(root, rel), 'stub');
  }
  writeFileSync(join(root, 'pnpm-workspace.yaml'), '');
  return root;
}

interface Harness {
  uploads: Array<{ local: string; remote: string }>;
  execs: Array<{ cmd: string; opts?: CloudExecOptions }>;
  logs: string[];
  run: (over?: Partial<{ vnc: boolean; exitCode: number; stdout: string }>) => Promise<void>;
}

function harness(): Harness {
  const uploads: Array<{ local: string; remote: string }> = [];
  const execs: Array<{ cmd: string; opts?: CloudExecOptions }> = [];
  const logs: string[] = [];
  const repo = makeFakeRepo();

  // `resolveRuntimeAssets` is called with the module's own staged-CLI probe, so
  // point the repo walk at the fixture instead.
  vi.doMock('../src/runtime-assets.js', async () => {
    const actual =
      await vi.importActual<typeof import('../src/runtime-assets.js')>('../src/runtime-assets.js');
    return {
      ...actual,
      findStagedCliRuntimeRoot: () => undefined,
      resolveRuntimeAssets: () => actual.resolveRuntimeAssets({ repoRoot: repo }),
    };
  });

  return {
    uploads,
    execs,
    logs,
    run: async (over = {}) => {
      const { installSpriteBase: install } = await import('../src/install.js');
      await install({
        upload: async (local, remote) => {
          uploads.push({ local, remote });
        },
        exec: async (cmd, opts): Promise<CloudExecResult> => {
          execs.push({ cmd, ...(opts ? { opts } : {}) });
          return {
            exitCode: cmd.startsWith('bash /tmp/') ? (over.exitCode ?? 0) : 0,
            stdout: cmd.startsWith('bash /tmp/') ? (over.stdout ?? '') : '',
            stderr: '',
          };
        },
        onLog: (l) => logs.push(l),
        vnc: over.vnc ?? false,
        timeoutMs: 60_000,
      });
    },
  };
}

describe('installSpriteBase', () => {
  it('uploads every runtime asset before running the installer', async () => {
    const h = harness();
    await h.run();
    expect(h.uploads).toHaveLength(RUNTIME_ASSETS.length);
    const remotes = h.uploads.map((u) => u.remote);
    for (const a of RUNTIME_ASSETS) expect(remotes).toContain(a.remotePath);
    // The installer exec is last; the chmod is in between.
    expect(h.execs.at(-1)?.cmd).toBe('bash /tmp/agentbox-install-sprite-base.sh');
  });

  // The SDK's filesystem write does not preserve mode, so the installer would
  // arrive non-executable without this.
  it('chmods the uploaded assets in one call', async () => {
    const h = harness();
    await h.run();
    const chmod = h.execs[0]!.cmd;
    expect(chmod).toContain("chmod 0755 '/tmp/agentbox-install-sprite-base.sh'");
    expect(chmod).toContain("chmod 0644 '/tmp/agentbox-custom-CLAUDE.md'");
    expect(h.execs.filter((e) => e.cmd.startsWith('chmod'))).toHaveLength(1);
  });

  it('passes the VNC flag through as an env var', async () => {
    const off = harness();
    await off.run({ vnc: false });
    expect(off.execs.at(-1)?.opts?.env?.AGENTBOX_SPRITES_VNC).toBe('0');

    vi.resetModules();
    const on = harness();
    await on.run({ vnc: true });
    expect(on.execs.at(-1)?.opts?.env?.AGENTBOX_SPRITES_VNC).toBe('1');
  });

  // A retry would race a still-running apt from the abandoned attempt and
  // deadlock on the dpkg lock.
  it('never retries the installer exec', async () => {
    const h = harness();
    await h.run();
    expect(h.execs.at(-1)?.opts?.noRetry).toBe(true);
  });

  it('surfaces the installer step markers so a hang is localizable', async () => {
    const h = harness();
    await h.run({
      stdout: '>>> BEGIN docker\nsome noise\n<<< END docker\nmore noise\n',
    });
    expect(h.logs.some((l) => l.includes('>>> BEGIN docker'))).toBe(true);
    expect(h.logs.some((l) => l.includes('<<< END docker'))).toBe(true);
    expect(h.logs.some((l) => l.includes('some noise'))).toBe(false);
  });

  it('throws with the tail of the output when the installer fails', async () => {
    const h = harness();
    await expect(
      h.run({ exitCode: 71, stdout: 'line1\nline2\nfatal: claude installer 403' }),
    ).rejects.toThrow(/base install failed \(exit 71\)[\s\S]*claude installer 403/);
  });
});
