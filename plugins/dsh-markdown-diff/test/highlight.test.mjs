/**
 * Highlight checks: the part of the narrowing that can be proven without a
 * browser — which text ranges get registered for which side of a pair.
 *
 * A minimal DOM stands in for the browser: `createTreeWalker` over text nodes,
 * `createRange` recording boundary points, and a `CSS.highlights` map. That is
 * exactly the surface the module touches, so a wrong offset here would be a wrong
 * highlight in the window.
 *
 *   node test/highlight.test.mjs
 */

import assert from 'node:assert/strict';

import { applyInlineHighlight, supportsInlineHighlight } from '../src/highlight.js';

let passed = 0;
let failed = 0;

/**
 * Run one named check.
 * @param name - what the check proves.
 * @param body - the assertions.
 */
function test(name, body) {
  try {
    globalThis.CSS = undefined;
    globalThis.document = undefined;
    globalThis.Highlight = undefined;
    body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  } finally {
    globalThis.CSS = undefined;
    globalThis.document = undefined;
    globalThis.Highlight = undefined;
  }
}

/** One text node. */
function textNode(data) {
  return { nodeType: 3, data, parentNode: null };
}

/**
 * An element holding text nodes and/or children, with just enough DOM for the
 * module: `textContent`, `parentNode`, `nodeName`, `querySelectorAll`, and an
 * attribute map. Parents are wired up on construction because the module walks
 * them to find the block a text node belongs to.
 *
 * @param children - text nodes and elements, in document order.
 * @param attributes - initial attributes.
 * @param tag - the element name the block-seam walk reads; defaults to a block.
 */
function element(children = [], attributes = {}, tag = 'DIV') {
  const attrs = new Map(Object.entries(attributes));
  const self = {
    nodeType: 1,
    nodeName: tag,
    children,
    get textContent() {
      return children.map((child) => (child.nodeType === 3 ? child.data : child.textContent)).join('');
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    attributes: attrs,
    /** Flatten every element below this one, this one included. */
    descendants() {
      const found = [self];
      for (const child of children) {
        if (child.nodeType !== 3) found.push(...child.descendants());
      }
      return found;
    },
  };
  self.parentNode = null;
  for (const child of children) child.parentNode = self;
  return self;
}

/** Install a fake DOM and CSS registry, and return the recorded state. */
function fakeBrowser() {
  /** Every range the module built, as `side:start-end` strings. */
  const painted = [];
  globalThis.CSS = { highlights: new Map() };
  globalThis.Highlight = class Highlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    createTreeWalker(root) {
      const nodes = [];
      const walk = (node) => {
        for (const child of node.children ?? []) {
          if (child.nodeType === 3) nodes.push(child);
          else walk(child);
        }
      };
      walk(root);
      let at = -1;
      return {
        nextNode() {
          at += 1;
          return at < nodes.length ? nodes[at] : null;
        },
      };
    },
    createRange() {
      const range = {
        startNode: null,
        startOffset: 0,
        endNode: null,
        endOffset: 0,
        setStart(node, offset) {
          range.startNode = node;
          range.startOffset = offset;
        },
        setEnd(node, offset) {
          range.endNode = node;
          range.endOffset = offset;
        },
        /** The text this range covers, read the way the browser would. */
        text() {
          if (range.startNode === range.endNode) {
            return range.startNode.data.slice(range.startOffset, range.endOffset);
          }
          return `${range.startNode.data.slice(range.startOffset)}…${range.endNode.data.slice(0, range.endOffset)}`;
        },
      };
      painted.push(range);
      return range;
    },
  };
  return { painted };
}

/**
 * A surface root with one paired modified block, its two sides holding the text.
 *
 * `split` is the offset at which each side's text is cut into two text nodes; it
 * exists to place a boundary inside a changed word, which is what inline markup
 * does to the DOM in the real renderer.
 */
function surface(beforeText, afterText, { split }) {
  const cut = (data) => (split === false || split === undefined
    ? [textNode(data)]
    : [textNode(data.slice(0, split)), textNode(data.slice(split))]);
  const before = element(cut(beforeText), { 'data-dsmd-pair': '0', 'data-dsmd-side': 'before' });
  const after = element(cut(afterText), { 'data-dsmd-pair': '0', 'data-dsmd-side': 'after' });
  const root = element([before, after]);
  root.querySelectorAll = (selector) => root.descendants().filter((node) => {
    if (selector !== '[data-dsmd-pair]') return false;
    return node.attributes?.has('data-dsmd-pair') === true;
  });
  return root;
}

test('an environment without the highlight API is reported as unsupported', () => {
  assert.equal(supportsInlineHighlight(), false);
  globalThis.CSS = { highlights: new Map() };
  globalThis.Highlight = function Highlight() {};
  assert.equal(supportsInlineHighlight(), true);
});

test('changing one word registers a range over that word only', () => {
  const { painted } = fakeBrowser();
  const root = surface('The quick fox jumps.', 'The quick fox leaps.', { split: false });
  applyInlineHighlight(root);
  const texts = painted.map((range) => `${String(range.startOffset)}:${range.text()}`);
  assert.deepEqual(texts, ['14:jumps', '14:leaps']);
});

/**
 * A pair whose sides each hold several blocks, as the renderer emits them: one
 * element per paragraph, and nothing between the elements. `textContent` glues
 * the last word of one block to the first word of the next, so a seam that is not
 * accounted for marks a word that never changed.
 *
 * @param beforeBlocks - one string per block on the base side.
 * @param afterBlocks - one string per block on the working-tree side.
 */
function blockSurface(beforeBlocks, afterBlocks) {
  const side = (blocks, name) => element(
    blocks.map((text) => element([textNode(text)], {}, 'P')),
    { 'data-dsmd-pair': '0', 'data-dsmd-side': name },
  );
  const root = element([side(beforeBlocks, 'before'), side(afterBlocks, 'after')]);
  root.querySelectorAll = (selector) => root.descendants().filter((node) => {
    if (selector !== '[data-dsmd-pair]') return false;
    return node.attributes?.has('data-dsmd-pair') === true;
  });
  return root;
}

test('a word in an unchanged neighbouring block is not painted', () => {
  // The second block changes; the first does not. Rendered as raw textContent the
  // seam reads "пунктВторой", one token, so marking the change would drag the
  // last word of the untouched block in with it.
  const { painted } = fakeBrowser();
  const root = blockSurface(
    ['Первый пункт', 'Второй пункт списка'],
    ['Первый пункт', 'Третий пункт списка'],
  );
  applyInlineHighlight(root);
  const marked = painted.map((range) => range.text().replaceAll('…', ''));
  assert.deepEqual(marked.includes('Третий'), true, `painted ${JSON.stringify(marked)}`);
  assert.equal(marked.some((text) => text.includes('Первый')), false,
    `an unchanged block was dragged in: ${JSON.stringify(marked)}`);
});

test('a changed word at the very seam is painted without its neighbour', () => {
  // The edit sits in the first block's last sentence, right against the seam.
  const { painted } = fakeBrowser();
  const root = blockSurface(
    ['Задачи', 'Сроки определены.'],
    ['Задачи', 'Даты определены.'],
  );
  applyInlineHighlight(root);
  const marked = painted.map((range) => range.text().replaceAll('…', ''));
  assert.deepEqual(marked.sort(), ['Даты', 'Сроки']);
});

test('inline markup inside one block still reads as one word', () => {
  // A seam is a block boundary, not a node boundary: "jum" + "ps" inside the same
  // paragraph must stay one token, or emphasis would split words apart.
  const { painted } = fakeBrowser();
  const before = element([element([textNode('The fox jum'), element([textNode('ps')], {}, 'STRONG')])], {}, 'P');
  const after = element([element([textNode('The fox lea'), element([textNode('ps')], {}, 'STRONG')])], {}, 'P');
  for (const side of [before, after]) side.setAttribute('data-dsmd-pair', '0');
  before.setAttribute('data-dsmd-side', 'before');
  after.setAttribute('data-dsmd-side', 'after');
  const root = element([before, after]);
  root.querySelectorAll = (selector) => root.descendants().filter((node) => {
    if (selector !== '[data-dsmd-pair]') return false;
    return node.attributes?.has('data-dsmd-pair') === true;
  });
  applyInlineHighlight(root);
  const marked = painted.map((range) => range.text().replaceAll('…', ''));
  assert.deepEqual(marked.sort(), ['jum' + 'ps', 'lea' + 'ps']);
});

test('the whole paragraph is not painted, only the words that moved', () => {
  const { painted } = fakeBrowser();
  const before = 'The quick brown fox jumps over the lazy dog.';
  const after = 'The quick brown fox leaps over a lazy dog.';
  const root = surface(before, after, { split: false });
  applyInlineHighlight(root);
  const covered = painted.reduce((total, range) => {
    if (range.startNode !== range.endNode) return total;
    return total + (range.endOffset - range.startOffset);
  }, 0);
  assert.equal(covered < before.length / 2, true,
    `painted ${String(covered)} of ${String(before.length)} characters`);
});

test('a word split across text nodes is still painted whole', () => {
  // The renderer emits separate text nodes around inline markup, so a changed
  // word can straddle two of them; the range must span both rather than be
  // dropped or cut at the seam. Here the cut falls inside "jumps" (offset 16).
  const { painted } = fakeBrowser();
  const root = surface('The quick fox jumps.', 'The quick fox leaps.', { split: 16 });
  applyInlineHighlight(root);
  assert.equal(painted.length, 2);
  assert.equal(painted.every((range) => range.startNode !== range.endNode), true);
  // Read across the seam, the two halves of the range are still the changed word
  // and nothing more: the range's start sits at the word, not at the node.
  assert.deepEqual(painted.map((range) => range.text().replaceAll('…', '')), ['jum' + 'ps', 'lea' + 'ps']);
});

test('a rewritten paragraph with no shared words keeps the block tint', () => {
  const { painted } = fakeBrowser();
  const root = surface('original sentence about cats', 'completely different words here', { split: false });
  const cleanup = applyInlineHighlight(root);
  // The words differ entirely, so ranges do cover them; the attribute must appear
  // because something was painted.
  assert.equal(painted.length > 0, true);
  assert.equal(root.getAttribute('data-dsmd-narrow'), 'true');
  cleanup();
  assert.equal(root.getAttribute('data-dsmd-narrow'), null);
});

test('the narrow attribute is withheld when nothing could be painted', () => {
  fakeBrowser();
  // A pair whose sides render no text at all cannot be marked, and narrowing
  // without marks would show a changed block as untouched.
  const empty = element([], { 'data-dsmd-pair': '0', 'data-dsmd-side': 'before' });
  const root = element([empty]);
  root.querySelectorAll = () => [empty];
  applyInlineHighlight(root);
  assert.equal(root.getAttribute('data-dsmd-narrow'), null);
});

test('cleanup removes this surface\'s ranges and its narrow attribute', () => {
  fakeBrowser();
  const root = surface('The quick fox jumps.', 'The quick fox leaps.', { split: false });
  const cleanup = applyInlineHighlight(root);
  assert.equal(globalThis.CSS.highlights.size, 2);
  cleanup();
  assert.equal(globalThis.CSS.highlights.size, 0);
  assert.equal(root.getAttribute('data-dsmd-narrow'), null);
});

test('a newer surface keeps its ranges when the older one unmounts', () => {
  fakeBrowser();
  const first = surface('alpha one beta', 'alpha two beta', { split: false });
  const second = surface('gamma three delta', 'gamma four delta', { split: false });
  const cleanupFirst = applyInlineHighlight(first);
  applyInlineHighlight(second);
  // The older preview leaves after the newer one took the registry; clearing on
  // its way out would blank the document that is actually on screen.
  cleanupFirst();
  assert.equal(globalThis.CSS.highlights.size, 2);
});

test('a surface with no pairs paints nothing and stays tinted', () => {
  const { painted } = fakeBrowser();
  const root = element([textNode('nothing here')]);
  root.querySelectorAll = () => [];
  applyInlineHighlight(root);
  assert.deepEqual(painted, []);
  assert.equal(root.getAttribute('data-dsmd-narrow'), null);
});

test('a failing range leaves the document alone instead of throwing', () => {
  fakeBrowser();
  globalThis.document.createRange = () => {
    throw new Error('detached');
  };
  const root = surface('alpha one beta', 'alpha two beta', { split: false });
  const cleanup = applyInlineHighlight(root);
  assert.equal(typeof cleanup, 'function');
  assert.equal(root.getAttribute('data-dsmd-narrow'), null);
});

console.log(`\n${String(passed)}/${String(passed + failed)} highlight checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
