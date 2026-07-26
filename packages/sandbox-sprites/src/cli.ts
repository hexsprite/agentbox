/**
 * `agentbox sprites` CLI surface — registered as a top-level subcommand by
 * `apps/cli/src/index.ts` (same pattern as `daytonaCommand` / `e2bCommand`).
 *
 * Subcommands:
 *   - `login`            — interactive credential setup (paste a token + org).
 *   - `login --status`   — show what is currently configured (masked).
 *
 * Also provides the `agentbox sprites create|claude|codex|opencode` sugar via
 * the argv-prefix rewriter in apps/cli.
 */

import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  ensureSpritesCredentials,
  maskKey,
  readSpritesCredStatus,
  secretsPath,
} from './credentials.js';
import { readPreparedState } from './prepared-state.js';
import { findSpriteCli } from './sprite-cli.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

function printStatus(): void {
  const s = readSpritesCredStatus();
  if (s.auth === 'none') {
    process.stdout.write(
      (s.token ? 'sprites: incomplete (token set, SPRITES_ORG missing)\n' : 'sprites: not configured\n') +
        '  run `agentbox sprites login` to set up credentials\n',
    );
    return;
  }
  const lines = ['sprites: configured', '  auth:   org token'];
  if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  if (s.org) lines.push(`  org:    ${s.org}`);
  lines.push(`  source: ${s.source}`);
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  const bin = findSpriteCli();
  lines.push(`  CLI:    ${bin ?? 'NOT FOUND (attach + relay tunnel need it)'}`);
  process.stdout.write(lines.join('\n') + '\n');
}

const loginSub = new Command('login')
  .description('Set up (or rotate) Fly.io Sprites credentials for sandbox boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'sprites login needs an interactive terminal — set SPRITES_TOKEN and SPRITES_ORG in ' +
            'the environment or in ~/.agentbox/secrets.env for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureSpritesCredentials({ force: true });
      // Credentials alone don't get a user a working box: attach and the relay
      // tunnel both shell out to the `sprite` binary, and `prepare` validates
      // the box runtime. Nudge toward both here rather than letting the first
      // create surface them.
      if (!findSpriteCli()) {
        log.warn(
          'The `sprite` CLI is not on PATH. Interactive attach and the host→box relay tunnel ' +
            'need it — install with `curl -fsSL https://sprites.dev/install.sh | sh`.',
        );
      }
      if (readPreparedState().base === undefined) {
        log.info(
          'Run `agentbox prepare --provider sprites` (or `agentbox install`) to validate the box runtime.',
        );
      }
    } catch (err) {
      reportError(err);
    }
  });

export const spritesCommand = new Command('sprites')
  .description(
    'Fly.io Sprites provider — credentials, plus sugar for `--provider sprites` ' +
      '(e.g. `agentbox sprites create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true });
