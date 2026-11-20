/**
 * Parse every shipped source file, without executing it.
 *
 * The package is ESM, so `node --check` runs against a `.mjs` copy of each file:
 * it accepts module syntax under that extension and needs no module graph, and
 * the copy lives in the temporary directory.
 *
 *   node scripts/syntax.mjs
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(tmpdir(), `dsh-markdown-diff-syntax-${String(process.pid)}`);
const files = ['lib', 'src', 'scripts', 'test'].flatMap((directory) =>
  readdirSync(join(root, directory))
    .filter((name) => name.endsWith('.js') || name.endsWith('.mjs'))
    .map((name) => join(directory, name)));

let failed = 0;
mkdirSync(scratch, { recursive: true });
for (const file of files) {
  const copy = join(scratch, `${file.replace(/[\\/]/g, '-')}.mjs`);
  copyFileSync(join(root, file), copy);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'inherit' });
    console.log(`ok   ${file}`);
  } catch {
    failed += 1;
    console.log(`FAIL ${file} did not parse`);
  }
}
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${String(files.length - failed)}/${String(files.length)} files parsed`);
process.exitCode = failed === 0 ? 0 : 1;
