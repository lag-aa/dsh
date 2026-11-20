/**
 * Host half of the markdown-diff plugin.
 *
 * Owns two authenticated routes inside Connection's fence:
 *
 *   GET /api/markdown-diff.base?session=<id>&path=<relative>&base=head|index|ref[&ref=<name>&point=tip|merge-base]
 *   GET /api/markdown-diff.refs?session=<id>
 *
 * The Session id is resolved to its workspace root on the Host side, so the
 * browser never names a directory and cannot read a file outside the Session
 * workspace. The answer carries the comparison base only; the working tree half
 * is the text the preview already loaded through the ordinary file route, so the
 * diff never reads the same file twice over two different transports.
 *
 * A branch name from the browser is resolved to a commit id by `refs.js` before
 * any command that reads a file runs, so no request text is ever evaluated as
 * revision syntax.
 *
 * @module dsh-markdown-diff
 */

import { readBase } from './base.js';
import { listRefs, mergeBaseWithHead, resolveRef } from './refs.js';

/** The base route this plugin claims. */
const BASE_PATH = '/api/markdown-diff.base';

/** The branch-list route. */
const REFS_PATH = '/api/markdown-diff.refs';

/** Services the route needs: the Session store, the sandbox root, and the fence. */
const inject = ['connection', 'sessions', 'sandboxPolicy'];

/** Comparison bases the browser may ask for. */
const BASES = new Set(['head', 'index', 'ref']);

/** Which commit of a branch the working tree is compared with. */
const POINTS = new Set(['tip', 'merge-base']);

/** Failures that are a statement about the workspace, not about the transport. */
const ANSWERED = new Set([
  'no-repo', 'outside-repo', 'outside-workspace', 'bad-base', 'base-too-large',
  'bad-ref', 'unknown-ref', 'no-merge-base',
]);

/**
 * Read a service that may be absent from this context.
 *
 * Cordis throws on a property read for a service that was never provided and is
 * not injected, and `?.` does not stop that, so every optional lookup is guarded.
 *
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service, or `undefined`.
 */
function optionalService(ctx, name) {
  try {
    const service = ctx.get(name);
    return service === undefined || service === null ? undefined : service;
  } catch {
    return undefined;
  }
}

/**
 * The Session's workspace root.
 *
 * There is deliberately no "unknown Session" refusal. A right-hand tab is a
 * long-lived seat that survives Session switches, and by the time its file is
 * opened the Session that minted the tab may be gone from this process even
 * though its files are still on disk — a 404 there costs the reader the whole
 * preview over an identity that the file route itself does not need. So the
 * lookup walks the same chain the shipped file API walks (live Session, its
 * committed working directory, the Session query, persistence), then the client
 * hint, and settles on the sandbox root rather than failing. `base.js` still
 * refuses any path that resolves outside whichever root is chosen.
 *
 * @param ctx - host context carrying the Session store and the sandbox policy.
 * @param sessionId - the Session on the wire.
 * @param hinted - a workspace directory the caller already knows, if any.
 * @returns the absolute root path, and which link of the chain answered.
 */
async function workspaceRootOf(ctx, sessionId, hinted) {
  const session = ctx.sessions.get(sessionId);
  const working = optionalService(ctx, 'workingDirectory');
  const committed = session === undefined ? undefined : working?.get(session);
  if (typeof committed === 'string' && committed !== '') return { root: committed, via: 'working-directory' };
  if (session?.header?.cwd !== undefined && session.header.cwd !== '') {
    return { root: session.header.cwd, via: 'live-session' };
  }

  const query = optionalService(ctx, 'sessionQuery');
  if (query !== undefined && typeof query.observeSession === 'function') {
    try {
      const observation = await query.observeSession(sessionId, { projectionMode: 'all' });
      try {
        const cwd = observation?.projections?.values?.workingDirectory ?? observation?.header?.cwd;
        if (typeof cwd === 'string' && cwd !== '') return { root: cwd, via: 'session-query' };
      } finally {
        observation?.[Symbol.dispose]?.();
      }
    } catch {
      // A Session the query backend cannot see is not a reason to refuse.
    }
  }

  const persistence = optionalService(ctx, 'sessionPersistence');
  if (persistence !== undefined && typeof persistence.stat === 'function') {
    try {
      const stored = await persistence.stat(sessionId);
      if (typeof stored?.header?.cwd === 'string' && stored.header.cwd !== '') {
        return { root: stored.header.cwd, via: 'persistence' };
      }
    } catch {
      // Same: a missing durable header falls through to the next link.
    }
  }

  // The caller's own scope, used only after every host-owned source is silent.
  // It is a path the tab was already reading through the shipped file route, so
  // it names no directory the browser could not already reach.
  if (typeof hinted === 'string' && hinted !== '') return { root: hinted, via: 'client-scope' };

  const fallback = ctx.sandboxPolicy?.workspaceRoot;
  return typeof fallback === 'string' && fallback !== '' ? { root: fallback, via: 'sandbox-root' } : { root: undefined, via: 'none' };
}

/**
 * Answer one base request.
 * @param ctx - host context.
 * @param request - the accepted browser request.
 * @returns the JSON answer.
 */
async function handleBase(ctx, request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  if (sessionId === null || sessionId === '') {
    return Response.json({ ok: false, code: 'missing-session', message: 'The request named no Session.' }, { status: 400 });
  }
  const path = url.searchParams.get('path');
  if (path === null || path === '') {
    return Response.json({ ok: false, code: 'missing-path', message: 'The request named no file.' }, { status: 400 });
  }
  const base = (url.searchParams.get('base') ?? 'head').toLowerCase();
  if (!BASES.has(base)) {
    return Response.json({ ok: false, code: 'bad-base', message: `Unknown comparison base "${base}".` }, { status: 400 });
  }
  const hinted = url.searchParams.get('cwd');
  const { root, via } = await workspaceRootOf(ctx, sessionId, hinted === null ? undefined : hinted);
  if (root === undefined || root === '') {
    return Response.json({ ok: false, code: 'no-workspace', message: 'No workspace root is available on this Host.' }, { status: 500 });
  }

  // A branch arrives as a name. It is resolved to a commit here, and only that
  // commit id travels further: `readBase` never sees the caller's text.
  let commit;
  let refName;
  let baseRef;
  if (base === 'ref') {
    const name = url.searchParams.get('ref');
    if (name === null || name === '') {
      return Response.json({ ok: false, code: 'bad-ref', message: 'The request named no branch.' }, { status: 400 });
    }
    const point = (url.searchParams.get('point') ?? 'tip').toLowerCase();
    if (!POINTS.has(point)) {
      return Response.json({ ok: false, code: 'bad-base', message: `Unknown comparison point "${point}".` }, { status: 400 });
    }
    const resolved = await resolveRef(root, name, { signal: request.signal });
    if (!resolved.ok) {
      const status = resolved.code === 'git-not-found' ? 503 : ANSWERED.has(resolved.code) ? 200 : 500;
      return Response.json({ ok: false, code: resolved.code, message: resolved.message }, { status, headers: { 'cache-control': 'no-store' } });
    }
    commit = resolved.value.commit;
    refName = name;
    // The label names what the reader actually compares with, so a merge-base
    // comparison does not claim to be the branch tip.
    baseRef = point === 'merge-base' ? `${name} (точка ветвления)` : name;
    if (point === 'merge-base') {
      const shared = await mergeBaseWithHead(root, commit, { signal: request.signal });
      if (!shared.ok) {
        const status = shared.code === 'git-not-found' ? 503 : ANSWERED.has(shared.code) ? 200 : 500;
        return Response.json({ ok: false, code: shared.code, message: shared.message }, { status, headers: { 'cache-control': 'no-store' } });
      }
      commit = shared.value.commit;
    }
  }

  const result = await readBase(root, path, base, { signal: request.signal, commit, refName });
  if (!result.ok) {
    const status = result.code === 'git-not-found' ? 503 : ANSWERED.has(result.code) ? 200 : 500;
    return Response.json({ ok: false, code: result.code, message: result.message }, { status, headers: { 'cache-control': 'no-store' } });
  }
  return Response.json({
    ok: true,
    status: result.value.status,
    baseRef: baseRef ?? result.value.baseRef,
    path,
    base: result.value.base,
    // Which link of the root chain answered, so a wrong comparison base in the
    // browser can be told apart from a workspace resolved through a fallback.
    rootVia: via,
  }, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Answer one branch-list request.
 * @param ctx - host context.
 * @param request - the accepted browser request.
 * @returns the JSON answer.
 */
async function handleRefs(ctx, request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session');
  if (sessionId === null || sessionId === '') {
    return Response.json({ ok: false, code: 'missing-session', message: 'The request named no Session.' }, { status: 400 });
  }
  const hinted = url.searchParams.get('cwd');
  const { root, via } = await workspaceRootOf(ctx, sessionId, hinted === null ? undefined : hinted);
  if (root === undefined || root === '') {
    return Response.json({ ok: false, code: 'no-workspace', message: 'No workspace root is available on this Host.' }, { status: 500 });
  }
  const result = await listRefs(root, { signal: request.signal });
  if (!result.ok) {
    const status = result.code === 'git-not-found' ? 503 : ANSWERED.has(result.code) ? 200 : 500;
    return Response.json({ ok: false, code: result.code, message: result.message }, { status, headers: { 'cache-control': 'no-store' } });
  }
  return Response.json({ ok: true, ...result.value, rootVia: via }, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Register the route inside Connection's authentication fence.
 * @param ctx - host context.
 */
function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: BASE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleBase(ctx, request),
  }), 'markdown-diff: base route');
  ctx.effect(() => ctx.connection.fetch.register({
    path: REFS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleRefs(ctx, request),
  }), 'markdown-diff: refs route');
}

export { BASE_PATH, BASES, POINTS, REFS_PATH, apply, inject, workspaceRootOf };
