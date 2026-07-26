/**
 * In-process attach bridge for `agentbox shell|claude|codex|opencode -p sprites`.
 *
 * Why this exists rather than shelling out to the CLI: `sprite exec --tty`
 * allocates a remote PTY but never negotiates the terminal size and never
 * forwards SIGWINCH. tmux inside the box therefore renders against whatever
 * size it was created with — `tmux list-panes` reports `client=x`, i.e. no
 * client dimensions at all — while the host terminal is some other shape.
 * Absolute cursor moves (`ESC[24;1H`) then land on the wrong rows, the
 * AgentBox status band gets overwritten mid-sequence, and the display fills
 * with shredded escapes like a bare `38;5;16m`. The CLI exposes no size flag.
 *
 * The SDK does expose it: `sprite.spawn(cmd, args, { tty, rows, cols })` plus
 * `SpriteCommand.resize(cols, rows)`. So the CLI spawns this script attached to
 * the user's terminal PTY and we proxy stdin/stdout/SIGWINCH to a correctly
 * sized in-box PTY. Same shape and same reason as sandbox-e2b's attach-helper.
 *
 * Wire shape:
 *
 *   stdin (host PTY)                 ┌──── cmd.stdin ────►  in-box PTY
 *                                    │                        │
 *   process.stdin ──────► attach-helper.cjs (this file)        │
 *                                    │                        │
 *   stdout (host PTY) ◄── cmd.stdout ┴──────────────  ◄────────┘
 *
 * Argv: `node attach-helper.cjs --sprite <name> [--user <name>]`.
 * Env:
 *   SPRITES_TOKEN / SPRITES_ORG / SPRITES_API_URL   credentials (threaded in
 *                              by build-attach.ts from ~/.agentbox/secrets.env).
 *   AGENTBOX_SPRITES_INNER_CMD Inner bash command (renderInnerCommand output:
 *                              the tmux ensure + attach). Passed via env, not
 *                              argv, so quoting stays sane and it doesn't leak
 *                              through `ps`.
 *   AGENTBOX_HOST_TERM         Host TERM, applied to the in-box PTY.
 *
 * Ships its own `ws` because the SDK's WebSocket auth is unusable under Node's
 * built-in implementation — see the note on the import below.
 *
 * INTERACTIVE ONLY. Detached pre-starts and `logs` keep using the plain
 * `sprite exec` argv: they run a command and exit, have no terminal to size,
 * and were never affected by any of this.
 *
 * Exit code mirrors the inner command (the tmux session). Detach (`Ctrl+a d`)
 * collapses tmux → the command exits 0; a transport error exits 1 so the CLI's
 * reconnect loop fires.
 */

import WebSocketImpl from 'ws';
import { SpritesClient } from '@fly/sprites';

// The SDK opens its exec WebSocket as `new WebSocket(url, { headers: {
// Authorization: 'Bearer …' } })`. Node's BUILT-IN WebSocket (undici) silently
// ignores an options object, so the credential never reaches the server and the
// handshake dies with a bare 1006 — no error, no data, an attach that hangs on a
// blank screen forever. Verified directly against api.sprites.dev: built-in →
// 1006; `ws` → past auth. Token-in-query and subprotocol auth are both rejected
// by the server, so replacing the implementation is the way through.
//
// `ws` takes `(url, protocols, options)` and treats a non-array second argument
// as options, which is exactly the shape the SDK passes. Assigned before any SDK
// call so every socket it opens uses this one. Also drops the Node 22
// requirement the built-in would impose — `ws` works on AgentBox's 20.10 floor.
(globalThis as { WebSocket?: unknown }).WebSocket = WebSocketImpl;

interface ParsedArgs {
  sprite: string;
  user: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let sprite: string | undefined;
  let user = 'vscode';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sprite') {
      sprite = argv[i + 1];
      i++;
    } else if (a === '--user') {
      user = argv[i + 1] ?? user;
      i++;
    }
  }
  if (!sprite) {
    process.stderr.write('attach-helper: --sprite is required\n');
    process.exit(2);
  }
  return { sprite, user };
}

async function main(): Promise<void> {
  const { sprite: spriteName, user } = parseArgs(process.argv.slice(2));

  const inner = process.env.AGENTBOX_SPRITES_INNER_CMD;
  if (!inner) {
    process.stderr.write('attach-helper: AGENTBOX_SPRITES_INNER_CMD env is required\n');
    process.exit(2);
  }
  const token = process.env.SPRITES_TOKEN;
  if (!token) {
    process.stderr.write('attach-helper: SPRITES_TOKEN env is required\n');
    process.exit(2);
  }

  const client = new SpritesClient(token, {
    baseURL: process.env.SPRITES_API_URL ?? 'https://api.sprites.dev',
  });
  const sprite = client.sprite(spriteName);

  // Default to 80x24 if stdout isn't a TTY (e.g. piped). node-pty hosts always
  // set them; this is the whole point of the helper, so get it right.
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;

  // `sprite exec` lands as the platform's own `sprite` account, so drop to the
  // box user the same way the backend's exec does.
  const cmd = sprite.spawn(
    'sudo',
    ['-n', '-H', '-u', user, 'bash', '-lc', inner],
    {
      tty: true,
      cols,
      rows,
      env: {
        // The inner command's own TERM guard (renderInnerCommand) downgrades to
        // xterm-256color when the box's terminfo lacks the host value, so an
        // exotic host TERM never breaks the attach.
        TERM: process.env.AGENTBOX_HOST_TERM || 'xterm-256color',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
    },
  );

  // node-pty already puts the host PTY in raw mode; this is defensive for a
  // plain-spawn fallback.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // In TTY mode the remote merges stderr into the PTY stream, but pipe it too
  // so a pre-PTY failure (sudo refusing, say) still reaches the user.
  cmd.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  cmd.stderr.on('data', (chunk: Buffer) => process.stdout.write(chunk));

  // Nothing may touch the socket before it opens: the SDK throws
  // "WebSocket not open" and turns it into an `error`, killing the attach. The
  // window is real, not theoretical — the AgentBox wrapper resizes the pty
  // immediately to lay out its status band, and a terminal that already has
  // buffered input delivers it on the first tick. So queue both until `spawn`.
  let ready = false;
  const pendingInput: Buffer[] = [];

  const writeInput = (chunk: Buffer): void => {
    if (!ready) {
      pendingInput.push(chunk);
      return;
    }
    try {
      cmd.stdin.write(chunk);
    } catch {
      // The command is gone (sprite slept mid-write, user detached). `wait()`
      // below settles and we exit cleanly.
    }
  };
  process.stdin.on('data', writeInput);

  // The reason this file exists: keep the in-box PTY the same size as the host
  // terminal, for the life of the session.
  const onResize = (): void => {
    if (!ready) return; // the spawn options already carry the current size
    const c = process.stdout.columns ?? cols;
    const r = process.stdout.rows ?? rows;
    if (c > 0 && r > 0) {
      try {
        cmd.resize(c, r);
      } catch {
        // race with shutdown
      }
    }
  };
  process.stdout.on('resize', onResize);

  // Forward Ctrl+C to the remote rather than killing the bridge — the user
  // expects tmux (or whatever is in the foreground) to receive it.
  process.on('SIGINT', () => {
    writeInput(Buffer.from([3]));
  });

  const cleanup = (): void => {
    process.stdout.off('resize', onResize);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdin.pause();
  };

  // `spawn()` already starts the command (it calls `start()` itself and emits
  // `spawn` / `error`), so calling start() here would throw "Command already
  // started". Re-assert the size on `spawn` instead: the options carry it, but
  // a terminal resized between spawn and ready would otherwise be missed, and
  // that window is exactly when the box is still waking.
  cmd.on('spawn', () => {
    ready = true;
    // Re-assert the size: the spawn options carried whatever it was at spawn
    // time, but the wrapper may have resized us while the socket was opening.
    onResize();
    for (const chunk of pendingInput.splice(0)) writeInput(chunk);
  });

  let exitCode = 0;
  try {
    // Race the exit against the error event. A failed connect (bad token, sprite
    // gone, WebSocket refused) emits `error` and then NEVER settles `wait()`, so
    // awaiting the exit alone hangs forever with an empty screen — which is
    // exactly how this looked before the race was added.
    exitCode = await new Promise<number>((res, rej) => {
      cmd.once('error', rej);
      cmd.wait().then(res, rej);
    });
  } catch (err) {
    process.stderr.write(
      `attach-helper: attach failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitCode = 1;
  } finally {
    cleanup();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(
    `attach-helper: unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
