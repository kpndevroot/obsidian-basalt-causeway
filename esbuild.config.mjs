import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const banner = `/*
This is a generated file. Source lives in src/ — see https://github.com/kpndevroot/obsidian-basalt
*/
`;

const production = process.argv[2] === 'production';

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  // Everything Obsidian injects at runtime. `obsidian` in particular must stay external:
  // it is an ambient API, not a package that ships in the bundle.
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    // Node's own list, rather than the `builtin-modules` package — it is the same data without
    // the dependency. Both spellings are listed because `builtinModules` reports bare names
    // ('fs'), while an import may equally be written 'node:fs', and esbuild matches externals
    // literally: a bare-only list silently bundles the prefixed form.
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: production,
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
