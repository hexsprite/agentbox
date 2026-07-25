import { describe, expect, it } from 'vitest';
import { deployRefForVersion } from '../src/control-plane/deploy-ref.js';

/**
 * The deploy ref used to be a hardcoded `main`, which silently mismatched every
 * nightly CLI: the host wrote a full-hub `.env` + `reverse_proxy app:8787` while
 * the VPS built v0.27.1, whose container listens on :3000 behind Postgres. Caddy
 * then 502'd for the whole healthz window against a hub that was perfectly fine.
 */
describe('deployRefForVersion', () => {
  it('deploys the nightly branch for a nightly build', () => {
    expect(deployRefForVersion('0.28.0-nightly.202607251816')).toBe('nightly');
  });

  it('deploys its own tag for a released build', () => {
    expect(deployRefForVersion('0.27.1')).toBe('v0.27.1');
    expect(deployRefForVersion('1.0.0')).toBe('v1.0.0');
  });

  it('deploys nightly for a dev build with no injected version', () => {
    expect(deployRefForVersion('0.0.0-dev')).toBe('nightly');
  });

  it('never returns a bare branch name for a release (that was the bug)', () => {
    expect(deployRefForVersion('0.27.1')).not.toBe('main');
  });
});
