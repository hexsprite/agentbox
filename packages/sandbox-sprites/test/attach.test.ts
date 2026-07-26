/**
 * `buildSpritesAttach`. The shared cloud `buildAttach` appends an SSH-shaped
 * `-t '<cmd>'` to `attachArgv`, which fits neither of this provider's two
 * transports — interactive goes through our own SDK PTY bridge, detached/logs
 * through plain `sprite exec`. These pin the argv for each.
 */

import type { BoxRecord } from '@agentbox/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sprite-cli.js', () => ({
  requireSpriteCli: () => '/usr/local/bin/sprite',
  spriteSelector: (name: string) => ['-o', 'test-org', '-s', name],
  findSpriteCli: () => '/usr/local/bin/sprite',
  spriteCliEnv: () => ({}),
}));

vi.mock('../src/sdk.js', () => ({
  resolveToken: () => 'tok-test',
  resolveOrg: () => 'test-org',
  resolveApiUrl: () => 'https://api.sprites.test',
}));

// Static, not dynamic: `vi.mock` is hoisted above imports, so these still see
// the mocks — and loading @agentbox/sandbox-cloud (which pulls in sandbox-docker)
// costs seconds on a loaded machine. Inside a test body that blows the 5s
// timeout; at collect time it's paid once.
const { buildSpritesAttach } = await import('../src/build-attach.js');
const { renderInnerCommand } = await import('@agentbox/sandbox-cloud');

const box = {
  id: 'b1',
  name: 'smoke',
  provider: 'sprites',
  cloud: { sandboxId: 'agentbox-smoke' },
} as unknown as BoxRecord;

describe('buildSpritesAttach', () => {
  // Regression: interactive attach used to shell out to `sprite exec --tty`,
  // which allocates a remote PTY but never negotiates the terminal size and
  // never forwards SIGWINCH — tmux reported `client=x` (no client dimensions)
  // and rendered at a stale size, shredding the display with mispositioned
  // text and bare escape fragments. The SDK can size a PTY; the CLI can't.
  it('routes interactive attach through the SDK PTY helper, not the CLI', async () => {
    const spec = await buildSpritesAttach(box, 'shell', { sessionName: 'shell' });
    expect(spec.argv[0]).toBe(process.execPath);
    expect(spec.argv[1]).toMatch(/attach-helper\.cjs$/);
    expect(spec.argv.slice(2)).toEqual(['--sprite', 'agentbox-smoke', '--user', 'vscode']);
    expect(spec.argv).not.toContain('--tty');
  });

  it('hands the helper its credentials and the inner command through env', async () => {
    const spec = await buildSpritesAttach(box, 'shell', { sessionName: 'shell' });
    expect(spec.env?.SPRITES_TOKEN).toBe('tok-test');
    expect(spec.env?.SPRITES_ORG).toBe('test-org');
    expect(spec.env?.SPRITES_API_URL).toBe('https://api.sprites.test');
    // Env, not argv — a long quote-heavy command has no business in `ps`.
    expect(spec.env?.AGENTBOX_SPRITES_INNER_CMD).toBe(
      renderInnerCommand('shell', { sessionName: 'shell' }),
    );
    expect(spec.argv.join(' ')).not.toContain('tmux');
  });

  // Regression: interactive attach used to go through `sprite console`, which
  // takes no command argument — so the inner command had to be TYPED at the
  // prompt via initialInput. That handoff arms 400ms after the remote's first
  // byte, and console emits terminal capability queries immediately, well
  // before `bash --login` is ready. The line was swallowed and no tmux session
  // was ever created. Carrying the command in argv has no race to lose.
  it('never uses typed input or `sprite console`', async () => {
    const spec = await buildSpritesAttach(box, 'shell');
    expect(spec.initialInput).toBeUndefined();
    expect(spec.argv).not.toContain('console');
  });

  // Detached pre-starts and `logs` run a command and exit — no terminal to
  // size, so no reason to pay for a PTY bridge.
  it('keeps the plain CLI path for detached and logs', async () => {
    for (const spec of [
      await buildSpritesAttach(box, 'agent', { detached: true }),
      await buildSpritesAttach(box, 'logs', { service: 'web' }),
    ]) {
      expect(spec.argv[0]).toBe('/usr/local/bin/sprite');
      expect(spec.argv[1]).toBe('exec');
      expect(spec.argv).not.toContain('--tty');
      expect(spec.argv.slice(6, 12)).toEqual(['--', 'sudo', '-n', '-H', '-u', 'vscode']);
    }
  });

  it('passes the detached inner command through unchanged', async () => {
    const opts = { detached: true, sessionName: 'agent' };
    const spec = await buildSpritesAttach(box, 'agent', opts);
    expect(spec.argv.at(-1)).toBe(renderInnerCommand('agent', opts));
  });

  it('uses the ctl log tail for logs', async () => {
    const spec = await buildSpritesAttach(box, 'logs', { service: 'web' });
    expect(spec.argv.at(-1)).toContain('agentbox-ctl logs');
  });

  it('forwards the host TERM in every mode', async () => {
    expect((await buildSpritesAttach(box, 'shell')).env?.AGENTBOX_HOST_TERM).toBeTruthy();
    expect(
      (await buildSpritesAttach(box, 'agent', { detached: true })).env?.AGENTBOX_HOST_TERM,
    ).toBeTruthy();
  });

  it('keeps the program at argv[0] so callers can split it', async () => {
    expect((await buildSpritesAttach(box, 'shell')).argv[0]).toBe(process.execPath);
    expect((await buildSpritesAttach(box, 'logs', { service: 'web' })).argv[0]).toBe(
      '/usr/local/bin/sprite',
    );
  });

  it('fails clearly on a record with no sandboxId', async () => {
    await expect(
      buildSpritesAttach({ id: 'b', name: 'broken', provider: 'sprites' } as BoxRecord, 'shell'),
    ).rejects.toThrow(/has no sandboxId/);
  });
});

describe('attach-helper wiring', () => {
  // Load-bearing and easy to "clean up" by mistake. The SDK opens its exec
  // WebSocket as `new WebSocket(url, { headers: { Authorization: … } })`, and
  // Node's built-in WebSocket silently ignores an options object — the token
  // never reaches the server, the handshake dies with a bare 1006, and the
  // attach hangs on a blank screen with no error. Verified live against
  // api.sprites.dev: built-in → 1006, `ws` → past auth. Token-in-query and
  // subprotocol auth are both rejected by the server, so swapping the
  // implementation is the only way through.
  it('replaces the global WebSocket with `ws` before touching the SDK', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../src/attach-helper.ts', import.meta.url)),
      'utf8',
    );
    const assign = src.indexOf('WebSocket = WebSocketImpl');
    const firstSdkUse = src.indexOf('new SpritesClient');
    expect(assign).toBeGreaterThan(-1);
    expect(firstSdkUse).toBeGreaterThan(-1);
    expect(assign).toBeLessThan(firstSdkUse);
  });

  // The helper is a standalone file run as `node <path>` out of the staged CLI
  // runtime tree, where there is no node_modules to resolve `ws` from.
  it('bundles ws into the standalone helper rather than externalizing it', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const cfg = readFileSync(fileURLToPath(new URL('../tsup.config.ts', import.meta.url)), 'utf8');
    expect(cfg).toContain("noExternal: ['ws']");
  });
});
