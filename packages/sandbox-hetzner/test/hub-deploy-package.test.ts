import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { controlPlaneCloudInit } from '../src/cloud-init.js';
import { hubContainerPort, isFullHubCompose } from '../src/control-plane-deploy.js';
import {
  HUB_DEPLOY_ASSETS,
  hubDeployCandidates,
  resolveHubDeployAssets,
} from '../src/hub-deploy-assets.js';

const FAKE_PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILongTextForKey agentbox/test';
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentbox-hub-deploy-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

/**
 * Package mode ships the compose stack from the host, because there is no repo
 * on the VPS to read it from. Missing files would otherwise surface as an scp
 * failure mid-deploy, after a billable server already exists.
 */
describe('resolveHubDeployAssets', () => {
  it('prefers the staged CLI runtime tree over the monorepo source', () => {
    const staged = tmp();
    for (const asset of HUB_DEPLOY_ASSETS) writeFileSync(join(staged, asset), 'x');
    const resolved = resolveHubDeployAssets({ stagedRoot: staged, repoRoot: REPO_ROOT });
    for (const asset of HUB_DEPLOY_ASSETS) {
      expect(resolved[asset]).toBe(join(staged, asset));
    }
  });

  it('falls back to apps/hub in a workspace dev build', () => {
    const resolved = resolveHubDeployAssets({
      stagedRoot: join(tmp(), 'nope'),
      repoRoot: REPO_ROOT,
    });
    expect(resolved['Dockerfile.package']).toBe(
      resolve(REPO_ROOT, 'apps', 'hub', 'Dockerfile.package'),
    );
  });

  it('throws listing every path tried when nothing resolves', () => {
    const empty = tmp();
    expect(() => resolveHubDeployAssets({ stagedRoot: join(empty, 'a'), repoRoot: empty })).toThrow(
      /could not resolve the control-box deploy assets[\s\S]*docker-compose\.yml/,
    );
  });

  it('always offers the monorepo path as a candidate, staged tree first', () => {
    const cands = hubDeployCandidates('docker-compose.yml', {
      stagedRoot: '/staged',
      repoRoot: '/repo',
    });
    expect(cands).toEqual(['/staged/docker-compose.yml', '/repo/apps/hub/docker-compose.yml']);
  });
});

/**
 * Both modes build the `app` service from the SAME docker-compose.yml — package
 * mode only layers an override that swaps the build block. So the file the deploy
 * ships must keep satisfying the two things the deploy reads out of it.
 */
describe('the shipped docker-compose.yml still drives the deploy', () => {
  it('publishes 8787 to 8787 (the Caddy upstream port) and wires the data dir', async () => {
    const body = await readFile(resolve(REPO_ROOT, 'apps', 'hub', 'docker-compose.yml'), 'utf8');
    expect(hubContainerPort(body)).toBe(8787);
    expect(isFullHubCompose(body)).toBe(true);
  });

  it('the package override replaces the build block and demands a spec', async () => {
    const body = await readFile(
      resolve(REPO_ROOT, 'apps', 'hub', 'docker-compose.package.yml'),
      'utf8',
    );
    expect(body).toContain('dockerfile: Dockerfile.package');
    expect(body).toContain('context: .');
    // `:?` so a deploy that forgot AGENTBOX_SPEC fails loudly at compose time
    // rather than building `@madarco/agentbox@` and 404ing from npm.
    expect(body).toMatch(/AGENTBOX_SPEC: \$\{AGENTBOX_SPEC:\?/);
  });

  it('the package Dockerfile pins the spec and sets the runtime-root envs', async () => {
    const body = await readFile(resolve(REPO_ROOT, 'apps', 'hub', 'Dockerfile.package'), 'utf8');
    expect(body).toContain('ARG AGENTBOX_SPEC');
    expect(body).toContain('@madarco/agentbox@${AGENTBOX_SPEC}');
    // Without NODE_ENV=production Next takes the dev path and dies with
    // "Couldn't find any `pages` or `app` directory" — the standalone has neither.
    expect(body).toContain('ENV NODE_ENV=production');
    // Fingerprint + shared-asset resolution: a container-spawned hub has no parent
    // CLI process to inherit these from.
    expect(body).toContain('ENV AGENTBOX_RUNTIME_ROOT=/opt/agentbox-cli/runtime');
    expect(body).toContain('ENV AGENTBOX_CLI_RUNTIME_DIR=/opt/agentbox-cli/runtime');
    expect(body).toContain('ENV AGENTBOX_CLI_ENTRY=/opt/agentbox-cli/dist/index.js');
    expect(body).toContain('runtime/hub/apps/hub/server.js');
  });
});

describe('controlPlaneCloudInit', () => {
  it('clones the repo when a ref is named (source mode)', () => {
    const yaml = controlPlaneCloudInit({
      sshPubkey: FAKE_PUBKEY,
      repo: { url: 'https://github.com/madarco/agentbox.git', ref: 'nightly' },
    });
    expect(yaml).toContain('git clone --depth 1 --branch');
    expect(yaml).toContain("'nightly'");
    expect(yaml).toContain('/opt/agentbox');
  });

  it('skips the clone entirely in package mode, keeping docker + git', () => {
    const yaml = controlPlaneCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml).not.toContain('git clone');
    expect(yaml).toContain('get.docker.com');
    // git stays: the resident create worker clones repos VPS-side.
    expect(yaml).toContain('apt-get install -y git');
    expect(yaml.startsWith('#cloud-config')).toBe(true);
    expect(yaml).toContain(`- "${FAKE_PUBKEY}"`);
  });
});

/** The staging script must actually put the three files where the resolver looks. */
describe('stage-runtime layout', () => {
  it('resolves from a staged tree shaped like runtime/hub-deploy/', () => {
    const runtime = tmp();
    const hubDeploy = join(runtime, 'hub-deploy');
    mkdirSync(hubDeploy);
    for (const asset of HUB_DEPLOY_ASSETS) writeFileSync(join(hubDeploy, asset), 'x');
    const resolved = resolveHubDeployAssets({ stagedRoot: hubDeploy, repoRoot: REPO_ROOT });
    expect(Object.keys(resolved).sort()).toEqual([...HUB_DEPLOY_ASSETS].sort());
  });
});
