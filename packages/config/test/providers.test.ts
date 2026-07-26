import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDERS, PROVIDER_NAMES, CLOUD_PROVIDER_NAMES, perProviderConfigKey } from '../src/providers.js';
import { BUILT_IN_DEFAULTS, lookupKey } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(here, '..', 'schema', 'user-config.schema.json'), 'utf8'),
) as { properties: { box: { properties: Record<string, unknown> } } };
const boxSchemaKeys = schema.properties.box.properties;

const BASES = ['image', 'size', 'defaultCheckpoint'] as const;

describe('provider table is the single source of truth', () => {
  it('every provider has all three per-provider keys registered in KEY_REGISTRY', () => {
    for (const p of PROVIDERS) {
      for (const base of BASES) {
        const key = perProviderConfigKey(base, p.name);
        expect(lookupKey(key), `${key} missing from KEY_REGISTRY`).toBeDefined();
      }
    }
  });

  it('every per-provider key exists in the JSON schema (parser ↔ schema agreement)', () => {
    // The schema uses additionalProperties:false, so a KEY_REGISTRY entry
    // without a matching schema key would make config files fail validation.
    for (const p of PROVIDERS) {
      for (const base of BASES) {
        const leaf = perProviderConfigKey(base, p.name).slice('box.'.length);
        expect(boxSchemaKeys[leaf], `box.${leaf} missing from user-config.schema.json`).toBeDefined();
      }
    }
  });

  it('every per-provider key has a built-in default (EffectiveConfig is total)', () => {
    const box = BUILT_IN_DEFAULTS.box as unknown as Record<string, unknown>;
    for (const p of PROVIDERS) {
      for (const base of BASES) {
        const leaf = perProviderConfigKey(base, p.name).slice('box.'.length);
        expect(typeof box[leaf], `${leaf} missing from BUILT_IN_DEFAULTS.box`).toBe('string');
      }
    }
  });

  it('box.provider enum matches PROVIDER_NAMES exactly', () => {
    const desc = lookupKey('box.provider');
    expect(desc?.enumValues).toEqual([...PROVIDER_NAMES]);
  });

  it('docker is the only local provider; the rest are cloud', () => {
    expect(PROVIDERS.find((p) => p.name === 'docker')?.kind).toBe('local');
    expect(CLOUD_PROVIDER_NAMES).not.toContain('docker');
    expect([...CLOUD_PROVIDER_NAMES].sort()).toEqual(
      PROVIDERS.filter((p) => p.name !== 'docker')
        .map((p) => p.name)
        .sort(),
    );
  });

  // `loginHint` is what the install wizard shows next to each provider, so it has
  // to describe the flow the user is about to get. Daytona's said "approve a
  // browser sign-in link" — but its login never does OAuth: it offers to open the
  // dashboard's keys page and then prompts you to PASTE a key
  // (packages/sandbox-daytona/src/credentials.ts). Vercel is the one provider
  // that genuinely signs you in through a browser, and the wrong Daytona copy was
  // cloned from it — so pin both, or the fix rots back.
  describe('loginHint describes the real flow', () => {
    const hintFor = (name: string): string =>
      PROVIDERS.find((p) => p.name === name)?.loginHint ?? '';

    it('daytona says paste-a-key, not browser sign-in', () => {
      expect(hintFor('daytona')).toMatch(/paste an API key/i);
      expect(hintFor('daytona')).not.toMatch(/sign-?in|browser|oauth|approve/i);
    });

    it('vercel keeps its browser sign-in — it really does OAuth', () => {
      expect(hintFor('vercel')).toMatch(/browser sign-?in/i);
    });

    it('the other paste-a-token providers stay paste-a-token', () => {
      for (const name of ['hetzner', 'e2b', 'digitalocean', 'sprites']) {
        expect(hintFor(name)).toMatch(/paste/i);
        expect(hintFor(name)).not.toMatch(/browser|sign-?in/i);
      }
    });
  });

  // `rebuildMinutes` is rendered as "~<value> min" by the install wizard and the
  // stale-base prompt. A value carrying its own prose reads as garbage —
  // "~1-2.5 per box min" shipped exactly once and was visible on the first real
  // `agentbox sprites claude`.
  describe('rebuildMinutes renders inside "~<value> min"', () => {
    it('is a bare number or number range for every provider', () => {
      for (const p of PROVIDERS) {
        expect(p.rebuildMinutes, `${p.name}: ${p.rebuildMinutes}`).toMatch(
          /^\d+(\.\d+)?(-\d+(\.\d+)?)?$/,
        );
      }
    });
  });

  // Copy that says "your base image is out of date, rebuild the base?" is
  // nonsense for a provider that has no base image — the wizard branches on
  // this, so the flag has to stay attached to the right providers.
  describe('baseKind marks the providers with no base image', () => {
    it('only sprites installs its runtime per box', () => {
      const perBox = PROVIDERS.filter((p) => p.baseKind === 'per-box').map((p) => p.name);
      expect(perBox).toEqual(['sprites']);
    });

    it('every other provider bakes a reusable base', () => {
      for (const p of PROVIDERS) {
        if (p.name === 'sprites') continue;
        expect(p.baseKind ?? 'baked', p.name).toBe('baked');
      }
    });
  });
});
