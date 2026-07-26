/**
 * The sprites backend run against the shared `CloudBackend` conformance suite,
 * driven by an in-memory fake of the `@fly/sprites` SDK. That exercises the
 * real backend code — status mapping, the sudo wrap, retry, the URL cache —
 * without touching the network or spending money.
 *
 * Three capabilities are opted out of, each for a documented platform reason
 * rather than to make the suite pass:
 *
 *   - `pauseIsObservable: false` — sprites' `pause()` drops the host's tunnels
 *     and lets idle detection put the sandbox to sleep on its own schedule.
 *     Nothing changes server-side at the moment of the call, by design; see
 *     backend.ts's `pause`.
 *   - `distinctStopState: false` — follows from the above: stop IS pause.
 *   - `skipFileRoundTrip: false` is left ON — the fake filesystem is real
 *     enough to round-trip bytes, which is worth checking.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloudBackendConformance } from '../../sandbox-cloud/test/cloud-backend-conformance-suite.js';

/** Sprites the fake control plane knows about, keyed by name. */
interface FakeSprite {
  name: string;
  status: string;
  url: string;
  labels: string[];
  createdAt: Date;
  files: Map<string, Buffer>;
}

const sprites = new Map<string, FakeSprite>();

class NotFound extends Error {
  statusCode = 404;
  constructor(name: string) {
    super(`sprite ${name} not found`);
  }
}

function requireSprite(name: string): FakeSprite {
  const sp = sprites.get(name);
  if (!sp) throw new NotFound(name);
  return sp;
}

/**
 * Minimal stand-in for the SDK's `Sprite` + `SpriteFilesystem`. `execFileHTTP`
 * understands just enough shell to satisfy the conformance suite: it honours a
 * trailing `exit N`, and returns 0 otherwise.
 */
function fakeSpriteHandle(name: string) {
  return {
    get name() {
      return name;
    },
    execFileHTTP: async (file: string, args: string[]) => {
      const sp = requireSprite(name);
      // Any request wakes a cold sprite — that's the platform's behaviour and
      // the reason `start()` is just a health check.
      sp.status = 'running';
      expect(file).toBe('sudo');
      const script = args.at(-1) ?? '';
      const m = /(?:^|\n)exit (\d+)\s*$/.exec(script);
      const exitCode = m ? Number.parseInt(m[1]!, 10) : 0;
      return { exitCode, stdout: '', stderr: '' };
    },
    filesystem: () => ({
      writeFile: async (path: string, data: string | Buffer) => {
        requireSprite(name).files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data));
      },
      readFile: async (path: string) => {
        const f = requireSprite(name).files.get(path);
        if (!f) throw new NotFound(path);
        return f;
      },
      readdir: async (dir: string) => {
        const sp = requireSprite(name);
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        return [...sp.files.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => ({
            name: p.slice(prefix.length),
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          }));
      },
    }),
  };
}

const fakeClient = {
  createSprite: async (name: string) => {
    const sp: FakeSprite = {
      name,
      status: 'running',
      url: `https://${name}-test.sprites.app`,
      labels: ['agentbox'],
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
      files: new Map(),
    };
    sprites.set(name, sp);
    return { ...fakeSpriteHandle(name), url: sp.url };
  },
  getSprite: async (name: string) => {
    const sp = requireSprite(name);
    return { ...fakeSpriteHandle(name), status: sp.status, url: sp.url, labels: sp.labels, createdAt: sp.createdAt };
  },
  listAllSprites: async () =>
    [...sprites.values()].map((sp) => ({
      name: sp.name,
      status: sp.status,
      url: sp.url,
      labels: sp.labels,
      createdAt: sp.createdAt,
    })),
  deleteSprite: async (name: string) => {
    if (!sprites.has(name)) throw new NotFound(name);
    sprites.delete(name);
  },
  checkSprite: async (name: string) => {
    const sp = requireSprite(name);
    sp.status = 'running';
    return { spriteName: name, spriteId: name, status: sp.status, checkedAt: new Date() };
  },
  sprite: (name: string) => fakeSpriteHandle(name),
};

vi.mock('../src/sdk.js', () => ({
  spritesClient: () => fakeClient,
  resolveToken: () => 'tok-test',
  resolveOrg: () => 'test-org',
  resolveApiUrl: () => 'https://api.sprites.test',
  hasUsableCredentials: () => true,
  resetSpritesClient: () => {},
}));

// The base install is a two-minute apt/npm run against a real machine; the
// conformance suite is about the CloudBackend surface, not the installer (which
// install.test.ts covers directly).
vi.mock('../src/install.js', () => ({
  installSpriteBase: async () => {},
}));

// `previewUrl` for a non-ingress port spawns a detached `sprite proxy`. Stub the
// tunnel module so the suite stays free of child processes.
const forwarded = new Map<string, number>();
vi.mock('../src/sprite-proxy.js', () => ({
  forward: async (name: string, port: number) => {
    const key = `${name}:${String(port)}`;
    if (!forwarded.has(key)) forwarded.set(key, 40000 + forwarded.size);
    return forwarded.get(key)!;
  },
  refresh: async (name: string, port: number) => {
    const key = `${name}:${String(port)}`;
    forwarded.set(key, 41000 + forwarded.size);
    return forwarded.get(key)!;
  },
  close: async () => {},
  closeAll: async (name: string) => {
    for (const key of [...forwarded.keys()]) {
      if (key.startsWith(`${name}:`)) forwarded.delete(key);
    }
  },
  listForwards: () => [],
}));

const { spritesBackend } = await import('../src/backend.js');

runCloudBackendConformance(
  'sprites',
  () => {
    sprites.clear();
    forwarded.clear();
    return { backend: spritesBackend };
  },
  {
    // See the file header: pause is host-side (drop the tunnels) and the
    // sandbox sleeps on its own, so nothing flips server-side synchronously.
    pauseIsObservable: false,
    distinctStopState: false,
    // 8080 is the public URL; 8788 is the relay bridge, which goes through a
    // loopback forward. Both must mint a URL.
    previewPorts: [8080, 8788],
  },
);

describe('sprites backend specifics', () => {
  beforeEach(() => {
    sprites.clear();
    forwarded.clear();
  });

  it('labels every sprite so list() can ignore foreign ones', async () => {
    await spritesBackend.provision({ name: 'labelled', image: 'x' });
    sprites.set('someone-elses', {
      name: 'someone-elses',
      status: 'running',
      url: 'https://x.sprites.app',
      labels: [],
      createdAt: new Date(),
      files: new Map(),
    });
    const listed = (await spritesBackend.list!()).map((s) => s.sandboxId);
    expect(listed).toEqual(['labelled']);
  });

  it('serves the public URL for the ingress port and a loopback forward for anything else', async () => {
    const h = await spritesBackend.provision({ name: 'urls', image: 'x' });
    expect((await spritesBackend.previewUrl(h, 8080)).url).toBe('https://urls-test.sprites.app');
    expect((await spritesBackend.previewUrl(h, 8788)).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('re-reads the public URL on refresh but hands back a NEW local port', async () => {
    const h = await spritesBackend.provision({ name: 'refresh', image: 'x' });
    const before = (await spritesBackend.previewUrl(h, 8788)).url;
    const after = (await spritesBackend.refreshPreviewUrl!(h, 8788)).url;
    expect(after).not.toBe(before);
    // The public URL is permanent, so refreshing it is a no-op in effect.
    expect((await spritesBackend.refreshPreviewUrl!(h, 8080)).url).toBe(
      'https://refresh-test.sprites.app',
    );
  });

  it('drops the host tunnels on pause — that IS the pause', async () => {
    const h = await spritesBackend.provision({ name: 'paused', image: 'x' });
    await spritesBackend.previewUrl(h, 8788);
    expect(forwarded.size).toBe(1);
    await spritesBackend.pause(h);
    expect(forwarded.size).toBe(0);
  });

  it('reports a cold sprite as paused and wakes it on start', async () => {
    const h = await spritesBackend.provision({ name: 'sleepy', image: 'x' });
    requireSprite('sleepy').status = 'cold';
    expect(await spritesBackend.state(h)).toBe('paused');
    await spritesBackend.start(h);
    expect(await spritesBackend.state(h)).toBe('running');
  });

  it('refuses to boot from a checkpoint rather than silently ignoring it', async () => {
    await expect(
      spritesBackend.provision({ name: 'snap', image: 'x', snapshot: 'some-checkpoint' }),
    ).rejects.toThrow(/not supported/);
  });

  it('declares no snapshot primitives at all', () => {
    expect(spritesBackend.createSnapshot).toBeUndefined();
    expect(spritesBackend.deleteSnapshot).toBeUndefined();
    expect(spritesBackend.snapshotExists).toBeUndefined();
  });

  // There is no session deadline to push out, so the keepalive loop's renewal
  // half must skip this backend — while its idle-pause half still runs.
  it('declares no renewTimeout but does declare pause + inactivity', () => {
    expect(spritesBackend.renewTimeout).toBeUndefined();
    expect(spritesBackend.timeoutModel).toBe('inactivity');
    expect(typeof spritesBackend.pause).toBe('function');
  });

  it('sizes the sprite from a cpu-memory-disk string', async () => {
    const h = await spritesBackend.provision({ name: 'sized', image: 'x', size: '4-8-40' });
    expect(h.resources).toEqual({ cpu: 4, memory: 8, disk: 40 });
  });
});
