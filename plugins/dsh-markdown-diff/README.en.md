# dsh-markdown-diff

A DSH Desktop plugin that highlights git changes in the right sidebar's Markdown preview.
The file opens in the preview as usual, but blocks that differ from `HEAD` (or from the
index, or from a branch) are marked: additions in green, deletions in red, edits in a frame.

The plugin **replaces** the shipped `.md` renderer rather than sitting beside it: the view
registry ranks a `priority: 'extension'` implementation above `builtin`, so the tab opens
here. It follows that every fallback is the plugin's own — no repository, no changes, a file
above the read limit, the "no highlighting" mode — each of those cases is drawn by the plugin.

## What it shows

- **Inline** (default) — one document, changed blocks framed in place.
- **Side by side** — two columns: the comparison base on the left, the working tree on the
  right, rows aligned.
- **No highlighting** — the ordinary preview.

The comparison is block by block: a paragraph, a heading, a list item, a code block, a table,
a quote, a rule, a piece of HTML. Inside a block nothing is marked, so a changed paragraph is
shown whole rather than word by word. An edit that keeps shared words collapses into one
`±` frame; fully rewritten text is shown as a deletion plus an insertion.

The comparison base switches in the toolbar: `HEAD` — every uncommitted change, `Index` —
unstaged changes only, `Branch` — the chosen branch (its tip or the point where it forked).

A branch name means something only in the repository that has it, while the preference is one
value for the whole app: it outlives a switch to another project, a worktree of another
repository and a restart. The name is therefore checked against the current repository's
branch list as soon as that list arrives: an unknown one is replaced by the same suggestion
the picker would have made instead of reaching the host as a request it answers with an error.

## Review comments

Select text in the preview and a button with a speech bubble appears to the left of the
block. It opens an input area below the block: the address and the quote on top, the remark
box underneath. **In chat** (or `Ctrl+Enter`) inserts the quote and the remark into this
session's chat draft, `Esc` cancels.

A remark always goes out as one and the same message — three parts in a row, no blank lines
between them: the address, the quote, and the remark behind a label. A blank line follows the
remark so the next one starts apart.

````
docs/plan.md:12-15
```
## Plan

timelines slipped
```
**Remark:** Why did they slip? The table below has the old dates.
````

The quote is a fenced block, not `>`. That keeps the entry compact: a Markdown blockquote
continues on the next line without `>` (lazy continuation), so a remark standing right after
the quote would render **inside** it. A fence closes where its closing line stands, whatever
follows. It also shows the source Markdown as text: `## heading` and `**bold**` read as markup
in a review rather than as formatting. When the quote contains a fenced block of its own, the
outer fence is one character longer.

The `**Remark:**` label separates the reader's words from the quote when the message is read
as plain text.

A comment is never sent by itself: it waits in the draft, so several remarks on one file leave
as a single message and the user chooses when. The draft is an ordinary one — the quote and
the remark can be edited or deleted before sending.

Both the new half and the removed half can be quoted. Line numbers are not always available,
so the address is built to stay correct either way: the path is mandatory, the lines appear
when they are known. A selection in the base half (old text, or a removed block) carries the
suffix `· old version`: its line numbers refer to the comparison base rather than to the file
on disk, and without the mark the model would search in the wrong place.

````
docs/plan.md:12-15 · old version
```
## Plan

timelines slipped
```
**Remark:** Why was this paragraph removed?
````

A block that already has a comment keeps a mark, with the remark text in its tooltip.

A selection longer than 500 characters is not quoted in full: only the address and the remark
go into the chat, and the input area says so before sending — a quote half a screen long would
flood the draft and bury the remark.

The same input area opens on a keyboard shortcut — `Ctrl+Enter` by default — while there is a
selection and the comment box is closed. The shortcut is changed in the plugin settings (below)
and appears in the button's tooltip; the caret lands in the remark field, so typing can follow
the shortcut.

The shortcut is bound to the **key position**, not to the character the layout prints:
`Ctrl+M` recorded on an English layout also fires on a Russian one, where the same key types
`ь`. It is read from `KeyboardEvent.code`, which is the same in every layout; `key` remains the
fallback for an event without a code. The field therefore always shows the Latin letter of the
position, even when the shortcut was recorded on a Cyrillic layout.

If the draft is busy sending, the plugin says so and writes nothing. Chips (`@file`) and
commands (`/goal`) are not flattened on insert: with them the text goes through the selection
channel, otherwise through the ordinary paragraph append.

## Files

- `lib/index.js` — host half (by hand): the `GET /api/markdown-diff.base` and
  `GET /api/markdown-diff.refs` routes.
- `lib/base.js` — by hand: reads the comparison base through git.
- `lib/refs.js` — by hand: the branch list, resolving a branch name to a commit, `merge-base`.
- `lib/git-run.js` — by hand: runs git without piped stdio.
- `src/client.js` — by hand: registers the renderer, the settings section and its icon.
- `src/MarkdownDiffBody.js` — by hand: the preview itself, three modes, styles.
- `src/settings.js` — by hand: the settings section.
- `src/icon.js` — by hand: the section's icon in the settings list (a split frame with `−` and
  `+`, the marks the preview itself paints).
- `src/blocks.js`, `src/diff.js` — by hand: Markdown block parsing and comparison.
- `src/comments.js`, `src/selection.js`, `src/draft.js` — by hand: the comment text (address,
  quote, remark label, quoting limit), reading the selection, and inserting into the chat draft.
- `src/hotkey.js` — by hand: the shortcut as text (`Ctrl+Enter`), recording a press and matching
  an event. The key is taken from `KeyboardEvent.code`, so the shortcut does not depend on the
  layout. Plain strings only, so it is checked without a DOM.
- `src/api.js`, `src/labels.js`, `src/prefs.js` — by hand: base requests, labels, preferences.
- `lib/client.js` — **generated** by `scripts/build.mjs` (esbuild). Do not edit.
- `test/*.mjs`, `scripts/*.mjs` — checks: `node scripts/check.mjs`.
- `locale/*.json` — the title and description shown in **Plugins**; `icon.svg` — its icon.

## Settings

The «Подсветка изменений» section in Settings: display mode, comparison base, whether to show
removed text, and the comment shortcut. The same switches live in the toolbar above the
document and write the same store (`localStorage`, key `dsh-markdown-diff`), so a change in
Settings is visible in an open preview at once.

The shortcut is not typed but recorded: the field accepts a press and shows what came out.
Ctrl, Alt or Meta is required — a bare key would fire while reading; `Esc` turns the shortcut
off entirely. It is stored as text (`Ctrl+Enter`), so it can also be edited by hand in
`localStorage`; an unreadable value falls back to the default at read time instead of becoming
a silently dead hotkey.

Why `localStorage` rather than a host settings document: this is a display choice, it has to
answer on the first paint before any round trip, and losing it costs one click.

## Install

Requires DSH Desktop with a profile; nothing in the DSH distribution is patched. The sidebar
file tab the plugin intercepts belongs to [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar),
which is **optional**: without it the plugin still draws `.md` files as the document renderer,
but the file-viewer tab keeps the shipped viewer.

Install from the catalog repository:

```
plugin_manager install_bundle
  target: git+https://github.com/lag-aa/dsh.git#main&path:/plugins/dsh-markdown-diff
```

The plugin sits in `lag-aa/dsh` as `plugins/dsh-markdown-diff`, so the spec carries `path:`
— without it the repository root would be installed instead. `#main` is the latest version,
and the copy is fixed at install time: to update, install again. A tag can stand in for
`main` when a pinned version is wanted.

A local checkout works too: **Plugins** → **Add plugin** takes a directory, as does
`plugin_manager install_bundle` with its absolute path.

## Checks

```
node scripts/check.mjs
```

It runs the syntax of every file, block parsing, the comparison engine, address parsing, the
host route against real git in a temporary repository, the shape of the built bundle, and the
packaging of the manifest.

`node --test` is unusable here: the DSH sandbox on Windows forbids piped stdio for child
processes, so every suite is a plain script with its own runner. Building the client bundle
needs `node scripts/build.mjs` and esbuild in `node_modules`.

## Limitations

- Block-level highlighting, not word-level inside a block.
- Footnotes and link definitions can render differently: the document is parsed by blocks.
- A file that was not loaded in full is shown without highlighting — otherwise everything
  below the loaded part would look deleted.
- The leading frontmatter is drawn by the plugin as it is, without parsing the YAML fields.
- A comment quotes the selected text; when the renderer rewrote it (markup, entities), the
  quote comes from the DOM while line numbers come from the block boundaries.
- Comment marks live in the tab's memory: after a reload they are gone, while the comments
  themselves stay in the chat draft.
- Line numbers in an address belong to the version the quote came from: the file on disk for
  the new half, the comparison base for the old one. The exact range is not always found (the
  renderer may have rewritten the text); the address then carries block boundaries or the path
  alone.
- Comments work in the **Inline** and **Side by side** modes; in **No highlighting** the
  shipped viewer draws the document, with its own "Add to chat" button.
- The plugin's own UI labels come from its Russian and Chinese dictionaries, chosen by the
  page's language; there is no English dictionary yet, so an English page shows the Russian
  labels. The title and description in **Plugins** are localized through `locale/*.json`.
