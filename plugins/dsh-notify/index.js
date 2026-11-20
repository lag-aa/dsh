/**
 * dsh-notify — Host half.
 *
 * The Host cannot raise an OS toast: a profile plugin has no Electron API, and
 * the new Desktop shell never renders `Notification` from the main process for
 * anything but its own mandatory-update notice. So this half only *collects*
 * what is worth telling the user about and serves it over one same-origin
 * route; the Web half (`./client.js`) turns each frame into a real browser
 * `Notification`, which the shell surfaces as a Windows toast.
 *
 * Sources watched here: the durable `session/event` feed — turn end, approval
 * asks, `ask_user_question` calls, and schedule deliveries. `agent/error` is
 * deliberately not subscribed: the same failure already closes the turn with
 * `reason.kind === 'error'`, and listening to both would toast every failure
 * twice.
 *
 * A turn ending is *not* the request being answered. A conversation can finish
 * a turn while a background job or a subagent keeps working, and either one
 * wakes it again for another turn — the `wakeup` completion delivery a settled
 * job uses is exactly that. Announcing every `turn/end` therefore reports
 * pauses as if they were endings. So a finished turn only arms a check, and
 * the frame is released once the whole conversation tree is quiet: no running
 * turn, no queued wake-up, no live child agent, no live background job. That
 * check is what `job/settled` and `agent/status` are consumed for — as inputs
 * to the question "is it over?", never as notifications of their own.
 *
 * @module dsh-notify
 */

import { createChannel as createWebhookChannel } from './webhook.js'
import { createSettingsStore, isQuiet } from './settings.js'
import { createWebhookStore, normalizeToken, normalizeWebhookUrl } from './credentials.js'

/** Unique, filesystem-safe prefix; the numeric suffix keeps it out of other plugins' way. */
const ROUTE_PREFIX = '/dsh-notify-8261'

/** Newest frames kept for a reconnecting client; older ones are simply dropped. */
const MAX_FRAMES = 40

/** Longest a `pending` request is held open while the queue stays empty. */
const MAX_WAIT_MS = 5000

/** One client may not page through more history than this in one response. */
const MAX_PAGE = 20

/**
 * How long a finished turn waits for a follow-up `turn/start` before the
 * conversation is examined at all. A goal round or a queued message starts the
 * next turn almost immediately; announcing the pause between them is noise.
 */
const TURN_SETTLE_MS = 1500

/**
 * How long after a wake-up trigger the conversation tree is examined again.
 * A settled job records `job/settled` *before* it wakes its owner, so checking
 * synchronously would see a job that already finished, an owner that has not
 * started yet, and would call the work done one instant too early.
 */
const WAKE_GRACE_MS = 1200

/** How often a conversation still busy in the background is re-examined. */
const WORK_RECHECK_MS = 2000

/** The tool whose call means the model is blocked waiting for a human choice. */
const USER_QUESTION_TOOL = 'ask_user_question'

export const name = 'dsh-notify'

/**
 * `webServer`/`connection` serve the queue. The two registries are what make
 * "the request is finished" answerable at all: `agents` reports live child
 * conversations and whether a turn is still running, `jobs` reports background
 * work that outlives the turn that started it. Both are optional in the
 * harness, so they are read through `ctx.get` and the plugin degrades to
 * per-turn announcements when they are absent.
 */
export const inject = ['webServer', 'connection']

/** Longest body a toast keeps; Windows truncates far later, but keep frames small. */
const BODY_LIMIT = 300

/**
 * Longest heading a frame carries — a question's `header`, which names the
 * topic where its `question` explains it at length.
 */
const LABEL_LIMIT = 100

/** Longest explanation kept after a short verdict ("нужен доступ…", model message). */
const NOTE_LIMIT = 150

function truncate(value, limit = BODY_LIMIT) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return undefined
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Collapse a multi-line blob into its first meaningful line. */
function firstLine(value, limit = LABEL_LIMIT) {
  const text = typeof value === 'string' ? value : ''
  if (text.trim() === '') return undefined
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+/g, ' ').trim()
    if (trimmed !== '') return truncate(trimmed, limit)
  }
  return undefined
}

/**
 * Split an approval reason into its machine prefix and the human explanation
 * behind it. Every one of the 519 approval asks in this profile's logs opens
 * with one of two `escalate sandbox to …` prefixes, which say nothing a person
 * needs; what follows them is the actual justification.
 */
function parseApprovalReason(reason) {
  const text = typeof reason === 'string' ? reason : ''
  const match = /^escalate sandbox to (danger-full-access|workspace-write)\s*:\s*([\s\S]*)$/i.exec(
    text.trim(),
  )
  if (match === null) {
    const note = firstLine(text, NOTE_LIMIT)
    return note === undefined ? {} : { note }
  }
  const access = match[1].toLowerCase() === 'workspace-write' ? 'write' : 'full'
  const note = firstLine(match[2], NOTE_LIMIT)
  return note === undefined ? { access } : { access, note }
}

/** A model failure code means more to a human than the adapter's raw message. */
function failureCode(error) {
  const code = error?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/**
 * Skip sessions nobody is looking at: subagent runs report through their
 * parent's conversation, and a toast per child turn would bury the real one.
 */
function shouldNotifySession(session) {
  const header = session?.header
  if (!header || typeof header !== 'object') return true
  if (header.origin === 'subagent') return false
  const depth = header.delegationDepth
  if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return false
  return true
}

/** The durable session id of the session an event came from. */
function sessionIdOf(session) {
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** `turn/end` reasons worth a toast; `aborted`/`interrupted`/`forked` are user-visible already. */
function turnEndKind(reasonKind) {
  if (reasonKind === 'completed') return 'turn-completed'
  if (reasonKind === 'error') return 'turn-error'
  if (reasonKind === 'max-tokens') return 'turn-truncated'
  return null
}

/**
 * Pull a short, readable summary out of an `ask_user_question` tool call. Each
 * question carries a terse `header` ("Объём новых карточек") and a long
 * multi-sentence `question`; the header is what belongs in a toast, with the
 * question body only as a fallback.
 */
function parseQuestion(args) {
  let parsed = args
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return undefined
    }
  }
  const questions = parsed?.questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const first = questions[0]
  if (typeof first === 'string') {
    const text = firstLine(first, NOTE_LIMIT)
    return text === undefined ? undefined : { title: text }
  }
  const title = firstLine(first?.header, LABEL_LIMIT)
  const detail = firstLine(first?.question, NOTE_LIMIT)
  const facts = {}
  if (title !== undefined) facts.title = title
  if (detail !== undefined && detail !== title) facts.detail = detail
  const count = Array.isArray(parsed.questions) ? parsed.questions.length : 0
  if (count > 1) facts.count = count
  return Object.keys(facts).length === 0 ? undefined : facts
}

/** Read the text of a `user/message` that arrived from a schedule. */
function scheduleText(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block?.type === 'text') {
      const text = firstLine(block.text, NOTE_LIMIT)
      if (text !== undefined) return text
    }
  }
  return undefined
}

/** Flatten a failed model call into one readable line. */
function errorMessage(error) {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return firstLine(error, NOTE_LIMIT)
  if (error instanceof Error) return firstLine(error.message, NOTE_LIMIT)
  const message = error.message ?? error.detail ?? error.error
  return firstLine(typeof message === 'string' ? message : String(error), NOTE_LIMIT)
}

export function apply(ctx, config) {
  /** Ordered frames waiting for a client; `seq` is the client's cursor. */
  const frames = []
  /** Pending long-poll resolvers: each is called once when new work lands. */
  const waiters = new Set()
  /** Monotonic frame counter — the value a client sends back as `since`. */
  let seq = 0

  /** Session display name, shared by every delivery channel. */
  const resolveTitle = (sessionId) => {
    const query = serviceOf('sessionQuery')
    const title = query?.readTitle?.(sessionId)
    return Promise.resolve(title)
      .then((snap) => (typeof snap?.title === 'string' && snap.title !== '' ? snap.title : undefined))
      .catch(() => undefined)
  }

  /**
   * The user's own switches for the webhook channel: mode and quiet hours.
   * Kept in `$DSH_HOME/dsh-notify/settings.json` (see `settings.js`) so a click
   * in Settings never rewrites the profile. Loaded before the channel is built,
   * so the very first frame already respects it.
   */
  const settings = createSettingsStore({ logger: ctx.logger, statePath: config?.statePath })

  /**
   * The webhook URL — the part of this channel that is a secret. It lives in
   * the credential store, not in configuration and not on disk in this package
   * (`credentials.js` owns the record and the "is it set?" answer).
   *
   * `config.webhook.url` is still read in exactly one case: a composition with
   * no credential store, where the settings page has nowhere to write. In the
   * normal case the first boot imports the profile value into the store and the
   * profile line stops being read.
   */
  const webhookStore = createWebhookStore({
    service: () => serviceOf('credentials'),
    legacyUrl: config?.webhook?.url,
    logger: ctx.logger,
  })

  /**
   * Second recipient: a webhook that carries the same verdict elsewhere. One
   * `POST` per frame to the address the user configured; no subscribers, no
   * polling. A pure side path — `deliver` never throws and never delays the
   * local toast. `maySend` carries the user's switch and quiet hours, and
   * `resolveUrl` the stored URL, both evaluated per frame.
   */
  const webhook = createWebhookChannel({
    logger: ctx.logger,
    resolveTitle,
    maySend: () => settings.allows(),
    resolveUrl: () => webhookStore.readUrl(),
    markdown: () => settings.get().webhook.markdown,
    timeoutMs: config?.webhook?.timeoutMs,
    trustSystemCa: config?.webhook?.trustSystemCa,
  })

  /**
   * One-time upgrade from the profile's loader row: move a URL stored there into
   * the credential store and remember that it happened.
   *
   * The flag is what makes the removal stick: the loader row keeps its old
   * `webhook.url` until the user edits the profile, so without it a URL cleared
   * in Settings would be imported again on the next boot.
   */
  const adoptLegacyUrl = async () => {
    if (!settings.loaded()) await settings.load()
    if (settings.get().webhook.imported === true) return
    try {
      await webhookStore.importLegacy()
    } catch (error) {
      ctx.logger?.warn?.(`dsh-notify: webhook URL migration failed: ${String(error)}`)
      return
    }
    await settings.update({ webhook: { imported: true } })
  }

  const wakeWaiters = () => {
    if (waiters.size === 0) return
    const pending = [...waiters]
    waiters.clear()
    for (const wake of pending) wake()
  }

  /** Append one frame and release every held request. */
  const push = (frame) => {
    seq += 1
    frames.push({ seq, at: Date.now(), ...frame })
    if (frames.length > MAX_FRAMES) frames.splice(0, frames.length - MAX_FRAMES)
    wakeWaiters()
    // The webhook sees the same verdict, one instant later. Fire-and-forget.
    webhook.deliver(frame)
    return seq
  }

  /** Hold a request until a frame arrives, the timeout expires, or the client goes away. */
  const waitForFrame = (since, timeoutMs, signal) =>
    new Promise((resolve) => {
      if (seq > since || timeoutMs <= 0 || signal?.aborted === true) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(finish)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      waiters.add(finish)
      signal?.addEventListener('abort', finish, { once: true })
    })

  /** Per-session ending waiting for the conversation to stop working. */
  const endings = new Map()

  /**
   * Optional harness registries. Reading them through `ctx.get` keeps this
   * plugin loadable in a composition that has neither, where it degrades to
   * announcing every finished turn.
   */
  const serviceOf = (key) => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }

  /**
   * Whether every worker behind one conversation has stopped.
   *
   * A turn ending proves only that the model stopped talking. Three separate
   * things keep working afterwards, and each one produces another turn: the
   * input a completion delivery queued for this conversation, child
   * conversations running their own turns, and background jobs still
   * registered. `wakeup` delivery is the default for a settled job, so a
   * running job is not a side note — it is unfinished work the user asked for.
   */
  const isQuiet = (sessionId) => {
    const agents = serviceOf('agents')
    const agent = agents?.get?.(sessionId)
    if (agent?.status === 'running') return false
    // Queued input is a turn already owed to this conversation.
    try {
      if (agent?.inbox?.hasPending === true) return false
    } catch {
      /* an inbox shape change must not silence notifications */
    }
    let live = []
    try {
      const listed = agents?.list?.()
      if (Array.isArray(listed)) live = listed
    } catch {
      /* same: absence of the registry is not evidence of quiet */
    }
    for (const other of live) {
      if (other?.id === sessionId || agent === undefined) continue
      try {
        // Runtime ownership, not durable lineage: a detached child that keeps
        // running is exactly the case this check exists for.
        if (agents?.isOwnedBy?.(other.id, agent) === true) return false
      } catch {
        /* ownership is a hint here, never authorization */
      }
    }
    const jobs = serviceOf('jobs')
    try {
      const owned = jobs?.list?.(sessionId)
      if (Array.isArray(owned)) {
        for (const job of owned) {
          if (job?.status === 'running' || job?.status === 'stopping') return false
        }
      }
    } catch {
      /* an unreadable registry leaves the turn-end announcement in place */
    }
    return true
  }

  /** Replace the pending quiet-check for one conversation. */
  const scheduleCheck = (sessionId, delay) => {
    const ending = endings.get(sessionId)
    if (ending === undefined) return
    if (ending.timer !== undefined) clearTimeout(ending.timer)
    const timer = setTimeout(() => {
      const current = endings.get(sessionId)
      if (current === undefined) return
      current.timer = undefined
      let quiet
      try {
        quiet = isQuiet(sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-notify: quiet check failed for ${sessionId}: ${String(error)}`)
        quiet = true
      }
      // Still working: the ending outlives every trigger, so poll until the
      // whole tree stops rather than giving up on the first busy answer.
      if (!quiet) {
        scheduleCheck(sessionId, WORK_RECHECK_MS)
        return
      }
      endings.delete(sessionId)
      push(current.frame)
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    ending.timer = timer
  }

  const clearEnding = (sessionId) => {
    const ending = endings.get(sessionId)
    if (ending === undefined) return
    if (ending.timer !== undefined) clearTimeout(ending.timer)
    endings.delete(sessionId)
  }

  /** Stop checking without forgetting the ending: the work is running again. */
  const holdEnding = (sessionId) => {
    const ending = endings.get(sessionId)
    if (ending === undefined || ending.timer === undefined) return
    clearTimeout(ending.timer)
    ending.timer = undefined
  }

  /**
   * A finished turn is a claim about the request, not about the model. Hold the
   * frame until the conversation is quiet.
   */
  const noteTurnEnd = (frame) => {
    const sessionId = frame.sessionId
    if (sessionId === undefined) {
      push(frame)
      return
    }
    const existing = endings.get(sessionId)
    if (existing === undefined) endings.set(sessionId, { frame, timer: undefined })
    else existing.frame = frame
    scheduleCheck(sessionId, TURN_SETTLE_MS)
  }

  /**
   * Re-examine a pending ending after something that may have restarted the
   * conversation. The grace period is not politeness: a settled job records
   * `job/settled` before it wakes its owner, so checking now would see the job
   * finished and the owner not yet running.
   */
  const nudgeEnding = (sessionId) => {
    if (endings.has(sessionId)) scheduleCheck(sessionId, WAKE_GRACE_MS)
  }

  /** Reduce one committed session event to at most one notify frame. */
  const reduceSessionEvent = (session, event) => {
    const type = event?.type
    if (type === undefined) return null
    const sessionId = sessionIdOf(session)

    if (type === 'turn/start') {
      if (sessionId !== undefined) {
        // A new turn means the previous ending was a pause, not an ending; the
        // turn that just started will produce its own `turn/end` later.
        clearEnding(sessionId)
      }
      return null
    }

    if (type === 'turn/end') {
      const reason = event.data?.reason
      const kind = turnEndKind(reason?.kind)
      if (kind === null) return null
      const frame = { kind, sessionId }
      if (kind === 'turn-error') {
        const code = failureCode(reason?.error)
        if (code !== undefined) frame.code = code
        const message = errorMessage(reason?.error)
        if (message !== undefined) frame.detail = message
      }
      return frame
    }

    if (type === 'approval/asked') {
      const data = event.data ?? {}
      const frame = { kind: 'approval', sessionId }
      if (typeof data.toolName === 'string' && data.toolName !== '') frame.tool = data.toolName
      const parsed = parseApprovalReason(data.reason)
      if (parsed.access !== undefined) frame.access = parsed.access
      if (parsed.note !== undefined) frame.note = parsed.note
      return frame
    }

    if (type === 'tool/call') {
      if (String(event.data?.name ?? '') !== USER_QUESTION_TOOL) return null
      const parsed = parseQuestion(event.data?.arguments)
      if (parsed === undefined) return null
      return { kind: 'question', sessionId, ...parsed }
    }

    if (type === 'user/message') {
      const source = event.data?.source
      if (source?.kind !== 'schedule') return null
      const text = scheduleText(event)
      return text === undefined ? { kind: 'schedule', sessionId } : { kind: 'schedule', sessionId, note: text }
    }

    if (type === 'job/settled') {
      // A settled job is progress, not an answer. Its own `wakeup` delivery
      // starts the next turn of the conversation that owns it, so the only
      // thing to do here is reconsider a conversation already waiting to be
      // declared finished.
      const data = event.data ?? {}
      if (data.cause === 'teardown' || data.status === 'running') return null
      const owner = typeof data.owner === 'string' && data.owner !== '' ? data.owner : undefined
      if (owner !== undefined) nudgeEnding(owner)
      return null
    }

    return null
  }

  ctx.effect(() => {
    // Read the persisted switches before any frame can arrive, so the first
    // notification after a restart already obeys them. The legacy URL import
    // waits for that read: it records its own outcome in the same file.
    settings.load()
      .catch((error) => {
        ctx.logger?.warn?.(`dsh-notify: settings load failed: ${String(error)}`)
      })
      .then(() => adoptLegacyUrl())
      .catch((error) => {
        ctx.logger?.warn?.(`dsh-notify: webhook URL migration failed: ${String(error)}`)
      })

    const offSession = ctx.on('session/event', (session, event) => {
      if (!shouldNotifySession(session)) return
      let frame
      try {
        frame = reduceSessionEvent(session, event)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-notify: failed to reduce ${String(event?.type)}: ${String(error)}`)
        return
      }
      if (frame === null) return
      if (frame.kind === 'turn-completed' || frame.kind === 'turn-error' || frame.kind === 'turn-truncated') {
        noteTurnEnd(frame)
        return
      }
      push(frame)
    })

    // Going idle is the harness's own answer to "does this conversation still
    // have work?", so it is the most reliable trigger there is — a job waking
    // its owner flips exactly this. Both directions matter: `idle` may mean the
    // work really finished, `running` cancels a check that would be premature.
    const offStatus = ctx.on('agent/status', (payload) => {
      const sessionId = payload?.agent?.id
      if (typeof sessionId !== 'string' || !endings.has(sessionId)) return
      if (!shouldNotifySession(serviceOf('sessions')?.get?.(sessionId))) return
      if (payload?.status === 'idle') scheduleCheck(sessionId, WAKE_GRACE_MS)
      else holdEnding(sessionId)
    })

    return () => {
      offSession()
      offStatus?.()
      for (const ending of endings.values()) {
        if (ending.timer !== undefined) clearTimeout(ending.timer)
      }
      endings.clear()
      webhook.close()
    }
  }, 'dsh-notify: notification sources')

  const sendJson = (res, status, obj) => {
    if (res.destroyed || res.writableEnded) return
    const payload = JSON.stringify(obj)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /**
   * Read a small JSON body. `undefined` means "not a JSON object", which the
   * caller turns into a 400: the settings file is the user's own state, so a
   * malformed write must be refused rather than coerced.
   */
  const readJsonBody = (req) =>
    new Promise((resolve) => {
      let size = 0
      const chunks = []
      const done = (value) => resolve(value)
      req.on('data', (chunk) => {
        size += chunk.length
        // A settings patch is a few hundred bytes; anything larger is a mistake.
        if (size > 64 * 1024) {
          done(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('error', () => done(undefined))
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        try {
          const parsed = JSON.parse(text)
          done(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined)
        } catch {
          done(undefined)
        }
      })
    })

  const handle = async (req, res, signal) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
    const method = req.method ?? 'GET'

    // The settings page reads and writes; everything else in this route is a
    // read-only view of the frame queue.

    /**
     * What the settings page may know about the webhook: whether an address is
     * stored, the address itself (the field is masked and pre-filled with it),
     * which host it points at, and whether it can be replaced here. Never the
     * token — it is split out of the address on every read.
     */
    const webhookView = async () => {
      try {
        return await webhookStore.describe()
      } catch (error) {
        return { configured: false, writable: false, error: `could not read the credential store: ${String(error)}` }
      }
    }

    if (rest === 'settings') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      // Opening the page is the right moment to finish an upgrade: a URL left
      // in the profile's loader row moves into the store before the page is
      // answered, so the page never reports "not configured" for a channel that
      // is about to start sending.
      try {
        await adoptLegacyUrl()
      } catch (error) {
        ctx.logger?.warn?.(`dsh-notify: webhook URL migration failed: ${String(error)}`)
      }
      sendJson(res, 200, {
        settings: settings.get(),
        // The page cannot compute the window itself without trusting the
        // browser clock, so the Host says what it thinks right now.
        quiet: isQuiet(settings.get().quietHours),
        // The toast is raised in the browser, but whether it should exist at
        // all is a Host decision: `mode` belongs to the same file as the rest.
        toastMuted: settings.toastMuted(),
        webhook: await webhookView(),
        path: settings.path,
      })
      return
    }

    if (rest === 'config') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const patch = await readJsonBody(req)
      if (patch === undefined) {
        sendJson(res, 400, { error: 'body must be a JSON object' })
        return
      }
      // The `webhook` block mixes secrets with an ordinary switch: the address
      // and the token go to the credential store, `markdown` to the settings
      // file. Both values are validated before anything is saved, so a bad
      // paste cannot leave the file half-updated.
      //
      // An empty field means "leave it as it is": both inputs are write-only,
      // so a person changing only the token would otherwise have to re-paste
      // the address. Removing the webhook altogether is the explicit `clear`.
      const webhookPatch =
        patch.webhook !== null && typeof patch.webhook === 'object' && !Array.isArray(patch.webhook)
          ? patch.webhook
          : undefined
      const urlDraft = typeof webhookPatch?.url === 'string' ? webhookPatch.url.trim() : undefined
      const tokenDraft = typeof webhookPatch?.token === 'string' ? webhookPatch.token.trim() : undefined
      if (urlDraft !== undefined && urlDraft !== '' && normalizeWebhookUrl(urlDraft) === undefined) {
        sendJson(res, 400, { error: 'invalid-url', detail: 'the webhook URL must be an http(s) URL without embedded credentials' })
        return
      }
      if (tokenDraft !== undefined && tokenDraft !== '' && normalizeToken(tokenDraft) === undefined) {
        sendJson(res, 400, { error: 'invalid-token', detail: 'the webhook token must be a short string without whitespace' })
        return
      }
      const { settings: next, persisted } = await settings.update({
        mode: patch.mode,
        quietHours: patch.quietHours,
        webhook: typeof webhookPatch?.markdown === 'boolean' ? { markdown: webhookPatch.markdown } : undefined,
      })
      if (!persisted) {
        sendJson(res, 500, { error: 'could not save the settings file', settings: next })
        return
      }
      try {
        if (webhookPatch?.clear === true) {
          await webhookStore.clear()
        } else if (urlDraft !== undefined || tokenDraft !== undefined) {
          const current = await webhookStore.read()
          const address = urlDraft === undefined || urlDraft === '' ? current.url : urlDraft
          if (address === undefined) {
            sendJson(res, 400, { error: 'missing-url', detail: 'enter the webhook URL before saving a token' })
            return
          }
          const token = tokenDraft === undefined || tokenDraft === '' ? current.token : tokenDraft
          await webhookStore.set({ url: address, token })
        }
      } catch (error) {
        const status = error?.code === 'credentials-unavailable' ? 503 : 500
        sendJson(res, status, { error: error?.code ?? 'webhook-store-failed', detail: String(error?.message ?? error) })
        return
      }
      sendJson(res, 200, { settings: next, quiet: isQuiet(next.quietHours), webhook: await webhookView() })
      return
    }

    if (rest === 'webhook/test') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      // The answer is a status the page shows, not an error: a dead endpoint is
      // exactly what this button exists to reveal.
      sendJson(res, 200, await webhook.test())
      return
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    if (rest === 'ping') {
      // `clientPath` is how a human confirms the Web half is composed into the
      // boot graph; a `null` here means `dsh.client` was not picked up.
      let clientPath
      try {
        clientPath = ctx.get('clientModules')?.clientPath?.('dsh-notify') ?? null
      } catch {
        clientPath = null
      }
      sendJson(res, 200, {
        ok: true,
        frames: frames.length,
        counter: seq,
        wait: MAX_WAIT_MS,
        clientPath,
        // `mode` is read on every poll: the user may switch it while the page
        // is open, and the Web half must react without a reload.
        mode: settings.get().mode,
        toastMuted: settings.toastMuted(),
      })
      return
    }

    if (rest === 'pending') {
      const rawSince = Number(url.searchParams.get('since') ?? '0')
      const since = Number.isFinite(rawSince) && rawSince >= 0 ? Math.floor(rawSince) : 0
      const rawWait = Number(url.searchParams.get('wait') ?? String(MAX_WAIT_MS))
      const wait = Number.isFinite(rawWait) ? Math.min(Math.max(Math.floor(rawWait), 0), MAX_WAIT_MS) : MAX_WAIT_MS
      await waitForFrame(since, wait, signal)
      if (signal.aborted) return
      const page = frames.filter((frame) => frame.seq > since).slice(-MAX_PAGE)
      sendJson(res, 200, { counter: seq, frames: page })
      return
    }

    sendJson(res, 404, { error: `unknown dsh-notify path: /${rest}` })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (ctx.connection.requestRejection(req) !== undefined) {
            sendJson(res, 403, { error: 'forbidden' })
            return
          }
          const abort = new AbortController()
          const onClose = () => abort.abort()
          res.on('close', onClose)
          try {
            await handle(req, res, abort.signal)
          } catch (error) {
            if (!abort.signal.aborted && !res.writableEnded) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          } finally {
            res.off('close', onClose)
            abort.abort()
          }
        },
      }),
    'dsh-notify: state route',
  )
}



