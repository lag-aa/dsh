/**
 * Local gate for the published copy of dsh-notify: syntax, packaging shape, and
 * a scan proving no personal data travelled with the sources.
 *
 * `node --test` is unusable here because it spawns each test file with piped
 * stdio, which the DSH Windows sandbox refuses, so this is a plain script.
 *
 *   node scripts/check.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Run one child Node script with inherited stdio and stop on failure. */
function run(label, script) {
  process.stdout.write(`\n== ${label}\n`);
  execFileSync(process.execPath, [join(root, script)], { stdio: 'inherit', cwd: root });
}

// ── syntax ──────────────────────────────────────────────────────────────────
process.stdout.write('== syntax\n');
const modules = readdirSync(root)
  .filter((name) => name.endsWith('.js'))
  .sort();
for (const name of modules) {
  execFileSync(process.execPath, ['--check', join(root, name)], { stdio: 'inherit' });
  console.log(`  ok  ${name}`);
}

// ── personal data ───────────────────────────────────────────────────────────
// The plugin was written for one desk before it was published. What was fine in
// a linked local bundle — a real webhook URL, a corporate hostname, a home
// directory — must never reach a packed copy, and `files` does not filter a
// `link:` dependency, so this scan is the only thing that would notice.
const FORBIDDEN = [
  ['a Windows home path', /[A-Za-z]:\\+Users\\+/i],
  // Also the `/`-separated and 8.3-short forms (`C:/Users/USER~1/…`): the long
  // name never appears in them, and a scan for the long name alone missed it once.
  ['a POSIX home path', /\/+(?:home|Users)\/[A-Za-z0-9._~-]+\//i],
  ['a webhook token in a URL', /[?&]token=[A-Za-z0-9]/],
  ['a bearer token', /Bearer\s+[A-Za-z0-9._-]/],
  // A shape, not one particular host: names that end in an internal-style label
  // (`*.corp.local`, `*.lan`) are the ones a company desk produces. The `\b`
  // keeps ordinary words such as `locale` out of the result.
  ['an internal hostname', /\.(?:corp|local|lan|intranet|internal)\b/i],
  ['a private IPv4 address', /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['a local bundle id', /@local\//],
  ['the private bundle directory', /dsh-notify-bundle/],
  ['a leftover test endpoint', /hooks\.example\.test/],
  ['the in-bundle state directory', /state\/settings\.json/],
];
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.yml', '.yaml', '.md', '.svg', '.txt']);
const SKIP_DIRECTORIES = new Set(['node_modules', 'test', 'scripts', '.tmp-npm-cache']);

/** Every file a packed copy would contain, minus the checks themselves. */
function packageFiles(dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.tmp')) continue;
      packageFiles(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

process.stdout.write('\n== personal data\n');
const files = packageFiles();
for (const file of files) {
  if (!TEXT_EXTENSIONS.has(extname(file))) continue;
  const text = readFileSync(file, 'utf8');
  for (const [label, pattern] of FORBIDDEN) {
    for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
      const context = text.slice(Math.max(0, match.index - 20), match.index + 60);
      console.error(`  FAIL ${relative(root, file)} carries ${label}: ${JSON.stringify(context)}`);
      process.exit(1);
    }
  }
}
console.log(`  ok  ${String(files.length)} packaged files carry no personal data`);

// ── packaging ───────────────────────────────────────────────────────────────
run('package shape', 'test/package.test.mjs');

// ── the manifest's own files list ───────────────────────────────────────────
process.stdout.write('\n== files list\n');
const listed = new Set(manifest.files ?? []);
for (const name of modules) {
  if (!listed.has(name)) {
    console.error(`  FAIL ${name} is part of the entry graph but missing from package.json "files"`);
    process.exit(1);
  }
}
for (const required of ['cordis.patch.yml', 'icon.svg', 'locale/*.json', 'README.md', 'README.en.md', 'LICENSE']) {
  if (!listed.has(required)) {
    console.error(`  FAIL package.json "files" is missing ${required}`);
    process.exit(1);
  }
}
console.log(`  ok  ${String(modules.length)} runtime modules and the display resources are listed`);

const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`\nall checks passed (${String(files.length)} files, ${String(bytes)} bytes)`);
