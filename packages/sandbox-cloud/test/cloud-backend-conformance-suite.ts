/**
 * Behavioral conformance suite for the {@link CloudBackend} seam. Every backend
 * (the in-memory mock, sprites, and any provider plugin) can run the SAME
 * assertions so they stay interchangeable under `createCloudProvider`.
 *
 * Modeled on `packages/relay/test/store-conformance-suite.ts`, which does the
 * same job for the `Store` seam. It replaces the "copy-paste
 * mock-backend-contract.test.ts and swap the factory" advice that
 * docs/cloud-providers.md and docs/provider-plugins.md used to give — copies
 * drift, and the `test/contract.ts` that mock-backend.ts advertised never
 * actually existed.
 *
 * The suite asserts only what the interface genuinely promises, and detects
 * optional capabilities by presence rather than assuming them. Where a real
 * backend legitimately cannot satisfy an assertion (no snapshot primitive, no
 * stop distinct from pause), say so through {@link CloudBackendCapabilities}
 * instead of dropping the whole suite.
 *
 * Pure — no docker, no network — as long as the injected factory is (a real
 * backend should be driven against a stubbed SDK).
 */

import { describe, expect, it } from 'vitest';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

export interface CloudBackendCapabilities {
  /**
   * `stop()` reaches a state distinguishable from `pause()`. False for backends
   * where the two are the same operation (e2b, sprites), which is allowed:
   * `CloudBackend.pause` documents "backends without pause map it to stop".
   */
  distinctStopState?: boolean;
  /**
   * `pause()` is observable through `state()`. False when pause is host-side
   * only — sprites' pause drops the host's tunnels and lets the sandbox fall
   * asleep on its own schedule, so the state doesn't change synchronously.
   */
  pauseIsObservable?: boolean;
  /**
   * `destroy()` makes the sandbox report `missing`. True for essentially every
   * backend; the escape hatch exists for one that defers deletion.
   */
  destroyIsImmediate?: boolean;
  /** Ports the backend can mint a preview URL for. Defaults to `[8080]`. */
  previewPorts?: number[];
  /** Skip the upload/download round-trip (backend has no real filesystem). */
  skipFileRoundTrip?: boolean;
  /**
   * `exec` actually runs the command it is given. False for a simulator that
   * records the call and returns a canned result — it can still be checked for
   * result SHAPE, but not for honouring an exit code.
   */
  execRunsCommands?: boolean;
}

export interface CloudBackendUnderTest {
  backend: CloudBackend;
  /** Torn down after each test. */
  cleanup?: () => Promise<void> | void;
}

const DEFAULTS: Required<Omit<CloudBackendCapabilities, 'previewPorts'>> & {
  previewPorts: number[];
} = {
  distinctStopState: true,
  pauseIsObservable: true,
  destroyIsImmediate: true,
  previewPorts: [8080],
  skipFileRoundTrip: false,
  execRunsCommands: true,
};

export function runCloudBackendConformance(
  name: string,
  factory: () => CloudBackendUnderTest | Promise<CloudBackendUnderTest>,
  caps: CloudBackendCapabilities = {},
): void {
  const c = { ...DEFAULTS, ...caps };

  /** Run `fn` against a fresh backend, then clean up. */
  async function withBackend(
    fn: (backend: CloudBackend) => Promise<void>,
  ): Promise<void> {
    const under = await factory();
    try {
      await fn(under.backend);
    } finally {
      await under.cleanup?.();
    }
  }

  async function provision(backend: CloudBackend, boxName = 'conformance'): Promise<CloudHandle> {
    return backend.provision({ name: boxName, image: 'conformance/base' });
  }

  describe(`CloudBackend conformance: ${name}`, () => {
    describe('identity', () => {
      it('reports a non-empty name', async () => {
        await withBackend(async (backend) => {
          expect(typeof backend.name).toBe('string');
          expect(backend.name.length).toBeGreaterThan(0);
        });
      });

      it('declares a timeout model the keepalive loop understands, if any', async () => {
        await withBackend(async (backend) => {
          if (backend.timeoutModel !== undefined) {
            expect(['absolute', 'inactivity']).toContain(backend.timeoutModel);
          }
        });
      });

      // The scaffold wires this to the in-box WebProxy AND resolves
      // `agentbox url --kind=web` through it, so a nonsense value breaks both.
      it('declares a valid webProxyPort, if any', async () => {
        await withBackend(async (backend) => {
          if (backend.webProxyPort !== undefined) {
            expect(Number.isInteger(backend.webProxyPort)).toBe(true);
            expect(backend.webProxyPort).toBeGreaterThan(0);
            expect(backend.webProxyPort).toBeLessThan(65536);
          }
        });
      });

      // An `inactivity` backend whose idle box we can't stop bills forever:
      // the host's own polling resets the provider's clock, so the keepalive
      // loop has to do the stopping, and it needs `pause` to do it with.
      it('provides pause when its timeout model is inactivity', async () => {
        await withBackend(async (backend) => {
          if (backend.timeoutModel === 'inactivity') {
            expect(typeof backend.pause).toBe('function');
          }
        });
      });
    });

    describe('provision', () => {
      it('returns a handle carrying a non-empty sandboxId', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          expect(typeof h.sandboxId).toBe('string');
          expect(h.sandboxId.length).toBeGreaterThan(0);
        });
      });

      it('reports the provisioned sandbox as running', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          expect(await backend.state(h)).toBe('running');
        });
      });

      it('resolves the fresh sandbox through get()', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          const got = await backend.get(h.sandboxId);
          expect(got?.sandboxId).toBe(h.sandboxId);
        });
      });

      it('reports any resources it echoes back as positive numbers', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          for (const v of [h.resources?.cpu, h.resources?.memory, h.resources?.disk]) {
            if (v !== undefined) expect(v).toBeGreaterThan(0);
          }
        });
      });
    });

    describe('lifecycle', () => {
      it('get() returns null for a sandbox that never existed', async () => {
        await withBackend(async (backend) => {
          expect(await backend.get('definitely-not-a-real-sandbox-id')).toBeNull();
        });
      });

      it('state() reports missing for a sandbox that never existed', async () => {
        await withBackend(async (backend) => {
          expect(await backend.state({ sandboxId: 'definitely-not-a-real-sandbox-id' })).toBe(
            'missing',
          );
        });
      });

      it('pause then resume returns the sandbox to running', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          await backend.pause(h);
          if (c.pauseIsObservable) expect(await backend.state(h)).toBe('paused');
          await backend.resume(h);
          expect(await backend.state(h)).toBe('running');
        });
      });

      it('stop then start returns the sandbox to running', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          await backend.stop(h);
          if (c.distinctStopState && c.pauseIsObservable) {
            expect(await backend.state(h)).toBe('stopped');
          }
          await backend.start(h);
          expect(await backend.state(h)).toBe('running');
        });
      });

      it('start on an already-running sandbox is harmless', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          await backend.start(h);
          await backend.start(h);
          expect(await backend.state(h)).toBe('running');
        });
      });

      it('destroy removes the sandbox', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          await backend.destroy(h);
          if (c.destroyIsImmediate) {
            expect(await backend.state(h)).toBe('missing');
            expect(await backend.get(h.sandboxId)).toBeNull();
          }
        });
      });

      // `destroy` is called on cleanup paths that may already have run, and on
      // records whose sandbox was deleted out-of-band. A throw there strands
      // the local box record.
      it('destroy is idempotent — destroying twice does not throw', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          await backend.destroy(h);
          await expect(backend.destroy(h)).resolves.not.toThrow();
        });
      });

      it('destroying a sandbox that never existed does not throw', async () => {
        await withBackend(async (backend) => {
          await expect(
            backend.destroy({ sandboxId: 'definitely-not-a-real-sandbox-id' }),
          ).resolves.not.toThrow();
        });
      });
    });

    describe('exec', () => {
      it('returns exitCode + stdout + stderr as a result, not a throw', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          const r = await backend.exec(h, 'echo hi');
          expect(typeof r.exitCode).toBe('number');
          expect(typeof r.stdout).toBe('string');
          expect(typeof r.stderr).toBe('string');
        });
      });

      // The whole scaffold branches on exitCode; a backend that throws on
      // non-zero (as some SDKs do natively) turns every failed probe into an
      // unhandled error deep inside create.
      it('reports a non-zero exit as a result rather than throwing', async () => {
        if (!c.execRunsCommands) return;
        await withBackend(async (backend) => {
          const h = await provision(backend);
          const r = await backend.exec(h, 'exit 3');
          expect(r.exitCode).not.toBe(0);
        });
      });

      it('accepts cwd, env and user without throwing', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          const r = await backend.exec(h, 'true', {
            cwd: '/workspace',
            env: { AGENTBOX_CONFORMANCE: '1' },
            user: 'root',
          });
          expect(typeof r.exitCode).toBe('number');
        });
      });
    });

    describe('files', () => {
      it('lists a directory as {name, isDir} entries', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          const entries = await backend.listFiles(h, '/tmp');
          expect(Array.isArray(entries)).toBe(true);
          for (const e of entries) {
            expect(typeof e.name).toBe('string');
            expect(typeof e.isDir).toBe('boolean');
          }
        });
      });

      it('round-trips a file through upload then download', async () => {
        if (c.skipFileRoundTrip) return;
        const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        await withBackend(async (backend) => {
          const h = await provision(backend);
          const dir = mkdtempSync(join(tmpdir(), 'agentbox-conformance-'));
          const src = join(dir, 'src.txt');
          const dst = join(dir, 'dst.txt');
          const body = 'agentbox conformance payload\n';
          writeFileSync(src, body);
          await backend.uploadFile(h, src, '/tmp/agentbox-conformance.txt');
          await backend.downloadFile(h, '/tmp/agentbox-conformance.txt', dst);
          expect(readFileSync(dst, 'utf8')).toBe(body);
        });
      });
    });

    describe('preview URLs', () => {
      it('mints a URL for each supported port', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          for (const port of c.previewPorts) {
            const p = await backend.previewUrl(h, port);
            expect(p.url).toMatch(/^https?:\/\//);
          }
        });
      });

      it('is stable across repeated calls for the same port', async () => {
        await withBackend(async (backend) => {
          const h = await provision(backend);
          const port = c.previewPorts[0]!;
          const a = await backend.previewUrl(h, port);
          const b = await backend.previewUrl(h, port);
          expect(a.url).toBe(b.url);
        });
      });

      it('refreshPreviewUrl, when present, returns a usable URL', async () => {
        await withBackend(async (backend) => {
          if (!backend.refreshPreviewUrl) return;
          const h = await provision(backend);
          const port = c.previewPorts[0]!;
          await backend.previewUrl(h, port);
          const fresh = await backend.refreshPreviewUrl(h, port);
          expect(fresh.url).toMatch(/^https?:\/\//);
        });
      });

      it('signedPreviewUrl, when present, returns a usable URL', async () => {
        await withBackend(async (backend) => {
          if (!backend.signedPreviewUrl) return;
          const h = await provision(backend);
          const p = await backend.signedPreviewUrl(h, c.previewPorts[0]!, 60);
          expect(p.url).toMatch(/^https?:\/\//);
        });
      });
    });

    describe('optional capabilities', () => {
      it('list(), when present, includes a sandbox this backend provisioned', async () => {
        await withBackend(async (backend) => {
          if (!backend.list) return;
          const h = await provision(backend, 'conformance-listed');
          const ids = (await backend.list()).map((s) => s.sandboxId);
          expect(ids).toContain(h.sandboxId);
        });
      });

      it('list(), when present, reports only states from the CloudState vocabulary', async () => {
        await withBackend(async (backend) => {
          if (!backend.list) return;
          await provision(backend);
          for (const s of await backend.list()) {
            if (s.state !== undefined) {
              expect(['running', 'paused', 'stopped', 'missing']).toContain(s.state);
            }
          }
        });
      });

      // A backend that can create snapshots but not probe or delete them
      // leaves the checkpoint machinery unable to prune a dangling manifest.
      it('snapshot support is all-or-nothing enough to be usable', async () => {
        await withBackend(async (backend) => {
          if (!backend.createSnapshot) {
            // Deliberately absent is fine; the scaffold raises its own clear
            // "doesn't support snapshots" error. But don't half-declare it.
            expect(backend.deleteSnapshot).toBeUndefined();
            return;
          }
          expect(typeof backend.deleteSnapshot).toBe('function');
        });
      });

      it('deleteSnapshot, when present, is idempotent for an unknown name', async () => {
        await withBackend(async (backend) => {
          if (!backend.deleteSnapshot) return;
          await expect(
            backend.deleteSnapshot('definitely-not-a-real-snapshot'),
          ).resolves.not.toThrow();
        });
      });

      it('snapshotExists, when present, returns false rather than throwing for an unknown name', async () => {
        await withBackend(async (backend) => {
          if (!backend.snapshotExists) return;
          expect(await backend.snapshotExists('definitely-not-a-real-snapshot')).toBe(false);
        });
      });

      it('ensureVolume, when present, is stable for the same name', async () => {
        await withBackend(async (backend) => {
          if (!backend.ensureVolume) return;
          const a = await backend.ensureVolume('agentbox-conformance');
          const b = await backend.ensureVolume('agentbox-conformance');
          expect(a.volumeId).toBe(b.volumeId);
        });
      });

      it('attachArgv, when present, returns a program plus arguments', async () => {
        await withBackend(async (backend) => {
          if (!backend.attachArgv) return;
          const h = await provision(backend);
          const argv = await backend.attachArgv(h);
          expect(argv.length).toBeGreaterThan(0);
          expect(typeof argv[0]).toBe('string');
          expect(argv[0]!.length).toBeGreaterThan(0);
        });
      });
    });
  });
}
