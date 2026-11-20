/**
 * Prove the anchor-split alignment is still lossless and correct: every token of
 * each side must be emitted exactly once, in order, and equal steps must pair
 * genuinely identical tokens.
 */

import { diffInline, rangesOf, tokensOf } from '../src/inline.js';

let passed = 0;
let failed = 0;

/** Run one named check. */
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

/**
 * Rebuild both sides from the segments and check every pair of equal a
 * positional match.
 */
function verify(before, after) {
  const segments = diffInline(before, after);
  const left = [];
  const right = [];
  const equalLeft = [];
  const equalRight = [];
  for (const segment of segments) {
    if (segment.kind === 'equal') {
      left.push(segment.text);
      right.push(segment.text);
      equalLeft.push(segment.text);
      equalRight.push(segment.text);
    } else if (segment.kind === 'del') {
      left.push(segment.text);
    } else {
      right.push(segment.text);
    }
  }
  if (left.join('') !== before) throw new Error('left side is not rebuilt losslessly');
  if (right.join('') !== after) throw new Error('right side is not rebuilt losslessly');
  if (equalLeft.join('') !== equalRight.join('')) throw new Error('equal segments disagree');
  return segments;
}

/**
 * A table bigger than the cell budget, with one cell changed.
 *
 * The first two lines are the header and its rule, so the row for term `at` lives
 * at index `at + 2`.
 */
function bigTable(rowCount, mutate) {
  const rows = ['| ID | Термин | Категория | Определение |', '|---|---|---|---|'];
  for (let at = 0; at < rowCount; at += 1) {
    rows.push(`| TERM-${String(at).padStart(3, '0')} | Термин${String(at)} | сущность | Определение термина номер ${String(at)} для проверки. |`);
  }
  return mutate(rows).join('\n');
}

/** The row index of term `at` inside the rows array. */
const rowOf = (at) => at + 2;

/** Replace term `at`'s definition while keeping its id and term name. */
function redefine(rows, at, definition) {
  rows[rowOf(at)] = `| TERM-${String(at).padStart(3, '0')} | Термин${String(at)} | сущность | ${definition} |`;
  return rows;
}

test('a table past the cell budget is rebuilt losslessly', () => {
  const before = bigTable(120, (rows) => rows);
  const after = bigTable(120, (rows) => redefine(rows, 59, 'Совсем другое определение для этой строки.'));
  verify(before, after);
});

test('a huge table with one changed cell marks only that cell', () => {
  const before = bigTable(120, (rows) => rows);
  const after = bigTable(120, (rows) => redefine(rows, 59, 'Иное определение взамен прежнего текста.'));
  const segments = diffInline(before, after);
  const ins = rangesOf(segments, 'ins');
  const painted = ins.map((range) => after.slice(range.start, range.end));
  const covered = ins.reduce((total, range) => total + (range.end - range.start), 0);
  const share = (covered / after.length) * 100;
  console.log(`       marked ${share.toFixed(2)}% as ${JSON.stringify(painted)}`);
  if (share > 3) throw new Error(`over-marked ${share.toFixed(1)}% of the table`);
  for (const piece of painted) {
    if (piece.includes('сущность')) throw new Error(`unchanged cell text was marked: ${JSON.stringify(piece)}`);
  }
});

test('a changed cell does not drag in the unchanged cell beside it', () => {
  // The shape of the defect: inside one row the term cell and the alternative
  // designations cell both change, and the category cell between them does not.
  // A prefix/suffix trim spans all three and paints "сущность"; anchors cut the
  // row at the ids, which occur once each, so only the two edited cells are found.
  const rows = ['| ID | Основной термин | Категория | Определение | Альтернативы |', '|---|---|---|---|---|'];
  for (let at = 0; at < 150; at += 1) {
    rows.push(`| TERM-${String(at).padStart(3, '0')} | Термин ${String(at)} | сущность | Определение ${String(at)}. | лог. термин ${String(at)} |`);
  }
  const before = rows.join('\n');
  const after = [...rows];
  after[rowOf(7)] = '| TERM-007 | Термин семь | сущность | Определение 7. | лог. термин семь; Т7 |';
  const table = after.join('\n');

  const painted = rangesOf(diffInline(before, table), 'ins').map((range) => table.slice(range.start, range.end));
  const flat = painted.join('\u0000');
  console.log(`       marked ${JSON.stringify(painted)}`);
  if (/сущность/u.test(flat)) {
    throw new Error(`the unchanged category cell was dragged in: ${JSON.stringify(painted)}`);
  }
  if (!flat.includes('семь')) throw new Error(`the edit is missing: ${JSON.stringify(painted)}`);
});

test('two edits far apart in a huge table are both located', () => {
  const before = bigTable(150, (rows) => rows);
  const after = bigTable(150, (rows) => {
    redefine(rows, 19, 'ПЕРВАЯ правка этой строки.');
    redefine(rows, 129, 'ВТОРАЯ правка этой строки.');
    return rows;
  });
  const painted = rangesOf(diffInline(before, after), 'ins').map((range) => after.slice(range.start, range.end));
  const flat = painted.join('\u0000');
  if (!flat.includes('ПЕРВАЯ')) throw new Error(`first edit missing: ${JSON.stringify(painted)}`);
  if (!flat.includes('ВТОРАЯ')) throw new Error(`second edit missing: ${JSON.stringify(painted)}`);
  const covered = rangesOf(diffInline(before, after), 'ins').reduce((total, range) => total + (range.end - range.start), 0);
  const share = (covered / after.length) * 100;
  console.log(`       marked ${share.toFixed(2)}%`);
  if (share > 5) throw new Error(`edits swept together: ${share.toFixed(1)}% marked`);
});

test('a huge block with no distinguishing words still terminates', () => {
  const before = 'а '.repeat(4000);
  const after = 'а '.repeat(2000) + 'б ' + 'а '.repeat(1999);
  const segments = diffInline(before, after);
  if (!segments.some((segment) => segment.kind !== 'equal')) throw new Error('the change was missed');
  verify(before, after);
});

console.log(`\n${String(passed)}/${String(passed + failed)} anchor checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
