# Fly.io Sprites provider — build-out backlog

> **Provider status: shipped, pending live e2e sign-off.** `--provider sprites`
> is wired end to end (config, CLI, hub, relay, doctor, prepare, attach) and
> covered by 133 unit tests including the shared `CloudBackend` conformance
> suite. What is *not* yet signed off is the live create → attach → destroy loop
> against a real sprite; see [Live e2e checklist](#live-e2e-checklist).

Status tracker for **Fly.io Sprites** (`--provider sprites`) as an eighth
AgentBox backend, alongside docker / daytona / hetzner / vercel / e2b /
digitalocean / remote-docker.

Sprites (https://sprites.dev) runs **Firecracker microVMs** with a TypeScript
SDK (`@fly/sprites`), scale-to-zero billing, ~300ms checkpoints, and native
detachable tmux sessions. Fly has publicly committed to "Computers for Agents"
as the company's forward focus.

Shape-wise it is closest to **Hetzner/DigitalOcean** (a real Ubuntu machine you
install into, reached partly through a host-side tunnel) crossed with
**E2B/Vercel** (microVM, SDK comms, scale-to-zero). It is unlike all of them in
one decisive way: **there is no reusable base image.**

## How Sprites maps onto the `CloudBackend` abstraction

| AgentBox concept       | Sprites primitive |
|------------------------|-------------------|
| provision a box        | `createSprite(name, { config, environment, labels, urlSettings, waitForCapacity })` — **then the base install, inline** |
| resolve existing box   | `getSprite(name)` |
| exec                   | `sprite.execFileHTTP('sudo', [...])` — plain HTTP, no WebSocket |
| upload / download / ls | `sprite.filesystem('/').writeFile / readFile / readdir` |
| preview URL (web)      | `SpriteInfo.url` → `https://<name>-<org>.sprites.app`, in-sprite **:8080 only** |
| preview URL (any other port) | detached `sprite proxy <local>:<remote>` → `http://127.0.0.1:<local>` |
| pause / resume         | **no API.** Drop the host tunnels and let idle detection sleep it; any request wakes it |
| list (for prune)       | `listAllSprites()` filtered on the `agentbox` label |
| destroy                | `deleteSprite(name)` |
| session timeout        | **none.** No session deadline exists, so no `renewTimeout` |
| base image (prepare)   | **nothing to bake.** `prepare` validates + fingerprints instead |
| checkpoints            | `createCheckpoint` / `restoreCheckpoint` — **in-place rollback, not a reusable artifact** |
| credentials            | `SPRITES_TOKEN` + `SPRITES_ORG` in `~/.agentbox/secrets.env` |

## Established facts (verified live, 2026-07-26)

Everything below was measured against real sprites in org `jordan-baker`, not
read off documentation.

### The base image is already an agent image

Ubuntu 26.04, and the following are present out of the box:

- Node 24.18, bun, deno, go, java, ruby, elixir, python3, corepack
- git 2.53, tmux 3.6, rsync, jq, curl, gh, setcap
- **`claude` 2.1.207 and `codex` 0.144.3**, pre-installed under the platform's
  own `sprite` user (uid 1001), plus `gemini` and `cursor-agent`
- passwordless sudo for the `sprite` user
- `~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor` skeletons

Missing and installed by `install-sprite-base.sh`: docker, git-lfs, bubblewrap,
opencode, portless, the `vscode` user, `/workspace`, agentbox-ctl, the shims and
the baked configs. VNC/Chromium is opt-in (see below).

### Timings

| Step | Measured |
|---|---|
| `sprite create` | **0.9–2.1s** |
| `apt-get update` | 4.5s |
| `docker.io` install | 16.6s |
| VNC stack (tigervnc + novnc + websockify) | 28.4s |
| Playwright Chromium download (114 MB) | 14.6s |
| `npm i -g opencode-ai` | ~7s |

**Total base install ≈ 2 minutes**, not the 7–10 a from-scratch Ubuntu bake
costs on hetzner/digitalocean. That is the entire reason install-per-box is
viable, and why the warm pool below is a nice-to-have rather than a blocker.

### The URL reaches exactly one port

`https://<sprite-name>-<org-suffix>.sprites.app`. With `python3 -m http.server`
bound to **both** 8080 and 8788, the URL served **8080**; killing that listener
made the URL return **502** rather than fall through to 8788. `sprite proxy
--help` says the same in words: *"HTTP-only and limited to one port."*

The hostname suffix (`-is44`) is **per-org and stable**, not per-sprite — but it
is server-assigned and not derivable from the org slug, so unlike e2b the URL
cannot be constructed locally. The backend reads it once from `getSprite` and
memoizes it.

Consequence: the relay bridge on 8788 needs a host-side forward. See
`src/sprite-proxy.ts`.

### Processes survive the sleep

A sprite with two background listeners was left idle until the API reported
`status: "cold"`. Both listeners were still bound afterwards, and the next exec
woke it transparently. So the ctl daemon, dockerd and tmux sessions all survive
scale-to-zero — AgentBox does not need to re-bootstrap on wake beyond what
`reEnsureCloudBox` already does idempotently.

### Status vocabulary

`running` / `warm` / `cold`, from the per-status counters `GET /v1/sprites`
returns. A sprite goes `warm` about **one second** after its last command, and
`cold` some minutes later. Mapping (pinned in `test/backend-mapping.test.ts`):

- `running`, `warm` → `running`
- `cold` → `paused`
- unrecognised → `running` (we only got here by successfully fetching it;
  calling a live billable box `missing` would be worse than being vague)
- 404 from the lookup → `missing`

### Concurrency caps

`running_limit: 10`, `warm_limit: 10` on the current plan, reported inline on
every `listSprites` response. `concurrent_sprite_limit_exceeded` is a distinct
error code from `sprite_creation_rate_limited`; the retry wrapper treats the
first as fatal (it needs a human to free a slot) and the second as retriable
(the request was rejected, so nothing was created).

### SDK

`@fly/sprites@0.1.0`, zero runtime dependencies. It declares
`engines.node >= 24` against AgentBox's `>= 20.10` floor. The only post-20.10
APIs it uses are `AbortSignal.any` (Node 20.3+) and the global `WebSocket`, and
every `WebSocket` reference lives in `proxy.js` / `control.js` — modules this
provider never loads. Everything AgentBox calls (`createSprite`, `getSprite`,
`listAllSprites`, `deleteSprite`, `checkSprite`, `execFileHTTP`, the filesystem
API) is plain `fetch`. So no Node floor change; the SDK stays `external` in tsup
so a Node 20 host only loads it when the user picks this provider.

## The two design problems, and what shipped

### 1. No pause primitive — the billing risk

The host relay's `CloudBoxPoller` long-polls every cloud box's bridge
continuously. Sprites bill CPU+RAM hours and sleep on idle. Continuous polling
means the sprite never sleeps.

This is the exact trap documented on `cloud-backend.ts` from the Daytona
measurement (2026-07-13), and Sprites has no API to force sleep — so
`backend.pause()` has nothing to call.

**What the audit found (Task 0):** the relay was *not* tearing the poller down
on pause. `pollers.stop(boxId)` fired only on `/admin/forget-box` (destroy) and
shutdown; `defaultPersistPaused` only wrote `cloud.lastState: 'paused'` to the
record. Daytona survives that because its SDK pause genuinely stops the sandbox,
so the polls simply fail. Sprites would have billed indefinitely.

Worse, the keepalive loop's per-tick scan gated on `typeof backend.renewTimeout
=== 'function'` **before** the idle-pause half ran — so a backend with no
session deadline to renew was silently excluded from the idle-pause half too.
The plan's assumption that omitting `renewTimeout` would skip only the renewal
half was wrong.

**What shipped** (`fix(relay): stop a cloud box's poller when it is paused`):

- `RelayServerHandle.stopCloudPoller(boxId)` + a loopback `POST
  /admin/pause-box`, which drop the poller but keep the registration — resume
  re-registers via `reEnsureCloudBox` and a fresh poller starts.
- The keepalive loop stops the poller after a successful idle-pause; the
  CLI-driven pause/stop path goes through `pauseBoxOnRelay`.
- The per-tick scan now gates only on "the backend resolved", and each half
  checks the capability it actually uses. The `renewTimeout` check moved above
  the record lookup so the skip stays I/O-free.
- Regression tests for all three, including the sprites shape (pause +
  `inactivity`, no `renewTimeout`).

On the provider side, `pause()` closes every `sprite proxy` tunnel for the box.
Since the tunnel is the only thing talking to an idle sprite, **dropping the
tunnels IS the pause** — and it's real work, not a state-recording no-op.

> **Not yet validated live.** Step 7 of the e2e checklist — leave a box idle,
> confirm via `sprite list` that it actually reaches `cold` and stops accruing
> CPU hours — is the test that proves this end to end. Until it runs, the
> billing story rests on the two component observations (polling keeps a sprite
> awake; a sprite with no traffic reaches `cold`) rather than on the composed
> behaviour.

### 2. No reusable base image

`CreateSprite` accepts `name`, `config`, `environment`, `labels`,
`urlSettings`, `waitForCapacity`, `runtime` — no image, no rootfs, no
create-from-checkpoint. Checkpoints are sprite-scoped rollback
(`/sprites/{name}/checkpoints/{id}/restore`), not id-addressed artifacts.

Fly has forking working in their admin console (since the Apr 16 release) and
confirms it's coming — *"Yep, forking from a sprite or checkpoint is coming!"*
(Kyle, Jan 3) — but has published no timeline and no public endpoint.

Handled honestly rather than faked:

- **`prepare` validates, it does not bake.** It checks credentials, checks the
  `sprite` CLI can list sprites *with AgentBox's configured token* (a mismatch
  against whatever `sprite use` points at otherwise surfaces later as a baffling
  "sprite not found" during attach), resolves + fingerprints the runtime assets,
  and writes `~/.agentbox/sprites-prepared.json`. It deliberately does not spin
  up a throwaway sprite to test-drive the install: that's billable, slow, and
  proves nothing a real create doesn't.
- **`provision` installs inline**, streaming the installer's `>>> BEGIN` /
  `<<< END` step markers into `~/.agentbox/logs/create.log` so a hang is
  localizable to one step.
- **No `createSnapshot` / `deleteSnapshot` / `snapshotExists`.** Sprite
  checkpoints restore only into their own sprite, which is not what
  `provision({snapshot})` means; implementing them would produce checkpoints
  that silently fail to seed a new box. With them absent, the cloud scaffold's
  `checkpoint.create` raises its own clear "doesn't support snapshots" error.
  `provision` also throws rather than silently ignoring a `snapshot` argument.

## Deliberate divergences from the other providers

| Thing | Sprites | Why |
|---|---|---|
| `exec` default user | **root** (via `sudo -n -H bash -lc`) | `SpawnOptions` has no `user` field and `sprite exec` lands as the unprivileged `sprite` account. Defaulting to root matches hetzner/digitalocean/daytona and keeps this backend clear of the `vercel`/`e2b` carve-outs in the scaffold's `carry.ts` + `workspace-resync.ts`. |
| agent installs | **symlinked** from `$SPRITE_HOME/.local` | Fly's base already carries claude + codex, ~440MB of them. Copying costs more wall-clock than the rest of the install combined, and re-downloading claude is both slower and the one step whose CDN 403s datacenter egress. The installer `chmod 0755`s `/home/sprite` to make them traversable — not a real privilege change, since `vscode` has NOPASSWD sudo and could already read them. |
| VNC / Chromium | **opt-in** (`CloudProvisionRequest.vnc`) | ~45s. On a baked provider that's paid once; here it's paid on every create. Baked providers ignore the new field. |
| `buildAttach` | **overridden** | The shared builder appends an SSH-shaped `-t '<cmd>'`. `sprite console` takes no command argument, so interactive attach connects to a bare shell and types one short line to run a staged script (the daytona trick), while detached/logs use `sprite exec` with the command inline. |
| attach user | `sudo -u vscode` inside the session | `sprite console` logs in as the platform's `sprite` account, not the `vscode` user everything AgentBox installs lives under. |
| host prerequisite | the **`sprite` CLI** | Both attach (`sprite console`) and the bridge tunnel (`sprite proxy`) shell out to it. It gets its own `agentbox doctor` row rather than surfacing as a create-time surprise. Driven with `SPRITE_TOKEN`/`SPRITE_ORG`/`SPRITE_URL` from AgentBox's own secrets, so the CLI and the SDK always act on the same credentials. |

Explicitly **not** in `PERSISTENT_SSH_PROVIDERS` / `IDE_PROVIDERS` /
`SSH_MOUNT_PROVIDERS`: `sprite console` is not real SSH, so there is no sshfs
mount and no VS Code Remote-SSH.

## Live e2e checklist

Follow the `CLAUDE.md` rule: background the command, `tail -f
~/.agentbox/logs/create.log`, stop the moment the log shows what's needed.

1. `agentbox sprites login` → `agentbox doctor --provider sprites` — three green rows.
2. `agentbox prepare --provider sprites` — fingerprint written, no bake attempted.
3. `node apps/cli/dist/index.js create -y -n sprite-smoke --provider sprites &`,
   then tail. Watch for: sprite created → assets uploaded → installer steps →
   workspace seeded → `agentbox-ctl bootstrap` → box ready.
4. `agentbox shell sprite-smoke -- echo agentbox-e2e-ping` — proves exec + the
   `sudo -u vscode` wrap.
5. `agentbox status --inspect` — preview URL resolves; confirm the bridge poller
   connects (relay log) through the `sprite proxy` tunnel.
6. `agentbox claude --provider sprites` driven through `pnpm drive` — proves
   `sprite console` attach + tmux + resize, and the `initialInput` handoff.
7. **Billing check.** Leave a box idle past the autopause window. Confirm via
   `sprite list` / the Fly dashboard that it reaches `cold` and stops accruing
   CPU hours. This validates or refutes the whole of design problem 1.
8. `agentbox destroy sprite-smoke -y`, then `sprite list` — verify clean.
9. `apps/cli/test/cloud-e2e-sprites.test.ts` (`describe.skipIf(!process.env.SPRITES_TOKEN)`)
   so the smoke is repeatable.

Also worth checking during the first live run:

- **DinD actually works.** The installer lays down docker.io and the scaffold
  starts `agentbox-dockerd-start`, but whether a Sprites microVM permits nested
  containers is unverified. E2B turned out to allow it despite an initial
  assumption it wouldn't; Vercel needed a platform change. If it doesn't work,
  flip `launchDockerd` to false in `src/index.ts` and note it here.
- **Upload ceiling.** `filesystem.writeFile` takes `string | Buffer` with no
  streaming API, so a workspace tarball is fully buffered on the host. Measure
  where that starts to hurt.
- **`sprite exec --http-post` exit frames.** Every CLI probe during the platform
  investigation ended with `Error: no exit frame received` on stderr while still
  producing correct stdout. Harmless for the CLI probes, but confirm the SDK's
  `execFileHTTP` doesn't have the same wart in a way that corrupts `exitCode`.

## Deferred: the warm pool (v2)

Keep N pre-installed sleeping sprites labelled with the runtime-asset
fingerprint; `provision()` claims one by label swap and triggers a background
top-up, falling back to the cold install when the pool is empty. Roughly 200 LOC
in `src/pool.ts`, entirely hidden behind `provision()` — nothing else in
AgentBox changes, because `sandboxId` is opaque on the box record.

Viable only because Sprites bills sleeping sprites on stored bytes alone. The
fingerprint key is already being written by `prepare`.

**Priority: low.** The plan assumed a 7–10 minute per-box bake; the measured
number is ~2 minutes, which makes the pool a nice-to-have rather than the thing
that rescues the provider. When fork ships, the pool collapses to a single
template sprite and `claim()` becomes `fork(template)` at the same call site —
which is the better version of this anyway.

## Open questions for Fly

1. Timeline or early access for the **fork-from-template / clone** API. This is
   the difference between a ~2 min create and a sub-minute one, and AgentBox is
   a strong design partner — eight backends, real create/checkpoint semantics.
2. Is there any way to **force a sprite to sleep**, or is idle detection the
   only path? (Today AgentBox drops its tunnels and waits.)
3. Are **label writes atomic** (compare-and-swap)? This decides whether the v2
   warm pool can claim safely across the hub / multiple hosts, or only on a
   single host under a local lock.
4. What exactly does `CreateSpriteRequest.runtime: 'default' | 'dev'` select?
   AgentBox leaves it at the default.
5. Is the in-sprite ingress port (8080) configurable per sprite? A second
   routable port would let AgentBox drop the `sprite proxy` tunnel entirely.
