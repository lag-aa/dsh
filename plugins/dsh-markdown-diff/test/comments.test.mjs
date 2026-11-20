/**
 * Review-comment checks: the wording of a comment and the way it reaches the
 * composer draft.
 *
 * Both halves are string work on purpose, so the shape a comment has in the chat
 * does not have to be read off a screenshot, and the two coordinate systems the
 * composer keeps are pinned here instead of being discovered in a browser.
 *
 *   node test/comments.test.mjs
 */

import assert from 'node:assert/strict';

import { addressOf, commentMessage, fenceOf, linesOfSelection, SELECTION_LIMIT, spanOf } from '../src/comments.js';
import { appendOffset, appendText, appendToDraft, foldClipboardOffset, separatorFor } from '../src/draft.js';

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

/** A client context with only the services a draft write reads. */
function contextOf({ conversation, sessions }) {
  return {
    get: (name) => {
      if (name === 'conversation') return conversation;
      if (name === 'sessions') return sessions;
      return undefined;
    },
  };
}

test('a selection is placed on the lines it came from', () => {
  const lines = linesOfSelection('# T\n\nold text\n', 'old text');
  assert.deepEqual(lines, { start: 3, end: 3 });
});

test('a selection spanning blocks covers the lines between them', () => {
  const lines = linesOfSelection('para one\n\npara two', 'one\n\npara two');
  assert.deepEqual(lines, { start: 1, end: 3 });
});

test('a selection that occurs twice is not guessed at', () => {
  assert.equal(linesOfSelection('a\na', 'a'), undefined);
});

test('a selection the renderer rewrote is not placed at all', () => {
  // Markup in the source never appears verbatim in the rendered text, so the
  // lookup misses and the block's own span answers instead.
  assert.equal(linesOfSelection('**bold** text', 'bold text'), undefined);
});

test('the browser trailing newline does not defeat the lookup', () => {
  assert.deepEqual(linesOfSelection('hello\n', 'hello\n'), { start: 1, end: 1 });
});

test('the block span stands in for a selection that cannot be placed', () => {
  assert.deepEqual(spanOf([{ start: 0, end: 2 }, { start: 6, end: 8 }]), { start: 1, end: 9 });
  assert.equal(spanOf([]), undefined);
  assert.equal(spanOf(undefined), undefined);
});

test('the address names the file and the lines the way a reader cites them', () => {
  assert.equal(addressOf('docs/a.md', { start: 12, end: 15 }), 'docs/a.md:12-15');
  assert.equal(addressOf('docs/a.md', { start: 3, end: 3 }), 'docs/a.md:3');
  assert.equal(addressOf('docs/a.md'), 'docs/a.md');
  assert.equal(addressOf('docs\\a.md', { start: 1, end: 2 }), 'docs/a.md:1-2');
});

test('the address names the version the line numbers belong to', () => {
  // The old half of a change cites lines that no longer exist in the file, so the
  // numbers alone would send the model to the wrong text.
  assert.equal(addressOf('a.md', { start: 1, end: 1 }, ' · старая версия'), 'a.md:1 · старая версия');
  // Without a span the address still says which version was quoted.
  assert.equal(addressOf('a.md', undefined, ' · старая версия'), 'a.md · старая версия');
});

test('a fence keeps every line of the quotation as written', () => {
  assert.equal(fenceOf('one\ntwo'), '```\none\ntwo\n```');
  // A blank line inside stays blank: a fenced block has no marker per line, so
  // nothing can end it early.
  assert.equal(fenceOf('a\n\nb'), '```\na\n\nb\n```');
  assert.equal(fenceOf('a\r\nb'), '```\na\nb\n```');
});

test('a quotation of a code block gets a fence longer than its own', () => {
  // Otherwise the quoted ``` would close the quotation half-way through it.
  assert.equal(fenceOf('```js\nx\n```'), '````\n```js\nx\n```\n````');
});

test('a comment is the address, the quotation and the labelled remark', () => {
  assert.equal(
    commentMessage({ address: 'a.md:3', quote: 'old', remark: 'why?', remarkLabel: 'Замечание:' }),
    'a.md:3\n```\nold\n```\n**Замечание:** why?\n',
  );
  assert.equal(
    commentMessage({ address: 'a.md:3', quote: 'a\nb', remark: '  why?  ', remarkLabel: 'Замечание:' }),
    'a.md:3\n```\na\nb\n```\n**Замечание:** why?\n',
  );
});

test('the parts stand apart by a line break only, and the record ends with one', () => {
  const message = commentMessage({ address: 'a.md:3', quote: 'old', remark: 'why?', remarkLabel: 'Замечание:' });
  // No blank line inside: the address, the quotation and the remark are one record.
  assert.equal(message.includes('\n\n'), false);
  // One at the end, so the next comment starts apart whatever the draft ends with.
  assert.equal(message.endsWith('\n'), true);
  assert.equal(message.endsWith('\n\n'), false);
});

test('the remark stays outside the quotation', () => {
  // A blockquote would take the remark line as a lazy continuation of itself, so
  // the fence is what keeps the reader's words out of the quoted block.
  const message = commentMessage({
    address: 'a.md:3',
    quote: '```js\nx\n```',
    remark: 'why?',
    remarkLabel: 'Замечание:',
  });
  assert.equal(message, 'a.md:3\n````\n```js\nx\n```\n````\n**Замечание:** why?\n');
  // The label is the last line, after the fence closed.
  assert.equal(message.split('\n')[2], '```js');
});

test('a remark without a label is still a remark', () => {
  assert.equal(
    commentMessage({ address: 'a.md:3', quote: 'old', remark: 'why?' }),
    'a.md:3\n```\nold\n```\nwhy?\n',
  );
});

test('the two halves of a change are shaped alike', () => {
  // What reaches the model must not depend on which half the reader happened to
  // select: same address position, same quotation, same label.
  const added = commentMessage({ address: 'a.md:3', quote: 'new', remark: 'why?', remarkLabel: 'Замечание:' });
  const removed = commentMessage({ address: 'a.md:3 · старая версия', quote: 'old', remark: 'why?', remarkLabel: 'Замечание:' });
  const shape = (message) => message
    .replace(/^[^\n]*/u, '<address>')
    .replace(/^(new|old)$/mu, '<quote>');
  assert.equal(shape(added), shape(removed));
});

test('an appended comment lands behind a paragraph break, not a space', () => {
  assert.equal(separatorFor(''), '');
  assert.equal(separatorFor('text'), '\n\n');
  assert.equal(separatorFor('text\n'), '\n');
  assert.equal(separatorFor('text\n\n'), '');
  assert.equal(appendText('', '> a'), '> a');
  assert.equal(appendText('text', '> a'), 'text\n\n> a');
});

test('a quotation over the limit keeps its address and drops the text', () => {
  const long = 'x'.repeat(SELECTION_LIMIT + 1);
  assert.equal(fenceOf(long), '');
  assert.equal(
    commentMessage({ address: 'a.md:3', quote: long, remark: 'why?', remarkLabel: 'Замечание:' }),
    'a.md:3\n**Замечание:** why?\n',
  );
});

test('a quotation keeps its leading indentation and loses only trailing space', () => {
  // Leading spaces are indentation inside a code block: stripping them would change
  // what the reader quoted.
  assert.equal(fenceOf('  indented\ncode  '), '```\n  indented\ncode\n```');
  assert.equal(fenceOf('  '), '');
  assert.equal(
    commentMessage({ address: 'a.md:3', quote: '  ', remark: 'why?', remarkLabel: 'Замечание:' }),
    'a.md:3\n**Замечание:** why?\n',
  );
});

test('a draft offset is folded into the editor coordinates before a span is used', () => {
  // One chip of three characters collapses to a single detect character, so the
  // end of the document is two positions earlier than the draft says.
  assert.equal(foldClipboardOffset('abcdef', [{ offset: 1, length: 3 }], 6), 4);
  // An offset at a chip's start stays before the chip.
  assert.equal(foldClipboardOffset('abcdef', [{ offset: 1, length: 3 }], 1), 1);
  // An offset inside a chip snaps to its trailing edge — behind the chip, at
  // detect 2, not in front of it.
  assert.equal(foldClipboardOffset('abcdef', [{ offset: 1, length: 3 }], 2), 2);
  // An offset at the trailing edge counts the chip as one character.
  assert.equal(foldClipboardOffset('abcdef', [{ offset: 1, length: 3 }], 4), 2);
});

test('the append offset counts a command chip that occurrences never mention', () => {
  assert.equal(appendOffset({ draft: 'ab', occurrences: [] }), 2);
  // `/goal ` is a chip in the editor but absent from `occurrences`.
  const claimed = { draft: '/goal abc', phase: 'claimed', claim: { token: '/goal ' }, occurrences: [{ offset: 6, length: 3 }] };
  assert.equal(appendOffset(claimed), 2);
});

test('the append offset folds a quote, which is published apart from occurrences', () => {
  // A quote is one detect character too: the trailing space is the only text left.
  assert.equal(appendOffset({ draft: '> a\n> b ', quotes: [{ offset: 0, length: 7 }], occurrences: [] }), 2);
});

test('the supported channel appends as new paragraphs and keeps the draft', () => {
  const calls = [];
  const conversation = {
    input: {
      requestDraftInitialization(binding, options) {
        calls.push({ binding, options });
        return 'applied';
      },
      for() {
        throw new Error('the facade must not be needed when the binding channel works');
      },
    },
  };
  const outcome = appendToDraft(contextOf({ conversation, sessions: { binding: () => ({ id: 's1' }) } }), 's1', '> q\n\nwhy?');
  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.whenDraftExists, 'append');
  assert.equal(calls[0].options.prompt, '> q\n\nwhy?');
});

test('a refused generation falls back to the composer facade', () => {
  const written = [];
  const input = {
    state: { getSnapshot: () => ({ draft: 'text', draftRev: 3, phase: 'plain', occurrences: [] }) },
    setDraft: (next) => { written.push(next); },
  };
  const conversation = {
    input: {
      requestDraftInitialization() { throw new Error('not the retained generation'); },
      for: () => input,
    },
  };
  const outcome = appendToDraft(contextOf({ conversation, sessions: { binding: () => ({ id: 's1' }), scope: () => ({}) } }), 's1', '> q\n\nwhy?');
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(written, ['text\n\n> q\n\nwhy?']);
});

test('a draft with chips is written through the span channel, not flattened', () => {
  const emitted = [];
  let revision = 7;
  const input = {
    state: { getSnapshot: () => ({ draft: 'abc', draftRev: revision, phase: 'plain', occurrences: [{ offset: 0, length: 3 }] }) },
    setDraft: () => { throw new Error('setDraft would flatten the chip'); },
  };
  const actx = { emit: (name, payload) => { emitted.push({ name, payload }); revision = 8; } };
  const conversation = { input: { for: () => input } };
  const outcome = appendToDraft(contextOf({ conversation, sessions: { binding: () => undefined, scope: () => actx } }), 's1', '> q');
  assert.deepEqual(outcome, { ok: true });
  assert.equal(emitted[0].name, 'slash/input-insert-text');
  assert.deepEqual(emitted[0].payload.span, { draftRev: 7, start: 1, end: 1 });
  assert.equal(emitted[0].payload.text, '\n\n> q');
});

test('a draft holding a quote is written through the span channel, not flattened', () => {
  const emitted = [];
  let revision = 9;
  const input = {
    state: { getSnapshot: () => ({ draft: '> a\n> b ', draftRev: revision, phase: 'plain', occurrences: [], quotes: [{ offset: 0, length: 7 }] }) },
    setDraft: () => { throw new Error('setDraft would flatten the quote node'); },
  };
  const actx = { emit: (name, payload) => { emitted.push({ name, payload }); revision = 10; } };
  const conversation = { input: { for: () => input } };
  const outcome = appendToDraft(contextOf({ conversation, sessions: { binding: () => undefined, scope: () => actx } }), 's1', '> q');
  assert.deepEqual(outcome, { ok: true });
  // The quote is one detect character plus the host's trailing space.
  assert.deepEqual(emitted[0].payload.span, { draftRev: 9, start: 2, end: 2 });
  assert.equal(emitted[0].payload.text, '\n\n> q');
});

test('an insert the host ignored is reported, not assumed', () => {
  const input = {
    state: { getSnapshot: () => ({ draft: 'abc', draftRev: 7, phase: 'plain', occurrences: [{ offset: 0, length: 3 }] }) },
  };
  const actx = { emit: () => {} };
  const conversation = { input: { for: () => input } };
  const outcome = appendToDraft(contextOf({ conversation, sessions: { scope: () => actx } }), 's1', '> q');
  assert.deepEqual(outcome, { ok: false, reason: 'refused' });
});

test('a composer that is sending reports busy instead of writing into a locked editor', () => {
  const input = {
    state: { getSnapshot: () => ({ draft: '', draftRev: 1, phase: 'sending', occurrences: [] }) },
    setDraft: () => { throw new Error('a locked editor must not be written to'); },
  };
  const conversation = { input: { for: () => input } };
  const outcome = appendToDraft(contextOf({ conversation, sessions: { scope: () => ({}) } }), 's1', '> q');
  assert.deepEqual(outcome, { ok: false, reason: 'busy' });
});

test('a blocked initialisation is busy, not a silent success', () => {
  const conversation = {
    input: {
      requestDraftInitialization: () => 'blocked',
      for: () => { throw new Error('unreachable'); },
    },
  };
  const outcome = appendToDraft(contextOf({ conversation, sessions: { binding: () => ({ id: 's1' }) } }), 's1', '> q');
  assert.deepEqual(outcome, { ok: false, reason: 'busy' });
});

test('a missing chat service is reported with its own reason', () => {
  assert.deepEqual(appendToDraft(contextOf({ conversation: undefined, sessions: undefined }), 's1', '> q'),
    { ok: false, reason: 'no-chat' });
  assert.deepEqual(appendToDraft(contextOf({}), '', '> q'), { ok: false, reason: 'no-session' });
  assert.deepEqual(appendToDraft(contextOf({}), 's1', '   '), { ok: false, reason: 'empty' });
});

console.log(`\n${String(passed)}/${String(passed + failed)} comment checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
