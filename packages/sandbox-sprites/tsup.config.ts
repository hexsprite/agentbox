import { defineConfig } from 'tsup';

// Two builds:
//   - ESM `src/index.ts` + `src/cli.ts` — the provider surface consumed by
//     apps/cli, and the `agentbox sprites login` subcommand.
//   - CJS `src/attach-helper.ts` — a standalone Node process spawned by
//     `buildSpritesAttach` to bridge the host PTY to a correctly sized in-box
//     PTY over the SDK. CJS because it's invoked as `node <path>` (no
//     package-level `type: module` hint reaches a standalone .js); bundling
//     lets us ship one file.
//
// `@fly/sprites` stays external + a real dep: it declares `engines.node >= 24`
// while AgentBox's floor is 20.10, and keeping it out of the bundle means a
// Node 20 host only ever loads it when the user actually picks this provider.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    target: 'node20',
    clean: true,
    dts: true,
    sourcemap: true,
    // commander + @clack/prompts are external (apps/cli bundles them at the root).
    external: ['commander', '@clack/prompts', '@fly/sprites'],
  },
  {
    entry: { 'attach-helper': 'src/attach-helper.ts' },
    format: ['cjs'],
    target: 'node20',
    // Don't clean — the ESM build above already cleaned dist/.
    clean: false,
    // No d.ts for the standalone helper.
    dts: false,
    sourcemap: true,
    // `ws` is deliberately NOT external here: the helper is a standalone file
    // run as `node <path>` from the staged CLI runtime tree, where there is no
    // node_modules to resolve it from.
    external: ['commander', '@clack/prompts', '@fly/sprites'],
    noExternal: ['ws'],
  },
]);
