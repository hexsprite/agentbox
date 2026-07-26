import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadEffectiveConfig } from '@agentbox/config';
import {
  syncAgentboxSshConfig,
  controlPlaneDeployPath,
  type ControlPlaneDeployRecord,
  type HubDeploySource,
} from '@agentbox/sandbox-core';
import { deployControlPlaneToHetzner, readHetznerCredStatus } from '@agentbox/sandbox-hetzner';

/**
 * CLI wrapper for the Hetzner control-plane deploy: precheck the token, run the
 * provisioning in `@agentbox/sandbox-hetzner`, and persist the deploy record so
 * a later command (or the user) can find / tear down the VPS.
 */
export interface HetznerDeployOptions {
  /** Path to the setup-written control-plane.env (scp'd to the VPS as `.env`). */
  envPath: string;
  /** Where the VPS gets the hub from — the npm package, or a cloned ref. */
  source: HubDeploySource;
  log: (line: string) => void;
  /**
   * Fired once the VPS exists, before the build + healthz poll. Lets the caller
   * report how to reach the machine when a later step fails — the server is not
   * torn down, so it is inspectable (and billable) either way.
   */
  onProvisioned?: (info: ControlPlaneDeployRecord) => void;
}

/**
 * Write `~/.agentbox/control-plane/deploy.json` and refresh the managed SSH
 * config so `ssh agentbox-hub` reaches the control box.
 *
 * Called BEFORE the build/healthz steps as well as after success: a deploy that
 * dies at `docker compose up` or on a 502 is exactly the case where the user
 * needs to get into the VPS, and it used to leave no trace of how.
 */
async function persistDeployRecord(record: ControlPlaneDeployRecord): Promise<void> {
  const deployPath = controlPlaneDeployPath();
  await mkdir(dirname(deployPath), { recursive: true });
  await writeFile(deployPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try {
    // Same opt-out as the per-box entries: a user who hand-maintains
    // `~/.ssh/config` gets the record on disk but no managed Host block.
    const cfg = await loadEffectiveConfig(homedir());
    if (cfg.effective.ssh.autoConfig) await syncAgentboxSshConfig();
  } catch {
    // Best-effort — the ssh alias is a convenience; the record above is what matters.
  }
}

export async function runHetznerDeploy(opts: HetznerDeployOptions): Promise<{ url: string }> {
  if (readHetznerCredStatus().source === 'none') {
    throw new Error('no HCLOUD_TOKEN configured — run `agentbox hetzner login` first');
  }
  const envContent = await readFile(opts.envPath, 'utf8');
  const result = await deployControlPlaneToHetzner({
    envContent,
    source: opts.source,
    onLog: opts.log,
    onProvisioned: async (info) => {
      const record: ControlPlaneDeployRecord = {
        provider: 'hetzner',
        source: opts.source,
        ...info,
      };
      opts.onProvisioned?.(record);
      await persistDeployRecord(record);
    },
  });
  await persistDeployRecord({ provider: 'hetzner', source: opts.source, ...result });
  return { url: result.url };
}

/** Human-readable recovery steps for a deploy that provisioned but never went healthy. */
export function recoveryHint(record: ControlPlaneDeployRecord): string[] {
  const key = record.sshKeyDir ? join(record.sshKeyDir, 'id_ed25519') : undefined;
  // Must match the `-f` list the deploy used: compose keys the project off it, so
  // a pasted command with the wrong list reports "no such service".
  const files = [
    '-f docker-compose.yml',
    ...(record.source?.kind === 'package' ? ['-f docker-compose.package.yml'] : []),
    '-f docker-compose.caddy.yml',
  ].join(' ');
  return [
    `The VPS is still running (server ${String(record.serverId ?? '?')}, ${record.ip ?? '?'}) — inspect it:`,
    `  ssh agentbox-hub`,
    ...(key ? [`  (or: ssh -i ${key} root@${record.ip ?? '?'})`] : []),
    `  cd /opt/agentbox/apps/hub && docker compose ${files} logs --tail=200 app`,
    `SSH is firewalled to this machine's egress IP, so run it from here.`,
    `Retry the deploy with \`agentbox hub deploy hetzner\` (reuses the same GitHub App).`,
  ];
}
