/**
 * Branch references, and the commits a comparison base may name.
 *
 * A comparison base used to be one of two fixed revisions (`HEAD`, the index).
 * A branch adds a name chosen by the reader, which is the one place where
 * browser input reaches git — so the name is never handed to `git show`.
 *
 * It is resolved first: `rev-parse --verify --end-of-options "<name>^{commit}"`
 * returns the commit object it names, and every later command uses that object
 * id. That closes the whole class of revision-syntax tricks (`master:path`,
 * `HEAD~5`, `--upload-pack=…`) rather than trying to enumerate them, and
 * `--end-of-options` stops a name that starts with a dash from being read as a
 * flag. The name is also shape-checked first, so a nonsense value fails with a
 * sentence about the branch instead of a paragraph of git's own output.
 *
 * @module dsh-markdown-diff/refs
 */

import { runGit } from './git-run.js';

/** Cap on how long one git command may run. */
const GIT_TIMEOUT_MS = 10000;

/** Fields of one ref line: full name, short name, commit, date, upstream, current. */
const FIELDS = '%(refname)%09%(refname:short)%09%(objectname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(HEAD)';

/** The namespaces offered as comparison bases, and the label each is shown under. */
const NAMESPACES = [
  { prefix: 'refs/heads/', kind: 'local' },
  { prefix: 'refs/remotes/', kind: 'remote' },
];

/**
 * A conservative shape for a ref name the browser may name.
 *
 * Letters of any script are allowed, because a branch may be named in Russian;
 * everything git itself forbids in a ref (`~ ^ : ? * [ \`, a space, a control
 * character) is absent from the class, as are the two sequences a ref may not
 * contain (`..`, and a leading or trailing `/`). This is a readability filter —
 * the security boundary is resolving the name to a commit id before use.
 */
const REF_NAME = /^[\p{L}\p{N}._/-]+$/u;

/**
 * Sanity-check a ref name before asking git about it.
 * @param name - the candidate, straight from the request.
 * @returns `true` when the name is shaped like a ref.
 */
export function isSafeRefName(name) {
  if (typeof name !== 'string' || name === '' || name.length > 255) return false;
  if (!REF_NAME.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (name.endsWith('.lock') || name === 'HEAD' || name === '@') return false;
  return true;
}

/**
 * Split one `for-each-ref` line into a ref record.
 * @param line - one output line.
 * @returns the record, or `undefined` for a line that is a remote's own HEAD.
 */
function parseRefLine(line) {
  const parts = line.split('\t');
  if (parts.length < 6) return undefined;
  const [full, short, commit, date, upstream, head] = parts;
  // `refs/remotes/origin/HEAD` is a symbolic pointer at a branch listed right
  // beside it; offering both would be two entries meaning one thing.
  if (short === undefined || short === '' || short.endsWith('/HEAD')) return undefined;
  const namespace = NAMESPACES.find((entry) => full.startsWith(entry.prefix));
  if (namespace === undefined) return undefined;
  const seconds = Number.parseInt(date, 10);
  return {
    name: short,
    kind: namespace.kind,
    commit,
    date: Number.isFinite(seconds) ? seconds : 0,
    upstream: upstream === undefined || upstream === '' ? undefined : upstream,
    current: head === '*',
  };
}

/**
 * List the refs a reader may compare against.
 *
 * `base` is the branch the current one probably diverged from: the remote's own
 * default branch when the clone recorded one, otherwise the first of `master`
 * and `main` that exists. The client offers it as a one-click choice instead of
 * making the reader hunt through two dozen names.
 *
 * @param cwd - absolute directory inside the repository.
 * @param options - cancellation.
 * @returns the ref list with the current branch and the suggested divergence base.
 */
export async function listRefs(cwd, options = {}) {
  const { signal } = options;
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
  if (!inside.ok) {
    if (inside.code === 'git-not-found') return inside;
    return { ok: false, code: 'no-repo', message: 'The workspace is not inside a git work tree.' };
  }
  if (inside.stdout.trim() !== 'true') {
    return { ok: false, code: 'no-repo', message: 'The workspace is not inside a git work tree.' };
  }

  const refs = await runGit(
    ['for-each-ref', `--format=${FIELDS}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'],
    { cwd, signal, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (!refs.ok) return refs;
  const entries = refs.stdout.split(/\r?\n/u).map(parseRefLine).filter((entry) => entry !== undefined);

  const currentRef = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
  const current = currentRef.ok ? currentRef.stdout.trim() : '';
  // A detached HEAD has no branch of its own; the current ref list is then honest
  // and carries no `current` flag, which is what the client draws.
  const flagged = entries.map((entry) => ({ ...entry, current: entry.current || entry.name === current }));

  const remoteHead = await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
  const suggested = remoteHead.ok && remoteHead.stdout.trim() !== ''
    ? remoteHead.stdout.trim()
    : ['master', 'main'].find((candidate) => flagged.some((entry) => entry.name === candidate)) ?? '';
  return { ok: true, value: { refs: flagged, current, suggested } };
}

/**
 * Resolve a ref name to the commit object it names.
 *
 * @param cwd - absolute directory inside the repository.
 * @param name - the ref name, already shape-checked.
 * @param options - cancellation.
 * @returns the full commit id, or a typed failure.
 */
export async function resolveRef(cwd, name, options = {}) {
  const { signal } = options;
  if (!isSafeRefName(name)) {
    return { ok: false, code: 'bad-ref', message: `"${String(name)}" is not a usable branch name.` };
  }
  const resolved = await runGit(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`],
    { cwd, signal, timeoutMs: GIT_TIMEOUT_MS },
  );
  if (!resolved.ok) {
    if (resolved.code === 'git-not-found') return resolved;
    return { ok: false, code: 'unknown-ref', message: `There is no branch "${name}" in this repository.` };
  }
  const commit = resolved.stdout.trim();
  if (commit === '') {
    return { ok: false, code: 'unknown-ref', message: `There is no branch "${name}" in this repository.` };
  }
  return { ok: true, value: { commit, name } };
}

/**
 * The commit where a branch and the current checkout last agreed.
 *
 * This is the base that answers "what did I change on my own branch": comparing
 * against the branch tip instead would charge the reader for every commit that
 * landed on the branch they branched from after they left it.
 *
 * @param cwd - absolute directory inside the repository.
 * @param commit - the branch's commit id.
 * @param options - cancellation.
 * @returns the merge base's commit id, or a typed failure.
 */
export async function mergeBaseWithHead(cwd, commit, options = {}) {
  const { signal } = options;
  const base = await runGit(['merge-base', commit, 'HEAD'], { cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
  if (!base.ok) {
    if (base.code === 'git-not-found') return base;
    return { ok: false, code: 'no-merge-base', message: 'The branch and the current checkout share no history.' };
  }
  const found = base.stdout.trim();
  if (found === '') {
    return { ok: false, code: 'no-merge-base', message: 'The branch and the current checkout share no history.' };
  }
  return { ok: true, value: { commit: found } };
}
