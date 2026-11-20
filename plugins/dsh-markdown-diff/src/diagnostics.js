/**
 * Registration outcomes, readable from the settings section.
 *
 * A registration that throws inside `ctx.effect` is otherwise invisible: the
 * preview quietly keeps the shipped renderer while the settings section looks
 * perfectly healthy. Recording each outcome turns that silence into something
 * the user can read off the settings page and report back.
 *
 * @module dsh-markdown-diff/diagnostics
 */

/**
 * The outcome of each step, in the order `apply` performs them.
 * `detail` carries the thrown message, so a failure names itself.
 */
export const outcomes = {
  viewer: { ok: false, detail: 'not attempted' },
  metadata: { ok: false, detail: 'not attempted' },
  body: { ok: false, detail: 'not attempted' },
  registry: { ok: false, detail: 'not observed' },
  renders: { ok: false, detail: 'never called' },
};

/** How many times the preview body has actually been asked to render. */
let renderCount = 0;

/**
 * Note that the body rendered, and what it was handed. This is what tells a
 * renderer that was never selected apart from one that was selected and then
 * fell back to the plain document.
 * @param detail - a short description of the incoming props.
 */
export function noteRender(detail) {
  renderCount += 1;
  outcomes.renders = { ok: true, detail: `called ${String(renderCount)}x (${detail})` };
}

/**
 * Record one outcome.
 * @param key - the outcome slot to fill.
 * @param ok - whether the step succeeded.
 * @param detail - what happened.
 */
export function record(key, ok, detail) {
  outcomes[key] = { ok, detail };
}

/**
 * Describe what a document preview registry holds, to tell a failed registration
 * apart from a plugin that registered into a registry no preview reads.
 * @param registry - the document preview registry.
 * @returns a one-line description.
 */
export function describeRegistry(registry) {
  if (registry === null || typeof registry !== 'object') return `no registry (${typeof registry})`;
  if (typeof registry.getSnapshot !== 'function') return 'registry has no getSnapshot';
  const definitions = registry.getSnapshot();
  if (!Array.isArray(definitions)) return `snapshot is ${typeof definitions}`;
  const names = definitions.map((definition) => `${String(definition.id)}@${String(definition.priority)}`);
  return `${String(definitions.length)}: ${names.join(' | ')}`;
}

/**
 * Run one registration, recording whether it succeeded.
 * @param key - the outcome slot to fill.
 * @param register - the registration to attempt.
 * @returns the disposer, or a no-op when the attempt failed.
 */
export function attempt(key, register) {
  try {
    const dispose = register();
    record(key, true, 'registered');
    return typeof dispose === 'function' ? dispose : () => {};
  } catch (error) {
    record(key, false, error instanceof Error ? error.message : String(error));
    return () => {};
  }
}
