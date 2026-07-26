/**
 * `buildSpritesAttach` — the Sprites provider's override of
 * `Provider.buildAttach`.
 *
 * The shared `buildAttach` in `@agentbox/sandbox-cloud` assumes an SSH-shaped
 * transport: it appends `-t '<inner command>'` to whatever `attachArgv`
 * returns. The `sprite` CLI spells the same thing as `exec --tty -- <argv>`,
 * so the argv can't be built by suffixing — hence this override.
 *
 * Every attach kind uses ONE shape:
 *
 *     sprite exec -o <org> -s <name> [--tty] -- sudo -n -H -u vscode bash -lc '<inner>'
 *
 * with `--tty` only for interactive sessions. Detached pre-starts and `logs`
 * deliberately want a non-interactive exec that runs and exits.
 *
 * Two things this deliberately does NOT do, both learned from the live e2e:
 *
 *   - It does not use `sprite console`. Console opens a shell and takes no
 *     command argument, so the inner command would have to be TYPED at the
 *     prompt via `AttachSpec.initialInput` (the trick daytona needs). That
 *     handoff arms 400ms after the remote's first byte — and `sprite console`
 *     emits terminal capability queries immediately, long before `bash --login`
 *     is ready, so the line was swallowed and no tmux session was ever created.
 *     Passing the command in argv has no race to lose.
 *   - It does not stage a script in /tmp first. That existed only to keep a
 *     long quote-heavy command off an interactive line editor. In argv, the
 *     length and quoting stop mattering.
 *
 * `sudo -u vscode` is still required: `sprite exec` runs as the platform's own
 * `sprite` account, not the user AgentBox installs everything under.
 */

import {
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@agentbox/core';
import { hostTermForCloud, renderInnerCommand } from '@agentbox/sandbox-cloud';
import { requireSpriteCli, spriteSelector } from './sprite-cli.js';

/** Box user AgentBox standardizes on; created by install-sprite-base.sh. */
const BOX_USER = 'vscode';

export async function buildSpritesAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const name = box.cloud?.sandboxId;
  if (!name) {
    throw new Error(`sprites box ${box.name} has no sandboxId — record is malformed`);
  }

  const bin = requireSpriteCli();
  const inner = renderInnerCommand(kind, opts);
  // Forward the host's TERM so tmux inside the box negotiates the same
  // capabilities; renderInnerCommand's own guard downgrades it when the box's
  // terminfo doesn't carry the value (e.g. xterm-ghostty).
  const hostTerm = hostTermForCloud();

  // A detached build only creates the tmux session and must exit; `logs` is a
  // pipe. Neither wants a terminal.
  const interactive = !opts?.detached && kind !== 'logs';

  const argv = [
    bin,
    'exec',
    ...spriteSelector(name),
    ...(interactive ? ['--tty'] : []),
    '--',
    'sudo',
    '-n',
    '-H',
    '-u',
    BOX_USER,
    'bash',
    '-lc',
    inner,
  ];

  return { argv, env: { AGENTBOX_HOST_TERM: hostTerm } };
}
