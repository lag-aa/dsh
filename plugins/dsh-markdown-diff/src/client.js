/**
 * Browser entry of the markdown-diff plugin.
 *
 * Three registrations, all idempotent disposers the plugin lifetime owns:
 *
 *   1. a file viewer in the sidebar's file tab, which is what actually opens a
 *      `.md` there — the tab type owns the address, so the host's document
 *      preview never sees it;
 *   2. a document renderer for `.md` / `.markdown` at `extension` priority, which
 *      covers the case where the host preview takes the address back;
 *   3. a settings section holding the default view, the comparison base, and the
 *      removals switch.
 *
 * `React` is the platform module the bundle's banner requires from the client
 * module table. The exports travel through a temporary global because esbuild's
 * IIFE bundle tree-shakes an ESM entry against the loader's own `return`, which
 * it never sees.
 *
 * @module dsh-markdown-diff/client
 */

import { MarkdownDiffBody, MarkdownDiffViewer } from './MarkdownDiffBody.js';
import { MarkdownDiffIcon } from './icon.js';
import { MarkdownDiffSettings } from './settings.js';
import { currentLabels } from './labels.js';
import { attempt, describeRegistry, outcomes, record } from './diagnostics.js';

/** The implementation id, unique across every registered renderer. */
export const BODY_ID = 'dsh-markdown-diff/markdown';

/** The file-tab viewer id. */
export const VIEWER_ID = 'dsh-markdown-diff:markdown';

/** The settings section id. */
export const SETTINGS_ID = 'markdown-diff';

/**
 * The renderer's registry definition.
 *
 * `loading: 'text-pages'` keeps the preview's own paging: the body receives the
 * same `content` the builtin Markdown body receives, so the plugin inherits
 * reloads, automatic refresh, and scroll restoration instead of re-reading the
 * file over its own route. `wrap: false` matches the builtin Markdown entry, so
 * the wrap control in the tab's bar keeps meaning the same thing.
 *
 * @returns the definition the document registry accepts.
 */
function bodyDefinition() {
  return {
    id: BODY_ID,
    extensions: ['md', 'markdown'],
    priority: 'extension',
    title: () => currentLabels().viewerLabel,
    loading: 'text-pages',
    wrap: false,
  };
}

/**
 * Registration outcomes, kept for the settings section to display.
 *
 * A failed registration is otherwise invisible: the preview quietly keeps the
 * shipped renderer and the settings section looks healthy. Recording the outcome
 * turns that silence into something the user can read and report.
 */
export { outcomes };

/**
 * The file viewer's descriptor.
 *
 * The sidebar ranks viewers by descending `priority`, and its own Markdown viewer
 * declares none — so a positive priority is what makes this one win for `.md`
 * without touching the tab type or the host's preview registry. `detect` is
 * deliberately absent: matching on the extension alone keeps the viewer inert for
 * every other file, and lets the shipped editor keep them.
 *
 * @returns the descriptor the file-tab service accepts.
 */
function viewerDefinition() {
  return {
    id: VIEWER_ID,
    title: () => currentLabels().viewerLabel,
    exts: ['md', 'markdown'],
    priority: 10,
    fetchStrategy: 'fsRead',
    component: MarkdownDiffViewer,
  };
}

/**
 * The `betterSidebar` service, if the sidebar plugin has provided it.
 *
 * Reading a service that is neither provided nor injected throws even through
 * `?.`, so the lookup is guarded and treated as "not ready yet" rather than as a
 * failure. The service is optional: without it the `.md` viewer is simply the
 * host's preview, which registration 2 below still covers.
 *
 * @param ctx - client Cordis context.
 * @returns the service, or `undefined` when the sidebar plugin is absent.
 */
function sidebarServiceOf(ctx) {
  try {
    const service = ctx.get('betterSidebar');
    if (service !== undefined && service !== null) return service;
  } catch {
    // The service is not provided in this context yet.
  }
  try {
    return ctx.betterSidebar;
  } catch {
    return undefined;
  }
}

/**
 * Register the file viewer for as long as the sidebar service exists.
 *
 * The service may be provided after this plugin is applied, so the registration
 * is retried on `ctx.inject` and released again when the service goes away.
 *
 * @param ctx - client Cordis context.
 * @returns the disposer.
 */
function registerViewer(ctx) {
  let dispose;
  const release = () => {
    const current = dispose;
    dispose = undefined;
    if (current === undefined) return;
    try {
      current();
    } catch (error) {
      record('viewer', false, error instanceof Error ? error.message : String(error));
    }
  };
  const tryRegister = () => {
    if (dispose !== undefined) return;
    const service = sidebarServiceOf(ctx);
    if (service === undefined || typeof service.registerFileViewer !== 'function') return;
    const disposeViewer = attempt('viewer', () => service.registerFileViewer(viewerDefinition()));
    if (outcomes.viewer.ok) dispose = disposeViewer;
  };
  // `inject` runs the callback as soon as the service is declared, and again on
  // every re-declaration, so a sidebar that loads later is still picked up.
  const stopWaiting = typeof ctx.inject === 'function'
    ? ctx.inject(['betterSidebar'], () => {
      tryRegister();
    })
    : undefined;
  tryRegister();
  return () => {
    if (typeof stopWaiting === 'function') {
      try {
        stopWaiting();
      } catch {
        // Releasing the wait must not mask the release below.
      }
    }
    release();
  };
}

/**
 * Register the renderer and the settings section.
 * @param ctx - client Cordis context.
 */
function apply(ctx) {
  ctx.effect(() => registerViewer(ctx), 'markdown-diff: file viewer');
  ctx.effect(() => {
    const dispose = attempt('metadata', () => ctx.documentPreviews.register(bodyDefinition()));
    record('registry', true, describeRegistry(ctx.documentPreviews));
    return dispose;
  }, 'markdown-diff: metadata');
  ctx.effect(() => attempt('body', () => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document',
    key: BODY_ID,
  }, MarkdownDiffBody))), 'markdown-diff: body');
  ctx.effect(() => ctx.slots.inject('settings.section', function* settingsSection() {
    yield ctx.slots.register({
      name: 'settings.section',
      id: SETTINGS_ID,
      // After the shipped sections: this is a reading preference, not a
      // connection or a model, and it belongs below them in the list.
      order: 40,
      label: () => currentLabels().settings.nav,
    }, MarkdownDiffSettings);
  }), 'markdown-diff: settings section');
  // The nav row keeps the shell's default glyph until an icon is registered under
  // the section's own id — here it is the diff mark, so the row says what the
  // section changes instead of looking like one more generic page. A `label` is
  // not carried: the shell never projects one for an icon, the section's own label
  // is what the row shows.
  ctx.effect(() => ctx.slots.inject('settings.section.icon', function* settingsIcon() {
    yield ctx.slots.register({
      name: 'settings.section.icon',
      id: SETTINGS_ID,
    }, MarkdownDiffIcon);
  }), 'markdown-diff: settings icon');
}

/** Services the browser half needs before it can register anything. */
export const inject = ['slots', 'documentPreviews'];

// Handed to the factory by the bundle's footer, which also clears it again.
globalThis.__dshMarkdownDiff = { apply, inject, BODY_ID, VIEWER_ID, SETTINGS_ID };
