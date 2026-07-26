/**
 * Host-side port forwards into a sprite, via detached `sprite proxy` children.
 *
 * Why this exists: a sprite's public URL (`https://<name>-<org>.sprites.app`)
 * reaches exactly one in-sprite port — 8080, fixed. Verified live 2026-07-26:
 * with listeners on both 8080 and 8788, the URL served 8080; killing the 8080
 * listener made it 502 rather than fall through. The `sprite proxy --help`
 * text says the same in words ("HTTP-only and limited to one port").
 *
 * AgentBox needs more than one: 8080 for the in-box WebProxy (user services),
 * 8788 for the relay bridge the host `CloudBoxPoller` long-polls, 6080 for
 * noVNC. So the backend splits them — the WebProxy port keeps the public URL
 * (browser-reachable, org-authed, wakes a sleeping sprite on demand), and every
 * other port gets a loopback forward from here.
 *
 * This is the same shape Hetzner/DigitalOcean use with `ssh -L`, minus the
 * ControlMaster: `sprite proxy` is already one long-lived process per mapping.
 * Detached + unref'd so it outlives the short-lived CLI process that minted it
 * (create runs in `agentbox create`, but the relay polls for hours afterwards).
 *
 * BILLING, and why `pause()` calls `closeAll` here: an open proxy holds a
 * WebSocket to the sprite, which is traffic, which keeps it awake. Sprites has
 * no API to force sleep — dropping the tunnels IS the pause. See
 * `CloudBackend.timeoutModel` and docs/sprites-backlog.md.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pickFreePort } from '@agentbox/sandbox-core';
import { requireSpriteCli, spriteCliEnv, spriteSelector } from './sprite-cli.js';

/** How long to wait for a freshly-spawned proxy to start accepting connections. */
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 200;
/** Per-probe TCP connect timeout when checking whether a forward is alive. */
const PROBE_TIMEOUT_MS = 1500;

interface ProxyRecord {
  pid: number;
  localPort: number;
  remotePort: number;
  startedAt: string;
}

/** `~/.agentbox/sprites/boxes/<sprite-name>/` — one dir per sprite. */
export function boxProxyDir(spriteName: string): string {
  const safe = spriteName.replace(/[^A-Za-z0-9._-]/g, '_');
  return resolve(homedir(), '.agentbox', 'sprites', 'boxes', safe);
}

function recordPath(spriteName: string, remotePort: number): string {
  return resolve(boxProxyDir(spriteName), `proxy-${String(remotePort)}.json`);
}

function readRecord(spriteName: string, remotePort: number): ProxyRecord | undefined {
  const path = recordPath(spriteName, remotePort);
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Partial<ProxyRecord>;
    if (typeof r.pid !== 'number' || typeof r.localPort !== 'number') return undefined;
    return {
      pid: r.pid,
      localPort: r.localPort,
      remotePort: r.remotePort ?? remotePort,
      startedAt: r.startedAt ?? '',
    };
  } catch {
    return undefined;
  }
}

function writeRecord(spriteName: string, rec: ProxyRecord): void {
  mkdirSync(boxProxyDir(spriteName), { recursive: true });
  writeFileSync(recordPath(spriteName, rec.remotePort), JSON.stringify(rec, null, 2), {
    mode: 0o600,
  });
}

function dropRecord(spriteName: string, remotePort: number): void {
  rmSync(recordPath(spriteName, remotePort), { force: true });
}

/** True when a process with this pid exists and we may signal it. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still "alive".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when something accepts a TCP connection on `127.0.0.1:port`. */
export async function portAccepts(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host: '127.0.0.1', port });
    const finish = (ok: boolean): void => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      finish(true);
    });
    sock.once('timeout', () => {
      finish(false);
    });
    sock.once('error', () => {
      finish(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Get (or create) a loopback forward to `remotePort` inside `spriteName`, and
 * return the host-side port. Reuses a live forward; a recorded-but-dead one is
 * cleaned up and replaced.
 */
export async function forward(spriteName: string, remotePort: number): Promise<number> {
  const existing = readRecord(spriteName, remotePort);
  if (existing && pidAlive(existing.pid) && (await portAccepts(existing.localPort))) {
    return existing.localPort;
  }
  if (existing) await close(spriteName, remotePort);
  return open(spriteName, remotePort);
}

/** Tear down and immediately re-open the forward. Used by `refreshPreviewUrl`. */
export async function refresh(spriteName: string, remotePort: number): Promise<number> {
  await close(spriteName, remotePort);
  return open(spriteName, remotePort);
}

async function open(spriteName: string, remotePort: number): Promise<number> {
  const bin = requireSpriteCli();
  const localPort = await pickFreePort();
  const child = spawn(
    bin,
    ['proxy', ...spriteSelector(spriteName), `${String(localPort)}:${String(remotePort)}`],
    {
      detached: true,
      // The proxy must outlive `agentbox create`; nothing reads its output, and
      // an inherited pipe would keep the parent's event loop alive.
      stdio: 'ignore',
      env: spriteCliEnv(),
    },
  );
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`sprites: could not spawn \`sprite proxy\` for ${spriteName}:${String(remotePort)}`);
  }
  writeRecord(spriteName, {
    pid,
    localPort,
    remotePort,
    startedAt: new Date().toISOString(),
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portAccepts(localPort)) return localPort;
    if (!pidAlive(pid)) break;
    await sleep(READY_POLL_MS);
  }
  await close(spriteName, remotePort);
  throw new Error(
    `sprites: \`sprite proxy\` for ${spriteName}:${String(remotePort)} did not start listening ` +
      `on 127.0.0.1:${String(localPort)} within ${String(READY_TIMEOUT_MS / 1000)}s`,
  );
}

/** Kill the forward for one port. Idempotent. */
export async function close(spriteName: string, remotePort: number): Promise<void> {
  const rec = readRecord(spriteName, remotePort);
  dropRecord(spriteName, remotePort);
  if (!rec) return;
  // Detached children are process-group leaders, so signal the group to catch
  // anything `sprite proxy` spawned.
  for (const target of [-rec.pid, rec.pid]) {
    try {
      process.kill(target, 'SIGTERM');
      break;
    } catch {
      // already gone, or not ours — try the next form
    }
  }
}

/**
 * Kill every forward for a sprite. Called by `pause`/`stop` (an open proxy is
 * traffic that keeps the sprite awake) and by `destroy`.
 */
export async function closeAll(spriteName: string): Promise<void> {
  const dir = boxProxyDir(spriteName);
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const m = /^proxy-(\d+)\.json$/.exec(name);
    if (!m) continue;
    await close(spriteName, Number.parseInt(m[1]!, 10));
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Ports currently recorded as forwarded for a sprite. Used by tests + doctor. */
export function listForwards(spriteName: string): ProxyRecord[] {
  const dir = boxProxyDir(spriteName);
  if (!existsSync(dir)) return [];
  const out: ProxyRecord[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const m = /^proxy-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const rec = readRecord(spriteName, Number.parseInt(m[1]!, 10));
    if (rec) out.push(rec);
  }
  return out;
}
