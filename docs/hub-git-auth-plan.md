# Control-box git auth — `gh` by default, GitHub App behind a setting

Status: **implemented** (2026-07-26). Live smoke against a real control box is the
remaining gate; see "Verification" below.

## Why

A control box could only give boxes git access through a **GitHub App**, and
installing an App is an owner/admin decision. An employee can't self-serve it, so
the whole deployed-hub feature was unusable in most work environments.

Hit live on 2026-07-25: the App was created while signed into GitHub as
`madawaldos`, the repos live under `madarco`, and every cloud create failed with
`GitHub App is not installed on madarco/agentbox-test-repo`. The App was private
(the manifest sets `public: false`), so it could only ever be installed on its
owner's account — and collaborator access does not extend to an App installation.
GitHub's API confirmed it: `repository_selection=all`, accessible repos **0**.

## The key discovery

This did **not** need a new credential model. The relay's bundle path — the box
asks the *host* to push and never sees a credential — was **already wired and
reachable on a control box**: `packages/relay/src/server.ts` routes
`git.push`/`git.fetch` from any `kind:'cloud'` registration into
`executeCloudAction` → `runGitRpc`.

The `HOST_LOCAL_METHODS` 501 ("not available on the hosted control plane") lives
in `packages/relay/src/core/handler.ts`, which is the **Vercel** hosted-plane
handler. A hetzner control box never reaches it: it runs the full relay daemon on
:8787 with Caddy blanket-proxying to it, and `plane.ts` would 503 there anyway for
lack of `POSTGRES_URL`.

So the work was finishing a path that already existed, not building a new one.

## What was missing, and what shipped

| Gap | Fix |
|---|---|
| No host checkout — the worker clones to `/tmp/agentbox-hub-worker-<jobId>` and deletes it in a `finally`, so `git -C <workspacePath>` hit ENOENT | `resolveHostGitRepo` in `host-actions.ts`: falls back to a throwaway `git init` repo. A bundle is self-contained (`git bundle create <file> <branch>` carries full history, no prerequisites), so unbundle + push needs no persistent clone — no `/root/projects`, no staleness, no concurrency problem |
| No host credential — step 4 was a bare `execa('git', ['push'])` with nothing attached | `apps/hub/lib/git-auth.ts` loads the stored token into `GH_TOKEN` at boot and runs `gh auth setup-git`, so clone, push and `gh.pr.*` all authenticate from one place |
| No `gh` in the image | added to `apps/hub/Dockerfile` from GitHub's apt repo (`gh.pr.*` / `gh.api` exited 127 on a control box before) |
| The worker threw at *construction* without an App, killing the hub at boot | resolved per job; a missing credential now fails one job with an actionable message and the queue keeps draining |
| `auto` push mode assumed every hub could mint per-box tokens | `auto` leases only when the hub runs an App (`hubGitAuth`); a `gh`-mode hub routes boxes through the relay instead |
| The "run `agentbox hub add`" nag pointed at an App that may not exist | silent unless `hub.gitAuth=app` |

**Security invariant preserved:** the scratch repo pushes to the box's
**registered** origin (`BoxRegistration.originUrl`), never one the box supplies.
A box can rewrite its own `origin`, and pushing there with the host's credential
helper attached would hand the token to whoever chose the URL. Same rule
`lease.ts` states for the lease path.

## Modes

`hub.gitAuth: 'gh' | 'app'`, default `gh`. Deploy intent — it selects what
`hub setup` / `hub deploy` provisions and which push mode a cloud box gets; it
cannot reconfigure a running hub.

- **`gh`** — the hub holds a GitHub token taken from the user's own `gh auth
  token` (or git credential helper), confirmed interactively with account +
  scopes shown, and shipped to the VPS **data volume** `secrets.env` (not compose
  `environment:`, which `docker inspect` exposes). Boxes get nothing.
- **`app`** — unchanged from before: App private key on the hub, 1-hour
  single-repo installation tokens leased per push. Tighter where you can install
  it.

The App code (`lease.ts`, `github-app.ts`, the `git.lease-token` RPC and its
branch-approval gate) is **untouched** and still the safest option — kept for
users who own their repos, and for future experiments.

## Resolved during implementation

The plan flagged one open item: `runGitRpc`'s `AGENTBOX_GIT_PUSH_NO_SUB` gate
(deny by default when no SSE subscriber is attached) might deny every push on a
headless control box. It does not — `bypassPushGate = isScratch ||
isSanctionedNonScratch` short-circuits first, and a box's branch is
`agentbox/<name>`, which `isScratchBranch` matches. That mirrors the lease gate's
semantics (scratch → immediate, other branches → approval). No change needed.

## Verification

Unit: `resolveHostGitRepo` (real checkout passthrough / scratch creation /
refusal without a registered origin), the `auto`-mode matrix in
`bootstrap-env.test.ts`, and an exhaustive `KEY_REGISTRY` ↔ JSON-schema check
that also closed 15 pre-existing drifted keys (and caught `box.provider` missing
`remote-docker`).

Live smoke, against `madarco/agentbox-test-repo` — the repo that fails today,
since `madawaldos` is only a collaborator there:

1. `agentbox hub setup` → reuses the host `gh` token, no App, no browser install.
2. `agentbox e2b claude` → no "isn't authorized" warning; the create succeeds.
3. Commit in the box, `git push`, then `git ls-remote` from the host to confirm
   the branch actually landed (exit codes are unreliable here).
4. `agentbox-ctl git pull` in the box — now works through the same bundle path.
5. Regression: a control box deployed `--git-auth app` still leases and pushes.

## Not done

- **`fetch`/`pull` in lease mode.** `AGENTBOX_GIT_LEASE=1` only affects `push`,
  so a *lease-mode* box still relays its fetches. Fixing it needs a box-side
  `leaseAndFetch`. Unaffected in `gh` mode, where everything relays anyway.
- **Persistent `/root/projects` clones.** The web-UI "New project" flow still
  expects a VPS checkout; the scratch-repo path deliberately doesn't create one.
- **OAuth ("Sign in with GitHub") mode.** Designed and dropped: a classic OAuth
  App token has the same blast radius as the `gh` token but adds a redirect flow,
  token storage and a refresh loop. Revisit only if a hub needs per-user
  attribution.
- **The credential-injecting proxy** (iron-proxy shape) for all box secrets —
  the intended future direction, which would subsume this.
