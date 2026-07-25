# Nightly release channel — plan of record

Status: **in progress** (started 2026-07-25).

## Why

Big features land on `nightly` and sit there. When this work started, `nightly` was **84 commits**
ahead of `main` (the whole `feat/control-box-plan` line) while `main` was still `release: v0.27.0`.
Running that code meant cloning the monorepo, so the only real-world testing it got was the
maintainer's.

The goal is a second, clearly-marked channel a friendly user opts into with one command and then
stays on, so features get exercised on other people's machines, projects, and cloud accounts before
they reach a stable release.

## What exists today (the starting point)

One channel, hardcoded in five places:

| what | where |
|---|---|
| npm dist-tag `latest` | `apps/cli/src/lib/update-check.ts`, `apps/cli/src/commands/update.ts` |
| tray release tag `tray-latest` | `apps/cli/src/commands/install-app.ts`, tray `Update/UpdateChecker.swift` |
| triplet-only semver compare | `apps/cli/src/lib/semver-lite.ts` |

Publishing is manual on both sides and stays that way (see Decisions): `npm publish --auth-type=web`
run by a human because npm's 2FA web-auth URL gets redacted in tool output, and the tray is signed +
notarized from the maintainer's keychain with no CI at all.

Consequence worth stating plainly: a prerelease build installed **today** gets no update nudges
(`compareSemver` returns `null` for anything that isn't `x.y.z`), and its first `agentbox self-update`
silently moves it **back to stable** (`@latest` is hardcoded).

## Decisions

- **Manual publishing, both sides.** No `NPM_TOKEN`, no npm trusted-publishing/OIDC, no macOS CI for
  the tray. The npm side rides the existing `/release-notes` skill via a new `nightly` argument.
- **Two channels only**: `stable` and `nightly`.
- **Nightly means "the newest build, prerelease or not"** — see below; this is the decision that
  shapes everything else.

## Design

| | stable | nightly |
|---|---|---|
| npm dist-tag | `latest` | `nightly` |
| npm version | `0.27.0` | `0.28.0-nightly.202607251430` |
| tray release tag | `tray-latest` | `tray-nightly` |
| tray version | `0.1.14` | `0.1.15-nightly.202607251430` |

### Nightly polls both tags and takes the greater

A nightly user checks **both** dist-tags and installs whichever version is higher. Because a nightly
is named for the release it *precedes*, semver gives the wanted priority for free —
`0.28.0 > 0.28.0-nightly.5` — so the moment `0.28.0` ships, every nightly tester is offered it
automatically, with no second publish under the `nightly` tag. They stay on it until
`0.29.0-nightly.1` appears and outranks it again.

Stable users are unaffected: they only ever look at `latest`, and pay exactly one probe per component
as before.

### Channel membership is sticky once joined

Deriving the channel from the running version (`-nightly.` suffix ⇒ nightly) is the **bootstrap** —
it is what makes `npm i -g @madarco/agentbox@nightly` self-sustaining with no config step.

But the rule above hands testers a *stable* build (`0.28.0`) with no suffix, which would derive
`stable` on the next launch and silently undo the opt-in. So the channel is persisted to
`update.channel` when it resolves to nightly, and whenever `self-update` crosses onto a
non-prerelease version. The key is `auto | stable | nightly` (default `auto`); `--channel` writes it
and `--channel stable` is the opt-out.

### Version scheme

`<next minor>-nightly.<YYYYMMDDHHmm UTC>` — unique and monotonic with no counter to track.

The base is the minor-bump of the **published `latest`** (`npm view @madarco/agentbox version`),
*not* of the branch's `package.json`. After a nightly commit the branch reads `0.28.0-nightly.5`,
whose minor-bump is `0.28.0` — which would **tie** the just-shipped stable instead of outranking it,
producing a nightly no tester ever receives. Anchoring on the published release is deterministic and
immune to that churn: the base is `0.28.0` until `0.28.0` ships, then `0.29.0`.

## Phases

- [ ] **Phase 0** — this doc.
- [ ] **Phase 1** — CLI channel plumbing: new `apps/cli/src/lib/channel.ts`, prerelease ordering in
      `semver-lite.ts`, thread the channel through `update-check.ts` / `update.ts` / `install-app.ts`,
      sticky-membership persist, `update.channel` config key, unit tests.
- [ ] **Phase 2** — publishing: `nightly` arm in `.claude/commands/release-notes.md`; `tray-nightly`
      support in `../agentbox-tray/scripts/publish-release.sh`.
- [ ] **Phase 3** — CI coverage for the `nightly` branch (`box-image.yml`, `ci.yml`).
- [ ] **Phase 4** — tray app channel awareness (`UpdateChecker.swift`).
- [ ] **Phase 5** — docs (`nightly.mdx`, `cli.mdx`, `development.md`, `README.md`, tray docs).

## Gotchas found while planning

Each of these is a silent failure — nothing errors, the channel just quietly misbehaves.

- **`npm publish` without `--tag nightly` moves `latest` onto the prerelease**, breaking every stable
  user. This is the one irreversible mistake in the flow (npm versions can't be replaced), so the
  skill must state it and the release check must assert `latest` is unchanged afterwards.
- **`box-image.yml` must run on `nightly`.** The CLI pulls the box image by build-context fingerprint
  (`registryRefForSha`), and only `main` pushes publish those tags today. Without this, every nightly
  tester silently falls into a ~10-minute local docker build, and Daytona degrades to a container
  class outright — it can only bake a VM snapshot from a *published* image.
- **…but the floating tags must stay on `main`.** `box-image.yml` claims `:$VERSION` and `:latest` on
  the native leg; running it on `nightly` unguarded would point GHCR's public `latest` at a nightly
  image.
- **The tray's source git tag must be skipped for nightly.** `publish-release.sh` tags the private
  repo `v$VERSION`, and the release-notes tray check anchors on `git describe --tags --abbrev=0`. A
  nightly tag there makes the "any app commits since its last release?" check go permanently empty
  for stable.
- **Both `isNewer` implementations drop the prerelease suffix** before comparing — `semver-lite.ts`
  returns `null` for a prerelease, and the tray's Swift version strips it. Either way,
  nightly-to-nightly comparison is a no-op and testers are never told about a newer nightly.

## Known caveats — documented, not solved

- **Channels share `~/.agentbox` entirely** — boxes, hub, secrets, and
  `~/.agentbox/<provider>-prepared.json`. Switching channels can force a cloud re-bake when the baked
  assets differ (minutes on hetzner/e2b/vercel), and a nightly carrying a state-schema change affects
  stable use afterwards. Per-channel isolation isn't worth building; the public docs page says so.
- **A nightly cut from a branch other than `nightly`** whose box-context files differ from anything
  published still falls back to a local image build. Phase 3 covers the `nightly` branch only.
- The `nightly` branch was previously undocumented — it appeared exactly once in the repo, in
  `.claude/commands/release-notes.md`. Phase 5 names it as the integration branch in
  `docs/development.md`.
