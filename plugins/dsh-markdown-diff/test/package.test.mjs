/**
 * Check that the package can be installed from somewhere other than this checkout.
 *
 * A linked directory hides every packaging mistake: `files` does not filter a
 * `link:` dependency, and a missing patch, locale or icon costs nothing until the
 * day the package is installed from a registry or a git commit. So this suite
 * reads the manifest the way an installer does — every path the manifest names —
 * and checks that the declared display resources exist and carry a title.
 *
 *   node test/package.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Whether a path exists as a file or directory, resolved against the package root. */
function has(path) {
  return path !== undefined && path !== '' && existsSync(join(root, path));
}

// The two entries the Host loads: the patch that inserts the plugin row, and the
// module the row names. A published copy without either is not a bundle.
assert.ok(has(manifest.dsh?.bundle?.patch), 'the bundle patch must be inside the package');
assert.ok(has(manifest.main), 'the Host entry `main` must exist');
assert.ok(has(manifest.exports?.['.']), 'the exported Host entry must exist');
assert.ok(has(manifest.exports?.['./client']), 'the exported client half must exist');
const clientBytes = statSync(join(root, 'lib', 'client.js')).size;
assert.ok(clientBytes > 0, 'the client half must be the built bundle, not an empty file');
console.log('ok   the patch, the Host entry and the built client half are inside the package');

// `files` decides what a packed copy contains, so every path the manifest mentions
// elsewhere has to be reachable through it. Directories are listed by name here,
// which is what npm accepts.
const listed = manifest.files ?? [];
assert.ok(listed.includes('lib'), 'lib must be listed: the built halves are not generated on install');
assert.ok(listed.includes(String(manifest.dsh?.bundle?.patch).replace(/^\.\//, '')),
  'the patch named by dsh.bundle.patch must be listed in files');
assert.ok(listed.includes('icon.svg'), 'the icon must be listed in files');
assert.ok(listed.includes('locale/*.json'), 'the locale files must be listed in files');
assert.ok(listed.includes('LICENSE'), 'the license text must be listed in files: package.json declares MIT');
console.log('ok   files lists everything the manifest names, including the patch');

// The display resources: without them the plugin row falls back to the package
// name and the panel's default artwork.
const iconPath = manifest.icon ?? manifest.exports?.['./icon'];
assert.ok(has(iconPath), 'the icon file named by the manifest must exist');
const icon = readFileSync(join(root, iconPath), 'utf8');
assert.match(icon, /<svg[^>]*viewBox="0 0 36 36"/, 'the icon is a 36-unit canvas, the size Plugin Manager expects');
for (const forbidden of ['<script', '<style', '<text', '<image', 'foreignObject']) {
  assert.ok(!icon.includes(forbidden), `a plugin icon must stay self-contained: ${forbidden} is not allowed`);
}
console.log('ok   the icon is a self-contained 36-unit SVG');

const locales = readdirSync(join(root, 'locale')).filter((name) => name.endsWith('.json'));
assert.ok(locales.length > 0, 'at least one locale file must carry the display metadata');
for (const name of locales) {
  const path = join('locale', name);
  const meta = JSON.parse(readFileSync(join(root, path), 'utf8')).meta ?? {};
  assert.ok(typeof meta.title === 'string' && meta.title !== '', `${path} must carry meta.title`);
  assert.ok(typeof meta.description === 'string' && meta.description !== '', `${path} must carry meta.description`);
  // A declared detail document that does not exist is an error on the plugin page,
  // not a fallback to the README.
  if (meta.detail !== undefined) {
    assert.ok(has(meta.detail), `${path} declares meta.detail "${String(meta.detail)}", which is missing`);
  }
}
assert.ok(locales.includes('en.json'), 'an English locale file is what a fresh installation reads first');
console.log(`ok   ${String(locales.length)} locale files carry a title and a description`);

// What a reader of the repository needs before installing, and what npm always
// includes whatever `files` says.
assert.ok(has('README.md'), 'the README is the plugin page, so it has to be there');
assert.ok(has('README.en.md'), 'the English README must stay beside the Russian page');
assert.ok(has('LICENSE'), 'package.json declares MIT, so the text has to be there');
assert.equal(manifest.private, true, 'keep the package unpublishable until someone asks for a registry copy');
console.log('ok   README, the English README and the license text are present');

console.log('\npackage check passed');
