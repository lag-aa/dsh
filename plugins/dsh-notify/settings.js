/**
 * dsh-notify — the notification channels' own settings.
 *
 * The person owns three things here rather than the profile file:
 *
 *   - **which channels speak** — `mode` picks the Windows toast, the webhook,
 *     or both. It is the day-to-day answer a user flips from Settings without
 *     editing YAML.
 *   - **quiet hours** — a window in which the webhook sends nothing, so a turn
 *     finishing at 02:00 does not wake anyone. This is what "the webhook runs on
 *     a schedule" means: the toast is local and always instant, the webhook waits
 *     for its window.
 *   - **the webhook payload's shape** — `webhook.markdown` decides whether the
 *     verdict line is wrapped in `**…**`; only a renderer that understands
 *     markdown may show those asterisks, so it stays a switch.
 *
 * This file never holds the webhook URL: that address may carry a token, so it
 * lives in the credential store (`credentials.js`). Here are only the values a
 * person would not mind seeing in a plain configuration file.
 *
 * State lives in `$DSH_HOME/dsh-notify/settings.json` — outside the package, so
 * a reinstall or a version bump cannot drop it, and outside the profile, so a
 * click in the GUI never rewrites `cordis.patch.yml`. The old in-bundle file is
 * read once and migrated (`load`).
 *
 * Times are wall-clock `HH:MM` strings compared against the Host's own local
 * clock: the Host runs on the machine whose notifications these are, so its
 * timezone is the right one and no offset has to be stored.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_DIR = dirname(fileURLToPath(import.meta.url))

/** Every weekday in ISO order (Monday `1` … Sunday `7`). */
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]

/** `HH:MM` in 24-hour form, the only shape the picker and the file use. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * The three positions of the switch, in the order the settings page shows them.
 *
 *   - `windows`  — only the local toast; the webhook stays silent.
 *   - `webhook`  — only the webhook; no toast at all.
 *   - `both`     — the toast immediately, the webhook inside its quiet window.
 *
 * `both` is the only mode where quiet hours mean anything: the other two have
 * no second channel to hold back, so a window there would be dead state the
 * page still had to explain.
 *
 * The middle position used to be spelled after the service this plugin was
 * channel was first written for. The value is a stored string, so the old
 * spelling is still accepted and rewritten on the next save (`normalizeSettings`).
 */
export const MODES = Object.freeze(['windows', 'webhook', 'both'])

/** What an untouched install behaves like: both channels, no quiet hours. */
export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'both',
  quietHours: Object.freeze({
    enabled: false,
    from: '20:00',
    to: '09:00',
    days: Object.freeze([...ALL_DAYS]),
  }),
  webhook: Object.freeze({
    markdown: true,
    // Set once the profile's old `webhook.url` has been imported (or knowingly
    // skipped): without it, a URL cleared in Settings would come back from the
    // loader row on the next boot.
    imported: false,
  }),
})

/** A deep copy, so a caller cannot mutate the frozen default through a read. */
function defaults() {
  return {
    mode: DEFAULT_SETTINGS.mode,
    quietHours: {
      enabled: DEFAULT_SETTINGS.quietHours.enabled,
      from: DEFAULT_SETTINGS.quietHours.from,
      to: DEFAULT_SETTINGS.quietHours.to,
      days: [...DEFAULT_SETTINGS.quietHours.days],
    },
    webhook: {
      markdown: DEFAULT_SETTINGS.webhook.markdown,
      imported: DEFAULT_SETTINGS.webhook.imported,
    },
  }
}

/** Whether a string names one of the three positions. */
export function isMode(value) {
  return typeof value === 'string' && MODES.includes(value)
}

function isTime(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value.trim())
}

function normalizeTime(value, fallback) {
  return isTime(value) ? value.trim() : fallback
}

/**
 * Weekdays the window applies to. An empty or unusable list falls back rather
 * than producing a window that silently covers no day at all — a "quiet hours"
 * switch that does nothing is worse than one the user has to re-check.
 */
function normalizeDays(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const days = []
  for (const raw of value) {
    const day = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isInteger(day) && day >= 1 && day <= 7 && !days.includes(day)) days.push(day)
  }
  days.sort((a, b) => a - b)
  return days.length === 0 ? [...fallback] : days
}

/**
 * Coerce anything read from the file or sent by the client into the exact
 * shape the rest of the plugin expects. Unknown fields are dropped, so a
 * hand-edited file cannot smuggle state into the runtime.
 *
 * `enabled` is the field this file used to carry before the three-position
 * switch. A file written by that revision is still on disk, so it is honoured:
 * `false` meant "the webhook is off", which is exactly the `windows` position.
 */
export function normalizeSettings(raw) {
  const base = defaults()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const quiet = raw.quietHours !== null && typeof raw.quietHours === 'object' && !Array.isArray(raw.quietHours)
    ? raw.quietHours
    : {}
  const webhook = raw.webhook !== null && typeof raw.webhook === 'object' && !Array.isArray(raw.webhook)
    ? raw.webhook
    : {}
  const mode = isMode(raw.mode)
    ? raw.mode
    : typeof raw.enabled === 'boolean'
      ? (raw.enabled ? 'both' : 'windows')
      : base.mode
  return {
    mode,
    quietHours: {
      enabled: typeof quiet.enabled === 'boolean' ? quiet.enabled : base.quietHours.enabled,
      from: normalizeTime(quiet.from, base.quietHours.from),
      to: normalizeTime(quiet.to, base.quietHours.to),
      days: normalizeDays(quiet.days, base.quietHours.days),
    },
    webhook: {
      markdown: typeof webhook.markdown === 'boolean' ? webhook.markdown : base.webhook.markdown,
      imported: webhook.imported === true,
    },
  }
}

/** Minutes since midnight, for comparing two `HH:MM` values numerically. */
function minutesOf(time) {
  const match = TIME_PATTERN.exec(time)
  return match === null ? 0 : Number(match[1]) * 60 + Number(match[2])
}

/** ISO weekday of a date: Monday `1` … Sunday `7` (`getDay` uses Sunday `0`). */
export function isoDay(date) {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/**
 * Is a moment inside the quiet window?
 *
 * Three shapes are possible, and the wrap is the one worth being explicit
 * about: for `20:00 → 09:00` the small hours of Saturday still belong to
 * Friday's window, so a window that starts on a selected day runs to its end
 * even though the clock has moved to the next date. Otherwise "quiet on
 * weekdays" would fall silent on Friday evening and speak up again at
 * midnight — the opposite of what the setting says.
 *
 * `from === to` reads as the whole day: it is the one way to silence entire
 * days (a weekend, for instance) without picking `00:00 → 23:59` and losing a
 * minute.
 */
export function isQuiet(quietHours, date = new Date()) {
  if (quietHours?.enabled !== true) return false
  const days = Array.isArray(quietHours.days) ? quietHours.days : ALL_DAYS
  if (days.length === 0) return false

  const from = isTime(quietHours.from) ? minutesOf(quietHours.from) : minutesOf(DEFAULT_SETTINGS.quietHours.from)
  const to = isTime(quietHours.to) ? minutesOf(quietHours.to) : minutesOf(DEFAULT_SETTINGS.quietHours.to)
  const now = date.getHours() * 60 + date.getMinutes()

  const today = isoDay(date)
  const yesterday = today === 1 ? 7 : today - 1

  if (from === to) return days.includes(today)
  if (from < to) return days.includes(today) && now >= from && now < to
  // A window that wraps midnight: the start day decides which side we are on.
  if (now >= from) return days.includes(today)
  if (now < to) return days.includes(yesterday)
  return false
}

/**
 * Where the settings live for this user: `$DSH_HOME/dsh-notify/settings.json`.
 *
 * The package directory is the wrong place — an installed copy sits under the
 * profile's `node_modules` and is replaced wholesale on an update, taking the
 * user's switches with it. `DSH_HOME` is the harness's own per-user root and is
 * set in every Desktop profile.
 *
 * @param env - the process environment, read at call time so a test can point the store elsewhere.
 * @returns absolute path of the settings file.
 */
export function defaultStatePath(env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-notify', 'settings.json')
}

/** The file the previous revision kept inside the bundle; read once, then migrated. */
export const LEGACY_STATE_PATH = join(BUNDLE_DIR, 'state', 'settings.json')

/**
 * The settings store the Host shares with the settings page.
 *
 * Reads are synchronous from memory so the delivery path can ask "may I send
 * this?" without awaiting anything; writes go through the file first so a
 * crash never leaves memory claiming a state the disk does not have.
 */
export function createSettingsStore({ logger, statePath, legacyPath } = {}) {
  const file = typeof statePath === 'string' && statePath.trim() !== ''
    ? statePath.trim()
    : defaultStatePath()
  const previousFile = typeof legacyPath === 'string' && legacyPath.trim() !== ''
    ? legacyPath.trim()
    : LEGACY_STATE_PATH

  const log = (level, message) => {
    try {
      logger?.[level]?.(`dsh-notify:settings: ${message}`)
    } catch {
      /* a logging failure must never break delivery */
    }
  }

  let current = defaults()
  let loaded = false

  /**
   * Read one file, or `undefined` when it is absent. A malformed or unreadable
   * file is worth a line but never a crash: the shipped defaults apply, and the
   * next save rewrites the file.
   */
  const readSettings = async (path) => {
    try {
      return normalizeSettings(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') log('warn', `could not read ${path}: ${String(error)}`)
      return undefined
    }
  }

  const save = async () => {
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      log('warn', `could not write ${file}: ${String(error)}`)
      return false
    }
  }

  const load = async () => {
    const own = await readSettings(file)
    if (own !== undefined) {
      current = own
    } else {
      // Upgrade path: the previous revision wrote inside the bundle. Adopt that
      // file and move it to the stable location right away, so the user's mode
      // and quiet hours survive the change.
      const legacy = previousFile === file ? undefined : await readSettings(previousFile)
      current = legacy ?? defaults()
      if (legacy !== undefined) {
        log('info', `settings imported from ${previousFile} into ${file}`)
        if (await save()) log('info', `${previousFile} is no longer read; it can be deleted`)
      }
    }
    loaded = true
    return current
  }

  /** The live settings; callers must not mutate the result. */
  const get = () => current

  /**
   * Merge a patch, persist it, and only then adopt it. A failed write leaves
   * the running state alone, so what the page shows is what the file holds.
   *
   * Fields explicitly set to `undefined` are dropped rather than spread over
   * the current value: the Host sends one patch per control, and `{ mode:
   * undefined }` must mean "leave the mode alone", not "reset it to the
   * shipped default".
   */
  const update = async (patch) => {
    const defined = (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
        : {}
    const next = normalizeSettings({
      ...current,
      ...defined(patch),
      quietHours: { ...current.quietHours, ...defined(patch?.quietHours) },
      webhook: { ...current.webhook, ...defined(patch?.webhook) },
    })
    const previous = current
    current = next
    if (await save()) return { settings: current, persisted: true }
    current = previous
    return { settings: current, persisted: false }
  }

  return {
    path: file,
    load,
    get,
    update,
    loaded: () => loaded,
    /**
     * Whether the webhook channel may send right now. Both halves have to agree:
     * the mode has to include the webhook at all, and the clock has to be
     * outside the window. The window is consulted only when it exists — in
     * `webhook` mode the user asked for "webhook only" and a leftover window from
     * a previous `both` reading must not silently mute the only channel left.
     */
    allows: (date = new Date()) => {
      const mode = current.mode
      if (mode !== 'both' && mode !== 'webhook') return false
      if (mode === 'webhook') return true
      return !isQuiet(current.quietHours, date)
    },
    /** Whether the local Windows toast may be raised right now. */
    allowsToast: () => current.mode === 'windows' || current.mode === 'both',
    /** Whether the mode silences the toast — the Web half reads this to skip the poll. */
    toastMuted: () => current.mode === 'webhook',
  }
}










