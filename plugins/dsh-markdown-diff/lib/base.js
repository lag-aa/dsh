/**
 * Read the comparison base of one Markdown file out of git.
 *
 * "The base" is one version of the file that the working tree is compared with,
 * chosen by the caller:
 *
 *   - `head`  — every uncommitted change, staged or not;
 *   - `index` — only what is still unstaged;
 *   - `ref`   — an arbitrary commit, named by a ref the caller picked.
 *
 * The third one arrives as a commit object id, never as a branch name: `refs.js`
 * resolves the name first, so nothing the browser typed reaches this module's
 * git arguments. Which commit the reader wanted — the branch tip, or the point
 * where it and the current checkout parted — is decided before this call, because
 * that is a question about a branch, not about a file.
 *
 * A file git does not know yet has no base, which is an answer rather than an
 * error: the whole document is new, and the preview draws it as one insertion.
 * The same answer is right for a file the chosen ref never had, which is why the
 * `absent` flag exists: the whole document reads as new, and the toolbar says the
 * file is not in that branch rather than silently presenting it as all-added.
 *
 * The path arriving from the browser is workspace-relative and already fenced by
 * the route, which resolves it against the Session workspace. This module turns
 * it into a repository-relative path, because `git show <ref>:<path>` names paths
 * from the repository root, not from the directory git happened to run in.
 *
 * @module dsh-markdown-diff/base
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { runGit } from './git-run.js';

/** Cap on one base version; a Markdown document above this is not worth diffing. */
const MAX_BASE_BYTES = 4 * 1024 * 1024;

/** Cap on how long one git command may run. */
const GIT_TIMEOUT_MS = 10000;

/** The refs a caller may ask for, mapped to the revision syntax that names one file. */
const BASE_REVISIONS = { head: 'HEAD', index: '' };

/** A commit id as `git rev-parse` prints one. */
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/**
 * Turn a decoded workspace-relative path into an absolute native path.
 * @param workspaceRoot - absolute workspace directory.
 * @param path - the request's path, `/`-separated.
 * @returns the absolute path, or `undefined` when it escapes the workspace.
 */
export function resolveInside(workspaceRoot, path) {
  const absolute = resolve(workspaceRoot, path.replace(/^[/\\]+/, ''));
  const back = relative(workspaceRoot, absolute);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) return undefined;
  return absolute;
}

/**
 * Widen one path to the form the filesystem actually keeps.
 *
 * `realpath` fails for a file that does not exist yet, and the fallback must not
 * be the untouched input: that would leave one side widened and the other in
 * short form. The parent directory is widened instead and the name joined back.
 *
 * @param path - the path to widen.
 * @returns the widened path, or the resolved input when even the parent is gone.
 */
async function realPath(path) {
  const absolute = resolve(path);
  const direct = await realpath(absolute).catch(() => undefined);
  if (direct !== undefined) return direct;
  const parent = await realpath(dirname(absolute)).catch(() => undefined);
  return parent === undefined ? absolute : join(parent, basename(absolute));
}

/**
 * Express an absolute path from the repository root, the way `git show` wants it.
 *
 * Both sides are widened first: git prints the toplevel with the case and the
 * short-name form its own `getcwd` produced (`C:/Users/USER~1/…`), while the
 * Session header carries the long form, and a byte comparison of the two would
 * call every file outside the repository.
 *
 * @param repoRoot - absolute repository root as git printed it.
 * @param absolute - absolute file path.
 * @returns the `/`-separated repository-relative path, or `undefined` when outside.
 */
async function repositoryPath(repoRoot, absolute) {
  const [realRoot, realFile] = await Promise.all([realPath(repoRoot), realPath(absolute)]);
  const back = relative(realRoot, realFile);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) return undefined;
  return back.split(sep).join('/');
}

/**
 * Read the base version of one Markdown file.
 *
 * @param workspaceRoot - absolute workspace directory the Session works in.
 * @param path - workspace-relative path of the previewed file.
 * @param base - `head`, `index`, or `ref`.
 * @param options - cancellation, and the commit id `ref` names.
 * @returns the base text with its status, or a typed failure.
 */
export async function readBase(workspaceRoot, path, base, options = {}) {
  const { signal, commit } = options;
  let revision = BASE_REVISIONS[base];
  if (base === 'ref') {
    // A commit id, not a branch name: `refs.js` already turned the reader's pick
    // into one. Anything else here would put untrusted text back into the
    // revision syntax that `git show <rev>:<path>` evaluates.
    if (typeof commit !== 'string' || !COMMIT.test(commit)) {
      return { ok: false, code: 'bad-base', message: 'The requested branch was not resolved to a commit.' };
    }
    revision = commit;
  }
  if (revision === undefined) {
    return { ok: false, code: 'bad-base', message: `Unknown comparison base "${String(base)}".` };
  }
  const absolute = resolveInside(workspaceRoot, path);
  if (absolute === undefined) {
    return { ok: false, code: 'outside-workspace', message: 'The requested path is outside the Session workspace.' };
  }
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: workspaceRoot, signal, timeoutMs: GIT_TIMEOUT_MS });
  if (!inside.ok) {
    if (inside.code === 'git-not-found') return inside;
    return { ok: false, code: 'no-repo', message: 'The workspace is not inside a git work tree.' };
  }
  if (inside.stdout.trim() !== 'true') {
    return { ok: false, code: 'no-repo', message: 'The workspace is not inside a git work tree.' };
  }
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: workspaceRoot, signal, timeoutMs: GIT_TIMEOUT_MS });
  if (!top.ok) return top;
  const repoRoot = top.stdout.trim();
  if (repoRoot === '') return { ok: false, code: 'no-repo', message: 'The workspace has no git working tree.' };
  const repoPath = await repositoryPath(repoRoot, absolute);
  if (repoPath === undefined) {
    return { ok: false, code: 'outside-repo', message: 'The file is outside the repository.' };
  }

  // Index membership decides whether there is a base version at all: an
  // untracked file has none, so every block in it reads as an insertion. That
  // reasoning is about the index, so it does not apply to a branch: a file the
  // reader has not staged may well exist in master, and refusing to look would
  // report a whole document as new when the branch has it in full.
  const fromRef = base === 'ref';
  const label = fromRef ? (typeof options.refName === 'string' && options.refName !== '' ? options.refName : commit) : revision;
  if (!fromRef) {
    const tracked = await runGit(['ls-files', '--error-unmatch', '--', repoPath], { cwd: repoRoot, signal, timeoutMs: GIT_TIMEOUT_MS });
    if (!tracked.ok) {
      if (tracked.code === 'git-not-found') return tracked;
      return { ok: true, value: { status: 'untracked', baseRef: revision === '' ? 'index' : revision, base: '' } };
    }
  }

  // `HEAD:<path>` and `:<path>` name the same file in either base; the empty
  // revision is git's own shorthand for the index copy.
  const show = await runGit(['show', `${revision}:${repoPath}`], {
    cwd: repoRoot,
    signal,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: MAX_BASE_BYTES,
  });
  if (!show.ok) {
    if (show.code === 'git-too-large') {
      return { ok: false, code: 'base-too-large', message: 'The comparison base is larger than the preview can diff.' };
    }
    if (show.code === 'git-not-found') return show;
    // The file is absent from this base. For HEAD or the index that means it was
    // added and not yet committed; for a branch it means the branch never had it,
    // which is a different sentence in the toolbar and so a different status.
    return { ok: true, value: { status: fromRef ? 'absent' : 'added', baseRef: label, base: '' } };
  }
  return {
    ok: true,
    value: {
      status: 'tracked',
      baseRef: label,
      base: show.stdout,
    },
  };
}
