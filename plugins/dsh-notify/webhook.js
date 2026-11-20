/**
 * dsh-notify — the webhook delivery channel.
 *
 * A second recipient for the same frames the toast carries: the conversation
 * finishes, asks for permission, or needs an answer. There is no subscriber
 * bookkeeping and no polling: the user pastes one address, and every frame
 * becomes a single `POST {"text": …}` to it. The receiving service applies its
 * own template and renders the result the way it likes — markdown by default.
 *
 * Two details come straight from that contract and are easy to get wrong:
 *
 *   - `Content-Type` must be `application/json; charset=utf-8`, otherwise
 *     Cyrillic arrives mangled;
 *   - the token lives in the query string of the URL, so the URL itself is a
 *     secret and must never reach a log line or an error message. Only
 *     `safeOrigin()` — `scheme://host` — is ever printed.
 *
 * Where the URL comes from is not this module's business: it is passed in as
 * `resolveUrl`, which the Host answers from the credential store, so replacing
 * the URL in Settings applies to the next frame without a restart. `resolveUrl`
 * returns `undefined` for "no webhook configured", which is the normal state of
 * an install that only wants Windows toasts.
 *
 * TLS: an internal endpoint may sit behind a corporate CA that is in the
 * Windows certificate store but not in Node's bundled root set, so a plain
 * `fetch` fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Node 24 can merge the
 * system store into the default trust set at runtime, which is exactly what the
 * corporate `--use-system-ca` guidance does; we do it once, guarded, and only
 * when a frame is actually about to be sent.
 *
 * Delivery is fire-and-forget and fail-isolated: a dead endpoint produces one
 * logged warning and never touches the local toast.
 */

import { getCACertificates, setDefaultCACertificates } from 'node:tls'

import { composeText } from './compose.js'

/** A webhook call must not hang the process. */
const CALL_TIMEOUT_MS = 15_000

/** The usual receiver limit is ~4000 characters; stay clear of the edge. */
const TEXT_LIMIT = 3_800

/** The title of the "send a test" message, and the line under it. */
const TEST_TITLE = 'Проверка связи'
const TEST_BODY = 'Уведомления dsh-notify доходят до этого вебхука.'

/**
 * The test message, shaped like a real one: a title line, then a body.
 *
 * The title is bold exactly when the verdict line of a real frame would be, so
 * the "check" button answers the other question a person has — whether the
 * receiver renders `**…**` — without waiting for a real turn to finish.
 */
export function composeTestText({ markdown } = {}) {
  const title = markdown !== false ? `**${TEST_TITLE}**` : TEST_TITLE
  return `${title}\n${TEST_BODY}`
}

/**
 * Merge the OS certificate store into Node's default trust set, once per
 * process. Node 24 exposes this as `tls.getCACertificates` /
 * `tls.setDefaultCACertificates`; on an older runtime the calls are simply
 * absent and we leave the default set alone (the request then fails and warns,
 * which is better than silently disabling verification).
 */
let systemCaApplied = false
function ensureSystemCa(log) {
  if (systemCaApplied) return
  systemCaApplied = true
  try {
    if (typeof getCACertificates !== 'function' || typeof setDefaultCACertificates !== 'function') {
      log('warn', 'runtime cannot merge the system CA store; an internal TLS endpoint may be rejected')
      return
    }
    const defaults = getCACertificates('default')
    const system = getCACertificates('system')
    if (!Array.isArray(system) || system.length === 0) {
      log('warn', 'the system CA store is empty; an internal TLS endpoint may be rejected')
      return
    }
    setDefaultCACertificates([...defaults, ...system])
    log('info', `trust set extended with ${system.length} system CA certificate(s)`)
  } catch (error) {
    log('warn', `could not extend the trust set with the system CA store: ${String(error)}`)
  }
}

/**
 * Host part of a URL, for log lines and the settings page that must not carry
 * the token.
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
 * Build the webhook channel. Every collaborator is a thunk, so the channel
 * never caches an answer the user may have changed since:
 *
 *   - `resolveUrl` — the current URL, or `undefined`; read per frame.
 *   - `maySend` — the user's day-to-day switch (channel off, quiet hours).
 *   - `resolveTitle` — session id to display name.
 *   - `markdown` — whether the verdict line may carry `**…**`; a boolean or a
 *     getter, because the settings page can flip it while the process runs.
 *
 * Every method is safe to call when the network, the credential store, or the
 * configuration is broken: a failure is one logged warning, never a throw.
 */
export function createChannel({ resolveUrl, maySend, resolveTitle, markdown, timeoutMs, trustSystemCa, logger } = {}) {
  const log = (level, message) => {
    try {
      logger?.[level]?.(`dsh-notify:webhook: ${message}`)
    } catch {
      /* a logging failure must never break delivery */
    }
  }

  const limit =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(1_000, Math.floor(timeoutMs))
      : CALL_TIMEOUT_MS

  /** `false` disables merging the OS trust set for an endpoint with a public CA. */
  const usesSystemCa = trustSystemCa !== false

  /** Whether a verdict line is bold; a getter keeps the live settings answer. */
  const wantsMarkdown = () => (typeof markdown === 'function' ? markdown() !== false : markdown !== false)

  let closed = false
  let lastError = undefined
  /** One warning per process for the ordinary "nobody configured a webhook" state. */
  let warnedMissingUrl = false
  /** Serializes sends so a burst of frames cannot interleave requests. */
  let chain = Promise.resolve()

  /** The current URL, with the "silently absent" case folded into `undefined`. */
  const currentUrl = async () => {
    if (resolveUrl === undefined) return undefined
    const url = await resolveUrl()
    return typeof url === 'string' && url.trim() !== '' ? url.trim() : undefined
  }

  /**
   * One POST, its result kept for both the log and the "send a test" answer.
   * @returns `{ ok: true }` or `{ ok: false, error }`; the error never contains the URL.
   */
  const post = async (url, text) => {
    const origin = safeOrigin(url)
    if (usesSystemCa) ensureSystemCa(log)
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(limit),
      })
    } catch (error) {
      const message = `POST ${origin}: ${String(error?.cause?.code ?? error)}`
      lastError = message
      log('warn', message)
      return { ok: false, error: message }
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 160)
      } catch {
        /* the status alone is enough */
      }
      const message = `POST ${origin} → ${response.status}${detail === '' ? '' : `: ${detail}`}`
      lastError = message
      log('warn', message)
      return { ok: false, error: message }
    }
    // A successful delivery drains the body so the socket can be reused.
    try {
      await response.text()
    } catch {
      /* nothing else to do */
    }
    lastError = undefined
    return { ok: true, host: origin }
  }

  /**
   * The one entry point the Host calls per frame. Synchronous fire-and-forget:
   * it never throws and never blocks the toast path. Unknown frame kinds are
   * dropped without resolving a title or touching the network.
   *
   * `maySend` and the URL are consulted per frame rather than once at build
   * time: the user flips the channel off (or the clock enters quiet hours)
   * while the process keeps running, and a frame queued behind the chain must
   * respect the answer at the moment it would actually be sent.
   */
  const deliver = (frame) => {
    if (closed) return
    try {
      if (composeText(frame) === undefined) return
    } catch {
      return
    }
    const sessionId = typeof frame?.sessionId === 'string' ? frame.sessionId : undefined
    chain = chain
      .then(async () => {
        if (closed) return
        let allowed
        try {
          allowed = maySend === undefined || maySend()
        } catch (error) {
          log('warn', `permission check failed: ${String(error)}`)
          return
        }
        if (!allowed) return
        let url
        try {
          url = await currentUrl()
        } catch (error) {
          log('warn', `could not read the webhook URL: ${String(error)}`)
          return
        }
        if (url === undefined) {
          if (!warnedMissingUrl) {
            warnedMissingUrl = true
            log('warn', 'no webhook URL is configured; the webhook channel stays silent until one is set in Settings')
          }
          return
        }
        let title
        try {
          title = sessionId !== undefined ? await resolveTitle?.(sessionId) : undefined
        } catch (error) {
          log('warn', `title lookup failed for ${sessionId}: ${String(error)}`)
        }
        let text
        try {
          text = composeText(frame, title, { markdown: wantsMarkdown() })
        } catch (error) {
          log('warn', `composeText failed: ${String(error)}`)
          return
        }
        if (text === undefined) return
        await post(url, text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text)
      })
      .catch((error) => log('warn', `deliver failed: ${String(error)}`))
  }

  /**
   * Send one fixed message to the URL that is configured right now — the
   * settings page's "check" button. Unlike `deliver` it reports the outcome
   * instead of only logging it, because a person is waiting for the answer.
   *
   * The message carries a title that is bold under the same switch as a real
   * verdict, so the button checks the markdown rendering too.
   *
   * @returns `{ ok: true, host }`, or `{ ok: false, error }` where `error` is
   *   `not-configured` / the masked transport error.
   */
  const test = async () => {
    let url
    try {
      url = await currentUrl()
    } catch (error) {
      return { ok: false, error: `could not read the webhook URL: ${String(error)}` }
    }
    if (url === undefined) return { ok: false, error: 'not-configured' }
    return post(url, composeTestText({ markdown: wantsMarkdown() }))
  }

  return {
    deliver,
    test,
    lastError: () => lastError,
    close: () => {
      closed = true
    },
  }
}


