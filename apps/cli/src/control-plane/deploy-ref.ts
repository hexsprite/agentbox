import { channelOfVersion } from '../lib/channel.js';
import { AGENTBOX_VERSION } from '../version.js';

/**
 * The git ref a control-box deploy should clone, derived from the CLI running it.
 *
 * The deploy is a two-sided contract: the VPS builds `apps/hub` from the cloned
 * ref, while the HOST generates the pieces that wrap it (the Caddyfile's upstream
 * port, the `.env` keys the compose consumes, the `/root/.agentbox` bind mount).
 * Those only line up when both sides come from the same code — so the ref has to
 * follow the CLI, not a constant.
 *
 * It used to be a hardcoded `main`, which silently broke every deploy from a
 * nightly CLI: `main`'s hub listened on :3000 behind a Postgres compose while the
 * nightly CLI wrote `reverse_proxy app:8787`, so Caddy 502'd against a perfectly
 * healthy hub for the full healthz window.
 *
 * - nightly build  → the `nightly` branch (nightlies are published from it, and
 *   are not tagged, so there is no exact ref to pin).
 * - released build → its own `v<version>` tag, exactly reproducing this CLI.
 * - dev build (`0.0.0-dev`, no version injected at bundle time) → `nightly`,
 *   the branch dev builds are cut from.
 */
export function deployRefForVersion(version: string): string {
  if (channelOfVersion(version) === 'nightly') return 'nightly';
  if (version.startsWith('0.0.0')) return 'nightly';
  return `v${version}`;
}

/** The deploy ref for this process. */
export function defaultDeployRef(): string {
  return deployRefForVersion(AGENTBOX_VERSION);
}
