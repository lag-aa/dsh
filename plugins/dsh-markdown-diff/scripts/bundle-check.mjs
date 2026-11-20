/**
 * Check that the built bundle is the shape the client module loader expects, and
 * that its factory registers the Markdown renderer and the settings section.
 *
 * The bundle is loaded against a stub module table and a recording client
 * context, so a registration that would break at load time fails here instead of
 * in the browser console.
 *
 *   node scripts/bundle-check.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { React, findBy, findByType, hookFrames, render, textOf } from '../test/react-stub.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');

let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registration = entry;
    },
  },
};

// The preference store subscribes to `storage` while the bundle is evaluated, so
// the recorder has to exist before the source runs. The checks use this same path
// to switch the view: the store reads its snapshot once and invalidates it on a
// cross-window change.
const storageListeners = [];
globalThis.addEventListener = (name, listener) => {
  if (name === 'storage') storageListeners.push(listener);
};

new Function(source)();

assert.ok(registration !== undefined, 'the bundle registered nothing with __ModuleLoader__');
assert.equal(registration.id, 'dsh-markdown-diff');
assert.equal(typeof registration.factory, 'function');
console.log('ok   the bundle registers one factory under dsh-markdown-diff');

/**
 * A stand-in for `primitives.MarkdownText`.
 *
 * It is expanded like any other function component, so the rendered tree carries
 * a `markdown` leaf whose props are the ones the body passed.
 */
function MarkdownText(props) {
  return { type: 'markdown', props, key: null };
}

const table = {
  react: React,
  '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText },
};
const plugin = registration.factory((id) => {
  const module = table[id];
  if (module === undefined) throw new Error(`the bundle required "${id}", which no shipped package provides`);
  return module;
});
assert.equal(typeof plugin.apply, 'function', 'the factory must return apply');
assert.ok(Array.isArray(plugin.inject), 'the factory must return the inject list');
assert.ok(plugin.inject.includes('documentPreviews'), 'the renderer registers into documentPreviews');
assert.ok(plugin.inject.includes('slots'), 'the body and the settings section ride on slots');
console.log(`ok   factory exports apply and inject ${JSON.stringify(plugin.inject)}`);

const seen = { previews: [], slots: [], viewers: [] };
const ctx = {
  slots: {
    // `inject` takes a generator that yields disposers, so the stub has to
    // iterate it — calling it alone would register nothing.
    inject(name, register) {
      const produced = register({ ...ctx, name });
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        const disposers = [];
        for (let step = produced.next(); step.done !== true; step = produced.next()) disposers.push(step.value);
        return () => {
          for (const dispose of disposers) dispose();
        };
      }
      return typeof produced === 'function' ? produced : () => {};
    },
    register(seat, component) {
      seen.slots.push({ seat, component });
      return () => {};
    },
  },
  documentPreviews: {
    register(definition) {
      seen.previews.push(definition);
      return () => {};
    },
  },
  // The sidebar's file-tab service. `get` is how the plugin looks it up, and
  // `inject` is the notification that fires once the service is declared.
  get(name) {
    return name === 'betterSidebar' ? sidebar : undefined;
  },
  inject(names, run) {
    if (names.includes('betterSidebar')) run();
    return () => {};
  },
  effect(handler) {
    const dispose = handler();
    return typeof dispose === 'function' ? dispose : () => {};
  },
};

const sidebar = {
  registerFileViewer(descriptor) {
    seen.viewers.push(descriptor);
    return () => {};
  },
};

plugin.apply(ctx);

assert.equal(seen.viewers.length, 1, 'exactly one file viewer is registered with the sidebar');
const viewer = seen.viewers[0];
assert.equal(viewer.id, 'dsh-markdown-diff:markdown');
assert.deepEqual(viewer.exts, ['md', 'markdown']);
assert.ok(viewer.priority > 0, 'a positive priority is what outranks the sidebar\'s own Markdown viewer');
assert.equal(viewer.fetchStrategy, 'fsRead', 'the viewer draws the bytes the tab already decoded');
assert.equal(typeof viewer.component, 'function');
assert.equal(viewer.title(), 'Markdown с изменениями');
console.log('ok   file viewer registered for .md above the sidebar\'s own viewer');

assert.equal(seen.previews.length, 1, 'exactly one document renderer is registered');
const definition = seen.previews[0];
assert.equal(definition.id, 'dsh-markdown-diff/markdown');
assert.deepEqual(definition.extensions, ['md', 'markdown']);
assert.equal(definition.priority, 'extension', 'an extension renderer outranks the builtin one');
assert.equal(definition.loading, 'text-pages', 'the preview keeps its own paging and reload');
assert.equal(definition.wrap, false, 'the wrap control keeps the meaning the builtin gives it');
assert.equal(typeof definition.title, 'function');
assert.equal(definition.title(), 'Markdown с изменениями');
console.log('ok   renderer registered for .md and .markdown at extension priority');

assert.deepEqual(seen.slots.map((slot) => slot.seat.name).sort(), [
  'settings.section',
  'settings.section.icon',
  'sidebar.right.tab.document',
]);
const bodySeat = seen.slots.find((slot) => slot.seat.name === 'sidebar.right.tab.document');
assert.equal(bodySeat.seat.key, 'dsh-markdown-diff/markdown', 'the body seat is keyed by the renderer id');
assert.equal(typeof bodySeat.component, 'function');
const settingsSeat = seen.slots.find((slot) => slot.seat.name === 'settings.section');
assert.equal(settingsSeat.seat.id, 'markdown-diff');
assert.equal(typeof settingsSeat.seat.label(), 'string');
// The nav row keeps the shell's default glyph unless an icon is registered under
// the section's own id: an icon filed under any other id never renders.
const iconSeat = seen.slots.find((slot) => slot.seat.name === 'settings.section.icon');
assert.equal(iconSeat.seat.id, settingsSeat.seat.id, 'the icon is addressed by the section id');
const iconTree = iconSeat.component({ size: 16, active: true });
assert.equal(iconTree.type, 'svg');
assert.equal(iconTree.props.width, 16, 'the icon draws at the edge the shell asks for');
assert.equal(iconTree.props.stroke, 'currentColor', 'the icon takes the theme colour it is given');
console.log('ok   body seat keyed by the renderer id, plus a settings section and its nav icon');

// The renderer itself: with no comparison base reachable the plugin must still
// draw the document, because it replaced the builtin body.
const prefs = { mode: 'inline', base: 'head', showRemoved: true };
globalThis.localStorage = {
  getItem: () => JSON.stringify(prefs),
  // The store writes through to storage, so the stub has to keep what it is
  // given: a no-op here would leave the checks reading a value nobody wrote.
  setItem: (_key, value) => {
    Object.assign(prefs, JSON.parse(value));
  },
  removeItem: () => {},
};
// The preference store listens for a `storage` event to invalidate its cached
// snapshot, which is how one window picks up a change made in another.
/** Change a stored preference and let the store reload it. */
function setPrefs(patch) {
  Object.assign(prefs, patch);
  for (const listener of storageListeners) listener({ key: 'dsh-markdown-diff' });
}

// Node 24 ships a read-only `navigator`, so the language the labels pick is
// pinned through the property descriptor rather than by assignment.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'ru-RU' },
  configurable: true,
  writable: true,
});
// The checks that run effects let the surface subscribe to the document, so the
// fake has to keep the listeners: the hotkey check below presses one of them.
const documentHandlers = new Map();
globalThis.document = {
  baseURI: 'http://127.0.0.1:59283/',
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, textContent: '', appendChild() {} }),
  querySelector: () => null,
  addEventListener: (name, listener) => {
    documentHandlers.set(name, listener);
  },
  removeEventListener: (name) => {
    documentHandlers.delete(name);
  },
};

/**
 * Render the body as if the Host had already answered.
 * @param content - the loaded document content.
 * @param answer - the Host's answer about the comparison base.
 * @returns the rendered tree, with the fragments the body asked to draw.
 */
function renderBody(content, answer, refs = { ok: false, code: 'idle', refs: [], suggested: '', current: '' }) {
  // The body reads its load state and the ref list through `useState`, which the
  // stub answers from this queue: the checks never run an effect, so nothing would
  // ever settle and the picker would never see a branch.
  React.__stateQueue = [{ phase: 'ready', answer }, refs];
  const tree = bodySeat.component({
    content,
    resourceAddress: 'dsh-resource://file/session/s-1/notes.md',
    useResource: () => ({ value: { absolutePath: '/w/notes.md' } }),
  });
  // The body's own components (`Block`, `Inline`, `Fragment`) are function
  // components, so the tree has to be expanded before it can be inspected.
  const expanded = render(tree);
  return { tree, expanded, fragments: findByType(expanded, 'markdown') };
}

const outside = renderBody(
  { kind: 'text', text: '# Title\n\nbody\n', pages: [], eof: true },
  { ok: false, code: 'no-repo', message: 'not a repository' },
);
assert.ok(textOf(outside.expanded).includes('вне git-репозитория'), 'a non-repository workspace is reported, not thrown');
assert.equal(outside.fragments.length, 1, 'the document is still drawn through the platform renderer');
assert.equal(outside.fragments[0].props.text, '# Title\n\nbody\n');
console.log('ok   outside a repository the plugin falls back to the plain document');

// An incomplete document must not be diffed: the loaded text is a prefix, so
// every block below the fold would read as removed.
const partial = renderBody(
  { kind: 'text', text: '# Title\n', pages: [{ lines: 2, text: '# Title\n' }], eof: false },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# Title\n\nbody\n' },
);
assert.ok(textOf(partial.expanded).includes('не целиком'), 'a partial document is drawn unmarked');
assert.equal(partial.fragments.length, 1, 'a partial document is drawn as one fragment');
assert.equal(partial.fragments[0].props.streaming, true, 'a partial document keeps the streaming hint');
console.log('ok   a partially loaded document is not diffed');

// A tracked file with an extra paragraph: the new block is framed as added and
// the unchanged stretch is drawn without a mark.
const changed = renderBody(
  { kind: 'text', text: '# Title\n\nbody\n\nnew paragraph\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# Title\n\nbody\n' },
);
const kinds = findBy(changed.expanded, (node) => node.props?.['data-kind'] !== undefined)
  .map((node) => node.props['data-kind']);
assert.deepEqual(kinds, ['equal', 'added'], 'the unchanged stretch and the new block are told apart');
assert.ok(textOf(changed.expanded).includes('+'), 'the added block carries a gutter mark');
assert.deepEqual(changed.fragments.map((fragment) => fragment.props.text), ['# Title\n\nbody', 'new paragraph']);
console.log('ok   a changed document is drawn group by group with marks');

// A selection becomes a comment through `data-dsmd-group`: it is the only handle
// the renderer leaves on which group a range fell into, so without it the
// floating button could never tell a block from the page background.
const grouped = findBy(changed.expanded, (node) => node.props?.['data-dsmd-group'] !== undefined);
assert.deepEqual(grouped.map((node) => node.props['data-dsmd-group']), ['0', '1'],
  'every block names the group it draws');
assert.equal(
  findBy(changed.expanded, (node) => node.props?.['data-markdown-diff-comment'] !== undefined).length,
  0,
  'no comment box is drawn until a selection is made',
);
console.log('ok   blocks are addressable by group and no comment box is drawn unprompted');

// The same document read in the two-column view: the base on the left, the file
// on the right, and both columns advancing on a one-sided change.
setPrefs({ mode: 'side-by-side' });
const split = renderBody(
  { kind: 'text', text: '# Title\n\nbody\n\nnew paragraph\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# Title\n\nbody\n' },
);
setPrefs({ mode: 'inline' });
const columns = findBy(split.expanded, (node) => node.props?.['data-side'] !== undefined);
assert.deepEqual(columns.map((node) => node.props['data-side']), ['base', 'worktree']);
// Each column holds a heading and the blocks below it, in one children array.
const columnKinds = (column) => column.props.children.map((node) => node.props?.['data-kind']).filter(Boolean);
assert.deepEqual(columnKinds(columns[0]), ['equal', 'empty'], 'the base column leaves the added row empty');
assert.deepEqual(columnKinds(columns[1]), ['equal', 'added']);
console.log('ok   the side-by-side view keeps both columns aligned');

// A rewritten paragraph is drawn twice in one frame: the old text struck through
// above the new one.
const rewritten = renderBody(
  { kind: 'text', text: '# T\n\ncompletely different words here\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\noriginal sentence about cats\n' },
);
const inlineKinds = findBy(rewritten.expanded, (node) => node.props?.['data-kind'] !== undefined)
  .map((node) => node.props['data-kind']);
assert.deepEqual(inlineKinds, ['equal', 'removed', 'added']);
assert.equal(findBy(rewritten.expanded, (node) => node.props?.className === 'dsmd-before').length, 0,
  'a rewrite has no struck-through pass inside one frame');
console.log('ok   a rewritten paragraph reads as a removal plus an addition');

// A heading that grew keeps its text on both sides, so it folds into one frame
// with the old wording above the new.
const grown = renderBody(
  { kind: 'text', text: '## Задачи и сроки\n\nbody\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '## Задачи\n\nbody\n' },
);
assert.equal(findBy(grown.expanded, (node) => node.props?.className === 'dsmd-before').length, 1,
  'a modified group draws the base text above the working-tree text');
assert.deepEqual(findBy(grown.expanded, (node) => node.props?.['data-kind'] !== undefined)
  .map((node) => node.props['data-kind']), ['modified', 'equal']);
console.log('ok   an extended heading folds into one modified frame');

// The narrowed highlight needs both halves of a modified group to be findable in
// the finished DOM, since the renderer turns raw HTML into literal text and the
// ranges are painted from outside its tree.
const paired = findBy(grown.expanded, (node) => node.props?.['data-dsmd-side'] !== undefined)
  .map((node) => `${String(node.props['data-dsmd-pair'])}:${String(node.props['data-dsmd-side'])}`);
assert.deepEqual(paired, ['0:before', '0:after'],
  'both sides of a modified group carry the same pair index');
const pairedFrames = findBy(grown.expanded, (node) => node.props?.['data-dsmd-paired'] === 'true');
assert.equal(pairedFrames.length, 1, 'the frame of a paired group is marked as paired');
console.log('ok   both halves of a modified group are paired for inline marking');

// Hiding removals must compact the inline view without breaking the narrowing:
// the old half leaves the flow but stays in the tree, because the highlighter
// compares the two sides' text to tell a changed word from an inserted one.
setPrefs({ showRemoved: false });
const compact = renderBody(
  { kind: 'text', text: '## Задачи и сроки\n\nbody\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '## Задачи\n\nbody\n' },
);
const hiddenBefore = findBy(compact.expanded, (node) => node.props?.className === 'dsmd-before');
assert.equal(hiddenBefore.length, 1, 'the old half is still rendered');
assert.equal(hiddenBefore[0].props['data-dsmd-hidden'], 'true', 'the old half is flagged as hidden');
// The stylesheet rule alone is not enough: a page can still be running the sheet
// of an earlier build, in which case a newly added selector never applies. The
// inline declaration is what makes the click work regardless.
assert.equal(hiddenBefore[0].props.style?.display, 'none',
  'hiding rides on the element style, not only on a stylesheet rule');
const stillPaired = findBy(compact.expanded, (node) => node.props?.['data-dsmd-side'] !== undefined)
  .map((node) => node.props['data-dsmd-side']);
assert.deepEqual(stillPaired, ['before', 'after'],
  'both sides stay in the tree so the word diff still has a base to compare against');
setPrefs({ showRemoved: true });
const expandedAgain = renderBody(
  { kind: 'text', text: '## Задачи и сроки\n\nbody\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '## Задачи\n\nbody\n' },
);
const shownBefore = findBy(expandedAgain.expanded, (node) => node.props?.className === 'dsmd-before');
assert.equal(shownBefore[0].props['data-dsmd-hidden'], undefined, 'with removals shown the old half is back');
console.log('ok   hiding removals compacts a modified block to one rendering');

// The checks above switch the stored preference directly, which is not what a
// click does. The button goes through the store and back into a re-render, so a
// break in that loop — a stale prop, a missed subscription — would stay invisible
// here and only show up as a control that does nothing. Click the button itself.
const clickable = renderBody(
  { kind: 'text', text: '## Задачи и сроки\n\nbody\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '## Задачи\n\nbody\n' },
);
const removalsButton = findBy(clickable.expanded, (node) => node.type === 'button'
  && node.props?.className === 'dsmd-tool'
  && node.props?.['aria-pressed'] !== undefined);
assert.equal(removalsButton.length, 1, 'the toolbar has one removals toggle');
assert.equal(removalsButton[0].props['aria-pressed'], true, 'removals start visible');
removalsButton[0].props.onClick();
assert.equal(prefs.showRemoved, false, 'the click reaches the stored preference');
const afterClick = renderBody(
  { kind: 'text', text: '## Задачи и сроки\n\nbody\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '## Задачи\n\nbody\n' },
);
const clickedBefore = findBy(afterClick.expanded, (node) => node.props?.className === 'dsmd-before');
assert.equal(clickedBefore[0].props.style?.display, 'none', 'the click hides the old half on the next render');
const clickedButton = findBy(afterClick.expanded, (node) => node.type === 'button'
  && node.props?.className === 'dsmd-tool'
  && node.props?.['aria-pressed'] !== undefined)[0];
assert.equal(clickedButton.props['aria-pressed'], false, 'the button reports its new state');
clickedButton.props.onClick();
assert.equal(prefs.showRemoved, true, 'a second click turns removals back on');
setPrefs({ showRemoved: true });
console.log('ok   clicking the removals button recomputes the view');

// The plugin replaced the builtin renderer, so a file with no changes and a file
// in plain mode must both still draw their text.
const unchanged = renderBody(
  { kind: 'text', text: '# Title\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# Title\n' },
);
assert.ok(textOf(unchanged.expanded).includes('Изменений нет'));
assert.deepEqual(unchanged.fragments.map((fragment) => fragment.props.text), ['# Title\n']);
setPrefs({ mode: 'plain' });
const plain = renderBody(
  { kind: 'text', text: '# Title\n\nnew\n', pages: [], eof: true },
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# Title\n' },
);
setPrefs({ mode: 'inline' });
assert.deepEqual(findBy(plain.expanded, (node) => node.props?.['data-kind'] !== undefined), [],
  'plain mode draws no frames at all');
assert.deepEqual(plain.fragments.map((fragment) => fragment.props.text), ['# Title\n\nnew\n']);
console.log('ok   an unchanged file and plain mode both draw the document');

// "Без подсветки" in the file tab is the sidebar's own reading view, not an
// imitation of it: that is where the frontmatter hiding, the rendered HTML, and
// the "add to conversation" popup for a selection live. The shipped component is
// therefore rendered whole, while the toolbar that leads back to a diff stays.
{
  const shipped = {
    id: 'markdown',
    exts: ['md'],
    fetchStrategy: 'fsRead',
    component: (props) => React.createElement('markdown', { 'data-shipped-plain': props.viewerId }),
  };
  const sidebarCtx = { ...ctx, get: () => ({ getFileViewers: () => [shipped], isViewerEnabled: () => true }) };
  setPrefs({ mode: 'plain' });
  React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\nold\n' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
  const delegatedTree = viewer.component({
    ctx: sidebarCtx,
    content: '# T\n\nnew\n',
    path: 'docs/notes.md',
    scope: { sessionId: 's-1', cwd: 'C:/w' },
  });
  const delegated = render(delegatedTree);
  assert.equal(findBy(delegated, (node) => node.props?.['data-shipped-plain'] !== undefined).length, 1,
    'plain mode renders the shipped reading view');
  // The plugin's own renderer draws a `markdown` element without the shipped
  // marker, so counting those tells the two apart.
  assert.equal(
    findBy(delegated, (node) => node.type === 'markdown' && node.props?.['data-shipped-plain'] === undefined).length,
    0,
    'plain mode does not also render this plugin\'s own copy of the document',
  );
  const backToDiff = findBy(delegated, (node) => node.type === 'button' && (node.props?.children === 'В тексте' || node.props?.children === 'В тексте'))
    .concat(findBy(delegated, (node) => node.props?.['data-markdown-diff-bar'] !== undefined));
  assert.ok(backToDiff.length > 0, 'the toolbar that leads back to a diff stays in plain mode');

  // Without the shipped viewer there is nothing to delegate to, so the plugin
  // draws the document itself — it must never show an empty frame.
  React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
  const ownPlain = render(viewer.component({
    ctx: { ...ctx, get: () => undefined },
    content: '# T\n',
    path: 'docs/notes.md',
    scope: { sessionId: 's-1', cwd: 'C:/w' },
  }));
  assert.equal(findBy(ownPlain, (node) => node.type === 'markdown').length, 1,
    'without the shipped viewer plain mode still draws the document itself');
  setPrefs({ mode: 'inline' });
}
console.log('ok   plain mode delegates to the shipped reading view and keeps the way back');

// A closed leading YAML frontmatter block is metadata: the preview shows the
// document, not its `---` delimiters rendered as a rule and a heading.
{
  setPrefs({ mode: 'plain' });
  const renderOwn = (content) => {
    React.__stateQueue = [false, { phase: 'ready', answer: { ok: false, code: 'no-repo', message: 'x' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
    return findByType(render(viewer.component({
      ctx: { ...ctx, get: () => undefined },
      content,
      path: 'docs/notes.md',
      scope: { sessionId: 's-1', cwd: 'C:/w' },
    })), 'markdown').map((node) => node.props.text);
  };
  assert.deepEqual(renderOwn('---\ntitle: x\nstatus: draft\n---\n\n# Body\n'), ['# Body\n'],
    `a closed leading frontmatter block is not rendered, got: ${JSON.stringify(renderOwn('---\ntitle: x\nstatus: draft\n---\n\n# Body\n'))}`);
  assert.deepEqual(renderOwn('---\ntitle: x\n'), ['---\ntitle: x\n'],
    'an unclosed frontmatter block is left alone');
  assert.deepEqual(renderOwn('# Body\n\n---\ntitle: x\n---\n'), ['# Body\n\n---\ntitle: x\n---\n'],
    'a frontmatter block that does not open the file is left alone');
  setPrefs({ mode: 'inline' });
}
console.log('ok   plain mode hides a closed leading frontmatter block');

// Frontmatter in a diff mode is metadata, not code: it is drawn as a sheet of
// properties with a fold button, and the fold keeps the rows in the document so
// the two halves of a modified group still compare equal.
{
  setPrefs({ mode: 'inline' });
  const frontmatterDoc = '---\nid: 1000000001\nspace_name: Sample\n---\n\n# Title\n\nbody\n';
  // The base differs below the header, so the document is actually a diff and the
  // header lands in an unchanged group — the case where it used to be a `<pre>`.
  const frontmatterBase = '---\nid: 1000000001\nspace_name: Sample\n---\n\n# Title\n\nold body\n';
  const drawFrontmatter = (collapsed) => {
    React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: frontmatterBase } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }, collapsed];
    return render(viewer.component({
      ctx: { ...ctx, get: () => undefined },
      content: frontmatterDoc,
      path: 'docs/notes.md',
      scope: { sessionId: 's-1', cwd: 'C:/w' },
    }));
  };

  const openTree = drawFrontmatter(false);
  const sheets = findBy(openTree, (node) => node.props?.['data-markdown-diff-frontmatter'] !== undefined);
  assert.ok(sheets.length > 0, 'the diff draws the frontmatter block at all');
  // A `pre` would mean the YAML is echoed as source, which is the thing this
  // changed: the block has to be structured markup now.
  assert.equal(
    findBy(openTree, (node) => node.type === 'pre' && node.props?.className?.includes('dsmd-frontmatter') === true).length,
    0,
    'frontmatter is not drawn as a code block',
  );
  // And the values are present as their own text, not as one source string.
  const keys = findBy(openTree, (node) => node.props?.['data-dsmd-prop'] !== undefined).map((node) => node.props['data-dsmd-prop']);
  assert.deepEqual(keys, ['id', 'space_name'], `each key becomes its own row, got: ${JSON.stringify(keys)}`);
  assert.ok(textOf(openTree).includes('Sample'), 'a property value is drawn');
  assert.ok(textOf(openTree).includes('1000000001'), 'a property value is drawn');
  assert.equal(
    textOf(openTree).includes('---'),
    false,
    'the delimiters are gone: they are syntax, not content',
  );

  // The fold button has to exist and describe itself, or the block reads as one
  // more inert box.
  const toggles = findBy(openTree, (node) => node.props?.['aria-expanded'] !== undefined);
  assert.equal(toggles.length, 1, 'the properties block has one fold button');
  assert.equal(toggles[0].props['aria-expanded'], 'true', 'it starts open');

  // Collapsed, the rows must still be in the tree: the inline highlighter compares
  // the two halves of a modified group by their text, and a folded half that lost
  // its rows would compare short against long and mis-mark the whole document.
  const foldedTree = drawFrontmatter(true);
  const foldedKeys = findBy(foldedTree, (node) => node.props?.['data-dsmd-prop'] !== undefined).map((node) => node.props['data-dsmd-prop']);
  assert.deepEqual(foldedKeys, keys, 'folding hides the rows without removing them from the tree');
  assert.equal(
    findBy(foldedTree, (node) => node.props?.['aria-expanded'] === 'false').length,
    1,
    'the button reports the block as folded',
  );
  const foldedSheet = findBy(foldedTree, (node) => node.props?.['data-markdown-diff-frontmatter'] !== undefined)[0];
  assert.equal(foldedSheet.props['data-dsmd-collapsed'], 'true', 'the fold is a state on the block, so CSS can clip it');

  setPrefs({ mode: 'inline' });
}
console.log('ok   frontmatter is drawn as foldable properties in a diff, not as code');

/**
 * Render the viewer as the file tab does: a decoded string, the workspace path,
 * and the scope the tab read it in — no address and no paging.
 * @param text - the decoded file text.
 * @param answer - the Host's answer about the comparison base.
 * @param extra - props the tab adds for an oversized file.
 * @returns the expanded tree and the fragments it drew.
 */
function renderViewer(text, answer, extra = {}) {
  // The viewer itself holds one cell (whether the shipped editor has taken the
  // document over) ahead of the surface's two, so the queue is three deep.
  React.__stateQueue = [false, { phase: 'ready', answer }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
  const tree = viewer.component({
    content: text,
    path: 'docs/notes.md',
    scope: { sessionId: 's-1', cwd: 'C:/w' },
    ...extra,
  });
  const expanded = render(tree);
  return { expanded, fragments: findByType(expanded, 'markdown') };
}

// The file tab is what actually opens a `.md`, so the same diff has to come out
// of a viewer that never sees an address.
const viewerChanged = renderViewer(
  '# Title\n\nbody\n\nnew paragraph\n',
  { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# Title\n\nbody\n' },
);
assert.deepEqual(
  findBy(viewerChanged.expanded, (node) => node.props?.['data-kind'] !== undefined).map((node) => node.props['data-kind']),
  ['equal', 'added'],
  'the viewer marks the same blocks the preview does',
);
assert.equal(findBy(viewerChanged.expanded, (node) => node.props?.['data-markdown-diff-view'] !== undefined).length, 1);
console.log('ok   the file viewer draws the same marked document from a plain string');

// An oversized file arrives flagged and without `content`: say so rather than
// draw an empty frame.
const viewerLarge = renderViewer('', { ok: true, status: 'tracked', baseRef: 'HEAD', base: '' }, { largeFile: true });
assert.ok(textOf(viewerLarge.expanded).includes('слишком велик'), 'an oversized file explains the empty frame');
assert.equal(viewerLarge.fragments.length, 0, 'an oversized file has no text to draw');
console.log('ok   an oversized file is reported instead of drawn empty');

// The viewer must tolerate the service vanishing mid-session: the lookup is
// guarded, so a context that never provides `betterSidebar` still applies.
const bare = { ...ctx, get: () => undefined, inject: () => () => {} };
assert.doesNotThrow(() => plugin.apply(bare), 'a missing sidebar service must not fail the plugin');
console.log('ok   a missing sidebar service leaves the host preview in place');

const settingsTree = settingsSeat.component({});
const buttons = findByType(settingsTree, 'button');
assert.equal(buttons.length, 11, 'three views, three bases, two points, the shortcut field\'s two buttons, and the reset');
assert.ok(textOf(settingsTree).includes('Подсветка изменений'));
assert.ok(textOf(settingsTree).includes('Ветка'), 'the settings section offers branch comparison');
assert.ok(textOf(settingsTree).includes('Точка ветвления'), 'and the divergence point');
console.log('ok   the settings section renders its choices and reset');

// The shortcut is recorded, not typed: the field takes the next keydown and stores
// what it was. Nothing here runs a browser, so this is the only place the wiring
// between a press, the store, and the surface's matcher is checked end to end.
{
  const field = findBy(settingsTree, (node) => node.props?.['data-markdown-diff-hotkey'] !== undefined)[0];
  assert.ok(field !== undefined, 'the settings section offers a shortcut field');
  assert.equal(field.props.value, 'Ctrl+Enter', 'it starts at the default combination');
  /**
   * Press a key in the field.
   * @param press - the event fields to override.
   * @returns whether the field claimed the press.
   */
  const press = (overrides) => {
    let claimed = false;
    field.props.onKeyDown({
      key: 'm',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      preventDefault: () => { claimed = true; },
      ...overrides,
    });
    return claimed;
  };
  assert.equal(press({ key: 'k', ctrlKey: true, shiftKey: true }), true, 'a combination is claimed by the field');
  assert.equal(prefs.commentHotkey, 'Ctrl+Shift+K', 'the field stores what was pressed');
  // The layout must not matter: the same physical key on the Russian layout prints
  // `л`, and the field still has to record the position the reader bound.
  assert.equal(press({ key: 'л', code: 'KeyK', ctrlKey: true, shiftKey: true }), true, 'a Cyrillic press is claimed too');
  assert.equal(prefs.commentHotkey, 'Ctrl+Shift+K', 'and stores the key position, not the Cyrillic letter');
  // A bare key would fire while the document is merely being read, so it is
  // refused — and refused visibly, through the same field.
  assert.equal(press({ key: 'k' }), true, 'a bare key is still claimed, so it cannot insert anything');
  assert.equal(prefs.commentHotkey, 'Ctrl+Shift+K', 'a bare key changes nothing');
  // Escape alone means "no shortcut", which is how a reader who dislikes one gets
  // rid of it without hunting for a button.
  assert.equal(press({ key: 'Escape' }), true, 'Esc is claimed');
  assert.equal(prefs.commentHotkey, '', 'Esc turns the shortcut off');
  const restore = findBy(settingsTree, (node) => node.type === 'button'
    && String(node.props?.children) === 'По умолчанию')[0];
  assert.ok(restore !== undefined, 'the section can put the default back');
  restore.props.onClick();
  assert.equal(prefs.commentHotkey, 'Ctrl+Enter', 'the default button restores the combination');
}
console.log('ok   the shortcut field records a press, refuses a bare key, and can be cleared');

// The branch picker: the third base is offered, but it needs the ref list, and
// the list arrives from the Host. The picker must not open on an empty selection,
// so choosing it adopts the suggestion the Host worked out.
const refAnswer = {
  ok: true,
  refs: [
    { name: 'master', kind: 'local', commit: 'abc1234', date: 1, current: false },
    { name: 'wt/create-glossary', kind: 'local', commit: 'def5678', date: 2, current: true },
    { name: 'origin/master', kind: 'remote', commit: 'abc1234', date: 1, current: false },
  ],
  current: 'wt/create-glossary',
  suggested: 'origin/master',
};
globalThis.fetch = async (url) => ({
  json: async () => (String(url).includes('markdown-diff.refs')
    ? refAnswer
    : { ok: true, status: 'tracked', baseRef: 'master', base: '# T\n\nold\n' }),
});
// The ref list is fetched in an effect, which the stub does not run, so the body
// is rendered with both of its state cells already settled: the Host's answer,
// then the ref list.
React.__stateQueue = [
  { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\nold\n' } },
  refAnswer,
];
const pickable = render(bodySeat.component({
  content: { kind: 'text', text: '# T\n\nnew\n', pages: [], eof: true },
  resourceAddress: 'dsh-resource://file/session/s-1/notes.md',
  useResource: () => ({ value: { absolutePath: '/w/notes.md' } }),
}));
const baseButtons = findBy(pickable, (node) => node.type === 'button' && node.props?.className === 'dsmd-tab'
  && ['HEAD', 'Индекс', 'Ветка'].includes(String(node.props?.children)));
assert.deepEqual(baseButtons.map((node) => node.props.children), ['HEAD', 'Индекс', 'Ветка'],
  'the toolbar offers the branch base beside the two fixed ones');
assert.equal(baseButtons[2].props.disabled, false,
  'the branch base is offered once the ref list has arrived');
const headButton = baseButtons[0];
headButton.props.onClick();
assert.equal(prefs.base, 'head', 'a fixed base still switches directly');
setPrefs({ base: 'head' });
console.log('ok   the toolbar offers a branch base beside HEAD and the index');

// Without a ref list the branch choice is disabled rather than hidden: a reader
// in a repository with no branches still learns that the feature exists.
React.__stateQueue = [
  { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\nold\n' } },
  { ok: false, code: 'no-repo', refs: [], suggested: '', current: '' },
];
const noRefs = render(bodySeat.component({
  content: { kind: 'text', text: '# T\n\nnew\n', pages: [], eof: true },
  resourceAddress: 'dsh-resource://file/session/s-1/notes.md',
  useResource: () => ({ value: { absolutePath: '/w/notes.md' } }),
}));
const branchButton = findBy(noRefs, (node) => node.type === 'button' && node.props?.children === 'Ветка')[0];
assert.equal(branchButton.props.disabled, true, 'with no ref list the branch base is disabled');
console.log('ok   without a ref list the branch base is disabled, not hidden');

// A branch name is meaningful only inside the repository that has it, while the
// preference is one value for the whole app: it survives a switch to another
// project and a reload. Asking for a name this repository has never heard of costs
// the reader the whole diff and an error page, so the surface replaces it with the
// suggestion as soon as the list arrives instead of sending the request.
{
  setPrefs({ base: 'ref', branch: 'feature/example' });
  React.__runEffects = true;
  React.__stateQueue = [
    { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'master', base: '# T\n\nold\n' } },
    refAnswer,
  ];
  render(bodySeat.component({
    content: { kind: 'text', text: '# T\n\nnew\n', pages: [], eof: true },
    resourceAddress: 'dsh-resource://file/session/s-1/notes.md',
    useResource: () => ({ value: { absolutePath: '/w/notes.md' } }),
  }));
  React.__runEffects = false;
  assert.equal(prefs.branch, 'origin/master', 'a branch this repository lacks is replaced by the suggestion');
  // The empty name is the same case: `ref` with nothing picked would reach the Host
  // as a request that names no branch at all.
  setPrefs({ branch: '' });
  React.__runEffects = true;
  React.__stateQueue = [
    { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'master', base: '# T\n\nold\n' } },
    refAnswer,
  ];
  render(bodySeat.component({
    content: { kind: 'text', text: '# T\n\nnew\n', pages: [], eof: true },
    resourceAddress: 'dsh-resource://file/session/s-1/notes.md',
    useResource: () => ({ value: { absolutePath: '/w/notes.md' } }),
  }));
  React.__runEffects = false;
  assert.equal(prefs.branch, 'origin/master', 'an empty branch adopts the suggestion');
  setPrefs({ base: 'head', branch: '' });
}
console.log('ok   a branch name from another repository is replaced instead of failing the diff');

// A branch the file predates: the whole document is new against it, and the
// toolbar has to say so rather than present it as an ordinary addition.
const absent = renderBody(
  { kind: 'text', text: '# New\n\nbody\n', pages: [], eof: true },
  { ok: true, status: 'absent', baseRef: 'master', base: '' },
);
assert.ok(textOf(absent.expanded).includes('нет в master'),
  `a file missing from the chosen branch is reported by name, got: ${JSON.stringify(textOf(absent.expanded).slice(0, 200))}`);
console.log('ok   a file absent from the chosen branch says so');

// The file tab's header draws the "preview / edit" pair and the refresh button
// only when the viewer reports a toolbar state. Claiming `.md` without that
// report is what silently turned every Markdown tab read-only, so the report is
// part of the contract, not a nicety.
{
  const reported = [];
  const controls = [];
  React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\nold\n' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
  const shipped = {
    id: 'markdown',
    exts: ['md'],
    fetchStrategy: 'fsRead',
    component: (props) => React.createElement('markdown', { 'data-shipped-editor': 'true', props }),
  };
  const ctxWithSidebar = {
    ...ctx,
    get: (name) => (name === 'betterSidebar'
      ? { getFileViewers: () => [shipped], isViewerEnabled: () => true }
      : undefined),
  };
  const tree = viewer.component({
    ctx: ctxWithSidebar,
    content: '# T\n\nnew\n',
    path: 'docs/notes.md',
    scope: { sessionId: 's-1', cwd: 'C:/w' },
    onToolbarState: (state) => { reported.push(state); },
    onToolbarControls: (next) => { controls.push(next); },
  });
  React.__runEffects = true;
  try {
    render(tree);
  } finally {
    React.__runEffects = false;
  }
  const last = reported[reported.length - 1];
  assert.ok(last !== undefined, 'the viewer reports a toolbar state to the tab header');
  assert.equal(last.modes, true, 'the header is told the preview/edit pair applies');
  assert.equal(last.mode, 'preview', 'the viewer starts in preview');
  assert.equal(last.editable, false, 'a diff never offers to save');
  assert.equal(last.dirty, false, 'a diff is never dirty');
  const lastControls = controls[controls.length - 1];
  assert.ok(lastControls !== undefined && lastControls !== null, 'the viewer registers its toolbar commands');
  // Asking the header's "edit" half for edit mode is what hands the file over.
  assert.equal(typeof lastControls.setMode, 'function', 'the commands carry a mode setter');
}
console.log('ok   the viewer reports a toolbar state so the tab header works');

// The handoff itself: with a shipped Markdown viewer registered, the tab can
// render it instead of losing editing to the intercept. Without one the tab
// still draws the diff and never offers an edit it cannot honour.
{
  /**
   * Render the viewer with its effects run once and collect the mode report.
   * @param get - the context's service lookup.
   * @returns the `modes` flag the header was last told.
   */
  const modesWith = (get) => {
    const modes = [];
    React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
    React.__runEffects = true;
    try {
      render(viewer.component({
        ctx: { ...ctx, get },
        content: '# T\n',
        path: 'docs/notes.md',
        scope: { sessionId: 's-1', cwd: 'C:/w' },
        onToolbarState: (state) => { modes.push(state.modes); },
      }));
    } finally {
      React.__runEffects = false;
    }
    return modes[modes.length - 1];
  };
  const shipped = {
    id: 'markdown',
    exts: ['md'],
    fetchStrategy: 'fsRead',
    component: (props) => React.createElement('markdown', { 'data-shipped-editor': 'true' }),
  };
  assert.equal(
    modesWith((name) => (name === 'betterSidebar' ? { getFileViewers: () => [shipped], isViewerEnabled: () => true } : undefined)),
    true,
    'with a shipped editor the tab offers the edit half',
  );
  assert.equal(modesWith(() => undefined), false,
    'with no shipped editor the tab does not offer an edit it cannot honour');
  assert.equal(
    modesWith((name) => (name === 'betterSidebar' ? { getFileViewers: () => [shipped], isViewerEnabled: () => false } : undefined)),
    false,
    'a shipped editor disabled in the sidebar settings is left disabled',
  );
}
console.log('ok   the edit half appears only when an enabled shipped editor can take the file');

// A reference like `docs/a.md#L131` names a source line. Blocks keep the source
// lines they came from, so the diff can mark the group that holds the line and
// scroll to it; a preview that always opened at the top would lose the reader
// who came for that line.
{
  /**
   * Render the viewer for an address that named a line.
   * @param line - the 1-based line, or `undefined` for an ordinary open.
   * @returns the anchor attributes the view drew.
   */
  const anchorsFor = (line) => {
    React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\nbody\n' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
    const tree = viewer.component({
      content: '# T\n\nbody\n\nnew tail\n',
      path: 'docs/notes.md',
      scope: { sessionId: 's-1', cwd: 'C:/w' },
      line,
    });
    return findBy(render(tree), (node) => node.props?.['data-dsmd-anchor'] !== undefined)
      .map((node) => node.props['data-dsmd-anchor']);
  };
  // Line 5 is the appended paragraph, so its group is the marked one.
  assert.deepEqual(anchorsFor(5), ['1'], 'an address that named a line marks the group holding it');
  assert.deepEqual(anchorsFor(1), ['0'], 'a line in the first block marks the first group');
  assert.deepEqual(anchorsFor(undefined), [], 'an ordinary open marks no group');
  assert.deepEqual(anchorsFor(999), [], 'a line past the end of the document marks nothing');

  // A line that only exists in the comparison base names text the file no longer
  // has: landing there would point the reader at a removed block. The document
  // above is one line shorter in the base, so line 5 is the working tree's.
  const removedOnly = (() => {
    React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\nbody\n\nold tail\n\nmore old\n' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
    return findBy(render(viewer.component({
      content: '# T\n\nbody\n',
      path: 'docs/notes.md',
      scope: { sessionId: 's-1', cwd: 'C:/w' },
      line: 7,
    })), (node) => node.props?.['data-dsmd-anchor'] !== undefined).map((node) => node.props['data-dsmd-anchor']);
  })();
  assert.deepEqual(removedOnly, [], 'a line only the base file had is not anchored in the working tree');
}
console.log('ok   a line in the address lands on the group that holds it');

// Clicking the header's "edit" half hands the file to the shipped editor — and
// that editor mounts in its OWN preview mode, so without a nudge the reader
// would land in a second read-only preview instead of an editor.
{
  const calls = [];
  const shipped = {
    id: 'markdown',
    exts: ['md'],
    fetchStrategy: 'fsRead',
    component: (props) => {
      // Stand in for TextEditor: register the commands the host drives it with.
      props.onToolbarControls({ setMode: (mode) => { calls.push(mode); }, save: () => {} });
      return React.createElement('markdown', { 'data-shipped-editor': 'true' });
    },
  };
  // The viewer's one cell says the handoff is already in progress, so this
  // renders the shipped editor exactly as a click on "edit" would.
  React.__stateQueue = [true, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
  React.__runEffects = true;
  try {
    render(viewer.component({
      ctx: { ...ctx, get: () => ({ getFileViewers: () => [shipped], isViewerEnabled: () => true }) },
      content: '# T\n',
      path: 'docs/notes.md',
      scope: { sessionId: 's-1', cwd: 'C:/w' },
    }));
  } finally {
    React.__runEffects = false;
  }
  assert.ok(calls.includes('edit'),
    `the handoff opens the shipped editor, not its preview, got: ${JSON.stringify(calls)}`);
}
console.log('ok   the handoff opens the shipped editor rather than its preview');

// The shortcut reaches the surface through a document listener, so the listener
// has to exist and has to stay quiet when there is nothing to comment on: without
// a selection the combination must not open an empty box or swallow the key.
{
  React.__stateQueue = [false, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '# T\n\nold\n' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
  React.__runEffects = true;
  let tree;
  try {
    tree = render(viewer.component({
      ctx: { ...ctx, get: () => undefined },
      content: '# T\n\nnew\n',
      path: 'docs/notes.md',
      scope: { sessionId: 's-1', cwd: 'C:/w' },
    }));
  } finally {
    React.__runEffects = false;
  }
  const onKeyDown = documentHandlers.get('keydown');
  assert.equal(typeof onKeyDown, 'function', 'the surface listens for the shortcut');
  let prevented = false;
  onKeyDown({
    key: 'm',
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false, 'with no selection the key is left alone');
  assert.equal(
    findBy(tree, (node) => node.props?.['data-markdown-diff-comment'] !== undefined).length,
    0,
    'and no comment box opens out of nothing',
  );
}
console.log('ok   the shortcut is subscribed and stays quiet without a selection');

// React counts hooks per component instance and refuses a render that calls a
// different number than the previous one — #300, "rendered fewer hooks than
// expected". The viewer switches between the diff and the shipped editor on the
// same instance, so its hook count has to stay constant across that switch; a
// hook after the handoff's early return is exactly what crashed the sidebar tab.
{
  const shipped = {
    id: 'markdown',
    exts: ['md'],
    fetchStrategy: 'fsRead',
    component: () => React.createElement('markdown', { 'data-shipped-editor': 'true' }),
  };
  const ctxWithSidebar = {
    ...ctx,
    get: () => ({ getFileViewers: () => [shipped], isViewerEnabled: () => true }),
  };
  /**
   * Render the viewer once and report the hooks it called.
   * @param editing - the value of the viewer's editing cell for this render.
   * @returns the hook names, in call order.
   */
  const hooksFor = (editing) => {
    hookFrames.delete(viewer.component);
    React.__stateQueue = [editing, { phase: 'ready', answer: { ok: true, status: 'tracked', baseRef: 'HEAD', base: '' } }, { ok: false, code: 'idle', refs: [], suggested: '', current: '' }];
    // The viewer has to go through `render` for its own hook calls to be
    // recorded — calling it directly would run it outside the recorded frame.
    render(React.createElement(viewer.component, {
      ctx: ctxWithSidebar,
      content: '# T\n',
      path: 'docs/notes.md',
      scope: { sessionId: 's-1', cwd: 'C:/w' },
    }));
    const runs = hookFrames.get(viewer.component) ?? [];
    return runs[0] ?? [];
  };
  const previewHooks = hooksFor(false);
  const editorHooks = hooksFor(true);
  assert.deepEqual(editorHooks, previewHooks,
    `the viewer must call the same hooks in the diff and in the editor (React #300), diff: ${JSON.stringify(previewHooks)}, editor: ${JSON.stringify(editorHooks)}`);
  assert.ok(previewHooks.length > 0, 'the viewer does call hooks');
}
console.log('ok   the viewer keeps its hook order when it hands the file to the editor');

console.log('\nbundle check passed');
