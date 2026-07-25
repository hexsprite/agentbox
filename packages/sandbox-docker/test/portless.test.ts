import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// execa is mocked so the tests never shell out to a real binary.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

import { existsSync } from 'node:fs';

import {
  detectPortless,
  ensurePortlessProxy,
  installPortless,
  portlessAlias,
  portlessBrowserEnv,
  portlessGetUrl,
  portlessInstallHint,
  portlessServiceHint,
  portlessServiceStatus,
  portlessStartHint,
  portlessDoctorRow,
  portlessUnalias,
  resetPortlessCache,
  resolvePortlessHostStateDir,
  startPortlessProxy,
  PORTLESS_PROXY_PORT,
} from '../src/portless.js';

interface ExecaResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

const ok = (stdout = ''): ExecaResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = ''): ExecaResult => ({ exitCode: 1, stdout: '', stderr });

// Per-command execa stubs. `detectPortless` shells out to `portless --version`
// and `pgrep`; the alias/get helpers shell out to `portless`. Tests set these.
let portlessResult: ExecaResult | Error;
let pgrepResult: ExecaResult;

let stateDir: string;
const originalStateDir = process.env['PORTLESS_STATE_DIR'];

beforeEach(async () => {
  resetPortlessCache();
  portlessResult = ok('0.13.0'); // installed by default
  pgrepResult = fail(); // no proxy process by default
  execaMock.mockReset();
  execaMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'pgrep') return pgrepResult;
    if (portlessResult instanceof Error) throw portlessResult;
    return portlessResult;
  });
  // Point the proxy-liveness probe at an empty dir so the proxy.pid path
  // reports nothing unless a test writes one in.
  stateDir = await mkdtemp(join(tmpdir(), 'agentbox-portless-test-'));
  process.env['PORTLESS_STATE_DIR'] = stateDir;
});

afterEach(async () => {
  resetPortlessCache();
  if (originalStateDir === undefined) delete process.env['PORTLESS_STATE_DIR'];
  else process.env['PORTLESS_STATE_DIR'] = originalStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

describe('detectPortless', () => {
  it('reports not-installed when `portless --version` fails', async () => {
    portlessResult = fail();
    expect(await detectPortless()).toEqual({ installed: false, proxyRunning: false });
  });

  it('reports installed and captures the version', async () => {
    portlessResult = ok('0.9.1');
    const r = await detectPortless();
    expect(r.installed).toBe(true);
    expect(r.version).toBe('0.9.1');
    expect(r.proxyRunning).toBe(false);
  });

  it('detects a running proxy from a live proxy.pid', async () => {
    await writeFile(join(stateDir, 'proxy.pid'), String(process.pid), 'utf8');
    expect((await detectPortless()).proxyRunning).toBe(true);
  });

  it('treats a stale proxy.pid as not running', async () => {
    // PID 2^31-1 is effectively never a live process.
    await writeFile(join(stateDir, 'proxy.pid'), '2147483647', 'utf8');
    expect((await detectPortless()).proxyRunning).toBe(false);
  });

  it('treats a foreign (root-owned) proxy.pid as running', async () => {
    // PID 1 always exists; the sudo/:443 proxy runs as root, so a non-root
    // probe gets EPERM — which still means the process is alive.
    await writeFile(join(stateDir, 'proxy.pid'), '1', 'utf8');
    expect((await detectPortless()).proxyRunning).toBe(true);
  });

  it('detects a foreground proxy via the process table when no proxy.pid exists', async () => {
    pgrepResult = ok('29219\n'); // `pgrep -f "portless proxy"` found one
    expect((await detectPortless()).proxyRunning).toBe(true);
  });

  it('never throws when execa rejects (binary missing)', async () => {
    portlessResult = new Error('spawn portless ENOENT');
    expect(await detectPortless()).toEqual({ installed: false, proxyRunning: false });
  });

  it('caches the result across calls', async () => {
    await detectPortless();
    await detectPortless();
    const portlessCalls = execaMock.mock.calls.filter((c) => c[0] === 'portless');
    expect(portlessCalls).toHaveLength(1);
  });
});

describe('portlessAlias / portlessUnalias', () => {
  it('portlessAlias returns true on exit 0', async () => {
    portlessResult = ok();
    expect(await portlessAlias('mybox', 54321)).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('portless', ['alias', 'mybox', '54321'], {
      reject: false,
    });
  });

  it('portlessAlias returns false on non-zero exit', async () => {
    portlessResult = fail('duplicate route');
    expect(await portlessAlias('mybox', 54321)).toBe(false);
  });

  it('portlessAlias never throws when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await portlessAlias('mybox', 54321)).toBe(false);
  });

  it('portlessUnalias returns true on exit 0', async () => {
    portlessResult = ok();
    expect(await portlessUnalias('mybox')).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('portless', ['alias', '--remove', 'mybox'], {
      reject: false,
    });
  });

  it('portlessUnalias never throws when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await portlessUnalias('mybox')).toBe(false);
  });
});

describe('portlessGetUrl', () => {
  it('returns the URL printed by `portless get`', async () => {
    portlessResult = ok('https://mybox.localhost\n');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });

  it('falls back to the deterministic URL on non-zero exit', async () => {
    portlessResult = fail('unknown route');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });

  it('falls back when stdout is not a URL', async () => {
    portlessResult = ok('not a url');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });

  it('falls back when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await portlessGetUrl('mybox')).toBe('https://mybox.localhost');
  });
});

describe('portlessBrowserEnv', () => {
  it('maps the box hostname to host.docker.internal for docker (mapTarget option)', () => {
    expect(portlessBrowserEnv('mybox', { mapTarget: 'host.docker.internal' })).toEqual({
      AGENT_BROWSER_ARGS: '--host-resolver-rules=MAP mybox.localhost host.docker.internal',
      AGENT_BROWSER_IGNORE_HTTPS_ERRORS: '1',
    });
  });

  it('maps to 127.0.0.1 for hetzner (box is the VPS, WebProxy on loopback)', () => {
    expect(portlessBrowserEnv('mybox', { mapTarget: '127.0.0.1' })).toEqual({
      AGENT_BROWSER_ARGS: '--host-resolver-rules=MAP mybox.localhost 127.0.0.1',
      AGENT_BROWSER_IGNORE_HTTPS_ERRORS: '1',
    });
  });
});

describe('hints', () => {
  it('install hint points at npm', () => {
    expect(portlessInstallHint()).toBe('npm install -g portless');
  });

  it('start hint starts the proxy', () => {
    expect(portlessStartHint()).toBe('portless proxy start');
  });
});

describe('installPortless / startPortlessProxy', () => {
  it('installPortless runs `npm install -g portless` and returns true on exit 0', async () => {
    portlessResult = ok();
    expect(await installPortless()).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('npm', ['install', '-g', 'portless'], {
      reject: false,
    });
  });

  it('installPortless returns false on non-zero exit', async () => {
    portlessResult = fail();
    expect(await installPortless()).toBe(false);
  });

  it('installPortless never throws when execa rejects', async () => {
    portlessResult = new Error('npm not found');
    expect(await installPortless()).toBe(false);
  });

  it('startPortlessProxy starts a no-TLS proxy on the no-root port', async () => {
    portlessResult = ok();
    expect(await startPortlessProxy()).toBe(true);
    expect(execaMock).toHaveBeenCalledWith(
      'portless',
      ['proxy', 'start', '--no-tls', '-p', '1355'],
      { reject: false },
    );
  });

  it('startPortlessProxy never throws when execa rejects', async () => {
    portlessResult = new Error('ENOENT');
    expect(await startPortlessProxy()).toBe(false);
  });
});

describe('resolvePortlessHostStateDir', () => {
  it('an explicit override wins outright', async () => {
    expect(await resolvePortlessHostStateDir('/custom/portless')).toBe('/custom/portless');
  });

  it('falls back to $PORTLESS_STATE_DIR when no override is given', async () => {
    // beforeEach sets PORTLESS_STATE_DIR to the temp stateDir.
    expect(await resolvePortlessHostStateDir()).toBe(stateDir);
  });

  it('returns an absolute path when nothing is configured', async () => {
    delete process.env['PORTLESS_STATE_DIR'];
    const r = await resolvePortlessHostStateDir();
    expect(r.startsWith('/')).toBe(true);
  });
});

describe('portlessDoctorRow', () => {
  it('warns with the install hint when Portless is not installed', () => {
    const row = portlessDoctorRow({ installed: false, proxyRunning: false });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('not installed');
    expect(row.hint).toContain(portlessInstallHint());
  });

  it('warns with the start hint when installed but the proxy is down', () => {
    const row = portlessDoctorRow({ installed: true, version: '0.13.0', proxyRunning: false });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('proxy not running');
    expect(row.hint).toContain(portlessStartHint());
  });

  it('is ok and shows the version when the proxy is running', () => {
    const row = portlessDoctorRow({ installed: true, version: '0.13.0', proxyRunning: true });
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('0.13.0');
    expect(row.hint).toBeUndefined();
  });

  it('is ok without a version string when none was reported', () => {
    const row = portlessDoctorRow({ installed: true, proxyRunning: true });
    expect(row.status).toBe('ok');
    expect(row.detail).toBe('running');
  });

  it('stays ok but flags a running proxy with no OS service', () => {
    const row = portlessDoctorRow({ installed: true, proxyRunning: true }, { installed: false });
    expect(row.status).toBe('ok');
    expect(row.detail).toContain("won't survive a reboot");
    expect(row.hint).toContain(portlessServiceHint());
  });

  it('says nothing extra when the OS service is installed', () => {
    const row = portlessDoctorRow({ installed: true, proxyRunning: true }, { installed: true });
    expect(row.detail).toBe('running');
    expect(row.hint).toBeUndefined();
  });
});

describe('portlessServiceStatus', () => {
  it('parses `Installed: yes`', async () => {
    portlessResult = ok(
      [
        'portless service',
        '  Manager state: running',
        '  Installed: yes',
        '  Proxy on 443: responding',
      ].join('\n'),
    );
    expect(await portlessServiceStatus()).toEqual({ installed: true });
    expect(execaMock).toHaveBeenCalledWith('portless', ['service', 'status'], { reject: false });
  });

  it('parses `Installed: no`', async () => {
    portlessResult = ok(['portless service', '  Installed: no'].join('\n'));
    expect(await portlessServiceStatus()).toEqual({ installed: false });
  });

  it('reports not-installed when the output has no Installed line', async () => {
    // A future Portless could reword this; the fallback must not claim a
    // service exists, since that only suppresses a nudge.
    portlessResult = ok('something else entirely');
    expect((await portlessServiceStatus()).installed).toBe(
      process.platform === 'darwin'
        ? existsSync('/Library/LaunchDaemons/sh.portless.proxy.plist')
        : false,
    );
  });

  it('never throws when the binary is missing', async () => {
    portlessResult = new Error('spawn portless ENOENT');
    await expect(portlessServiceStatus()).resolves.toBeDefined();
  });
});

describe('ensurePortlessProxy', () => {
  it('does nothing when Portless is not installed', async () => {
    portlessResult = fail();
    const state = await ensurePortlessProxy();
    expect(state).toEqual({ installed: false, proxyRunning: false });
    expect(execaMock.mock.calls.some((c) => c[1]?.includes?.('start'))).toBe(false);
  });

  it('does nothing when a proxy is already running', async () => {
    await writeFile(join(stateDir, 'proxy.pid'), String(process.pid), 'utf8');
    const state = await ensurePortlessProxy();
    expect(state.proxyRunning).toBe(true);
    const starts = execaMock.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'proxy');
    expect(starts).toHaveLength(0);
  });

  it('starts the no-root proxy when none is running', async () => {
    await ensurePortlessProxy();
    expect(execaMock).toHaveBeenCalledWith(
      'portless',
      ['proxy', 'start', '--no-tls', '-p', String(PORTLESS_PROXY_PORT)],
      { reject: false },
    );
  });

  it('never asks for a password unless allowRootPrompt is set', async () => {
    await ensurePortlessProxy();
    expect(execaMock.mock.calls.some((c) => c[0] === 'osascript')).toBe(false);
  });

  it('reports the proxy as running once the start succeeds', async () => {
    // The post-start re-probe is what tells the caller it worked, so simulate a
    // proxy that writes its pid file the way a real daemon start does.
    execaMock.mockImplementation(async (cmd: string, args?: readonly string[]) => {
      if (cmd === 'pgrep') return pgrepResult;
      if (Array.isArray(args) && args[0] === 'proxy' && args[1] === 'start') {
        await writeFile(join(stateDir, 'proxy.pid'), String(process.pid), 'utf8');
        return ok();
      }
      return portlessResult as ExecaResult;
    });
    expect((await ensurePortlessProxy()).proxyRunning).toBe(true);
  });
});
