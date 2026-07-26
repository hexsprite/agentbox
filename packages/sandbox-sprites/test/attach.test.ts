/**
 * `buildSpritesAttach`. The shared cloud `buildAttach` appends an SSH-shaped
 * `-t '<cmd>'` to `attachArgv`; `sprite console` takes no command argument and
 * `sprite exec` spells it differently, so this provider overrides the builder
 * outright. These pin the resulting argv for each mode.
 */

import type { BoxRecord } from '@agentbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execCalls: Array<{ sandboxId: string; cmd: string }> = [];

vi.mock('../src/sprite-cli.js', () => ({
  requireSpriteCli: () => '/usr/local/bin/sprite',
  spriteSelector: (name: string) => ['-o', 'test-org', '-s', name],
  findSpriteCli: () => '/usr/local/bin/sprite',
  spriteCliEnv: () => ({}),
}));

vi.mock('../src/backend.js', () => ({
  spritesBackend: {
    name: 'sprites',
    exec: async (h: { sandboxId: string }, cmd: string) => {
      execCalls.push({ sandboxId: h.sandboxId, cmd });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  },
}));

const box = {
  id: 'b1',
  name: 'smoke',
  provider: 'sprites',
  cloud: { sandboxId: 'agentbox-smoke' },
} as unknown as BoxRecord;

beforeEach(() => {
  execCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildSpritesAttach', () => {
  it('opens an interactive shell with `sprite console` and no trailing command', async () => {
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    const spec = await buildSpritesAttach(box, 'shell');
    expect(spec.argv).toEqual([
      '/usr/local/bin/sprite',
      'console',
      '-o',
      'test-org',
      '-s',
      'agentbox-smoke',
    ]);
  });

  // `sprite console` logs in as the platform's `sprite` account, not the
  // `vscode` user everything AgentBox installs lives under.
  it('drops into the vscode user via the typed line, not the argv', async () => {
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    const spec = await buildSpritesAttach(box, 'shell');
    expect(spec.initialInput).toMatch(/^exec sudo -n -H -u vscode bash \/tmp\/agentbox-attach-/);
    expect(spec.initialInput?.endsWith('\n')).toBe(true);
    expect(spec.argv.join(' ')).not.toContain('vscode');
  });

  // The real inner command is a multi-line, heavily-quoted tmux incantation. A
  // terminal line editor mangles that onto a `>` continuation, so it is staged
  // as a file first and one short line is typed.
  it('stages the inner command as a script before connecting', async () => {
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    const spec = await buildSpritesAttach(box, 'agent', { sessionName: 'agent' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.sandboxId).toBe('agentbox-smoke');
    expect(execCalls[0]!.cmd).toContain('base64 -d > /tmp/agentbox-attach-agent.sh');
    expect(execCalls[0]!.cmd).toContain('chown vscode:vscode');
    expect(execCalls[0]!.cmd).toContain('chmod 700');
    expect(spec.initialInput).toContain('/tmp/agentbox-attach-agent.sh');
  });

  it('round-trips the inner command through the staged base64 payload', async () => {
    const { renderInnerCommand } = await import('@agentbox/sandbox-cloud');
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    await buildSpritesAttach(box, 'shell', { sessionName: 'shell' });
    const b64 = /printf %s '([^']+)'/.exec(execCalls[0]!.cmd)?.[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(
      renderInnerCommand('shell', { sessionName: 'shell' }),
    );
  });

  // A detached build only creates the tmux session and must exit; `logs` is a
  // pipe. Both are plain execs that carry their command as an argument.
  it('uses `sprite exec` with the command inline when detached', async () => {
    const { renderInnerCommand } = await import('@agentbox/sandbox-cloud');
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    const spec = await buildSpritesAttach(box, 'agent', { detached: true, sessionName: 'agent' });
    expect(spec.argv.slice(0, 7)).toEqual([
      '/usr/local/bin/sprite',
      'exec',
      '-o',
      'test-org',
      '-s',
      'agentbox-smoke',
      '--',
    ]);
    expect(spec.argv.slice(7, 13)).toEqual(['sudo', '-n', '-H', '-u', 'vscode', 'bash']);
    expect(spec.argv.at(-1)).toBe(renderInnerCommand('agent', { detached: true, sessionName: 'agent' }));
    expect(spec.initialInput).toBeUndefined();
    // Nothing to stage — the command travels in the argv.
    expect(execCalls).toHaveLength(0);
  });

  it('uses the exec form for logs', async () => {
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    const spec = await buildSpritesAttach(box, 'logs', { service: 'web' });
    expect(spec.argv[1]).toBe('exec');
    expect(spec.argv.at(-1)).toContain('agentbox-ctl logs');
    expect(execCalls).toHaveLength(0);
  });

  it('forwards the host TERM in every mode', async () => {
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    expect((await buildSpritesAttach(box, 'shell')).env?.AGENTBOX_HOST_TERM).toBeTruthy();
    expect(
      (await buildSpritesAttach(box, 'agent', { detached: true })).env?.AGENTBOX_HOST_TERM,
    ).toBeTruthy();
  });

  it('fails clearly on a record with no sandboxId', async () => {
    const { buildSpritesAttach } = await import('../src/build-attach.js');
    await expect(
      buildSpritesAttach({ id: 'b', name: 'broken', provider: 'sprites' } as BoxRecord, 'shell'),
    ).rejects.toThrow(/has no sandboxId/);
  });
});
