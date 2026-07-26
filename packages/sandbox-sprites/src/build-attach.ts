/**
 * `buildSpritesAttach` — the Sprites provider's override of
 * `Provider.buildAttach`.
 *
 * The shared `buildAttach` in `@agentbox/sandbox-cloud` assumes an SSH-shaped
 * transport: it appends `-t '<inner command>'` to whatever `attachArgv`
 * returns. Neither of this provider's two transports takes that shape, so the
 * builder is overridden outright.
 *
 * The two paths, and why they differ:
 *
 *   - **Interactive** → our own `attach-helper.cjs` over the SDK. `sprite exec
 *     --tty` allocates a remote PTY but never negotiates the terminal size and
 *     never forwards SIGWINCH — `tmux list-panes` reports `client=x`, no client
 *     dimensions at all — so tmux renders at whatever size the session was born
 *     with and the display fills with mispositioned text and shredded escape
 *     sequences. The CLI has no size flag; the SDK has `spawn({tty, rows,
 *     cols})` + `resize()`. Hence the helper. (Same reason sandbox-e2b ships
 *     one.)
 *   - **Detached pre-starts and `logs`** → plain `sprite exec`. They run a
 *     command and exit, have no terminal to size, and were never affected. No
 *     reason to route them through a PTY bridge.
 *
 * Two things this deliberately does NOT do, both learned from the live e2e:
 *
 *   - It does not use `sprite console`. Console opens a shell and takes no
 *     command argument, so the inner command would have to be TYPED at the
 *     prompt via `AttachSpec.initialInput` (the trick daytona needs). That
 *     handoff arms 400ms after the remote's first byte — and `sprite console`
 *     emits terminal capability queries immediately, long before `bash --login`
 *     is ready, so the line was swallowed and no tmux session was ever created.
 *   - It does not stage a script in /tmp. That existed only to keep a long
 *     quote-heavy command off an interactive line editor; nothing types it now.
 *
 * `sudo -u vscode` is required on both paths: `sprite exec` and the SDK's spawn
 * both land as the platform's own `sprite` account, not the user AgentBox
 * installs everything under.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@agentbox/core';
import { hostTermForCloud, renderInnerCommand } from '@agentbox/sandbox-cloud';
import { resolveApiUrl, resolveOrg, resolveToken } from './sdk.js';
import { requireSpriteCli, spriteSelector } from './sprite-cli.js';

/** Box user AgentBox standardizes on; created by install-sprite-base.sh. */
const BOX_USER = 'vscode';

const SELF = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `attach-helper.cjs`. In the published CLI it lives at
 * `runtime/sprites/attach-helper.cjs` (the staged provider runtime tree); in
 * dev it sits next to this package's `dist/`.
 */
export function resolveAttachHelperPath(): string {
  const candidates = [
    resolve(SELF, 'attach-helper.cjs'),
    resolve(SELF, '..', 'dist', 'attach-helper.cjs'),
    resolve(SELF, '..', 'runtime', 'sprites', 'attach-helper.cjs'),
    resolve(SELF, '..', '..', 'runtime', 'sprites', 'attach-helper.cjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Return the first candidate so the error names somewhere informative.
  return candidates[0]!;
}

export async function buildSpritesAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const name = box.cloud?.sandboxId;
  if (!name) {
    throw new Error(`sprites box ${box.name} has no sandboxId — record is malformed`);
  }

  const inner = renderInnerCommand(kind, opts);
  // Forward the host's TERM so tmux inside the box negotiates the same
  // capabilities; renderInnerCommand's own guard downgrades it when the box's
  // terminfo doesn't carry the value (e.g. xterm-ghostty).
  const hostTerm = hostTermForCloud();

  // A detached build only creates the tmux session and must exit; `logs` is a
  // pipe. Neither wants a terminal, so both keep the simple CLI path.
  const interactive = !opts?.detached && kind !== 'logs';

  if (!interactive) {
    return {
      argv: [
        requireSpriteCli(),
        'exec',
        ...spriteSelector(name),
        '--',
        'sudo',
        '-n',
        '-H',
        '-u',
        BOX_USER,
        'bash',
        '-lc',
        inner,
      ],
      env: { AGENTBOX_HOST_TERM: hostTerm },
    };
  }

  const helper = resolveAttachHelperPath();
  if (!existsSync(helper)) {
    throw new Error(
      `sprites attach helper not found at ${helper} — rebuild the CLI (\`pnpm -w build\`) ` +
        'so packages/sandbox-sprites/dist/attach-helper.cjs is generated.',
    );
  }

  return {
    argv: [process.execPath, helper, '--sprite', name, '--user', BOX_USER],
    env: {
      SPRITES_TOKEN: resolveToken(),
      SPRITES_ORG: resolveOrg(),
      SPRITES_API_URL: resolveApiUrl(),
      // Via env, not argv: keeps the quoting sane and keeps a long command out
      // of `ps`.
      AGENTBOX_SPRITES_INNER_CMD: inner,
      AGENTBOX_HOST_TERM: hostTerm,
    },
  };
}
