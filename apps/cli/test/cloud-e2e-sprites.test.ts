/**
 * Fly.io Sprites end-to-end smoke test. Real sprite lifecycle gated on
 * `SPRITES_TOKEN` + `SPRITES_ORG`. Skipped silently when the env isn't
 * configured — CI without the secrets sees nothing; a developer with
 * `~/.agentbox/secrets.env` exported can run
 * `pnpm --filter @madarco/agentbox test cloud-e2e-sprites` and exercise the
 * full provision → shell → pause → destroy path.
 *
 * Cost: ~3 minutes of wall time, one sprite. Sprites has no reusable base
 * image, so the ~2-minute runtime install runs inside this box rather than
 * having been baked by `prepare` — that IS the thing under test here.
 *
 * `--no-vnc` shaves ~45s off that install and is the flag a cost-conscious
 * user would reach for, so the smoke exercises it.
 *
 * Cleanup: `afterAll` always runs `destroy`. If a kill -9 prevents that, reap
 * the orphan with `sprite list` + `sprite destroy <name>`, and check for a
 * stray `sprite proxy` process (the host-side bridge tunnel) with
 * `ps aux | grep 'sprite proxy'`.
 */

import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

const hasCreds = !!process.env['SPRITES_TOKEN'] && !!process.env['SPRITES_ORG'];

describe.skipIf(!hasCreds)('sprites e2e (SPRITES_TOKEN)', () => {
  const cliEntry = require.resolve('../dist/index.js');
  const boxName = `e2e-spr-${Math.random().toString(36).slice(2, 8)}`;
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agentbox-e2e-sprites-'));
    // Initialize a tiny git repo so seedCloudWorkspace has a bundle to ship.
    await execa('git', ['init', '-q'], { cwd: workspace });
    await execa(
      'git',
      ['-c', 'user.email=ci@agentbox', '-c', 'user.name=ci', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: workspace },
    );
  }, 30_000);

  afterAll(async () => {
    if (workspace) {
      // Best-effort destroy; ignore non-zero exits (the test may have failed
      // before recording state).
      await execa('node', [cliEntry, 'destroy', boxName, '-y'], { reject: false }).catch(() => {
        /* ignore */
      });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it(
    'create → shell → url → pause → destroy round-trip',
    async () => {
      const create = await execa(
        'node',
        [cliEntry, 'create', '--provider', 'sprites', '-y', '-n', boxName, '--no-vnc'],
        {
          cwd: workspace,
          reject: false,
          timeout: 900_000,
          // The workspace has no agentbox.yaml, but a host-level carry: block
          // would still block on approval with no TTY.
          env: { ...process.env, AGENTBOX_CARRY: 'skip' },
        },
      );
      expect(create.exitCode, `create stderr: ${create.stderr}`).toBe(0);

      // Exec — proves the `sudo -u vscode` wrap and that the base install
      // actually produced a working box.
      const shell = await execa(
        'node',
        [cliEntry, 'shell', boxName, '--', 'echo', 'agentbox-e2e-ping'],
        { cwd: workspace, reject: false, timeout: 120_000 },
      );
      expect(shell.exitCode, `shell stderr: ${shell.stderr}`).toBe(0);
      expect(shell.stdout).toMatch(/agentbox-e2e-ping/);

      // The box user, not Fly's platform account, and in that user's home —
      // `sprite exec` starts in /home/sprite and `sudo -H` doesn't cd.
      const whoami = await execa(
        'node',
        [cliEntry, 'shell', boxName, '--', 'sh', '-c', 'id -un; pwd'],
        { cwd: workspace, reject: false, timeout: 120_000 },
      );
      expect(whoami.stdout).toContain('vscode');
      expect(whoami.stdout).toContain('/home/vscode');

      // The workspace actually landed, on the per-box branch.
      const branch = await execa(
        'node',
        [cliEntry, 'shell', boxName, '--', 'sh', '-c', 'cd /workspace && git rev-parse --abbrev-ref HEAD'],
        { cwd: workspace, reject: false, timeout: 120_000 },
      );
      expect(branch.stdout).toContain(`agentbox/${boxName}`);

      // Status — exercises provider.probeState.
      const status = await execa('node', [cliEntry, 'status', boxName], {
        cwd: workspace,
        reject: false,
        timeout: 60_000,
      });
      expect(status.exitCode).toBe(0);

      // Pause IS the tunnel teardown on this provider: Sprites has no stop API,
      // and the host's `sprite proxy` forwards are the only thing keeping an
      // idle sprite awake. So a pause that leaves them running is a pause that
      // silently keeps billing.
      const tunnelDir = resolve(homedir(), '.agentbox', 'sprites', 'boxes');
      const pause = await execa('node', [cliEntry, 'pause', boxName], {
        cwd: workspace,
        reject: false,
        timeout: 180_000,
      });
      expect(pause.exitCode, `pause stderr: ${pause.stderr}`).toBe(0);
      expect(existsSync(join(tunnelDir, boxName))).toBe(false);

      const destroy = await execa('node', [cliEntry, 'destroy', boxName, '-y'], {
        cwd: workspace,
        reject: false,
        timeout: 180_000,
      });
      expect(destroy.exitCode, `destroy stderr: ${destroy.stderr}`).toBe(0);
      // Nothing left behind on the host either.
      expect(existsSync(join(tunnelDir, boxName))).toBe(false);
    },
    1_200_000, // 20-minute budget — the runtime install runs per box (~2 min).
  );
});
