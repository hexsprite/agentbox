# Fly.io Sprites provider — build-out backlog

> **Provider status: shipped and live-verified.** `--provider sprites` is wired
> end to end (config, CLI, hub, relay, doctor, prepare, attach) and covered by
> 138 unit tests including the shared `CloudBackend` conformance suite. The live
> create → exec → attach → pause → destroy loop has been run against real
> sprites in org `jordan-baker`; results and the seven bugs it caught are in
> [Live e2e results](#live-e2e-results). One item remains unverified: the
> composed idle→sleep billing loop, which needs a long idle window.

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
| `sprite create` | **0.9–2.5s** |
| `apt-get update` | 4.5s |
| `docker.io` install | 16.6s |
| VNC stack (tigervnc + novnc + websockify) | 28.4s |
| Playwright Chromium download (114 MB) | 14.6s |
| `npm i -g opencode-ai` | ~7s |
| **base install, end to end** | **1m40s** (with VNC/Chromium) |
| **`agentbox create`**, this repo, VNC on | **~2m25s** (install + 22 MB clone + credentials + bootstrap) |
| **`agentbox create --no-vnc`**, small repo | **~50s** (the e2e test's measured round-trip incl. destroy) |

So the honest range is **~50s to ~2.5 min**, driven mostly by whether the
VNC/Chromium stack is installed (~45s) and how big the workspace clone is — not
the 7–10 minutes a from-scratch Ubuntu bake costs on hetzner/digitalocean. That
is the entire reason install-per-box is viable, and why the warm pool below is a
nice-to-have rather than a blocker.

### DinD works

An open question until the first live box: Sprites microVMs **do** permit nested
containers. `docker ps` inside the box succeeds with `vscode` in the `docker`
group, so `launchDockerd: true` is correct. (E2B turned out the same way against
an initial assumption it wouldn't; Vercel needed a platform change.)

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

> **Partly validated live.** `agentbox pause` demonstrably drops both tunnels
> and kills both `sprite proxy` processes, and an untouched sprite is known to
> reach `cold` on its own. What has not been watched end to end is the composed
> loop — idle box → keepalive idle-pause → poller torn down → sprite sleeps
> unaided — which needs a full idle window with nothing else touching the box.
> See [Still unverified](#still-unverified).

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
| `buildAttach` | **overridden** | The shared builder appends an SSH-shaped `-t '<cmd>'`; the `sprite` CLI spells it `exec --tty -- <argv>`. One shape for every kind, `--tty` only when interactive. See [Why attach uses `sprite exec --tty`](#why-attach-uses-sprite-exec---tty-not-sprite-console). |
| attach user | `sudo -u vscode` in the exec argv | `sprite exec` runs as the platform's `sprite` account, not the `vscode` user everything AgentBox installs lives under. |
| host prerequisite | the **`sprite` CLI** | Both attach (`sprite exec --tty`) and the bridge tunnel (`sprite proxy`) shell out to it. It gets its own `agentbox doctor` row rather than surfacing as a create-time surprise. Driven with `SPRITE_TOKEN`/`SPRITE_ORG`/`SPRITE_URL` from AgentBox's own secrets, so the CLI and the SDK always act on the same credentials. |

Explicitly **not** in `PERSISTENT_SSH_PROVIDERS` / `IDE_PROVIDERS` /
`SSH_MOUNT_PROVIDERS`: `sprite exec` is not real SSH, so there is no sshfs
mount and no VS Code Remote-SSH.

## Live e2e results

Run against org `jordan-baker`, 2026-07-26. Every sprite created was destroyed;
`sprite list` verified empty at the end.

| Step | Result |
|---|---|
| `agentbox sprites login` → `doctor --provider sprites` | three green rows (credentials, sprite CLI, box runtime) |
| `agentbox prepare --provider sprites` | fingerprint written, nothing baked, `base freshness: up to date` |
| `agentbox create --provider sprites` | box ready in ~2m25s |
| workspace | `/workspace` on branch `agentbox/<box>`, full history, correct HEAD |
| `agentbox shell <box> -- …` | runs as `vscode`, cwd `/home/vscode`, node 24 + claude 2.1.207 on PATH |
| DinD | `docker ps` succeeds |
| agent credentials | claude / codex / opencode all seeded |
| in-box bootstrap | `dockerd=up ctl=up vnc=up` |
| relay poller | task-state events streaming to the host through the `sprite proxy` tunnel |
| `agentbox url` | opens `https://<box>-<org>.sprites.app` |
| interactive attach | `vscode@<box>:/workspace$` inside tmux |
| `agentbox pause` | both tunnels + both proxy processes gone |
| `agentbox destroy` | sprite gone, no orphan processes, no state left |

### Bugs it caught

All seven are fixed with regression tests; see the `fix(sprites):` commits.

1. **`npm: command not found` aborted every install.** Fly's toolchain lives at
   `/.sprite/bin`, added to the platform user's PATH by a shell profile rather
   than `/etc/environment` — so root and `vscode` both started without it.
2. **`execFileHTTP` throws on non-zero exit, it does not return.** Every
   `CloudBackend.exec` caller branches on `exitCode`, so a routine failing probe
   became an unhandled `ExecError` that aborted create.
3. **Uploaded files stayed owned by the platform user.** `/tmp` is sticky, so
   `vscode` could read but not delete them — agent-credential seeding untarred
   fine and then died on `rm: Operation not permitted`.
4. **exec landed in `/home/sprite`.** `sudo -H` sets HOME without changing
   directory, so relative paths resolved in Fly's account home.
5. **`agentbox url` failed outright.** Omitting `signedPreviewUrl` made
   `resolveUrl` claim the URL needs a header token browsers can't attach —
   untrue; it is org-authenticated and opens fine for the owner.
6. **Attach never started a tmux session.** See below.
7. **Destroy left an orphan `sprite proxy`.** The host poller outlives
   `backend.destroy`, so a failed poll in that window drove `recoverPreviewUrl`
   into minting a tunnel for a sprite that no longer existed.

### Why attach uses an SDK PTY bridge

The first implementation used `sprite console` plus `AttachSpec.initialInput` —
the daytona trick, where the inner command is typed at the prompt because the
transport won't take a command argument. It never worked: the handoff arms 400ms
after the remote's first byte, and `sprite console` emits terminal capability
queries immediately, well before `bash --login` is ready. The line was swallowed
every time and no tmux session was created.

`sprite exec --tty -- sudo -u vscode bash -lc '<inner>'` fixed that — the
command travels in argv, so there is no race to lose — and it is still what
detached pre-starts and `logs` use.

But interactive attach needed one more step. `sprite exec --tty` allocates a
remote PTY and then never negotiates the terminal size or forwards SIGWINCH:
tmux reported `pane=90x49` regardless of the real terminal. Absolute cursor
moves landed on the wrong rows, the status band was drawn twice, and the screen
filled with escape fragments that had lost their `ESC[` prefix. The CLI has no
size flag. So interactive attach goes through `src/attach-helper.cjs`, which
uses the SDK's `spawn({ tty, cols, rows })` + `SpriteCommand.resize()` — the
same shape and the same reason as sandbox-e2b's helper. Verified: host 143
columns produced `pane=143x46` (one row for the band), band drawn once.

Two things that helper has to get right, both found live:

- **It replaces the global `WebSocket` with `ws`.** The SDK opens its exec
  socket as `new WebSocket(url, { headers: { Authorization: ... } })`, and
  Node's built-in WebSocket silently ignores an options object — the token
  never reaches the server, the handshake dies with a bare 1006, and the attach
  hangs on a blank screen with no error at all. Measured directly against
  api.sprites.dev: built-in gave 1006, `ws` got past auth. Token-in-query and
  subprotocol auth are both rejected by the server. Upstream bug in
  `@fly/sprites@0.1.0`, worth reporting.
- **It queues stdin and resizes until the socket opens.** The AgentBox wrapper
  resizes the pty immediately to lay out its status band, and anything touching
  the socket before `spawn` throws "WebSocket not open", which the SDK turns
  into an `error` that kills the attach.

Also note `spawn()` starts the command itself; calling `start()` again throws
"Command already started", and a failed connect emits `error` while `wait()`
never settles — so the helper races the two.

Two notes for whoever debugs this next:

- `sprite console` is not broken — it works fine under a real TTY (`script -q
  /dev/null sprite console …` reaches a prompt immediately). It produces **zero
  bytes** under the drive harness's node-pty, which is what made this look like a
  CLI bug at first. Same for `sprite exec --tty`. Verifying either against a live
  sprite needs `script`, not `pnpm drive`.
- CLI rc43 → rc46 changed neither behaviour. (rc43 separately had a `sprite
  destroy` that failed on a TTY error; rc46 fixes that.)

### Still unverified

- **The composed billing loop.** The two halves are each verified — polling keeps
  a sprite awake, and an untouched sprite reaches `cold` on its own — and
  `agentbox pause` demonstrably drops both tunnels and their processes. What
  hasn't been watched end to end is an idle box going: keepalive idle-pause →
  poller torn down → sprite reaches `cold` unaided. That needs a full idle window
  with nothing else touching the box.
- **Upload ceiling.** `filesystem.writeFile` takes `string | Buffer` with no
  streaming API, so a workspace tarball is fully buffered on the host. A 22 MB
  clone tar was fine; where it starts to hurt is unmeasured.
- **`--http-post` exit frames.** Every `sprite exec --http-post` CLI probe ends
  with `Error: no exit frame received` on stderr while still producing correct
  stdout. The SDK's `execFileHTTP` has not shown the same wart, and exit codes
  have been correct throughout — but it's worth knowing about.
- `apps/cli/test/cloud-e2e-sprites.test.ts`
  (`describe.skipIf(!process.env.SPRITES_TOKEN)`) is not written yet, so the
  smoke isn't repeatable in CI.

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
