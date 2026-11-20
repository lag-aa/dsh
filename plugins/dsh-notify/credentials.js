/**
 * dsh-notify — the webhook address and its token, kept as one credential.
 *
 * The address a webhook service hands out and the token that authorises posting are
 * both secrets: DSH's own rule is that configuration holds references and the
 * credential seam holds values. The settings file therefore keeps only the
 * non-secret switches, and this module owns the one record:
 *
 *   key      `dsh-notify/webhook`  (scope = this plugin's registered name)
 *   record   `{ kind: 'grant', payload: { url, token? } }`
 *
 * The seam never interprets a payload — the owner does — so this split is the
 * plugin's own business: `url` is the address without the secret, `token` is
 * appended as `?token=<token>` when the request is made. A single pasted URL
 * that already carries its token in the query keeps working: the token stays in
 * the URL and `composeWebhookUrl()` leaves it alone.
 *
 * Three rules follow from that:
 *
 *   - the browser never receives either value. `describe()` answers whether a
 *     record is set, which host it points at (`scheme://host`, never the query),
 *     and whether a token travels with it, so the settings page can show
 *     "configured" without holding the secret; both fields are write-only from
 *     the page's point of view.
 *   - a frame reads the record per delivery through `readUrl()`, so replacing
 *     the address or the token in Settings takes effect on the next
 *     notification, without a restart and without rebuilding the channel.
 *   - clearing the record means "no webhook". While the credential service is
 *     present it is the only source; the profile's old `webhook.url` is used
 *     only when the composition has no credential store at all, where the
 *     settings page has nowhere to write.
 *
 * The profile's field is not dead weight for an existing install: the first
 * boot after an upgrade imports it into the record (`importLegacy()`), so the
 * channel keeps working and the user can then delete the line from
 * `cordis.patch.yml`.
 */

/** Longest URL accepted; a real webhook link is far shorter, anything longer is a mistake. */
const MAX_URL_LENGTH = 2_048

/** Longest token accepted: real tokens are short, and a paste of a whole document is not one. */
const MAX_TOKEN_LENGTH = 512

/** The record this plugin owns. Both segments match the seam's key grammar. */
export const WEBHOOK_RECORD_KEY = 'dsh-notify/webhook'

/**
 * Coerce a pasted value into a usable webhook URL, or reject it.
 *
 * `http:` is allowed on purpose: a webhook receiver on the same machine (or a
 * self-hosted one on a trusted network) is a normal way to run this, and the
 * channel does not send anything secret beyond the payload it was asked to
 * deliver. Credentials embedded in the URL are refused — the token belongs in
 * the query, and a `user:password@host` form would leak into `safeOrigin()`'s
 * host line.
 *
 * @param value - candidate URL.
 * @returns the trimmed URL, or `undefined` when it is not acceptable.
 */
export function normalizeWebhookUrl(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '' || text.length > MAX_URL_LENGTH) return undefined
  // Whitespace and control characters inside a URL are either a paste accident
  // or an attempt to smuggle a second header; neither may reach `fetch`.
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return undefined
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  if (parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.hostname === '') return undefined
  return text
}

/**
 * Coerce a pasted token into a value that can travel in a query string, or
 * reject it.
 *
 * The token is percent-encoded when it is appended, so `&`, `/` and `+` are
 * harmless; what is refused is the shape of a mistake — empty, whitespace
 * inside, a control character, or a whole document pasted into the field.
 *
 * @param value - candidate token.
 * @returns the trimmed token, or `undefined` when it is not acceptable.
 */
export function normalizeToken(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '' || text.length > MAX_TOKEN_LENGTH) return undefined
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return undefined
  return text
}

/**
 * The URL's host without its path or query — the only form that may be shown
 * or logged, because the token lives in the query string.
 * @param url - a webhook URL.
 * @returns `scheme://host`, or a generic description when the URL is unusable.
 */
export function safeOrigin(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return 'the configured webhook URL'
  }
}

/**
 * Whether the URL already carries a token of its own.
 *
 * A single pasted webhook link usually looks like `…/hook?token=…`; the
 * settings page has to say "a token is set" for it even though the separate
 * field is empty, and the Host must not append a second parameter.
 */
export function urlCarriesToken(url) {
  try {
    return new URL(url).searchParams.has('token')
  } catch {
    return false
  }
}

/**
 * The address to `POST` to: the stored URL, with the stored token appended as
 * the `token` query parameter when there is one.
 *
 * `URLSearchParams.set` percent-encodes the value and replaces an existing
 * `token` parameter, so a pasted URL that already had one is not sent with two.
 *
 * @param baseUrl - the stored address, with or without its own token.
 * @param token - the separately stored token, if any.
 * @returns the request URL, or `undefined` when the address is unusable.
 */
export function composeWebhookUrl(baseUrl, token) {
  const base = normalizeWebhookUrl(baseUrl)
  if (base === undefined) return undefined
  if (typeof token !== 'string' || token === '') return base
  try {
    const parsed = new URL(base)
    parsed.searchParams.set('token', token)
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * Split a pasted link into the address and the token it carries.
 *
 * A service often hands out one link with the token already inside, while this plugin
 * keeps the two apart so the settings page can show the address. Splitting here
 * — on every write and on every read — means an old single-link record and a
 * new two-field one behave identically, and the address is never the value that
 * `describe()` would have to hide.
 *
 * A token that is not a usable token stays in the address: sending then still
 * works exactly as pasted, and the page keeps the field empty rather than
 * claiming a token it cannot vouch for.
 *
 * @param url - a URL, possibly with `?token=…`.
 * @returns the address without the token, and the token when one was recognised.
 */
export function splitToken(url) {
  const base = normalizeWebhookUrl(url)
  if (base === undefined) return { url: undefined, token: undefined }
  let parsed
  try {
    parsed = new URL(base)
  } catch {
    return { url: base, token: undefined }
  }
  const raw = parsed.searchParams.get('token')
  const token = normalizeToken(raw)
  if (raw === null || token === undefined) return { url: base, token: undefined }
  parsed.searchParams.delete('token')
  return { url: parsed.toString(), token }
}

/** The payload this plugin writes; read back defensively by {@link createWebhookStore}. */
function recordValues(record) {
  const payload = record?.kind === 'grant' ? record.payload : undefined
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { url: undefined, token: undefined }
  }
  const split = splitToken(payload.url)
  return {
    url: split.url,
    // A separate token wins over one left inside an old single-link record.
    token: normalizeToken(payload.token) ?? split.token,
  }
}

/**
 * The webhook store over `ctx.credentials`.
 *
 * `service` is a thunk, not the provider itself: the Host creates plugins
 * before every service is mounted, so the provider is looked up at the moment
 * it is used rather than captured at `apply` time.
 *
 * @param options.service - returns the credential provider, or `undefined` in a composition without one.
 * @param options.legacyUrl - `config.webhook.url` from the loader row, used only when no provider exists.
 * @param options.logger - Cordis logger; only key names and hosts ever reach it.
 */
export function createWebhookStore({ service, legacyUrl, logger } = {}) {
  const log = (level, message) => {
    try {
      logger?.[level]?.(`dsh-notify:webhook: ${message}`)
    } catch {
      /* a logging failure must never break settings */
    }
  }

  const provider = () => {
    try {
      return service?.()
    } catch {
      return undefined
    }
  }

  const legacy = normalizeWebhookUrl(legacyUrl)

  /** The stored values, or the profile's legacy URL when there is no store. */
  const read = async () => {
    const credentials = provider()
    if (credentials === undefined) {
      const split = splitToken(legacy)
      return { url: split.url, token: split.token }
    }
    return recordValues(await credentials.readRecord(WEBHOOK_RECORD_KEY))
  }

  /** The URL the channel should post to, or `undefined` when there is none. */
  const readUrl = async () => {
    const { url, token } = await read()
    return composeWebhookUrl(url, token)
  }

  /**
   * Replace the stored address and/or token. Values are validated here rather
   * than in the caller, so a malformed paste can never reach `fetch` through
   * any path.
   *
   * `token` is optional and `undefined` means "no separate token": the address
   * is then used as it was pasted, which is how a single link from a service —
   * token already inside — keeps working.
   *
   * @param values.url - the address, without the secret when the two are split.
   * @param values.token - the token to append to it, if the user entered one.
   * @throws when a value is unusable, or when this composition has no credential store.
   */
  const set = async ({ url: rawUrl, token: rawToken } = {}) => {
    const split = splitToken(rawUrl)
    if (split.url === undefined) {
      const error = new Error('the webhook URL must be an http(s) URL without embedded credentials')
      error.code = 'invalid-url'
      throw error
    }
    // A pasted link with the token inside is stored split: the address is what
    // the page shows, the token is what it never shows.
    let token = split.token
    if (rawToken !== undefined) {
      token = normalizeToken(rawToken)
      if (token === undefined) {
        const error = new Error('the webhook token must be a short string without whitespace')
        error.code = 'invalid-token'
        throw error
      }
    }
    const credentials = provider()
    if (credentials === undefined) {
      const error = new Error('this composition has no credential store, so the webhook cannot be saved')
      error.code = 'credentials-unavailable'
      throw error
    }
    const payload = token === undefined ? { url: split.url } : { url: split.url, token }
    await credentials.modifyRecord(WEBHOOK_RECORD_KEY, async () => ({ kind: 'grant', payload }))
    log('info', `webhook stored for ${safeOrigin(split.url)}${token === undefined ? '' : ' with a separate token'}`)
  }

  /** Forget the stored values; a no-op when nothing is stored. */
  const clear = async () => {
    const credentials = provider()
    if (credentials === undefined) {
      const error = new Error('this composition has no credential store, so the webhook cannot be removed')
      error.code = 'credentials-unavailable'
      throw error
    }
    await credentials.deleteRecord(WEBHOOK_RECORD_KEY)
    log('info', 'webhook removed from the credential store')
  }

  /**
   * What the settings page may know: whether an address exists, the address
   * itself, its host, whether a token travels with it, and whether this
   * composition can change it. Never the token.
   *
   * The address is returned on purpose — the page pre-fills its field with it,
   * so changing only the token does not start from an empty box — and it is
   * safe to return because a token is split out of it on every write and read.
   * The guard stays for the one case splitting cannot handle: a token-like
   * value that is not a usable token, which must not leak through the address
   * either.
   */
  const describe = async () => {
    const credentials = provider()
    if (credentials === undefined) {
      const split = splitToken(legacy)
      const safe = split.url !== undefined && !urlCarriesToken(split.url) ? split.url : undefined
      return {
        configured: split.url !== undefined,
        url: safe,
        host: split.url === undefined ? undefined : safeOrigin(split.url),
        source: split.url === undefined ? null : 'config',
        writable: false,
        token: split.token !== undefined,
        hasToken: split.token !== undefined,
      }
    }
    const { url, token } = recordValues(await credentials.readRecord(WEBHOOK_RECORD_KEY))
    const safe = url !== undefined && !urlCarriesToken(url) ? url : undefined
    return {
      configured: url !== undefined,
      url: safe,
      host: url === undefined ? undefined : safeOrigin(url),
      source: url === undefined ? null : 'credentials',
      writable: true,
      token: token !== undefined,
      hasToken: token !== undefined,
    }
  }

  /**
   * Move a URL from the profile's loader row into the store, once. This is the
   * upgrade path: an install that already had `webhook.url` in
   * `cordis.patch.yml` keeps its channel without the user re-pasting anything.
   * The imported URL keeps its own token in the query.
   *
   * @returns whether a record was written.
   */
  const importLegacy = async () => {
    if (legacy === undefined) return false
    const credentials = provider()
    if (credentials === undefined) return false
    const existing = recordValues(await credentials.readRecord(WEBHOOK_RECORD_KEY)).url
    if (existing !== undefined) return false
    const split = splitToken(legacy)
    const payload = split.token === undefined ? { url: split.url } : { url: split.url, token: split.token }
    await credentials.modifyRecord(WEBHOOK_RECORD_KEY, async () => ({ kind: 'grant', payload }))
    log('info', `webhook URL imported into the credential store for ${safeOrigin(legacy)}; the profile field is no longer read`)
    return true
  }

  return { read, readUrl, set, clear, describe, importLegacy, key: WEBHOOK_RECORD_KEY }
}

