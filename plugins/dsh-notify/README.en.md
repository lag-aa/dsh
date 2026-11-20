# dsh-notify

A DSH Desktop bundle that turns session activity into notifications: a Windows toast, a
webhook message to any HTTP endpoint, or both.

## What it reports

The Host half subscribes to session and agent events and reduces them to a small, fixed
set of frames. The browser half raises one toast per frame.

| Frame | When |
|---|---|
| `turn-completed` | the agent finished a turn and nothing else is running |
| `turn-error` | generation failed; carries the provider verdict (`RATE_LIMIT`, …) |
| `turn-truncated` | the answer hit the output limit |
| `approval` | a tool call is waiting for permission |
| `question` | a question to the user is waiting, with the count of the rest |
| `schedule` | a scheduled reminder was delivered |

The reducer deliberately stays quiet while the agent is still busy: a turn end is only a
turn end when no background job, subagent, or queued input is still owed. That logic lives
in `index.js`; `compose.js` turns a frame into the Russian verdict line and optional title.

## Settings navigation

The section is its own page (`settings.section`, id `dsh-notify`), and it also registers the
navigation glyph (`settings.section.icon`, same id): an outline bell drawn in `currentColor`
at the size the row asks for. Without that registration the shell keeps its generic gear,
which says nothing about notifications.

## Two channels

- **Windows toast** — the Web app's `Notification` API with the plugin's own icon. Clicking
  the toast focuses the session it came from.
- **Webhook** — one `POST` per frame with `{"text": "…"}`, `content-type:
  application/json; charset=utf-8`. The text is the same verdict plus an optional bold
  heading (`**…**`) and the session title, capped at 3 800 characters. Sends are
  serialized, never retried, and time out after 15 seconds; a failure is logged once and
  never reaches the toast path.

`mode` decides which of the two is active: `windows`, `webhook`, or `both`. Quiet hours —
a window with a weekday mask that may cross midnight — hold back the webhook in `both`
mode only. In `webhook` mode the user asked for the webhook and nothing else, so the window
is ignored.

## The webhook address and token are secrets

The address a webhook service hands out and the token that authorises posting to it are
credentials, not settings. Design rules that follow, and that the tests pin down:

- both are stored as one credential record: key `dsh-notify/webhook`, payload
  `{ kind: 'grant', payload: { url, token? } }`, written through `ctx.credentials`. A token
  found inside a pasted link is split off the address when the record is written and again
  when it is read, so an old single-link record and a new two-field one behave alike;
- the token is appended to the address as `?token=…` when the request is made,
  percent-encoded, and it is the one value the settings page never receives;
- the address is returned: `GET /settings` answers
  `{ configured, url, host, source, writable, token, hasToken }`, where `host` is
  `scheme://host` and `url` is the token-free address the field is pre-filled with. Both
  fields are masked, and an address whose token cannot be split off is withheld rather than
  sent;
- an empty field means "keep the stored value", so changing only the token does not require
  re-pasting the address; `POST /config` with `{ webhook: { clear: true } }` removes the whole
  record;
- logs print `scheme://host` at most, never the query or the token;
- values are validated before anything is written: the address must be `http`/`https` without
  embedded `user:password`, whitespace or control characters, at most 2 048 characters; the
  token must be non-empty without whitespace, at most 512 characters;
- a frame reads the record on every delivery, so replacing the address or the token in
  Settings takes effect on the next notification without a restart or a channel rebuild.

A composition without a credential service falls back to the loader row's
`webhook.url` and reports the page as read-only. An install that already had that field
gets it imported into the record once, on the first boot after the upgrade
(`importLegacy()`), and the profile field is then ignored — it can be deleted.

## Settings

The page is registered into the `settings.section` slot as `dsh-notify` and talks to the
Host through the bundle's private prefix `/dsh-notify-8261`:

| Route | Purpose |
|---|---|
| `GET /settings` | the non-secret switches, whether quiet hours are active right now, and the webhook description |
| `POST /config` | one patch per control: `mode`, `quietHours`, or `webhook: { url \| token \| clear \| markdown }` |
| `POST /webhook/test` | send the fixed test message and report `{ ok, host }` or `{ ok: false, error }`; its title is bold under the same switch as a real verdict, so the button also proves the renderer |

The settings file is `$DSH_HOME/dsh-notify/settings.json` (fallback `~/.dsh`) and holds
only `mode`, `quietHours`, `webhook.markdown`. An earlier revision kept it in a `state`
folder inside the bundle; that file is read once and migrated, so an upgraded install keeps
its switches. The Host answers `quiet` and `toastMuted` from the same file, so the page
never disagrees with what will actually be sent.

The browser half also long-polls `GET /frames` for toasts and exposes
`window.__dshNotify` / the `dshNotify` service for a manual test toast.

## Installation

```
plugin_manager install_bundle
  target: git+https://github.com/lag-aa/dsh.git#<40-character-commit>&path:/plugins/dsh-notify
```

`path:` is required, otherwise the repository root is installed. A local directory works
too: **Plugins** → **Add plugin**. The bundle patch inserts one row (`id: dsh-notify`,
`name: dsh-notify`); nothing secret belongs in it.

Do not keep two copies of this plugin active at once: both would poll the same frames and
raise the same toast twice.

## Working on it

```
node scripts/check.mjs
```

The script syntax-checks every runtime module, verifies that `files` covers everything the
manifest names, and scans the packaged sources for personal data — webhook URLs and
tokens, internal hostnames, ids of a linked local bundle. `npm pack` needs a workspace cache
on Windows (`--cache .tmp-npm-cache`), because the default `%LOCALAPPDATA%` cache is not
writable inside the DSH sandbox.

There is no build step: `client.js` is the browser half as loaded by the Web app, and
`window.__ModuleLoader__.load` registers it under the package name.

## Limits

- Toasts need the notification permission; without it the browser half reports
  `unsupported`/`denied` and the webhook still works.
- The webhook is fire-and-forget: no retry queue, no ordering guarantee beyond the
  per-process chain, and a receiver that answers `2xx` is trusted.
- Node 24's merged system CA store is used for TLS when available; older runtimes fall back
  to the bundled CAs with a one-time warning.




