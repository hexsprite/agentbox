/**
 * `buildSpritesAttach` — the Sprites provider's override of
 * `Provider.buildAttach`.
 *
 * The shared `buildAttach` in `@agentbox/sandbox-cloud` assumes an SSH-shaped
 * transport: it appends `-t '<inner command>'` to whatever `attachArgv`
 * returns. `sprite console` takes no command argument at all (it is
 * specifically "open an interactive shell"), and `sprite exec` spells the same
 * thing differently, so the two attach modes need different argv rather than
 * one argv plus a suffix. Hence the override.
 *
 *   - interactive  → `sprite console -o <org> -s <name>`, plus `initialInput`.
 *   - detached/logs → `sprite exec -o <org> -s <name> -- sudo -u vscode …`.
 *
 * Two wrinkles the inner command has to absorb:
 *
 *   1. `sprite console` logs in as the platform's `sprite` account, not the
 *      `vscode` user AgentBox installs everything under. So the staged script
 *      is run through `sudo -u vscode -H`.
 *   2. The inner command is far too long and quote-heavy to type at a prompt —
 *      a terminal line editor mangles it onto a `>` continuation. So we stage
 *      it as a file with a plain exec first (no TTY needed) and type one short
 *      line to run it. Same trick the shared builder uses for daytona, whose
 *      SSH gateway withholds a TTY from exec sessions.
 */

import {
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@agentbox/core';
import { attachScriptPath, hostTermForCloud, renderInnerCommand } from '@agentbox/sandbox-cloud';
import { spritesBackend } from './backend.js';
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
  const selector = spriteSelector(name);
  const inner = renderInnerCommand(kind, opts);
  // Forward the host's TERM so tmux inside the box negotiates the same
  // capabilities; renderInnerCommand's own guard downgrades it when the box's
  // terminfo doesn't carry the value (e.g. xterm-ghostty).
  const hostTerm = hostTermForCloud();

  // Detached pre-start and `logs` genuinely want a non-interactive exec that
  // runs a command and exits — `sprite exec` is exactly that. No TTY: a
  // detached build only creates the tmux session, and `logs` is a pipe.
  if (opts?.detached || kind === 'logs') {
    return {
      argv: [
        bin,
        'exec',
        ...selector,
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

  const scriptPath = attachScriptPath(opts?.sessionName ?? kind);
  const b64 = Buffer.from(inner, 'utf8').toString('base64');
  // Stage as root (the backend's default) and hand it to vscode, so the script
  // is readable by the user that will run it regardless of umask.
  await spritesBackend.exec(
    { sandboxId: name },
    `printf %s '${b64}' | base64 -d > ${scriptPath} && chown ${BOX_USER}:${BOX_USER} ${scriptPath} && chmod 700 ${scriptPath}`,
  );

  return {
    argv: [bin, 'console', ...selector],
    env: { AGENTBOX_HOST_TERM: hostTerm },
    // `exec` so the script replaces the login shell: the user never lands back
    // on the `sprite` account's prompt when they detach from tmux.
    initialInput: `exec sudo -n -H -u ${BOX_USER} bash ${scriptPath}\n`,
  };
}
