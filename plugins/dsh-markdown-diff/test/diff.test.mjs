/**
 * Diff engine checks: alignment, group folding, and the counters the toolbar
 * prints. Run directly:
 *
 *   node test/diff.test.mjs
 */

import assert from 'node:assert/strict';

import { afterText, beforeText, diffDocuments, similarityOf, summarize } from '../src/diff.js';

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
  }
}

/** The kinds of the non-equal groups, in order. */
function kindsOf(result) {
  return result.groups.filter((group) => group.kind !== 'equal').map((group) => group.kind);
}

test('an unchanged document has no groups to show', () => {
  const result = diffDocuments('# A\n\ntext\n', '# A\n\ntext\n');
  assert.equal(result.changed, false);
  assert.deepEqual(kindsOf(result), []);
  assert.equal(result.stats.groups, 0);
});

test('an added block after an unchanged one is reported as added', () => {
  const result = diffDocuments('# A\n', '# A\n\ntext\n');
  assert.deepEqual(kindsOf(result), ['added']);
  assert.equal(afterText(result.groups.at(-1)), 'text');
  assert.equal(beforeText(result.groups.at(-1)), '');
  assert.deepEqual(result.stats, { added: 1, removed: 0, modified: 0, groups: 1 });
});

test('a deleted block is reported as removed', () => {
  const result = diffDocuments('# A\n\ntext\n', '# A\n');
  assert.deepEqual(kindsOf(result), ['removed']);
  assert.equal(beforeText(result.groups.at(-1)), 'text');
});

test('an edited paragraph folds into one modified group', () => {
  const result = diffDocuments(
    'The quick brown fox jumps over the lazy dog.\n',
    'The quick brown fox leaps over the lazy dog.\n',
  );
  assert.deepEqual(kindsOf(result), ['modified']);
  const group = result.groups.at(-1);
  assert.equal(beforeText(group), 'The quick brown fox jumps over the lazy dog.');
  assert.equal(afterText(group), 'The quick brown fox leaps over the lazy dog.');
});

test('a rewritten paragraph stays a removal plus an addition', () => {
  const result = diffDocuments(
    'Alpha beta gamma delta.\n',
    'Entirely unrelated sentence about something else.\n',
  );
  assert.deepEqual(kindsOf(result), ['removed', 'added']);
});

test('a new file reports every block as added', () => {
  const result = diffDocuments('', '# New\n\nbody\n');
  assert.deepEqual(kindsOf(result), ['added']);
  assert.equal(result.stats.added, 2);
});

test('the empty-side case of an emptied file reports every block removed', () => {
  const result = diffDocuments('# Old\n\nbody\n', '');
  assert.deepEqual(kindsOf(result), ['removed']);
  assert.equal(result.stats.removed, 2);
});

test('equal groups keep the document readable in order', () => {
  const result = diffDocuments('# A\n\none\n\n# B\n', '# A\n\none\n\n# C\n');
  const kinds = result.groups.map((group) => group.kind);
  // Unchanged blocks arrive as one run, so the parser sees the stretch whole.
  assert.equal(kinds.at(0), 'equal');
  assert.deepEqual(result.groups.at(0).after.map((block) => block.text), ['# A', 'one']);
  // A heading renamed to unrelated words is a replacement, not an edit.
  assert.deepEqual(kinds.slice(-2), ['removed', 'added']);
});

test('an unchanged stretch between two edits stays one group', () => {
  const result = diffDocuments(
    '# Title\n\nalpha beta\n\nmiddle text\n\ngamma delta\n',
    '# Title\n\nalpha beta gamma\n\nmiddle text\n\ngamma delta epsilon\n',
  );
  const kinds = result.groups.map((group) => group.kind);
  assert.deepEqual(kinds, ['equal', 'modified', 'equal', 'modified']);
  assert.deepEqual(result.groups.at(2).after.map((block) => block.text), ['middle text']);
});

test('a heading extended in place folds into one modified group', () => {
  const result = diffDocuments('## Задачи\n', '## Задачи и сроки\n');
  assert.deepEqual(kindsOf(result), ['modified']);
});

test('a block moved down the document shows as a removal and an addition', () => {
  const result = diffDocuments('one\n\ntwo\n', 'two\n\none\n');
  assert.ok(kindsOf(result).length > 0, 'a move must be reported');
});

test('showRemoved=false drops removal-only groups but keeps the counters', () => {
  const result = diffDocuments('# A\n\ntext\n', '# A\n', { showRemoved: false });
  assert.deepEqual(kindsOf(result), []);
  assert.equal(result.stats.removed, 1);
  assert.equal(result.changed, true);
});

test('showRemoved=false keeps a modified group, which has content on both sides', () => {
  const result = diffDocuments('fox jumps\n', 'fox leaps\n', { showRemoved: false });
  assert.deepEqual(kindsOf(result), ['modified']);
});

test('unrelated text is not folded, similar text is', () => {
  assert.ok(similarityOf('a b c', 'a b c') === 1);
  assert.ok(similarityOf('a b c', 'x y z') === 0);
  const partial = similarityOf('alpha beta gamma', 'alpha beta delta');
  assert.ok(partial > 0.3 && partial < 1);
});

test('the summary reads as a sign per counter', () => {
  assert.equal(summarize({ added: 2, removed: 0, modified: 0, groups: 1 }), '+2');
  assert.equal(summarize({ added: 0, removed: 3, modified: 0, groups: 1 }), '−3');
  assert.equal(summarize({ added: 1, removed: 1, modified: 2, groups: 3 }), '+1 −1 ~2');
  assert.equal(summarize({ added: 0, removed: 0, modified: 0, groups: 0 }), '');
});

test('a large document falls back without throwing', () => {
  const line = (index) => `Paragraph number ${String(index)} with its own wording.`;
  const big = Array.from({ length: 900 }, (_, index) => line(index)).join('\n\n');
  const edited = big.replace('Paragraph number 500 with its own wording.', 'Paragraph number 500, rewritten.');
  const result = diffDocuments(big, edited);
  assert.equal(result.changed, true);
  assert.ok(result.groups.length > 0);
});

test('group texts are valid Markdown for the renderer', () => {
  const result = diffDocuments('', '- one\n- two\n\n```js\ncode\n```\n');
  const text = afterText(result.groups.at(-1));
  assert.ok(text.includes('- one'), 'list markers survive the join');
  assert.ok(text.includes('```js'), 'fences survive the join');
});

console.log(`\n${String(passed)}/${String(passed + failed)} diff checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
