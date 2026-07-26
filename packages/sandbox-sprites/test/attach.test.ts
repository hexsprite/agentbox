/**
 * `buildSpritesAttach`. The shared cloud `buildAttach` appends an SSH-shaped
 * `-t '<cmd>'` to `attachArgv`; the `sprite` CLI spells the same thing as
 * `exec --tty -- <argv>`, so this provider overrides the builder outright.
 * These pin the resulting argv for each mode.
 */

import type { BoxRecord } from '@agentbox/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sprite-cli.js', () => ({
  requireSpriteCli: () => '/usr/local/bin/sprite',
  spriteSelector: (name: string) => ['-o', 'test-org', '-s', name],
  findSpriteCli: () => '/usr/local/bin/sprite',
  spriteCliEnv: () => ({}),
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
  it('runs the inner command through `sprite exec --tty` as the box user', async () => {
    const spec = await buildSpritesAttach(box, 'shell', { sessionName: 'shell' });
    expect(spec.argv.slice(0, 8)).toEqual([
      '/usr/local/bin/sprite',
      'exec',
      '-o',
      'test-org',
      '-s',
      'agentbox-smoke',
      '--tty',
      '--',
    ]);
    // `sprite exec` runs as the platform's own `sprite` account, not the user
    // AgentBox installs everything under.
    expect(spec.argv.slice(8, 14)).toEqual(['sudo', '-n', '-H', '-u', 'vscode', 'bash']);
    expect(spec.argv.at(-1)).toBe(renderInnerCommand('shell', { sessionName: 'shell' }));
  });

  // Regression: interactive attach used to go through `sprite console`, which
  // takes no command argument — so the inner command had to be TYPED at the
  // prompt via initialInput. That handoff arms 400ms after the remote's first
  // byte, and console emits terminal capability queries immediately, well
  // before `bash --login` is ready. The line was swallowed and no tmux session
  // was ever created. Carrying the command in argv has no race to lose.
  it('carries the command in argv, never as typed input', async () => {
    const spec = await buildSpritesAttach(box, 'shell');
    expect(spec.initialInput).toBeUndefined();
    expect(spec.argv).not.toContain('console');
  });

  it('allocates a TTY only for interactive kinds', async () => {
    expect((await buildSpritesAttach(box, 'shell')).argv).toContain('--tty');
    expect((await buildSpritesAttach(box, 'agent')).argv).toContain('--tty');
    // A detached build only creates the tmux session and must exit; `logs` is a
    // pipe. Neither wants a terminal.
    expect((await buildSpritesAttach(box, 'agent', { detached: true })).argv).not.toContain('--tty');
    expect((await buildSpritesAttach(box, 'logs', { service: 'web' })).argv).not.toContain('--tty');
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
    const spec = await buildSpritesAttach(box, 'shell');
    expect(spec.argv[0]).toBe('/usr/local/bin/sprite');
  });

  it('fails clearly on a record with no sandboxId', async () => {
    await expect(
      buildSpritesAttach({ id: 'b', name: 'broken', provider: 'sprites' } as BoxRecord, 'shell'),
    ).rejects.toThrow(/has no sandboxId/);
  });
});
