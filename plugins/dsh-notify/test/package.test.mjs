/**
 * Check that this copy can be installed from somewhere other than a checkout.
 *
 * A linked directory hides packaging mistakes: `files` does not filter a
 * `link:` dependency, so a missing module, patch, locale, or icon costs nothing
 * until the day the package is installed from a git commit. This suite reads
 * the manifest the way an installer does and inspects what it would load.
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

// What the Host loads: the patch that inserts the plugin row, the module the row
// names, and the browser half the `dsh.client` declaration points at.
assert.equal(manifest.name, 'dsh-notify', 'the package name is the id the Web app registers');
assert.ok(has(manifest.dsh?.bundle?.patch), 'the bundle patch must be inside the package');
assert.ok(has(manifest.main), 'the Host entry `main` must exist');
assert.equal(manifest.main, 'index.js');
assert.equal(manifest.exports?.['.'], './index.js');
assert.equal(manifest.exports?.['./client'], './client.js');
assert.ok(has('client.js'), 'the browser half must be inside the package');
assert.equal(manifest.dsh?.client?.platform, 'web');
const clientBytes = statSync(join(root, 'client.js')).size;
assert.ok(clientBytes > 0, 'the browser half must not be an empty file');
console.log('ok   the patch, the Host entry and the browser half are inside the package');

// The browser half must register under the package name: the loader resolves a
// client module by the id the factory passes to `__ModuleLoader__.load`, and a
// mismatch leaves the toasts unregistered while everything else looks installed.
const client = readFileSync(join(root, 'client.js'), 'utf8');
assert.match(client, new RegExp(`id: '${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',`),
  'the client module id must equal the package name');
// The Host resolves the same module to serve it; the literal must match too.
const host = readFileSync(join(root, 'index.js'), 'utf8');
assert.ok(host.includes(`clientPath?.('${manifest.name}')`), 'the Host must look the client up by package name');
assert.ok(!host.includes('@local/'), 'no local bundle id may survive in the published Host half');
console.log('ok   the client module and the Host route agree on the package name');

// `files` decides what a packed copy contains, so every runtime module the entry
// graph needs has to be reachable through it.
const listed = manifest.files ?? [];
const runtimeModules = readdirSync(root).filter((name) => name.endsWith('.js')).sort();
assert.deepEqual(runtimeModules, ['client.js', 'compose.js', 'credentials.js', 'index.js', 'settings.js', 'webhook.js'],
  'the runtime module set changed; update this check and `files` together');
for (const name of runtimeModules) assert.ok(listed.includes(name), `${name} must be listed in files`);
assert.ok(listed.includes('cordis.patch.yml'), 'the patch named by dsh.bundle.patch must be listed in files');
assert.ok(listed.includes('icon.svg'), 'the icon must be listed in files');
assert.ok(listed.includes('locale/*.json'), 'the locale files must be listed in files');
assert.ok(listed.includes('LICENSE'), 'the license text must be listed in files: package.json declares MIT');
assert.ok(listed.includes('README.md') && listed.includes('README.en.md'), 'both READMEs must be listed');
console.log('ok   files lists every runtime module and display resource');

// Nothing from the original in-bundle store may travel: that file held the mode,
// the quiet window, and once the webhook URL.
assert.ok(!has('state'), 'a state directory must never be packed');
assert.ok(!listed.some((entry) => entry.startsWith('state')), 'files must not mention state');

// The display resources: without them the row falls back to the package name and
// the panel's default artwork.
const iconPath = manifest.icon ?? manifest.exports?.['./icon'];
assert.ok(has(iconPath), 'the icon file named by the manifest must exist');
const icon = readFileSync(join(root, iconPath), 'utf8');
assert.match(icon, /<svg[^>]*viewBox="0 0 \d+ \d+"/, 'the icon must carry a viewBox');
for (const forbidden of ['<script', '<style', '<text', '<image', 'foreignObject']) {
  assert.ok(!icon.includes(forbidden), `a plugin icon must stay self-contained: ${forbidden} is not allowed`);
}
console.log('ok   the icon is a self-contained SVG');

const locales = readdirSync(join(root, 'locale')).filter((name) => name.endsWith('.json'));
assert.ok(locales.includes('en.json'), 'an English locale file is what a fresh installation reads first');
for (const name of locales) {
  const path = join('locale', name);
  const meta = JSON.parse(readFileSync(join(root, path), 'utf8')).meta ?? {};
  assert.ok(typeof meta.title === 'string' && meta.title !== '', `${path} must carry meta.title`);
  assert.ok(typeof meta.description === 'string' && meta.description !== '', `${path} must carry meta.description`);
}
console.log(`ok   ${String(locales.length)} locale files carry a title and a description`);

// The patch row: a row named after the package loads `main`, and the id is what
// the settings page and the credential record key hang off.
const patch = readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8');
assert.match(patch, /-\s+insert:/, 'the patch must insert a row');
assert.match(patch, new RegExp(`name: ${manifest.name}\\s*$`, 'm'), 'the row must name this package');
assert.ok(!/[?&]token=/.test(patch), 'no webhook token may sit in the patch');
console.log('ok   the patch inserts one row named after the package');

assert.ok(has('README.md'), 'the README is the plugin page, so it has to be there');
assert.ok(has('README.en.md'), 'the English README must stay beside the Russian page');
assert.ok(has('LICENSE'), 'package.json declares MIT, so the text has to be there');
assert.equal(manifest.private, true, 'keep the package unpublishable until someone asks for a registry copy');
console.log('ok   README, the English README and the license text are present');

console.log('\npackage check passed');
