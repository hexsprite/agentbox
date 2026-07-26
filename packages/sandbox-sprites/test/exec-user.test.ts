/**
 * `SpawnOptions` on the Sprites SDK has no `user` field and `sprite exec` runs
 * as the platform's unprivileged `sprite` account, so every command AgentBox
 * runs goes through sudo. These pin the argv that produces.
 */

import { describe, expect, it } from 'vitest';
import { buildExecArgv } from '../src/backend.js';

describe('buildExecArgv', () => {
  it('defaults to root, matching hetzner/digitalocean/daytona', () => {
    expect(buildExecArgv('echo hi')).toEqual([
      '-n',
      '-H',
      'bash',
      '-lc',
      'cd "$HOME" 2>/dev/null || true\necho hi',
    ]);
  });

  it('does not add a -u for an explicit root request', () => {
    expect(buildExecArgv('echo hi', { user: 'root' }).slice(0, 4)).toEqual([
      '-n',
      '-H',
      'bash',
      '-lc',
    ]);
  });

  it('drops privileges with -u for a named user', () => {
    expect(buildExecArgv('echo hi', { user: 'vscode' }).slice(0, 6)).toEqual([
      '-n',
      '-H',
      '-u',
      'vscode',
      'bash',
      '-lc',
    ]);
  });

  // Regression: `sprite exec` starts in the PLATFORM user's home
  // (/home/sprite), and `sudo -H` sets HOME without changing directory. Without
  // an explicit cd, a relative path from `agentbox shell <box> -- <cmd>`
  // resolved inside Fly's account instead of the box user's.
  it('cds to the target user home when no cwd is given', () => {
    expect(buildExecArgv('pwd', { user: 'vscode' }).at(-1)).toBe(
      'cd "$HOME" 2>/dev/null || true\npwd',
    );
  });

  it('prepends a cd for cwd, overriding the home default', () => {
    const argv = buildExecArgv('ls', { cwd: '/workspace' });
    expect(argv.at(-1)).toBe("cd '/workspace'\nls");
    expect(argv.at(-1)).not.toContain('$HOME');
  });

  it('single-quotes a cwd containing a quote', () => {
    const argv = buildExecArgv('ls', { cwd: "/tmp/it's here" });
    expect(argv.at(-1)).toBe("cd '/tmp/it'\\''s here'\nls");
  });

  it('exports env vars ahead of the command', () => {
    const argv = buildExecArgv('run', { cwd: '/w', env: { FOO: 'bar', BAZ: 'a b' } });
    expect(argv.at(-1)).toBe("cd '/w'\nexport FOO='bar'\nexport BAZ='a b'\nrun");
  });

  it('quotes an env value that tries to break out', () => {
    const argv = buildExecArgv('run', { cwd: '/w', env: { FOO: "'; rm -rf /; '" } });
    expect(argv.at(-1)).toBe("cd '/w'\nexport FOO=''\\''; rm -rf /; '\\'''\nrun");
  });

  // The value is quoted but the KEY is interpolated bare into a string that
  // runs as root — so a non-identifier key has to be refused, not escaped.
  it('rejects an env var name that is not a POSIX identifier', () => {
    expect(() => buildExecArgv('run', { env: { 'x;rm -rf /': '1' } })).toThrow(/invalid env var name/);
    expect(() => buildExecArgv('run', { env: { '1BAD': '1' } })).toThrow(/invalid env var name/);
    expect(() => buildExecArgv('run', { env: { 'a b': '1' } })).toThrow(/invalid env var name/);
  });

  it('accepts underscore-prefixed and digit-containing names', () => {
    expect(() => buildExecArgv('run', { env: { _A1: 'x' } })).not.toThrow();
  });

  it('combines cwd, env and user in that order', () => {
    const argv = buildExecArgv('make', {
      cwd: '/workspace',
      env: { CI: '1' },
      user: 'vscode',
    });
    expect(argv).toEqual([
      '-n',
      '-H',
      '-u',
      'vscode',
      'bash',
      '-lc',
      "cd '/workspace'\nexport CI='1'\nmake",
    ]);
  });
});
