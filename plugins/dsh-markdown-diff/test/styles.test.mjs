/**
 * Stylesheet checks: the part that explains why a control can set an attribute
 * and still change nothing on screen.
 *
 * A plugin can be re-evaluated without the page being reloaded, and the `<style>`
 * element it installed earlier stays in the document. If that element is only
 * created when missing, its contents stay at the first build's rules, so a
 * selector added by a later build never applies — the DOM changes, the picture
 * does not. These checks pin the behaviour that prevents it.
 *
 *   node test/styles.test.mjs
 */

import assert from 'node:assert/strict';

import { injectStyles } from '../src/MarkdownDiffBody.js';
import { BTN_GAP, BTN_OFFSET } from '../src/selection.js';

let passed = 0;
let failed = 0;

/**
 * Run one named check.
 * @param name - what the check proves.
 * @param body - the assertions.
 */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  } finally {
    globalThis.document = undefined;
  }
}

/**
 * Install a fake document whose head records appended style tags.
 * @param existing - the style element already present, or null for a fresh page.
 * @returns the installed tags and the head they go into.
 */
function fakeDocument(existing = null) {
  const tags = existing === null ? [] : [existing];
  globalThis.document = {
    querySelector: (selector) => {
      if (!selector.includes('data-plugin-css')) return null;
      if (existing !== null) return existing;
      // A fresh page has no tag until the first call appends one, so a second
      // call in the same page must find what the first one added.
      return tags[0] ?? null;
    },
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: {
      appendChild: (tag) => {
        tags.push(tag);
      },
    },
  };
  return { tags };
}

test('a fresh page gets one style element', () => {
  const { tags } = fakeDocument();
  injectStyles();
  assert.equal(tags.length, 1);
  assert.ok(tags[0].textContent.includes('.dsmd-block'));
});

test('the tag is not duplicated on a second call', () => {
  const { tags } = fakeDocument();
  injectStyles();
  injectStyles();
  assert.equal(tags.length, 1);
});

test('a stale tag from an earlier build is rewritten, not kept', () => {
  // This is the regression: the tag exists, so an early return would leave the
  // old rules in place for the life of the page.
  const stale = { dataset: {}, textContent: '.dsmd-block{color:red}' };
  fakeDocument(stale);
  injectStyles();
  assert.equal(stale.textContent.includes('.dsmd-block{color:red}'), false,
    'the old rules must be replaced');
  assert.ok(stale.textContent.includes('.dsmd-block'));
});

test('a current tag is left untouched', () => {
  const fresh = { dataset: {}, textContent: '' };
  fakeDocument(fresh);
  injectStyles();
  const painted = fresh.textContent;
  injectStyles();
  assert.equal(fresh.textContent === painted, true);
});

test('the sheet carries the rule that hides an old block half', () => {
  // The compact inline view works by hiding the base half with an attribute, so
  // a build missing this selector turns the control into a no-op.
  const { tags } = fakeDocument();
  injectStyles();
  assert.ok(tags[0].textContent.includes('.dsmd-before[data-dsmd-hidden="true"]{display:none}'));
});

test('the fold of the properties block is a clip, not a removal', () => {
  // The inline highlighter compares the two halves of a modified group by their
  // text content, so a fold that hid its rows with anything other than `display`
  // would also have to delete them from the tree — and the halves would disagree.
  const { tags } = fakeDocument();
  injectStyles();
  assert.ok(
    tags[0].textContent.includes('.dsmd-props[data-dsmd-collapsed="true"] .dsmd-propsBody{display:none}'),
    'the collapsed block clips its body',
  );
  assert.ok(tags[0].textContent.includes('.dsmd-propKey'), 'and the rows have their own rule');
});

test('the commentary button clears the text by exactly its own footprint', () => {
  // The button is absolutely positioned, so the width in the sheet and the offset in
  // `selection.js` are the only two numbers that keep it off the text: a button
  // widened without the offset would cover the first characters of the line it
  // points at, and an offset grown alone would drift away from it.
  const { tags } = fakeDocument();
  injectStyles();
  const rule = tags[0].textContent.slice(tags[0].textContent.indexOf('.dsmd-commentBtn{'));
  const width = /width:(\d+)px/u.exec(rule.slice(0, rule.indexOf('}')))?.[1];
  assert.ok(width !== undefined, 'the button declares its width');
  assert.equal(BTN_OFFSET - BTN_GAP, Number(width), 'the offset is the button plus the gap');
  assert.equal(Number(width), 26, 'and the button is drawn at the size the icon needs');
  assert.ok(tags[0].textContent.includes('.dsmd-commentBtn svg{width:16px;height:16px}'),
    'the icon inside it is drawn at 16px, not 12px');
});console.log(`\n${String(passed)}/${String(passed + failed)} stylesheet checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
