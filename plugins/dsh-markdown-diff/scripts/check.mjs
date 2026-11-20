/**
 * Local gate: syntax, the block splitter, the diff engine, the Host route, and
 * the built bundle's factory shape.
 *
 * `node --test` is unusable here because it spawns each test file with piped
 * stdio, which the DSH Windows sandbox refuses, so every suite is a plain script
 * that reports and exits on its own.
 *
 *   node scripts/check.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run one child Node script with inherited stdio and stop on failure. */
function run(label, script) {
  process.stdout.write(`\n== ${label}\n`);
  execFileSync(process.execPath, [join(root, script)], { stdio: 'inherit', cwd: root });
}

run('syntax', 'scripts/syntax.mjs');
run('block splitter', 'test/blocks.test.mjs');
run('frontmatter properties', 'test/frontmatter.test.mjs');
run('diff engine', 'test/diff.test.mjs');
run('inline diff', 'test/inline.test.mjs');
run('anchor alignment', 'test/anchor.test.mjs');
run('inline highlight', 'test/highlight.test.mjs');
run('address helpers', 'test/address.test.mjs');
run('review comments', 'test/comments.test.mjs');
run('review selection', 'test/selection.test.mjs');
run('comment shortcut', 'test/hotkey.test.mjs');
run('stylesheet install', 'test/styles.test.mjs');
run('host route', 'scripts/selfcheck.mjs');
run('branch comparison', 'test/refs.test.mjs');
run('bundle shape', 'scripts/bundle-check.mjs');
run('package for installation', 'test/package.test.mjs');

const bytes = Buffer.byteLength(readFileSync(join(root, 'lib', 'client.js'), 'utf8'));
console.log(`\nall checks passed (client bundle ${String(bytes)} bytes)`);
