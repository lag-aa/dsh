/**
 * Put a review comment into the chat draft of the file's Session.
 *
 * The comment is not a message: it joins the draft the reader is already
 * writing, so several remarks on one document leave as one message and the
 * reader still chooses when to send. That makes this module a draft writer, and
 * a draft writer here has two channels:
 *
 * - `requestDraftInitialization` with `whenDraftExists: 'append'` adds the text as
 *   new paragraphs and keeps every reference chip. It only works for the Session
 *   generation the client currently retains, and it throws when the binding it is
 *   handed is not that generation.
 * - The composer facade (`input.for(actx)`) always answers, but `setDraft` rebuilds
 *   the document from a plain string and therefore flattens inline chips into
 *   their text. When the draft carries chips, the only channel that preserves
 *   them is the scoped `slash/input-insert-text` event, whose span has to be given
 *   in the editor's *detect* coordinates.
 *
 * The order is that one, and the second channel is the fallback for a Session the
 * client no longer retains (a preview opened from an older tab, for instance).
 * Both are wrapped: a preview must not fail to render because the conversation
 * service moved.
 *
 * The helpers below are a port of `dsh-better-sidebar`'s `conversation-draft.ts`
 * rather than an import — a plugin may only import the module table, never
 * another plugin's sources. If the host's rule changes, this copy is what changes.
 *
 * @module dsh-markdown-diff/draft
 */

/** Phases in which the editor refuses every write. `claimed` is not one of them. */
const BUSY_PHASES = new Set(['adjudicating', 'submitting', 'sending']);

/**
 * Read one client service without letting a missing registry throw.
 * @param ctx - the surface's client context.
 * @param name - the service name.
 * @returns the service, or `undefined`.
 */
function serviceOf(ctx, name) {
  try {
    const service = ctx?.get?.(name);
    return service ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The separating text that puts an appended block after what is already written.
 *
 * A review comment is a blockquote followed by a remark, and a blockquote glued
 * to the previous sentence with a space would read as part of it. So the draft's
 * own trailing whitespace decides: nothing is added to an empty draft, one
 * newline becomes two, and a draft ending in a paragraph break already has one.
 *
 * @param draft - the draft as the composer reports it.
 * @returns the text to put between the draft and the appended block.
 */
export function separatorFor(draft) {
  if (draft.trim() === '') return '';
  if (draft.endsWith('\n\n')) return '';
  if (draft.endsWith('\n')) return '\n';
  return '\n\n';
}

/**
 * The draft with one block appended behind a paragraph break when needed.
 * @param draft - the current draft.
 * @param text - the block to append.
 * @returns the next draft.
 */
export function appendText(draft, text) {
  return `${draft}${separatorFor(draft)}${text}`;
}

/**
 * Fold one clipboard-projection offset to its detect-projection twin.
 *
 * The host keeps two coordinate systems over the same document: the clipboard
 * projection (`InputState.draft`, `occurrences`) expands every chip to its whole
 * clipboard text, while a span must speak the detect projection, which collapses
 * each chip to a single placeholder character. An offset taken from the draft and
 * used as a span therefore overshoots by `length - 1` per chip and the host
 * rejects the out-of-range span — the second chip insert of a Session fails
 * silently.
 *
 * An offset inside a chip snaps to that chip's trailing edge: the host replaces
 * whole chips, never splits one. An offset exactly at a chip's start resolves to
 * the position *before* the chip, because the host's own mapping reads that case
 * as "inside" and would move the caret one chip too far right.
 *
 * @param draft - the clipboard-projection draft.
 * @param occurrences - the reference chips, sorted by offset.
 * @param offset - a clipboard-projection offset.
 * @returns the detect-projection offset.
 */
export function foldClipboardOffset(draft, occurrences, offset) {
  const target = Math.max(0, Math.min(offset, draft.length));
  let shrink = 0;
  for (const occurrence of occurrences) {
    const end = occurrence.offset + occurrence.length;
    if (target >= end) {
      shrink += occurrence.length - 1;
      continue;
    }
    if (target > occurrence.offset) return occurrence.offset - shrink + 1;
    break;
  }
  return target - shrink;
}

/**
 * The clipboard-coordinate spans of every chip-like node, in one ordered list.
 *
 * `occurrences` holds reference chips and `quotes` holds quote nodes; both are
 * projected from one character in detect coordinates and both must be folded
 * before a draft offset can be spoken as a span.
 *
 * @param lists - the published chip lists.
 * @returns the spans, ordered by offset.
 */
function chipSpans(...lists) {
  const spans = [];
  for (const list of lists) {
    if (Array.isArray(list) === false) continue;
    for (const entry of list) {
      if (Number.isFinite(entry?.offset) && Number.isFinite(entry?.length)) {
        spans.push({ offset: entry.offset, length: entry.length });
      }
    }
  }
  return spans.sort((left, right) => left.offset - right.offset);
}

/**
 * The detect-projection offset that appends at the end of the document.
 *
 * Folding the draft's length alone is not enough: a command chip (`/goal `, which
 * is present while `phase === 'claimed'`) collapses to one detect character but
 * never appears in `occurrences`, so the fold would place the span one character
 * short of the end and the host would insert in the middle of the command.
 *
 * A quote node collapses to one character the same way. `InputState` does not
 * publish quote ranges (`quotes` exists on a submit attempt, not on the published
 * state), so this fold can only account for them where a snapshot does carry the
 * list; a caller that has just inserted a quote knows its own geometry instead.
 *
 * @param snapshot - the composer's published state.
 * @returns the offset, or `undefined` when it cannot be derived.
 */
export function appendOffset(snapshot) {
  const draft = typeof snapshot?.draft === 'string' ? snapshot.draft : '';
  const occurrences = chipSpans(snapshot?.occurrences, snapshot?.quotes);
  const claim = snapshot?.claim;
  const token = snapshot?.phase === 'claimed' && claim !== undefined && typeof claim.token === 'string'
    && draft.startsWith(claim.token)
    ? claim.token
    : '';
  if (token === '') return foldClipboardOffset(draft, occurrences, draft.length);
  const rest = draft.slice(token.length);
  const shifted = occurrences
    .filter((occurrence) => occurrence.offset >= token.length)
    .map((occurrence) => ({ offset: occurrence.offset - token.length, length: occurrence.length }));
  return 1 + foldClipboardOffset(rest, shifted, rest.length);
}

/**
 * The reason a write was refused, as a value the caller can turn into a notice.
 * @param reason - the short machine-readable cause.
 * @returns the outcome object.
 */
function refused(reason) {
  return { ok: false, reason };
}

/**
 * Append one block of Markdown to the draft of a Session.
 *
 * @param ctx - the surface's client context; needs the `conversation` and
 *   `sessions` services.
 * @param sessionId - the Session whose composer is the destination.
 * @param text - the Markdown to append.
 * @returns `{ ok: true }`, or `{ ok: false, reason }` with one of `empty`,
 *   `no-session`, `no-chat`, `busy`, `refused`, `failed`.
 */
export function appendToDraft(ctx, sessionId, text) {
  if (typeof text !== 'string' || text.trim() === '') return refused('empty');
  if (typeof sessionId !== 'string' || sessionId === '') return refused('no-session');
  const conversation = serviceOf(ctx, 'conversation');
  if (conversation === undefined || typeof conversation.input?.for !== 'function') return refused('no-chat');
  const sessions = serviceOf(ctx, 'sessions');

  // The paragraph channel first: it is the only one that keeps the draft's own
  // paragraph structure and chips intact, and it is the host's supported way of
  // handing a composer text it did not receive from a keystroke.
  if (typeof conversation.input.requestDraftInitialization === 'function' && typeof sessions?.binding === 'function') {
    try {
      const binding = sessions.binding(sessionId);
      if (binding !== undefined && binding !== null) {
        const outcome = conversation.input.requestDraftInitialization(binding, {
          prompt: text,
          whenDraftExists: 'append',
        });
        if (outcome === 'applied') return { ok: true };
        if (outcome === 'blocked') return refused('busy');
      }
    } catch {
      // Not the retained generation, or the editor refused: the facade below is
      // the channel that does not depend on retention.
    }
  }

  let actx;
  try {
    actx = sessions?.scope?.(sessionId);
  } catch {
    actx = undefined;
  }
  if (actx === undefined || actx === null) return refused('no-chat');

  try {
    const input = conversation.input.for(actx);
    const snapshot = input.state.getSnapshot();
    if (BUSY_PHASES.has(snapshot.phase)) return refused('busy');
    const draft = typeof snapshot.draft === 'string' ? snapshot.draft : '';
    // Both chip kinds force the span channel: a command chip is not an
    // occurrence, yet `setDraft` flattens it just the same, and flattening it
    // also drops the claim — the host would re-read the draft as plain text and
    // cancel the command the reader is in the middle of typing.
    const hasChips = chipSpans(snapshot.occurrences, snapshot.quotes).length > 0 || snapshot.phase === 'claimed';
    if (hasChips) {
      const at = appendOffset(snapshot);
      const emit = typeof actx.emit === 'function' ? actx.emit.bind(actx) : undefined;
      if (typeof snapshot.draftRev !== 'number' || at === undefined || emit === undefined) return refused('refused');
      emit('slash/input-insert-text', {
        text: `${separatorFor(draft)}${text}`,
        span: { draftRev: snapshot.draftRev, start: at, end: at },
      });
      // The host reports nothing back on this channel; a moved revision is the
      // only evidence the edit landed.
      return input.state.getSnapshot().draftRev === snapshot.draftRev ? refused('refused') : { ok: true };
    }
    input.setDraft(appendText(draft, text));
    return { ok: true };
  } catch {
    return refused('failed');
  }
}
