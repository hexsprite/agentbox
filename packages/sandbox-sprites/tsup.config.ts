import { defineConfig } from 'tsup';

// Two ESM entries:
//   - `src/index.ts` — provider surface consumed by apps/cli.
//   - `src/cli.ts`   — `agentbox sprites login` subcommand.
//
// No CJS entry: unlike e2b/vercel, attach needs no standalone helper process.
// `sprite console` is a real terminal program, so `buildSpritesAttach` just
// hands node-pty an argv (see src/build-attach.ts).
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  dts: true,
  sourcemap: true,
  // commander + @clack/prompts are external (apps/cli bundles them at the root).
  // `@fly/sprites` stays external + a real dep: it declares `engines.node >=24`
  // while AgentBox's floor is 20.10, and keeping it out of the bundle means a
  // Node 20 host only ever loads it when the user actually picks this provider.
  external: ['commander', '@clack/prompts', '@fly/sprites'],
});
