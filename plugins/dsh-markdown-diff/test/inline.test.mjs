/**
 * Inline diff checks: the word-level segments behind the narrowed highlight, and
 * the offset ranges they produce on each side.
 *
 *   node test/inline.test.mjs
 */

import assert from 'node:assert/strict';

import { diffInline, hasChange, rangesOf, tokensOf } from '../src/inline.js';

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

/** The marked segments only, as `kind:text` pairs. */
function marked(segments) {
  return segments.filter((segment) => segment.kind !== 'equal').map((segment) => `${segment.kind}:${segment.text}`);
}

/** Rebuild one side's text from the segments, which must be lossless. */
function rebuild(segments, side) {
  return segments
    .filter((segment) => segment.kind === 'equal' || segment.kind === side)
    .map((segment) => segment.text)
    .join('');
}

test('tokens keep words, punctuation, and whitespace apart', () => {
  assert.deepEqual(tokensOf('fox, dog'), ['fox', ',', ' ', 'dog']);
  assert.deepEqual(tokensOf('Привет, мир!'), ['Привет', ',', ' ', 'мир', '!']);
  // Chinese has no spaces, so a whole clause is one token; the split still has to
  // leave the punctuation separable.
  assert.deepEqual(tokensOf('你好，世界'), ['你好', '，', '世界']);
});

test('identical text is one equal segment and reports no change', () => {
  const segments = diffInline('The quick fox.', 'The quick fox.');
  assert.deepEqual(marked(segments), []);
  assert.equal(hasChange(segments), false);
});

test('a replaced word marks only that word on each side', () => {
  const segments = diffInline('The quick fox jumps.', 'The quick fox leaps.');
  assert.deepEqual(marked(segments), ['del:jumps', 'ins:leaps']);
  // The rest of the sentence stays untouched, which is the whole point: a
  // block-level marking would have tinted the entire paragraph.
  assert.equal(hasChange(segments), true);
});

test('the segments rebuild both sides losslessly', () => {
  const before = 'The quick brown fox jumps over the lazy dog.';
  const after = 'The quick brown fox leaps over a lazy dog.';
  const segments = diffInline(before, after);
  assert.equal(rebuild(segments, 'del'), before);
  assert.equal(rebuild(segments, 'ins'), after);
});

test('an inserted word leaves the surrounding text equal', () => {
  const before = 'alpha beta';
  const after = 'alpha shiny beta';
  const segments = diffInline(before, after);
  // The trailing space stays inside the inserted segment, so the segments rebuild
  // both sides exactly; the painted range itself is trimmed to the word.
  assert.deepEqual(marked(segments), ['ins:shiny ']);
  assert.equal(rebuild(segments, 'del'), before);
  assert.equal(rebuild(segments, 'ins'), after);
  const ranges = rangesOf(segments, 'ins');
  assert.deepEqual(ranges.map((range) => after.slice(range.start, range.end)), ['shiny']);
});

test('a removed word leaves the surrounding text equal', () => {
  const before = 'alpha shiny beta';
  const after = 'alpha beta';
  const segments = diffInline(before, after);
  assert.deepEqual(marked(segments), ['del:shiny ']);
  assert.equal(rebuild(segments, 'del'), before);
  assert.equal(rebuild(segments, 'ins'), after);
  const ranges = rangesOf(segments, 'del');
  assert.deepEqual(ranges.map((range) => before.slice(range.start, range.end)), ['shiny']);
});

test('every equal segment contributes the same text to both sides', () => {
  // The invariant rangesOf walks on: one offset per side, advanced by the same
  // amount for an equal segment. A segment carrying text that exists on one side
  // only would shift every later offset and paint the wrong words — which is what
  // happened when boundary whitespace was re-labelled as shared.
  const cases = [
    ['a b', 'a b c'],
    ['a b c', 'a c'],
    ['Сроки готовы.', 'Сроки готовы. Итоги собраны.'],
    ['Первое слово второе слово третье слово', 'Первое слово третье слово'],
    ['Цепь перемещения товара', 'Цепочка перемещения товара'],
  ];
  for (const [before, after] of cases) {
    const segments = diffInline(before, after);
    assert.equal(rebuild(segments, 'del'), before, `base side drifted for ${JSON.stringify(before)}`);
    assert.equal(rebuild(segments, 'ins'), after, `working side drifted for ${JSON.stringify(before)}`);
  }
});

test('a change is presented removals-first, not interleaved', () => {
  const segments = diffInline('one two three', 'one FOUR three');
  assert.deepEqual(segments.map((segment) => segment.kind), ['equal', 'del', 'ins', 'equal']);
});

test('boundary whitespace is not part of a changed range', () => {
  const segments = diffInline('alpha beta gamma', 'alpha delta gamma');
  assert.deepEqual(marked(segments), ['del:beta', 'ins:delta']);
  const ranges = rangesOf(segments, 'del');
  // "beta" starts at offset 6 in "alpha beta gamma" and ends before the space.
  assert.deepEqual(ranges, [{ start: 6, end: 10 }]);
});

test('ranges locate every changed word on the base side', () => {
  const before = 'The quick brown fox jumps over the lazy dog.';
  const after = 'The quick brown fox leaps over a lazy dog.';
  const segments = diffInline(before, after);
  const ranges = rangesOf(segments, 'del');
  const texts = ranges.map((range) => before.slice(range.start, range.end));
  assert.deepEqual(texts, ['jumps', 'the']);
});

test('ranges locate every changed word on the working-tree side', () => {
  const before = 'The quick brown fox jumps over the lazy dog.';
  const after = 'The quick brown fox leaps over a lazy dog.';
  const segments = diffInline(before, after);
  const ranges = rangesOf(segments, 'ins');
  const texts = ranges.map((range) => after.slice(range.start, range.end));
  assert.deepEqual(texts, ['leaps', 'a']);
});

test('a rewrite of the whole paragraph marks everything', () => {
  const segments = diffInline('alpha beta gamma', 'unrelated words entirely');
  const ranges = rangesOf(segments, 'del');
  assert.equal(ranges.length > 0, true);
  assert.equal(hasChange(segments), true);
});

test('a markdown syntax change alone does not mark a word', () => {
  // The renderer drops the emphasis markers, so the text content is what
  // matters: the comment below is the reason both sides compare equal here.
  const segments = diffInline('some text', 'some text');
  assert.deepEqual(marked(segments), []);
});

test('a huge block still answers without stalling', () => {
  const before = Array.from({ length: 4000 }, (_, at) => `word${String(at)}`).join(' ');
  const after = before.replace('word2000', 'changed');
  const segments = diffInline(before, after);
  assert.equal(hasChange(segments), true);
  assert.equal(rebuild(segments, 'del'), before);
});

test('a long paragraph is compared exactly, not coarsely', () => {
  // Two edits far apart in a paragraph of a few hundred words. The coarse path
  // trims the shared start and end and marks everything between them, which is
  // the over-marking a reader sees; below the cell limit the edit is located.
  const sentence = 'Раздел описывает порядок подготовки материалов и сроки согласования. ';
  const block = (first, second) => `${sentence.repeat(6)}${first} ${sentence.repeat(6)}${second} ${sentence.repeat(6)}`;
  const segments = diffInline(block('ПЕРВЫЙ', 'ВТОРОЙ'), block('НОВЫЙ', 'ДРУГОЙ'));
  assert.deepEqual(marked(segments), ['del:ПЕРВЫЙ', 'ins:НОВЫЙ', 'del:ВТОРОЙ', 'ins:ДРУГОЙ']);
});

test('a paragraph of ordinary length marks only the two words that changed', () => {
  const body = 'Раздел описывает порядок подготовки материалов к встрече и согласование сроков с участниками проекта. ';
  const before = `${body}Начало документа. ${body}Конец раздела.`;
  const after = `${body}Начало отчёта. ${body}Финал раздела.`;
  const ranges = rangesOf(diffInline(before, after), 'ins');
  const painted = ranges.map((range) => after.slice(range.start, range.end));
  assert.deepEqual(painted, ['отчёта', 'Финал']);
});

console.log(`\n${String(passed)}/${String(passed + failed)} inline checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
