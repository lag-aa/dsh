/**
 * Build the browser bundle the DSH client module loader serves at
 * /plugins/dsh-markdown-diff/client.js.
 *
 * The output is the loader's factory form, mirroring the shipped bundles: the
 * banner opens the factory and pulls the platform modules from the frozen module
 * table with the synchronous `require` the loader passes in, the body is the
 * bundled plugin, and the footer returns the factory's exports. Keeping the
 * platform modules in the banner is also what lets esbuild resolve them: it never
 * sees a bare specifier it would have to bundle.
 *
 * esbuild's own `postinstall` cannot run inside the DSH Windows sandbox, so the
 * platform binary is executed directly and writes the output file itself; both
 * steps avoid the piped stdio the sandbox refuses.
 *
 *   node scripts/build.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'lib', 'client.js');
const moduleId = 'dsh-markdown-diff';
const externals = ['react', '@deepseek-ai/dsh-client-ui-primitives'];

/** Locate the platform binary pnpm extracted for the `esbuild` package. */
function esbuildBinary() {
  const candidates = [
    join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    join(root, 'node_modules', '.pnpm', '@esbuild+win32-x64@0.28.2', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    // The sibling plugin already has the binary unpacked; sharing it keeps this
    // package from needing an install of its own.
    join(root, '..', 'dsh-workspace-git', 'node_modules', '.pnpm', '@esbuild+win32-x64@0.28.2', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error('esbuild is not installed: run "pnpm add -D esbuild" in this package first');
  }
  return found;
}

mkdirSync(join(root, 'lib'), { recursive: true });

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(moduleId)}, factory: (require) => {`,
  'var React = require("react");',
  'var primitives = require("@deepseek-ai/dsh-client-ui-primitives");',
].join('\n');

const footer = [
  'var shipped = globalThis.__dshMarkdownDiff;',
  'delete globalThis.__dshMarkdownDiff;',
  'return shipped;',
  '} });',
].join('\n');

execFileSync(esbuildBinary(), [
  join(root, 'src', 'client.js'),
  '--bundle',
  '--format=iife',
  '--platform=browser',
  '--target=chrome120',
  '--minify',
  '--legal-comments=none',
  '--outfile=' + outFile,
  ...externals.map((name) => `--external:${name}`),
  '--banner:js=' + banner,
  '--footer:js=' + footer,
], { stdio: 'inherit', cwd: root });

console.log(`built ${outFile}`);
