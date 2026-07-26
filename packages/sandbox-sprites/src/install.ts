/**
 * The per-box base install: upload the runtime assets, then run
 * `install-sprite-base.sh` inside the sprite.
 *
 * Every other provider does this once, at `agentbox prepare`, and bakes the
 * result into an image. Sprites has no reusable image and no fork-from-template
 * (yet), so it runs on every create — see backend.ts's header and
 * docs/sprites-backlog.md.
 *
 * Factored out of `backend.provision` for two reasons: it keeps the backend a
 * readable mapping table, and it's the seam the deferred warm-pool work
 * replaces (a pooled sprite has already run this, so `claim()` skips straight
 * past it).
 *
 * Takes `exec`/`upload` as parameters rather than importing the backend so the
 * unit test can drive it with fakes and assert the ordering + flags without a
 * network.
 */

import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';
import type { CloudExecOptions, CloudExecResult } from '@agentbox/core';

export interface InstallSpriteBaseArgs {
  exec: (cmd: string, opts?: CloudExecOptions) => Promise<CloudExecResult>;
  upload: (localPath: string, remotePath: string) => Promise<void>;
  onLog: (line: string) => void;
  /** Install the VNC + Chromium stack (~45s). See the installer's header. */
  vnc: boolean;
  /** Per-attempt cap for the install exec. */
  timeoutMs: number;
  /** `native` (default) or `npm`, only consulted if the base image lacks claude. */
  claudeInstall?: 'native' | 'npm';
}

export async function installSpriteBase(args: InstallSpriteBaseArgs): Promise<void> {
  const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
  args.onLog(`sprites: uploading ${String(assets.length)} runtime assets`);
  for (const asset of assets) {
    await args.upload(asset.localPath, asset.remotePath);
  }

  // The SDK's filesystem write doesn't preserve mode, and the installer must be
  // executable. chmod everything in one call rather than per-asset round-trips.
  const chmods = assets
    .map((a) => `chmod ${a.remoteMode.toString(8).padStart(4, '0')} ${shq(a.remotePath)}`)
    .join(' && ');
  // Explicitly root: `backend.exec` defaults to `vscode` (what the shared sync
  // layer assumes), but THIS script is what creates that user — so until it has
  // run, `sudo -u vscode` fails with "unknown user vscode".
  const chmodRes = await args.exec(chmods, { user: 'root', attemptTimeoutMs: 60_000 });
  if (chmodRes.exitCode !== 0) {
    throw new Error(
      `sprites: could not set modes on the uploaded runtime assets: ${
        chmodRes.stderr || chmodRes.stdout
      }`,
    );
  }

  args.onLog(
    'sprites: running the base install (Sprites has no reusable image, so this runs per box)',
  );
  const env: Record<string, string> = {
    AGENTBOX_SPRITES_VNC: args.vnc ? '1' : '0',
    AGENTBOX_CLAUDE_INSTALL: args.claudeInstall ?? 'native',
  };
  // noRetry: the installer is idempotent step-by-step but a retry that races a
  // still-running apt from an abandoned attempt would deadlock on the dpkg
  // lock. One shot, generous timeout, loud failure.
  const res = await args.exec('bash /tmp/agentbox-install-sprite-base.sh', {
    // Root for the same reason as the chmod above, and because the installer
    // does root work throughout (useradd, apt, install into /usr/local/bin).
    user: 'root',
    env,
    attemptTimeoutMs: args.timeoutMs,
    noRetry: true,
  });
  // The installer's own BEGIN/END markers are the progress signal; surface them
  // so ~/.agentbox/logs/create.log localizes a hang to a single step.
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('>>> BEGIN ') || line.startsWith('<<< END ')) args.onLog(`  ${line}`);
  }
  if (res.exitCode !== 0) {
    const tail = (res.stderr || res.stdout).trim().split('\n').slice(-15).join('\n');
    throw new Error(
      `sprites: base install failed (exit ${String(res.exitCode)}):\n${tail}`,
    );
  }
  args.onLog('sprites: base install complete');
}

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
