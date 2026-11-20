/**
 * Checks for branch comparison: the ref list, resolving a name to a commit, the
 * divergence point, and reading a file out of a branch.
 *
 * These run real git against a throwaway repository, because the parts worth
 * checking are exactly the ones a stub would get wrong — how `for-each-ref`
 * formats a line, what `merge-base` answers, and what `git show <commit>:<path>`
 * does for a file the branch never had.
 *
 *   node test/refs.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBase } from '../lib/base.js';
import { isSafeRefName, listRefs, mergeBaseWithHead, resolveRef } from '../lib/refs.js';

/** Run git with file-redirected stdio, which is what the sandbox allows. */
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

let passed = 0;
/** Report one passing check. */
function ok(label) {
  passed += 1;
  console.log(`ok   ${label}`);
}

const root = await mkdtemp(join(tmpdir(), 'dsh-markdown-diff-refs-'));
try {
  await gitOrThrow(['init', '-q', '-b', 'master'], root);
  await gitOrThrow(['config', 'user.email', 'refs@example.invalid'], root);
  await gitOrThrow(['config', 'user.name', 'Refs check'], root);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'shared.md'), '# Shared\n\nmaster version\n');
  await gitOrThrow(['add', '.'], root);
  await gitOrThrow(['commit', '-q', '-m', 'on master'], root);
  const forkCommit = (await gitOrThrow(['rev-parse', 'HEAD'], root)).trim();

  // A branch that leaves master here, and a later commit on master that the
  // branch never sees. Comparing against the branch tip and against the merge
  // base must then disagree — that difference is the whole point of the choice.
  await gitOrThrow(['checkout', '-q', '-b', 'feature'], root);
  await writeFile(join(root, 'docs', 'only-feature.md'), '# Feature\n\nnew file\n');
  await writeFile(join(root, 'docs', 'shared.md'), '# Shared\n\nfeature version\n');
  await gitOrThrow(['add', '.'], root);
  await gitOrThrow(['commit', '-q', '-m', 'on feature'], root);

  await gitOrThrow(['checkout', '-q', 'master'], root);
  await writeFile(join(root, 'docs', 'master-only.md'), '# Master only\n\nlanded after the fork\n');
  await gitOrThrow(['add', '.'], root);
  await gitOrThrow(['commit', '-q', '-m', 'master moves on'], root);
  // The tip is read here, after master moved: it has to differ from the fork.
  const masterCommit = (await gitOrThrow(['rev-parse', 'HEAD'], root)).trim();
  await gitOrThrow(['checkout', '-q', 'feature'], root);

  // --- the ref list ---------------------------------------------------------
  const listed = await listRefs(root);
  assert.equal(listed.ok, true, listed.ok === false ? listed.message : '');
  const names = listed.value.refs.map((entry) => entry.name);
  assert.ok(names.includes('master'), `master missing from ${JSON.stringify(names)}`);
  assert.ok(names.includes('feature'), `feature missing from ${JSON.stringify(names)}`);
  assert.equal(listed.value.current, 'feature');
  assert.equal(listed.value.refs.find((entry) => entry.name === 'feature').current, true);
  assert.equal(listed.value.refs.find((entry) => entry.name === 'master').current, false);
  assert.equal(listed.value.suggested, 'master');
  ok('the list carries both branches, marks the current one, and suggests master');

  // A remote-tracking HEAD is a pointer at a branch listed beside it, so it must
  // not become a second entry meaning the same thing.
  await gitOrThrow(['update-ref', 'refs/remotes/origin/master', forkCommit], root);
  await gitOrThrow(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'], root);
  const withRemote = await listRefs(root);
  const remoteNames = withRemote.value.refs.map((entry) => entry.name);
  assert.ok(remoteNames.includes('origin/master'), `origin/master missing from ${JSON.stringify(remoteNames)}`);
  assert.equal(remoteNames.includes('origin/HEAD'), false, 'origin/HEAD must not be listed as a base of its own');
  assert.equal(withRemote.value.refs.find((entry) => entry.name === 'origin/master').kind, 'remote');
  assert.equal(withRemote.value.suggested, 'origin/master', 'the remote default outranks the local guess');
  ok('a remote branch is listed as remote, and its HEAD pointer is skipped');

  // --- resolving a name -----------------------------------------------------
  const resolved = await resolveRef(root, 'master');
  assert.equal(resolved.ok, true, resolved.ok === false ? resolved.message : '');
  assert.equal(resolved.value.commit, masterCommit);
  ok('a branch name resolves to the commit it names');

  const unknown = await resolveRef(root, 'no-such-branch');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown-ref');
  ok('an unknown branch is refused by name, not by crashing');

  // The shape check refuses what git itself forbids, and the `--end-of-options`
  // guard means a name that starts with a dash can never be read as a flag.
  for (const bad of ['', 'a b', 'a..b', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[1]', 'a\\b', '-upload', 'HEAD', '/abs', 'trail/']) {
    assert.equal(isSafeRefName(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
  for (const good of ['master', 'origin/master', 'wt/create-glossary', 'feature-1.2', 'ветка']) {
    assert.equal(isSafeRefName(good), true, `${JSON.stringify(good)} must be accepted`);
  }
  const injected = await resolveRef(root, 'master:docs/shared.md');
  assert.equal(injected.ok, false);
  assert.equal(injected.code, 'bad-ref');
  ok('revision syntax in a branch name is refused before git sees it');

  // --- the divergence point -------------------------------------------------
  const mergeBase = await mergeBaseWithHead(root, masterCommit);
  assert.equal(mergeBase.ok, true, mergeBase.ok === false ? mergeBase.message : '');
  const expected = (await gitOrThrow(['merge-base', 'master', 'HEAD'], root)).trim();
  assert.equal(mergeBase.value.commit, expected);
  assert.notEqual(mergeBase.value.commit, masterCommit, 'the fork and the master tip must differ in this fixture');
  ok('the divergence point is the merge base, not the branch tip');

  // --- reading a file out of a branch ---------------------------------------
  const fromMaster = await readBase(root, 'docs/shared.md', 'ref', { commit: masterCommit, refName: 'master' });
  assert.equal(fromMaster.ok, true, fromMaster.ok === false ? fromMaster.message : '');
  assert.equal(fromMaster.value.base, '# Shared\n\nmaster version\n');
  assert.equal(fromMaster.value.baseRef, 'master');
  ok('a tracked file reads from the branch, not from the working tree');

  // The branch has a file the working tree does not: it must read, and the
  // reading must be the branch's version rather than a "no base" answer.
  const masterOnly = await readBase(root, 'docs/master-only.md', 'ref', { commit: masterCommit, refName: 'master' });
  assert.equal(masterOnly.ok, true, masterOnly.ok === false ? masterOnly.message : '');
  assert.equal(masterOnly.value.status, 'tracked');
  assert.equal(masterOnly.value.base, '# Master only\n\nlanded after the fork\n');
  ok('a file the branch has and the checkout lacks still reads — the index is not consulted for a ref base');

  // A file the branch never had is all-new against that branch, and says so.
  const neverInMaster = await readBase(root, 'docs/only-feature.md', 'ref', { commit: masterCommit, refName: 'master' });
  assert.equal(neverInMaster.ok, true, neverInMaster.ok === false ? neverInMaster.message : '');
  assert.equal(neverInMaster.value.status, 'absent');
  assert.equal(neverInMaster.value.base, '');
  assert.equal(neverInMaster.value.baseRef, 'master');
  ok('a file the branch never had answers absent, so the toolbar can say so');

  // A commit id is the only thing readBase accepts for a ref base: a branch name
  // reaching it would mean the resolution step had been skipped.
  const named = await readBase(root, 'docs/shared.md', 'ref', { commit: 'master', refName: 'master' });
  assert.equal(named.ok, false);
  assert.equal(named.code, 'bad-base');
  const missing = await readBase(root, 'docs/shared.md', 'ref', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'bad-base');
  ok('readBase refuses anything but a resolved commit id for a branch base');

  // --- the fixed bases still behave -----------------------------------------
  const headBase = await readBase(root, 'docs/shared.md', 'head');
  assert.equal(headBase.ok, true);
  assert.equal(headBase.value.baseRef, 'HEAD');
  ok('the fixed bases are unchanged by the new one');

  console.log(`\n${String(passed)}/11 refs checks passed`);
} finally {
  await rm(root, { recursive: true, force: true });
}
