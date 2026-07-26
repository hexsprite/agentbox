/**
 * The Sprites status vocabulary, pinned. Derived from the live API on
 * 2026-07-26: `GET /v1/sprites` returns per-status counters named exactly
 * `running` / `warm` / `cold`, and a sprite observed going running → warm
 * (~1s after its last exec) → cold while idle.
 */

import { describe, expect, it } from 'vitest';
import { isNotFound, mapState, parseSpritesSize, safeSpriteName } from '../src/backend.js';

describe('mapState', () => {
  it('maps `running` to running', () => {
    expect(mapState('running')).toBe('running');
  });

  // `warm` is up and instantly usable — idle, not stopped. Reporting it as
  // paused would make `agentbox list` show every settled box as paused, since
  // a sprite goes warm about a second after its last command.
  it('maps `warm` to running', () => {
    expect(mapState('warm')).toBe('running');
  });

  // Asleep, but the filesystem and every running process survive (verified: a
  // listener bound before the sprite went cold was still bound afterwards) and
  // any API call wakes it. That is exactly AgentBox's `paused`.
  it('maps `cold` to paused', () => {
    expect(mapState('cold')).toBe('paused');
  });

  it('maps a missing status to missing', () => {
    expect(mapState(undefined)).toBe('missing');
  });

  // We only reach mapState by having successfully fetched the sprite, so it
  // demonstrably exists. Calling an unfamiliar status `missing` would invite
  // callers to treat a live, billable box as gone.
  it('maps an unrecognised status to running, not missing', () => {
    expect(mapState('provisioning')).toBe('running');
    expect(mapState('suspended')).toBe('running');
  });
});

describe('isNotFound', () => {
  it('detects a 404 statusCode', () => {
    expect(isNotFound({ statusCode: 404 })).toBe(true);
  });

  it('detects a 404 status', () => {
    expect(isNotFound({ status: 404 })).toBe(true);
  });

  it('detects a not-found message', () => {
    expect(isNotFound(new Error('sprite not found'))).toBe(true);
    expect(isNotFound(new Error('failed to get sprite (status 404): nope'))).toBe(true);
  });

  it('does not treat other failures as missing', () => {
    expect(isNotFound({ statusCode: 500 })).toBe(false);
    expect(isNotFound(new Error('rate limited'))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe('parseSpritesSize', () => {
  it('parses cpu-memory-disk', () => {
    expect(parseSpritesSize('4-8-40')).toEqual({ cpus: 4, ramMB: 8192, storageGB: 40 });
  });

  it('parses cpu-memory without a disk slot', () => {
    expect(parseSpritesSize('2-4')).toEqual({ cpus: 2, ramMB: 4096 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSpritesSize('  1-2  ')).toEqual({ cpus: 1, ramMB: 2048 });
  });

  // A foreign `box.size` (a hetzner server type, a vercel vCPU count) must fall
  // through to the defaults rather than provision something arbitrary.
  it('returns undefined for a size it does not recognise', () => {
    expect(parseSpritesSize('cx23')).toBeUndefined();
    expect(parseSpritesSize('4')).toBeUndefined();
    expect(parseSpritesSize('')).toBeUndefined();
    expect(parseSpritesSize(undefined)).toBeUndefined();
  });

  it('rejects zero-valued dimensions', () => {
    expect(parseSpritesSize('0-8')).toBeUndefined();
    expect(parseSpritesSize('4-0')).toBeUndefined();
  });

  it('drops a zero disk rather than requesting a 0GB volume', () => {
    expect(parseSpritesSize('2-4-0')).toEqual({ cpus: 2, ramMB: 4096 });
  });
});

describe('safeSpriteName', () => {
  // The name lands in a hostname: `<name>-<org>.sprites.app`.
  it('passes an already-safe name through', () => {
    expect(safeSpriteName('agentbox-smoke')).toBe('agentbox-smoke');
  });

  it('lowercases and replaces unsafe runs with a single dash', () => {
    expect(safeSpriteName('My Box/Name_1')).toBe('my-box-name-1');
  });

  it('trims leading and trailing dashes', () => {
    expect(safeSpriteName('__box__')).toBe('box');
  });

  it('truncates to a DNS-label-safe length', () => {
    expect(safeSpriteName('a'.repeat(80))).toHaveLength(50);
  });

  it('falls back rather than producing an empty name', () => {
    expect(safeSpriteName('///')).toBe('agentbox-box');
  });
});
