/**
 * Selection checks: what a comment is written about.
 *
 * The resolution runs on the finished DOM only — which block a range fell into,
 * which half of a pair it belongs to, and where the button should stand — so a
 * minimal element tree is enough to prove it without a browser. A wrong answer
 * here is a comment filed against the wrong lines, which is worse than no
 * comment at all, so each branch of the fallback is pinned.
 *
 *   node test/selection.test.mjs
 */

import assert from 'node:assert/strict';

import { readSelection, sideOf } from '../src/selection.js';

let passed = 0;
let failed = 0;

/**
 * Run one named check with a clean fake browser.
 * @param name - what the check proves.
 * @param body - the assertions.
 */
function test(name, body) {
  try {
    globalThis.window = undefined;
    globalThis.document = undefined;
    body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  } finally {
    globalThis.window = undefined;
    globalThis.document = undefined;
  }
}

/** One text node, wired to its parent by `element`. */
function textNode(data) {
  return { nodeType: 3, data, parentNode: null, get parentElement() { return null; } };
}

/** A rectangle the geometry assertions can predict. */
function rect(left, top, width = 40, height = 20) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * An element with the parts this module reads: attributes, class, `closest`,
 * `querySelector`, `contains`, and a rectangle.
 *
 * @param children - text nodes and elements.
 * @param attributes - initial attributes; `class` is read from here too.
 * @param box - the element's client rectangle.
 */
function element(children, attributes = {}, box = rect(0, 0)) {
  const attrs = new Map(Object.entries(attributes));
  const self = {
    nodeType: 1,
    nodeName: 'DIV',
    children,
    parentNode: null,
    box,
    scrollTop: 0,
    scrollLeft: 0,
    get className() {
      return attrs.get('class') ?? '';
    },
    get textContent() {
      return children.map((child) => (child.nodeType === 3 ? child.data : child.textContent)).join('');
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getBoundingClientRect() {
      return self.box;
    },
    /** Whether `node` is this element or sits inside it. */
    contains(node) {
      let at = node;
      while (at !== null && at !== undefined) {
        if (at === self) return true;
        at = at.parentNode ?? null;
      }
      return false;
    },
    /** The nearest ancestor-or-self matching one of the module's selectors. */
    closest(selector) {
      let at = self;
      while (at !== null) {
        if (matches(at, selector)) return at;
        at = at.parentNode;
      }
      return null;
    },
    /** The first descendant matching the selector, as the module asks. */
    querySelector(selector) {
      for (const child of children) {
        if (child.nodeType === 3) continue;
        if (matches(child, selector)) return child;
        const deeper = child.querySelector(selector);
        if (deeper !== null) return deeper;
      }
      return null;
    },
  };
  self.parentNode = null;
  for (const child of children) child.parentNode = self;
  return self;
}

/** The four selectors the module uses. */
function matches(node, selector) {
  if (selector === '[data-dsmd-group]') return node.getAttribute('data-dsmd-group') !== null;
  if (selector === '[data-dsmd-side]') return node.getAttribute('data-dsmd-side') !== null;
  if (selector === '.dsmd-col') return node.className.split(' ').includes('dsmd-col');
  if (selector === '.dsmd-content') return node.className.split(' ').includes('dsmd-content');
  return false;
}

/**
 * A range over one text node, as the browser would report a selection inside it.
 * @param node - the selected text node.
 * @param text - what `selection.toString()` answers.
 * @param box - the rectangle of the selected line.
 * @param options - `collapsed` for a caret, otherwise a real selection.
 */
function rangeOf(node, text, box, options = {}) {
  return {
    range: {
      startContainer: node,
      endContainer: node,
      commonAncestorContainer: node,
      getClientRects: () => [box],
      getBoundingClientRect: () => box,
    },
    selection: {
      rangeCount: options.collapsed === true ? 0 : 1,
      isCollapsed: options.collapsed === true,
      toString: () => text,
      getRangeAt: () => null,
      removeAllRanges: () => {},
    },
  };
}

/**
 * Install a fake window whose selection is over one text node, and a document
 * with no focused field.
 * @param node - the selected text node.
 * @param text - the selected text.
 * @param box - the selected line's rectangle.
 * @param activeElement - what the document reports as focused.
 */
function browser(node, text, box, activeElement) {
  const made = rangeOf(node, text, box);
  globalThis.document = { activeElement: activeElement ?? null };
  globalThis.window = {
    getSelection: () => ({ ...made.selection, getRangeAt: () => made.range }),
  };
}

/** The two-block document: an unchanged heading and a rewritten paragraph. */
function groups() {
  return [
    {
      kind: 'equal',
      before: [{ kind: 'equal', text: '# T', start: 0, end: 0 }],
      after: [{ kind: 'equal', text: '# T', start: 0, end: 0 }],
    },
    {
      kind: 'modified',
      before: [{ kind: 'modified', text: 'old text', start: 2, end: 2 }],
      after: [{ kind: 'modified', text: 'new text', start: 2, end: 2 }],
    },
  ];
}

/**
 * The inline view of that document: group 0 is one content box, group 1 has both
 * halves paired.
 * @param rootBox - the surface's client rectangle.
 */
function inlineDocument(rootBox = rect(100, 50, 400, 600)) {
  const root = element([], {}, rootBox);
  const heading = element([textNode('# T')], { class: 'dsmd-content' }, rect(112, 60));
  const group0 = element([heading], { 'data-dsmd-group': '0', class: 'dsmd-block' }, rect(112, 60));
  const before = element([textNode('old text')], { class: 'dsmd-content dsmd-marked', 'data-dsmd-side': 'before' }, rect(112, 120));
  const after = element([textNode('new text')], { class: 'dsmd-content dsmd-marked', 'data-dsmd-side': 'after' }, rect(112, 150));
  const group1 = element([before, after], { 'data-dsmd-group': '1', class: 'dsmd-block' }, rect(112, 120));
  root.children.push(group0, group1);
  group0.parentNode = root;
  group1.parentNode = root;
  return { root, group0, group1, before, after, heading };
}

test('a selection in the working-tree half is read with its own lines', () => {
  const { root, after } = inlineDocument();
  browser(after.children[0], 'new', rect(160, 152));
  const anchor = readSelection(root, groups(), 'docs/a.md');
  assert.equal(anchor.groupIndex, 1);
  assert.equal(anchor.side, 'after');
  assert.equal(anchor.address, 'docs/a.md:3');
  assert.equal(anchor.quote, 'new');
});

test('the button stands left of the block, level with the first selected line', () => {
  const { root, after } = inlineDocument();
  browser(after.children[0], 'new', rect(160, 152));
  const anchor = readSelection(root, groups(), 'docs/a.md');
  // block.left - root.left - BTN_OFFSET = 112 - 100 - 30, clamped at the edge.
  assert.equal(anchor.left, 0);
  assert.equal(anchor.top, 102);
});

test('a scrolled surface keeps the button on its line', () => {
  const { root, after } = inlineDocument();
  root.scrollTop = 100;
  browser(after.children[0], 'new', rect(160, 152));
  const anchor = readSelection(root, groups(), 'docs/a.md');
  assert.equal(anchor.top, 202);
});

test('a selection in the base half says so in the citation', () => {
  const { root, before } = inlineDocument();
  browser(before.children[0], 'old', rect(160, 122));
  const anchor = readSelection(root, groups(), 'docs/a.md', ' · старая версия');
  assert.equal(anchor.side, 'before');
  assert.equal(anchor.address, 'docs/a.md:3 · старая версия');
  assert.equal(anchor.quote, 'old');
});

test('a whole-block selection quotes the Markdown, not the rendering', () => {
  const { root, group1, after } = inlineDocument();
  // The source carries markup the rendered text does not, so the lookup misses
  // and the block's own span answers — but the quotation still keeps the markup,
  // which is what the model has to see.
  browser(after.children[0], 'new text', rect(160, 152));
  const shaped = [
    { kind: 'equal', before: [], after: [] },
    { kind: 'modified', before: [], after: [{ kind: 'modified', text: '**new** text', start: 2, end: 4 }] },
  ];
  const anchor = readSelection(root, shaped, 'a.md');
  assert.equal(anchor.address, 'a.md:3-5');
  assert.equal(anchor.quote, '**new** text');
  assert.equal(group1.children[1], after);
});

test('a selection outside the surface is ignored', () => {
  const { root } = inlineDocument();
  const stray = element([textNode('elsewhere')], {});
  browser(stray.children[0], 'elsewhere', rect(0, 0));
  assert.equal(readSelection(root, groups(), 'a.md'), undefined);
});

test('a caret is not a comment target', () => {
  const { root, after } = inlineDocument();
  const made = rangeOf(after.children[0], '', rect(160, 152), { collapsed: true });
  globalThis.document = { activeElement: null };
  globalThis.window = { getSelection: () => ({ ...made.selection, getRangeAt: () => made.range }) };
  assert.equal(readSelection(root, groups(), 'a.md'), undefined);
});

test('a caret inside the comment box is not a comment target either', () => {
  const { root, after } = inlineDocument();
  const area = element([textNode('')], {}, rect(0, 0));
  area.tagName = 'TEXTAREA';
  browser(after.children[0], 'new', rect(160, 152), area);
  assert.equal(readSelection(root, groups(), 'a.md'), undefined);
});

test('a selection in the base column of the split view counts as the base half', () => {
  const column = element([], { class: 'dsmd-col', 'data-side': 'base' });
  const content = element([textNode('# T')], { class: 'dsmd-content' });
  const block = element([content], { 'data-dsmd-group': '0', class: 'dsmd-block' });
  column.children.push(block);
  block.parentNode = column;
  assert.equal(sideOf(content), 'before');
  const worktree = element([], { class: 'dsmd-col', 'data-side': 'worktree' });
  worktree.children.push(block);
  block.parentNode = worktree;
  assert.equal(sideOf(content), 'after');
});

test('without a selection API the surface simply offers nothing', () => {
  const { root } = inlineDocument();
  assert.equal(readSelection(root, groups(), 'a.md'), undefined);
});

console.log(`\n${String(passed)}/${String(passed + failed)} selection checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
