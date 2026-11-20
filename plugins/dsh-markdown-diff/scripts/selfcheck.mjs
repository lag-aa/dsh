/**
 * End-to-end self check for the host half: builds a throwaway repository with a
 * committed Markdown file, edits it, and reads the base through the same
 * `readBase` the route calls.
 *
 * The check spawns git with its output redirected to temporary files instead of
 * pipes, because piped stdio is refused (EPERM) inside the DSH Windows sandbox.
 *
 *   node scripts/selfcheck.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBase, resolveInside } from '../lib/base.js';
import { workspaceRootOf } from '../lib/index.js';

/**
 * Run git with file-redirected stdio.
 * @param args - git arguments.
 * @param cwd - working directory.
 * @returns the exit code and captured streams.
 */
async function git(args, cwd) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-markdown-diff-io-'));
  const outPath = join(dir, 'stdout.txt');
  const errPath = join(dir, 'stderr.txt');
  const out = await open(outPath, 'w');
  const err = await open(errPath, 'w');
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', out.fd, err.fd] });
      child.once('error', reject);
      child.once('close', resolve);
    });
    const read = async (path) => {
      const handle = await open(path, 'r');
      try {
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    };
    return { code, stdout: await read(outPath), stderr: await read(errPath) };
  } finally {
    await out.close();
    await err.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fail loudly on a non-zero git exit. */
async function gitOrThrow(args, cwd) {
  const result = await git(args, cwd);
  assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

const root = await mkdtemp(join(tmpdir(), 'dsh-markdown-diff-check-'));
try {
  await gitOrThrow(['init', '-q', '-b', 'main'], root);
  await gitOrThrow(['config', 'user.email', 'selfcheck@example.invalid'], root);
  await gitOrThrow(['config', 'user.name', 'Self check'], root);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'committed.md'), '# Committed\n\nold text\n');
  await writeFile(join(root, 'docs', 'staged.md'), '# Staged\n\nversion one\n');
  await gitOrThrow(['add', '.'], root);
  await gitOrThrow(['commit', '-q', '-m', 'initial'], root);

  // A worktree edit that is not staged: it differs from both bases.
  await writeFile(join(root, 'docs', 'committed.md'), '# Committed\n\nnew text\n');
  // A staged edit with a further unstaged one on top: the two bases disagree.
  await writeFile(join(root, 'docs', 'staged.md'), '# Staged\n\nversion two\n');
  await gitOrThrow(['add', '--', 'docs/staged.md'], root);
  await writeFile(join(root, 'docs', 'staged.md'), '# Staged\n\nversion three\n');
  // A file git has never seen.
  await writeFile(join(root, 'docs', 'fresh.md'), '# Fresh\n\nbody\n');

  const head = await readBase(root, 'docs/committed.md', 'head');
  assert.equal(head.ok, true, head.ok === false ? head.message : '');
  assert.equal(head.value.status, 'tracked');
  assert.equal(head.value.baseRef, 'HEAD');
  assert.equal(head.value.base, '# Committed\n\nold text\n');
  console.log('ok   head base of an unstaged edit is the committed version');

  const index = await readBase(root, 'docs/committed.md', 'index');
  assert.equal(index.value.base, '# Committed\n\nold text\n');
  console.log('ok   index base of an unstaged edit is the committed version too');

  const headStaged = await readBase(root, 'docs/staged.md', 'head');
  assert.equal(headStaged.value.base, '# Staged\n\nversion one\n');
  console.log('ok   head base of a staged file is still the committed version');

  const indexStaged = await readBase(root, 'docs/staged.md', 'index');
  assert.equal(indexStaged.value.base, '# Staged\n\nversion two\n');
  console.log('ok   index base of a staged file is the staged version');

  const fresh = await readBase(root, 'docs/fresh.md', 'head');
  assert.equal(fresh.ok, true, fresh.ok === false ? fresh.message : '');
  assert.equal(fresh.value.status, 'untracked');
  assert.equal(fresh.value.base, '');
  console.log('ok   an untracked file has an empty base and status untracked');

  const missing = await readBase(root, 'docs/absent.md', 'head');
  assert.equal(missing.value.status, 'untracked');
  assert.equal(missing.value.base, '');
  console.log('ok   a path with no file on disk still answers untracked, not an error');

  const bad = await readBase(root, 'docs/committed.md', 'nonsense');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-base');
  console.log('ok   an unknown comparison base is refused');

  const escape = await readBase(root, '../outside.md', 'head');
  assert.equal(escape.ok, false);
  assert.equal(escape.code, 'outside-workspace');
  assert.equal(resolveInside(root, '../outside.md'), undefined);
  console.log('ok   a path escaping the workspace is refused');

  const plain = await mkdtemp(join(tmpdir(), 'dsh-markdown-diff-plain-'));
  try {
    await writeFile(join(plain, 'doc.md'), '# x\n');
    const outside = await readBase(plain, 'doc.md', 'head');
    assert.equal(outside.ok, false);
    assert.equal(outside.code, 'no-repo');
    console.log('ok   a directory outside git is reported as no-repo');
  } finally {
    await rm(plain, { recursive: true, force: true });
  }

  // The root chain is what stands between a long-lived right-hand tab and a 404
  // that costs the reader the whole preview. Each link is checked in isolation,
  // and the chain as a whole must never refuse: a Session the Host has forgotten
  // still has files on disk.
  const policy = { workspaceRoot: root };
  const live = { sessions: { get: () => ({ header: { cwd: join(root, 'docs') } }) }, sandboxPolicy: policy };
  assert.deepEqual(await workspaceRootOf(live, 's-1'), { root: join(root, 'docs'), via: 'live-session' });
  console.log('ok   a live Session answers with its own directory');

  const committed = {
    sessions: { get: () => ({ header: {} }) },
    get: (name) => (name === 'workingDirectory' ? { get: () => join(root, 'docs') } : undefined),
    sandboxPolicy: policy,
  };
  assert.deepEqual(await workspaceRootOf(committed, 's-1'), { root: join(root, 'docs'), via: 'working-directory' });
  console.log('ok   the committed working directory outranks the raw header');

  const hinted = { sessions: { get: () => undefined }, sandboxPolicy: policy };
  assert.deepEqual(await workspaceRootOf(hinted, 'gone', join(root, 'docs')), { root: join(root, 'docs'), via: 'client-scope' });
  console.log('ok   a Session the Host forgot still resolves through the caller scope');

  const empty = { sessions: { get: () => undefined }, sandboxPolicy: policy };
  assert.deepEqual(await workspaceRootOf(empty, 'gone'), { root, via: 'sandbox-root' });
  console.log('ok   with nothing else answering, the sandbox root is used, never a refusal');

  // A throwing optional service must not take the chain down with it.
  const hostile = {
    sessions: { get: () => undefined },
    get: () => {
      throw new Error('cannot get property without inject');
    },
    sandboxPolicy: policy,
  };
  assert.deepEqual(await workspaceRootOf(hostile, 'gone'), { root, via: 'sandbox-root' });
  console.log('ok   an un-readable optional service is skipped, not fatal');

  console.log('\nself check passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
