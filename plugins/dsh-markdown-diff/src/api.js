/**
 * The one Host call the browser half makes.
 *
 * The base arrives as text over the authenticated route, and the working-tree
 * half is the text the preview already loaded, so nothing here reads a file:
 * only the comparison base is fetched.
 *
 * @module dsh-markdown-diff/api
 */

/** The route the Host half registers for a comparison base. */
export const BASE_ROUTE = '/api/markdown-diff.base';

/** The route that lists the branches a reader may pick. */
export const REFS_ROUTE = '/api/markdown-diff.refs';

/**
 * Ask the Host for the ref list of this workspace.
 *
 * A failure is answered rather than thrown: the branch picker then offers
 * nothing and the reader keeps the two fixed bases. Losing the list must not cost
 * a preview.
 *
 * @param sessionId - the Session the file belongs to.
 * @param signal - cancellation.
 * @param cwd - the workspace directory the caller already knows, if any.
 * @returns `{ ok: true, refs, current, suggested }`, or a typed failure.
 */
export async function readRefs(sessionId, signal, cwd) {
  const query = new URLSearchParams({ session: sessionId });
  if (typeof cwd === 'string' && cwd !== '') query.set('cwd', cwd);
  let response;
  try {
    response = await fetch(`${REFS_ROUTE}?${query.toString()}`, { credentials: 'same-origin', signal });
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'aborted', message: 'The request was cancelled.' };
    return { ok: false, code: 'network', message: String(error?.message ?? error) };
  }
  let answer;
  try {
    answer = await response.json();
  } catch {
    return { ok: false, code: 'bad-answer', message: `HTTP ${String(response.status)} without a JSON body.` };
  }
  if (answer?.ok !== true) {
    return {
      ok: false,
      code: typeof answer?.code === 'string' ? answer.code : 'failed',
      message: typeof answer?.message === 'string' ? answer.message : `HTTP ${String(response.status)}`,
    };
  }
  const refs = Array.isArray(answer.refs)
    ? answer.refs.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string')
    : [];
  return {
    ok: true,
    refs: refs.map((entry) => ({
      name: entry.name,
      kind: entry.kind === 'remote' ? 'remote' : 'local',
      commit: typeof entry.commit === 'string' ? entry.commit : '',
      date: typeof entry.date === 'number' ? entry.date : 0,
      current: entry.current === true,
      upstream: typeof entry.upstream === 'string' ? entry.upstream : undefined,
    })),
    current: typeof answer.current === 'string' ? answer.current : '',
    suggested: typeof answer.suggested === 'string' ? answer.suggested : '',
  };
}

/**
 * Read the comparison base of one previewed file.
 *
 * A failure is answered, not thrown: the preview has to draw something either
 * way, and "no repository" is an ordinary state rather than an error.
 *
 * `cwd` is a hint, not an instruction: the Host resolves the Session itself and
 * only consults the hint when the Session identity no longer answers. The file
 * tab knows the directory even when the Session that minted the tab is gone, and
 * without the hint that case loses the whole preview.
 *
 * @param sessionId - the Session the file belongs to.
 * @param path - workspace-relative path of the previewed file.
 * @param base - `head`, `index`, or `ref`.
 * @param signal - cancellation.
 * @param cwd - the workspace directory the caller already knows, if any.
 * @param picked - for `ref`, the branch name and which commit of it to use.
 * @returns `{ ok: true, status, baseRef, base }`, or a typed failure.
 */
export async function readBase(sessionId, path, base, signal, cwd, picked) {
  const query = new URLSearchParams({ session: sessionId, path, base });
  if (typeof cwd === 'string' && cwd !== '') query.set('cwd', cwd);
  if (base === 'ref' && picked !== undefined) {
    query.set('ref', picked.branch);
    query.set('point', picked.point === 'merge-base' ? 'merge-base' : 'tip');
  }
  let response;
  try {
    response = await fetch(`${BASE_ROUTE}?${query.toString()}`, {
      credentials: 'same-origin',
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'aborted', message: 'The request was cancelled.' };
    return { ok: false, code: 'network', message: String(error?.message ?? error) };
  }
  let answer;
  try {
    answer = await response.json();
  } catch {
    return { ok: false, code: 'bad-answer', message: `HTTP ${String(response.status)} without a JSON body.` };
  }
  if (answer?.ok === true) {
    return {
      ok: true,
      status: answer.status,
      baseRef: answer.baseRef,
      base: typeof answer.base === 'string' ? answer.base : '',
      rootVia: typeof answer.rootVia === 'string' ? answer.rootVia : 'unknown',
    };
  }
  return {
    ok: false,
    code: typeof answer?.code === 'string' ? answer.code : 'failed',
    message: typeof answer?.message === 'string' ? answer.message : `HTTP ${String(response.status)}`,
  };
}
