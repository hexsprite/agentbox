/**
 * Fly.io Sprites `CloudBackend` — maps the provider-neutral cloud primitives
 * onto the `@fly/sprites` SDK. Composed into a full `Provider` by
 * `@agentbox/sandbox-cloud`'s `createCloudProvider`.
 *
 * Platform shape this backend is built around, all verified against a live
 * sprite on 2026-07-26:
 *
 *   - **No reusable base image.** `CreateSprite` takes a name, a size, env,
 *     labels and URL settings — no image, no rootfs, no create-from-checkpoint.
 *     Checkpoints are per-sprite rollback, not id-addressed artifacts. So
 *     `provision` installs the AgentBox runtime inline on every create rather
 *     than booting a baked image. That's affordable only because Fly's base is
 *     already an agent image (Ubuntu 26.04, Node 24, bun, git, tmux, gh, plus
 *     claude and codex pre-installed): the install lands around two minutes.
 *     Fly has fork-from-sprite working internally with no public endpoint yet;
 *     when it ships this collapses to one call. See docs/sprites-backlog.md.
 *
 *   - **One public port.** `https://<name>-<org>.sprites.app` reaches in-sprite
 *     port 8080 and nothing else (killing the 8080 listener 502s the URL rather
 *     than falling through). AgentBox also needs 8788 for the relay bridge and
 *     6080 for noVNC, so `previewUrl` splits: the WebProxy port gets the public
 *     URL, everything else gets a loopback forward from a detached
 *     `sprite proxy` (see sprite-proxy.ts) — the Hetzner `ssh -L` shape.
 *
 *   - **No stop/pause/sleep API.** Sprites sleep on idle by themselves and wake
 *     on any request; the SDK has no way to force it. So `pause`/`stop` drop
 *     the host's tunnels, which is the only thing keeping the sprite awake, and
 *     let idle detection do the rest. `timeoutModel: 'inactivity'` makes the
 *     relay keepalive loop drive that. Processes DO survive the sleep (verified:
 *     listeners still bound after the sprite went `cold`), so the ctl daemon and
 *     tmux sessions come back untouched.
 *
 *   - **No `user` on exec.** `SpawnOptions` has cwd/env/tty/detachable/… but no
 *     user, and `sprite exec` runs as the platform's `sprite` account. Every
 *     command is therefore wrapped in `sudo`, defaulting to root — the same
 *     model as hetzner/digitalocean/daytona, which keeps this backend clear of
 *     the `vercel`/`e2b` carve-outs in the cloud scaffold's carry + resync paths.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@agentbox/core';
import type { Sprite } from './sdk.js';
import { spritesClient } from './sdk.js';
import { withSpritesRetry } from './retry.js';
import { installSpriteBase } from './install.js';
import * as tunnel from './sprite-proxy.js';

/**
 * Sentinel image ref the cloud-provider hands us when no `--image` was passed.
 * Sprites has no image concept at all; the field exists only to satisfy the
 * shared request shape.
 */
export const DEFAULT_BOX_IMAGE_REF = 'agentbox/box:dev';

/** Label every AgentBox sprite carries, so `list()` can ignore foreign ones. */
export const AGENTBOX_LABEL = 'agentbox';

/** Box user AgentBox standardizes on; created by install-sprite-base.sh. */
const BOX_OWNER = 'vscode:vscode';

/**
 * The single port Sprites' HTTP ingress routes the public URL to. Not
 * configurable, and not discovered — hard-wired by the platform.
 */
const SPRITES_INGRESS_PORT = 8080;

/** Defaults when neither `--size` nor config supplies one. */
const DEFAULT_CPUS = 2;
const DEFAULT_RAM_GB = 4;
const DEFAULT_STORAGE_GB = 20;

/** Per-attempt cap for the inline base install. It's the long pole of create. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Single-quote a string for safe embedding inside a `bash -lc '<…>'`. */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Sprite names land in a hostname (`<name>-<org>.sprites.app`), so they must be
 * DNS-label safe. Box names are already conservative, but coerce defensively.
 */
export function safeSpriteName(name: string): string {
  const coerced = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return coerced.length > 0 ? coerced : 'agentbox-box';
}

/**
 * Parse `CloudProvisionRequest.size` as `cpu-memoryGB[-diskGB]` (the daytona
 * spelling, e.g. `4-8-40`). Returns undefined for anything else so a foreign
 * `box.size` (a hetzner server type, say) falls back to the defaults instead of
 * provisioning something absurd.
 */
export function parseSpritesSize(
  size: string | undefined,
): { cpus: number; ramMB: number; storageGB?: number } | undefined {
  if (!size) return undefined;
  const m = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(size.trim());
  if (!m) return undefined;
  const cpus = Number.parseInt(m[1]!, 10);
  const memGb = Number.parseInt(m[2]!, 10);
  if (cpus <= 0 || memGb <= 0) return undefined;
  const diskGb = m[3] !== undefined ? Number.parseInt(m[3], 10) : undefined;
  return {
    cpus,
    ramMB: memGb * 1024,
    ...(diskGb !== undefined && diskGb > 0 ? { storageGB: diskGb } : {}),
  };
}

/**
 * Map a Sprites status string onto our four-value `CloudState`.
 *
 * The vocabulary (`running` / `warm` / `cold`) is derived from the live API —
 * `GET /v1/sprites` returns per-status counters with exactly those names, and a
 * sprite observed to transition running → warm → cold while idle. Pinned in
 * test/backend-mapping.test.ts.
 *
 *   - `running` — executing right now.
 *   - `warm`    — up and instantly usable, just not busy. Running, for us.
 *   - `cold`    — asleep. Processes and filesystem are preserved and any API
 *                 call wakes it, which is exactly AgentBox's `paused`.
 *
 * An UNRECOGNISED status maps to `running`, not `missing`: we only got here by
 * successfully fetching the sprite, so it demonstrably exists, and reporting
 * `missing` would invite callers to treat a live box as gone. `missing` is
 * reserved for a 404 from the lookup itself.
 */
export function mapState(s: string | undefined): CloudState {
  switch (s) {
    case 'running':
    case 'warm':
      return 'running';
    case 'cold':
      return 'paused';
    case undefined:
      return 'missing';
    default:
      return 'running';
  }
}

/** True when the error means "sprite doesn't exist" (404). */
export function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status =
    (err as { statusCode?: unknown }).statusCode ?? (err as { status?: unknown }).status;
  if (status === 404) return true;
  const msg = err instanceof Error ? err.message : '';
  return /\b404\b|not[ _-]?found/i.test(msg);
}

/**
 * Public URLs, memoized per sprite. The hostname carries a server-assigned org
 * suffix (`agentbox-smoke-is44.sprites.app`) that isn't derivable from the org
 * slug, so unlike e2b we can't build it locally — but it IS stable for the life
 * of the sprite, so one lookup is enough.
 */
const urlCache = new Map<string, string>();

async function spriteUrl(name: string): Promise<string> {
  const hit = urlCache.get(name);
  if (hit) return hit;
  const sp = await getSprite(name);
  if (!sp?.url) {
    throw new Error(
      `sprites: sprite ${name} has no public URL yet — it may still be provisioning`,
    );
  }
  urlCache.set(name, sp.url);
  return sp.url;
}

async function getSprite(name: string): Promise<Sprite | null> {
  return withSpritesRetry({ method: 'getSprite', retryOnAmbiguous: true }, async () => {
    try {
      return await spritesClient().getSprite(name);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  });
}

/**
 * Compose the command Sprites actually runs. `sprite exec` has no `user`
 * option and lands as the platform's unprivileged `sprite` account, so every
 * call goes through sudo: to root by default (matching hetzner/digitalocean),
 * or dropping to a named user when the caller asks.
 *
 * `-H` sets HOME for the target user, which the agent tooling depends on.
 * Exported for the unit test that pins the quoting.
 */
export function buildExecArgv(cmd: string, opts?: CloudExecOptions): string[] {
  const prelude: string[] = [];
  if (opts?.cwd) {
    prelude.push(`cd ${shq(opts.cwd)}`);
  } else {
    // `sprite exec` starts in the PLATFORM user's home (/home/sprite), and
    // `sudo -H` sets HOME for the target user without changing directory — so
    // without this, a relative path from `agentbox shell <box> -- <cmd>` would
    // resolve inside Fly's account rather than the box user's. Every SSH-shaped
    // provider lands in the login user's home; match that. Tolerant of a
    // missing/unwritable HOME so it can never fail the command outright.
    prelude.push('cd "$HOME" 2>/dev/null || true');
  }
  for (const [k, v] of Object.entries(opts?.env ?? {})) {
    // The value is shell-quoted, but the key is interpolated bare into a
    // `bash -lc` string that runs as root — reject anything that isn't a POSIX
    // env-var name so a key like `x;rm -rf /` can't inject a command.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`sprites exec: invalid env var name ${JSON.stringify(k)}`);
    }
    prelude.push(`export ${k}=${shq(v)}`);
  }
  const inner = [...prelude, cmd].join('\n');
  const user = opts?.user ?? 'root';
  if (user === 'root') return ['-n', '-H', 'bash', '-lc', inner];
  return ['-n', '-H', '-u', user, 'bash', '-lc', inner];
}

/** The SDK's `ExecResult`, whose stdout/stderr are `string | Buffer`. */
interface SdkExecResult {
  exitCode: number;
  stdout: string | Buffer;
  stderr: string | Buffer;
}

function isExecResultLike(v: unknown): v is SdkExecResult {
  return Boolean(v) && typeof v === 'object' && typeof (v as SdkExecResult).exitCode === 'number';
}

function toExecResult(r: SdkExecResult): CloudExecResult {
  return {
    exitCode: r.exitCode,
    stdout: typeof r.stdout === 'string' ? r.stdout : (r.stdout?.toString('utf8') ?? ''),
    stderr: typeof r.stderr === 'string' ? r.stderr : (r.stderr?.toString('utf8') ?? ''),
  };
}

async function execOnSprite(
  name: string,
  cmd: string,
  opts?: CloudExecOptions,
): Promise<CloudExecResult> {
  const timeoutMs = opts?.attemptTimeoutMs ?? 300_000;
  return withSpritesRetry(
    {
      method: 'exec',
      retryOnAmbiguous: opts?.noRetry ? false : true,
      attemptTimeoutMs: timeoutMs,
      backoffMs: opts?.noRetry ? [] : undefined,
    },
    async () => {
      const sp = spritesClient().sprite(name);
      try {
        // execFileHTTP is the plain-HTTP path: one request, no WebSocket. It
        // avoids the SDK's `control.js` / WebSocket-global code entirely (the
        // only reason its package.json claims engines.node>=24) and needs no
        // stream teardown. Output is coalesced, which is fine — AgentBox's execs
        // are control-plane commands, not log firehoses.
        const r = await sp.execFileHTTP('sudo', buildExecArgv(cmd, opts), {
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        });
        return toExecResult(r);
      } catch (err) {
        // The SDK THROWS an ExecError on any non-zero exit, carrying the full
        // result on `.result`. Every `CloudBackend.exec` caller branches on
        // `exitCode` instead (that's the contract vercel/daytona/hetzner
        // implement), so map it back — otherwise a routine `test -x` probe
        // becomes an unhandled error that aborts create. Same fix e2b needed
        // for its CommandExitError.
        const result = (err as { result?: unknown }).result;
        if (isExecResultLike(result)) return toExecResult(result);
        throw err;
      }
    },
  );
}

export const spritesBackend: CloudBackend = {
  name: 'sprites',

  // Fixed by the platform, not a choice: the sprite's public URL routes here.
  // Wired to the in-box ctl as AGENTBOX_WEB_PROXY_PORT by buildBootstrapEnv so
  // the WebProxy binds the same port.
  webProxyPort: SPRITES_INGRESS_PORT,

  // A sprite's idle clock is reset by ANY request, and the host relay polls the
  // bridge continuously — so an idle box would never sleep on its own. The
  // keepalive loop stands in: it pauses the box (which drops our tunnels) after
  // a full idle window. See CloudBackend.timeoutModel.
  timeoutModel: 'inactivity',

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const log = req.onLog ?? ((): void => {});
    const name = safeSpriteName(req.name);
    const sized = parseSpritesSize(req.size);
    const cpus = sized?.cpus ?? req.resources?.cpu ?? DEFAULT_CPUS;
    const ramMB = sized?.ramMB ?? (req.resources?.memory ?? DEFAULT_RAM_GB) * 1024;
    const storageGB = sized?.storageGB ?? req.resources?.disk ?? DEFAULT_STORAGE_GB;

    if (req.snapshot !== undefined) {
      // Reachable only if a cloud-checkpoint manifest for this provider exists,
      // which nothing writes today (the provider ships no createSnapshot). Fail
      // loudly rather than silently ignore what the user asked to boot from.
      throw new Error(
        'sprites: booting from a checkpoint is not supported — Sprites checkpoints roll a ' +
          'single sprite back in place rather than producing a reusable image. ' +
          'Remove the checkpoint or use a provider with snapshot support.',
      );
    }

    // No retry: createSprite is billable and non-idempotent — a timeout after
    // the request reached the origin could leave a duplicate sprite we can't
    // reference for cleanup. (The rate-limit rejection path IS retriable, but
    // that's a rejection, so nothing was created; withSpritesRetry can't tell
    // the two apart here, so we take the conservative branch.)
    const sprite = await withSpritesRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 300_000, backoffMs: [] },
      async () =>
        spritesClient().createSprite(name, {
          config: {
            cpus,
            ramMB,
            storageGB,
            ...(req.location ? { region: req.location } : {}),
          },
          ...(req.env ? { environment: req.env } : {}),
          labels: [AGENTBOX_LABEL],
          urlSettings: { auth: 'sprite' },
          // Queue behind capacity rather than failing the create outright.
          waitForCapacity: true,
        }),
    );
    if (sprite.url) urlCache.set(name, sprite.url);
    log(`sprites: created sprite ${name} (${String(cpus)} vCPU / ${String(ramMB)}MB / ${String(storageGB)}GB)`);

    // The install that other providers bake once at `prepare`. Streams its
    // BEGIN/END step markers into the create log so a hang is localizable.
    await installSpriteBase({
      exec: (cmd, opts) => execOnSprite(name, cmd, opts),
      upload: (local, remote) => uploadToSprite(name, local, remote),
      onLog: log,
      vnc: req.vnc === true,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });

    return {
      sandboxId: name,
      resources: { cpu: cpus, memory: Math.round(ramMB / 1024), disk: storageGB },
    };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    const sp = await getSprite(sandboxId);
    return sp ? { sandboxId } : null;
  },

  async list(): Promise<CloudSandboxSummary[]> {
    return withSpritesRetry({ method: 'list', retryOnAmbiguous: true }, async () => {
      // listAllSprites walks the continuation tokens for us.
      const sprites = await spritesClient().listAllSprites();
      const out: CloudSandboxSummary[] = [];
      for (const sp of sprites) {
        if (!sp.labels.includes(AGENTBOX_LABEL)) continue;
        const summary: CloudSandboxSummary = { sandboxId: sp.name, name: sp.name };
        const st = mapState(sp.status);
        summary.state = st;
        if (sp.createdAt instanceof Date) summary.createdAt = sp.createdAt.toISOString();
        out.push(summary);
      }
      return out;
    });
  },

  // `checkSprite` is the cheapest call that wakes a sleeping sprite — it's a
  // health probe, and any request against a cold sprite resumes it. There is no
  // explicit start/resume API because there is no explicit stop.
  async start(h: CloudHandle): Promise<void> {
    await withSpritesRetry(
      { method: 'start', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        await spritesClient().checkSprite(h.sandboxId);
      },
    );
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  /**
   * Sprites has no stop/pause/sleep API — sleep is implicit on idle. What keeps
   * a sprite awake is traffic, and the traffic AgentBox generates is the host
   * relay long-polling the bridge through our `sprite proxy` tunnels. Dropping
   * those tunnels is therefore the entire pause: with nothing talking to it the
   * sprite goes `cold` on its own, and its processes and filesystem survive
   * (verified). The relay stops its own poller in the same breath — see
   * `RelayServerHandle.stopCloudPoller`.
   */
  async pause(h: CloudHandle): Promise<void> {
    await tunnel.closeAll(h.sandboxId);
  },

  async stop(h: CloudHandle): Promise<void> {
    await this.pause(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    await tunnel.closeAll(h.sandboxId);
    urlCache.delete(h.sandboxId);
    await withSpritesRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        try {
          await spritesClient().deleteSprite(h.sandboxId);
        } catch (err) {
          if (isNotFound(err)) return; // idempotent
          throw err;
        }
      },
    );
  },

  async state(h: CloudHandle): Promise<CloudState> {
    const sp = await getSprite(h.sandboxId);
    if (!sp) return 'missing';
    return mapState(sp.status);
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    return execOnSprite(h.sandboxId, cmd, opts);
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    await uploadToSprite(h.sandboxId, localPath, remotePath);
    await chownUploaded(h.sandboxId, [remotePath]);
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    await withSpritesRetry(
      { method: 'downloadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const fs = spritesClient().sprite(h.sandboxId).filesystem('/');
        const bytes = await fs.readFile(remotePath, null);
        await writeFile(localPath, bytes);
      },
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    return withSpritesRetry({ method: 'listFiles', retryOnAmbiguous: true }, async () => {
      const fs = spritesClient().sprite(h.sandboxId).filesystem('/');
      const entries = await fs.readdir(remoteDir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    });
  },

  /**
   * The WebProxy port gets the sprite's public HTTPS URL — browser-reachable,
   * org-authenticated, and it wakes a sleeping sprite on demand. Every other
   * port gets a loopback forward, because the public URL reaches exactly one
   * in-sprite port and that port is 8080. See sprite-proxy.ts.
   */
  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    if (port === SPRITES_INGRESS_PORT) {
      return { url: await spriteUrl(h.sandboxId) };
    }
    const localPort = await tunnel.forward(h.sandboxId, port);
    // Plain loopback URL — the forward is already auth-gated by the CLI's own
    // credentials. The cloud-provider layer adds the Portless alias.
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  /**
   * Tear down the (likely dead) forward and re-open it. Called by the host
   * poller after ECONNREFUSED on the local port — e.g. the detached
   * `sprite proxy` died with a host sleep/wake or a network blip. The public
   * URL never needs this, so that branch is a plain re-read.
   */
  async refreshPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    if (port === SPRITES_INGRESS_PORT) {
      urlCache.delete(h.sandboxId);
      return { url: await spriteUrl(h.sandboxId) };
    }
    const localPort = await tunnel.refresh(h.sandboxId, port);
    return { url: `http://127.0.0.1:${String(localPort)}` };
  },

  /**
   * Sprites has no URL-embedded token, so this is the same URL `previewUrl`
   * returns — but it IS browser-usable, which is what the caller actually
   * needs. `urlSettings.auth: 'sprite'` grants access to org members through
   * their normal Fly browser session, so a click works for the person who
   * owns the box. Omitting this instead would make `agentbox url` fail with a
   * "needs a header token browsers can't attach" error that is simply untrue
   * here.
   *
   * What it is NOT is a shareable link for someone outside the org. Making one
   * means flipping the sprite to `auth: 'public'`, which is a real exposure
   * decision and stays the user's to make (`sprite url update --auth public`).
   */
  async signedPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return this.previewUrl(h, port);
  },

  // NOTE: `createSnapshot` / `deleteSnapshot` / `snapshotExists` are
  // deliberately absent. Sprites' checkpoints (`createCheckpoint` /
  // `restoreCheckpoint`) restore only into the sprite that made them — they are
  // in-place rollback, not the id-addressed artifact `provision({snapshot})`
  // means. Implementing them against this interface would produce checkpoints
  // that silently fail to seed a new box. With them absent, the cloud
  // scaffold's `checkpoint.create` raises its own clear "doesn't support
  // snapshots" error instead.
  //
  // `renewTimeout` is absent too: there is no session deadline to push out.
  //
  // `ensureVolume`, `setInbound`, `repairReachability` and `startInBoxPortless`
  // are absent: no volume primitive, no per-box firewall to program, and a
  // public URL that needs no in-box mirror.
};

/**
 * Hand ownership of freshly-uploaded files to the box user.
 *
 * The SDK's filesystem API writes as the PLATFORM user (`sprite`), while every
 * consumer of an uploaded file runs as `vscode`. `/tmp` is sticky, so a
 * `vscode` process can read such a file but cannot delete it — which is how
 * this first showed up: the agent-credential seeding untarred fine and then
 * died on `rm: cannot remove '/tmp/agentbox-claude-creds.tar.gz': Operation not
 * permitted`, reporting the whole extract as failed and dropping the box back
 * to an interactive login.
 *
 * Best-effort: a chown failure leaves a readable file, which is still better
 * than failing the upload.
 */
async function chownUploaded(name: string, remotePaths: string[]): Promise<void> {
  if (remotePaths.length === 0) return;
  const cmd = `chown ${BOX_OWNER} ${remotePaths.map(shq).join(' ')}`;
  try {
    await execOnSprite(name, cmd, { attemptTimeoutMs: 30_000 });
  } catch {
    // the file is at least present and readable
  }
}

async function uploadToSprite(name: string, localPath: string, remotePath: string): Promise<void> {
  await withSpritesRetry(
    { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
    async () => {
      // The filesystem API takes `string | Buffer` — there is no streaming
      // write — so the whole file is buffered on the host. Fine for the runtime
      // assets and the workspace tarball (tens of MB); a multi-GB upload would
      // need chunking.
      const data = await readFile(localPath);
      const sp = spritesClient().sprite(name);
      await sp.filesystem('/').writeFile(remotePath, data);
    },
  );
}
