/**
 * Doctor probes + normalized credential status for the sprites provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 *
 * Three rows rather than the usual two: the `sprite` CLI is a genuine host
 * prerequisite here (interactive attach shells out to `sprite console`, and the
 * host→box relay tunnel to `sprite proxy`), so a missing binary is worth its
 * own line rather than a create-time surprise.
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { readSpritesCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';
import { findSpriteCli } from './sprite-cli.js';
import { readSpriteCliVersion } from './prepare.js';

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readSpritesCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readSpritesCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            // Name which half is missing — "not configured" is unhelpful when
            // the user has pasted a token but never set an org.
            detail: cred.token ? 'token set, org missing' : 'not configured',
            hint: '`agentbox sprites login`',
          }
        : {
            label: 'credentials',
            status: 'ok',
            detail: `${cred.auth} (${cred.source}, org ${cred.org ?? '—'})`,
          };

    const bin = findSpriteCli();
    const cliRes: CheckResult = bin
      ? {
          label: 'sprite CLI',
          status: 'ok',
          detail: `${bin}${(await readSpriteCliVersion()) ? ` (${String(await readSpriteCliVersion())})` : ''}`,
        }
      : {
          label: 'sprite CLI',
          status: 'warn',
          detail: 'not found on PATH',
          hint: 'curl -fsSL https://sprites.dev/install.sh | sh (attach + the relay tunnel need it)',
        };

    const prepared = readPreparedState();
    const baseRes: CheckResult = prepared.base?.contextSha256
      ? {
          label: 'box runtime',
          status: 'ok',
          detail: `${prepared.base.contextSha256.slice(0, 12)} (${prepared.base.cliVersion ?? '—'}) — installed per box`,
        }
      : {
          label: 'box runtime',
          status: 'warn',
          detail: 'not validated',
          hint: '`agentbox prepare --provider sprites`',
        };
    return [credRes, cliRes, baseRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
