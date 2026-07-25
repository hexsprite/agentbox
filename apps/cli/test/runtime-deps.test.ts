/**
 * Guards on the *published* dependency list. These can't be caught by running the
 * dev CLI: pnpm's workspace tree hoists packages the published tarball never
 * declares, so a missing runtime dep works locally and crashes for every user who
 * installs from npm.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string> };

describe('published runtime dependencies', () => {
  it('declares `ws`, which nothing here imports but the bundle needs at startup', () => {
    // `@daytona/sdk` depends on `isomorphic-ws`, whose `ws` is a PEER it does not
    // declare itself. npm installs no undeclared transitive peer, so without this
    // line `ws` is simply absent from a real install and the very first require in
    // dist/index.js throws `Cannot find module 'ws'` — every command, not just the
    // Daytona ones. pnpm's dev tree happens to have `ws` hoisted, which is exactly
    // why this survived to a published release (0.27.0 shipped broken this way).
    //
    // So: do NOT delete this as an unused dependency. Verify with
    // `npm pack` + an install into a clean prefix, never with the dev symlink.
    expect(pkg.dependencies?.ws).toBeTruthy();
  });
});
