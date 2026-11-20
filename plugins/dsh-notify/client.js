/**
 * dsh-notify — Web half.
 *
 * The Host half only queues what is worth announcing; this half raises the
 * actual OS notification through the renderer's `Notification` API, which the
 * Desktop shell is free to surface as a Windows toast. One frame in, at most
 * one toast out, and a click jumps back to the session it came from.
 *
 * @module dsh-notify/client
 */

;(() => {
  const ROUTE_PREFIX = '/dsh-notify-8261'
  const NS = 'dsh-notify'

  /** How long one poll asks the Host to hold the request open. */
  const WAIT_MS = 5000
  /** Pause after a failed poll before retrying, so a dead Host is not hammered. */
  const RETRY_MS = 2000
  /** Longest toast body; Windows shows one line or two, the rest is lost anyway. */
  const BODY_LIMIT = 240
  /** Longest session name a body repeats; the sidebar truncates far later. */
  const SESSION_LABEL_LIMIT = 60

  /**
   * The toast icon, inlined: a notification icon must be an absolute URL the
   * renderer can load without the page, and the page origin (`dsh-app://app/`)
   * is not something a data URL has to negotiate with.
   */
  const ICON_DATA_URL =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
        '<rect width="64" height="64" rx="14" fill="#1f6feb"/>' +
        '<path d="M32 13a11.5 11.5 0 0 0-11.5 11.5v7.9l-3.2 5.4A2.5 2.5 0 0 0 19.4 42h25.2a2.5 2.5 0 0 0 2.1-3.8l-3.2-5.4v-7.9A11.5 11.5 0 0 0 32 13Z" fill="#fff"/>' +
        '<path d="M27.1 45.4a5.1 5.1 0 0 0 9.8 0Z" fill="#fff"/></svg>',
    )

  /**
   * Model failure codes from `dsh-llm` and the DeepSeek adapter. Every raw
   * message behind them is an adapter stack trace; the code is the part a
   * person can act on. Codes absent here fall back to the trimmed message.
   */
  const ERROR_CODES = {
    RATE_LIMIT: { ru: 'Перегрузка провайдера, повторите позже', en: 'Provider overloaded, retry later' },
    SERVER: { ru: 'Ошибка на стороне провайдера', en: 'Provider-side error' },
    TRANSPORT: { ru: 'Связь с провайдером прервалась', en: 'Connection to provider lost' },
    TIMEOUT: { ru: 'Провайдер не ответил вовремя', en: 'Provider timed out' },
    AUTH: { ru: 'Нужен повторный вход в аккаунт', en: 'Sign-in required' },
    INVALID_CREDENTIAL: { ru: 'Ключ доступа отклонён', en: 'Credential rejected' },
    INVALID_REQUEST: { ru: 'Провайдер отклонил запрос', en: 'Request rejected by provider' },
    EMPTY_RESPONSE: { ru: 'Провайдер вернул пустой ответ', en: 'Provider returned nothing' },
    ABORTED: { ru: 'Запрос отменён', en: 'Request cancelled' },
    QUOTA: { ru: 'Исчерпана квота запросов', en: 'Request quota exhausted' },
    ACCOUNT_QUOTA: { ru: 'Исчерпана квота аккаунта', en: 'Account quota exhausted' },
    CONTEXT_WINDOW_EXCEEDED: { ru: 'Контекст длиннее окна модели', en: 'Context exceeds model window' },
    IMAGE_OFFLOAD_REQUIRED: { ru: 'Изображение слишком велико', en: 'Image too large' },
  }

  const TITLES = {
    'turn-completed': { ru: 'Запрос выполнен', en: 'Request finished' },
    'turn-error': { ru: 'Генерация не удалась', en: 'Generation failed' },
    'turn-truncated': { ru: 'Вывод усечён', en: 'Output truncated' },
    approval: { ru: 'Нужно разрешение', en: 'Permission needed' },
    question: { ru: 'Нужен ваш ответ', en: 'Your answer needed' },
    schedule: { ru: 'Напоминание выполнено', en: 'Reminder delivered' },
  }

  /**
   * Kinds this half knows how to render. The Host half only reloads with a
   * process restart while this file hot-reloads on its own, so for a while a
   * newer client talks to an older Host that still emits per-job frames. Those
   * are progress reports the user asked not to receive, so an unknown kind is
   * dropped rather than shown under the generic `DSH` title.
   */
  const HANDLED = new Set(Object.keys(TITLES))

  /** Only the parts a phrase needs to stay grammatical per language. */
  const PHRASES = {
    ru: {
      'notify.approval.escalate.full': 'нужен доступ вне рабочей папки',
      'notify.approval.escalate.write': 'нужен доступ на запись за пределами папки',
      'notify.approval.tool': 'инструмент {tool}',
      'notify.question.more': 'ещё вопросов: {count}',
      'notify.turn.truncated': 'модель упёрлась в лимит длины ответа',
      'notify.schedule.delivered': 'запущено по расписанию',
    },
    en: {
      'notify.approval.escalate.full': 'needs access outside the workspace',
      'notify.approval.escalate.write': 'needs write access outside the workspace',
      'notify.approval.tool': 'tool {tool}',
      'notify.question.more': 'more questions: {count}',
      'notify.turn.truncated': 'the reply hit the length limit',
      'notify.schedule.delivered': 'triggered by schedule',
    },
  }

  /** The bundle ships two languages; anything else reads as Russian. */
  const isEnglish = (ctx) => String(ctx.locale.getLocale?.() ?? 'ru').toLowerCase().startsWith('en')

  function pick(table, key, ctx) {
    const entry = table[key]
    if (entry === undefined) return undefined
    return isEnglish(ctx) ? entry.en : entry.ru
  }

  function truncate(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') return ''
    return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT - 1)}…` : text
  }

  /** Windows treats a stale toast click as harmless, but a dead tab must not throw. */
  function openSession(ctx, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    try {
      const workspace = ctx.get?.('uiWorkspace')
      workspace?.openSession?.(sessionId)
    } catch (error) {
      console.warn('[dsh-notify] openSession failed:', error)
    }
    try {
      window.focus()
    } catch {}
    // The shell registers `dsh:` as its default protocol and focuses the
    // primary window on `dsh://open`; a same-origin fetch cannot do that.
    if (/electron/i.test(navigator.userAgent)) {
      try {
        const frame = document.createElement('iframe')
        frame.style.display = 'none'
        frame.src = 'dsh://open'
        document.body.appendChild(frame)
        setTimeout(() => frame.remove(), 1000)
      } catch {}
    }
  }

  function wireClick(notification, ctx, sessionId) {
    notification.onclick = () => {
      try {
        notification.close()
      } catch {}
      openSession(ctx, sessionId)
    }
    // A closed toast must not keep the queue's listener alive.
    notification.onclose = () => {
      notification.onclick = null
      notification.onclose = null
    }
  }

  /**
   * The notification half: polling the Host and raising OS toasts.
   *
   * Named `applyCore` because the exported `apply` inside `factory` wraps it
   * with the settings page. Keeping this at module scope means the toast path
   * holds no reference to React or to any slot, so a shell without them still
   * notifies.
   */
  function applyCore(ctx) {
    /** Page visibility and focus decide whether a toast is warranted at all. */
    let pageVisible = typeof document === 'undefined' ? true : document.visibilityState === 'visible'
    let pageFocused = typeof document === 'undefined' ? false : document.hasFocus()
    const isPageActive = () => pageVisible && pageFocused

    ctx.effect(() => {
      if (typeof document === 'undefined') return () => {}
      const onVisibility = () => {
        pageVisible = document.visibilityState === 'visible'
      }
      const onFocus = () => {
        pageFocused = true
      }
      const onBlur = () => {
        pageFocused = false
      }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      }
    }, 'dsh-notify: focus tracking')

    ctx.effect(
      () =>
        ctx.locale.register(NS, PHRASES),
      'dsh-notify: dictionaries',
    )
    const t = ctx.locale.bind(NS)

    let enabled = true
    /**
     * Whether a focused window still gets a toast. The original rule — stay
     * quiet while the user is looking at the page — is right for a single
     * monitor and wrong for a second screen, a pinned window, or a long turn
     * the user walked away from with the window still focused. A setting lets
     * both readings win instead of picking one for everybody.
     */
    let alwaysOn = true
    /**
     * Whether the Host's `mode` silences the local toast. Owned by the Host
     * because it lives in the same settings file as the remote switch; the page
     * only mirrors it. `false` until the first `/ping` answers, so a page that
     * cannot reach the Host keeps notifying rather than going silently dead.
     */
    let toastMuted = false
    try {
      enabled = window.localStorage.getItem('dsh-notify:enabled') !== '0'
      alwaysOn = window.localStorage.getItem('dsh-notify:alwaysOn') !== '0'
    } catch {}

    /** Permission is auto-granted by the shell; request anyway for a plain browser. */
    const ensurePermission = () => {
      if (typeof Notification === 'undefined') return false
      if (Notification.permission === 'granted') return true
      if (Notification.permission === 'denied') return false
      try {
        Notification.requestPermission().catch(() => {})
      } catch {}
      return false
    }
    ensurePermission()

    /**
     * Title in the active UI language. Only `ru` and `en` ship here; any other
     * locale falls back to `ru`, which is the language this bundle was written
     * for, rather than to a half-translated third variant.
     */
    const titleOf = (kind) => {
      const entry = TITLES[kind]
      if (entry === undefined) return 'DSH'
      const locale = String(ctx.locale.getLocale?.() ?? 'ru').toLowerCase()
      return locale.startsWith('en') ? entry.en : entry.ru
    }

    /**
     * Compose the one line a toast gets. Every branch prefers a short verdict
     * that a person can act on and appends the frame's own explanation only
     * when the Host supplied one — the raw payloads never reach the body.
     */
    const bodyOf = (frame) => {
      const parts = []

      if (frame.kind === 'turn-error') {
        const verdict = paint(frame.code)
        if (verdict !== undefined) parts.push(verdict)
        else if (typeof frame.detail === 'string') parts.push(truncate(frame.detail))
        return parts.join(' — ')
      }

      if (frame.kind === 'turn-completed') {
        // The title already says the turn finished; the body only names the
        // conversation, which `composeBody` prefixes. Repeating the verdict
        // here would spend the one line a toast has on nothing.
        return ''
      }

      if (frame.kind === 'turn-truncated') {
        return t('notify.turn.truncated')
      }

      if (frame.kind === 'approval') {
        const verdict =
          frame.access === 'write'
            ? t('notify.approval.escalate.write')
            : frame.access === 'full'
              ? t('notify.approval.escalate.full')
              : undefined
        const tool =
          typeof frame.tool === 'string' && frame.tool !== ''
            ? t('notify.approval.tool', { tool: frame.tool })
            : undefined
        if (verdict !== undefined) parts.push(verdict)
        else if (tool !== undefined) parts.push(tool)
        if (verdict !== undefined && tool !== undefined) parts.push(tool)
        const note = typeof frame.note === 'string' && frame.note !== '' ? frame.note : frame.body
        if (typeof note === 'string' && note !== '') parts.push(truncate(note))
        return parts.join(' · ')
      }

      if (frame.kind === 'question') {
        if (typeof frame.title === 'string' && frame.title !== '') parts.push(frame.title)
        else if (typeof frame.detail === 'string' && frame.detail !== '') parts.push(truncate(frame.detail))
        const count = typeof frame.count === 'number' ? frame.count : 0
        if (count > 1) parts.push(t('notify.question.more', { count: count - 1 }))
        return parts.join(' · ')
      }

      if (frame.kind === 'schedule') {
        if (typeof frame.note === 'string' && frame.note !== '') return truncate(frame.note)
        return t('notify.schedule.delivered')
      }

      return typeof frame.detail === 'string' ? truncate(frame.detail) : ''
    }

    /** A known failure code in plain words; unknown codes stay out of the body. */
    const paint = (code) => (typeof code === 'string' ? pick(ERROR_CODES, code, ctx) : undefined)

    /**
     * The session's own displayed name, so a toast says *which* conversation it
     * is about. Read lazily and defensively: the service may not be up yet, and
     * a missing name must never cost the toast.
     */
    const sessionLabelOf = (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const row = ctx.get?.('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId]
        const label = row?.displayTitle ?? row?.title
        if (typeof label !== 'string' || label.trim() === '') return undefined
        return label.length > SESSION_LABEL_LIMIT ? `${label.slice(0, SESSION_LABEL_LIMIT - 1)}…` : label
      } catch {
        return undefined
      }
    }

    /** Lead with the session name, then the verdict; the pair must fit one toast. */
    const composeBody = (frame) => {
      let body = bodyOf(frame)
      // The Host half only re-evaluates on a restart (module roots are not
      // watched), while this file hot-reloads on its own. A frame from a Host
      // still running the previous revision carries `body` instead of the
      // normalized facts, so fall back to it rather than showing nothing.
      if (body === '' && typeof frame.body === 'string') body = frame.body
      const label = sessionLabelOf(frame.sessionId)
      const text = body === '' ? (label ?? '') : label === undefined ? body : `${label} · ${body}`
      return truncate(text)
    }

    const toast = (frame) => {
      if (!enabled) return
      // `mode` can silence the toast entirely (the middle position): the webhook is the only
      // channel the user asked for, so raising a toast would contradict them.
      // Seeded from the Host and refreshed on every poll.
      if (toastMuted) return
      // Only suppress when the user asked for quiet-while-looking.
      if (!alwaysOn && isPageActive()) return
      if (!HANDLED.has(frame.kind)) return
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      const title = titleOf(frame.kind)
      const body = composeBody(frame)
      try {
        const options = { tag: `dsh-notify-${frame.kind}`, icon: ICON_DATA_URL, silent: false }
        if (body !== '') options.body = body
        const notification = new Notification(title, options)
        wireClick(notification, ctx, frame.sessionId)
      } catch (error) {
        console.warn('[dsh-notify] could not raise a notification:', error)
      }
    }

    let disposed = false
    let cursor = 0
    let seeded = false
    let controller

    const sleep = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        if (typeof timer.unref === 'function') timer.unref()
      })

    /**
     * Start from the Host's current counter, not from zero: frames queued
     * before this page loaded are history, and replaying them would greet the
     * user with a burst of toasts for things they already saw.
     */
    const seedCursor = async () => {
      const response = await fetch(`${ROUTE_PREFIX}/ping`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return
      const payload = await response.json()
      if (typeof payload?.toastMuted === 'boolean') toastMuted = payload.toastMuted
      if (typeof payload?.counter === 'number' && Number.isFinite(payload.counter)) {
        cursor = Math.max(cursor, Math.floor(payload.counter))
        seeded = true
      }
    }

    const pollOnce = async () => {
      controller = new AbortController()
      const response = await fetch(`${ROUTE_PREFIX}/pending?since=${cursor}&wait=${WAIT_MS}`, {
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`notify route answered ${response.status}`)
      const payload = await response.json()
      if (disposed) return
      if (typeof payload?.counter === 'number' && Number.isFinite(payload.counter)) {
        // Trust the Host's counter, not the page count: frames older than the
        // retained window are gone, and replaying them would double-toast.
        cursor = Math.max(cursor, Math.floor(payload.counter))
      }
      // The switch may have moved while the page was open, so the answer is
      // adopted per poll rather than once at load.
      if (typeof payload?.toastMuted === 'boolean') toastMuted = payload.toastMuted
      const frames = Array.isArray(payload?.frames) ? payload.frames : []
      for (const frame of frames) {
        if (disposed) return
        if (typeof frame?.kind !== 'string') continue
        try {
          toast(frame)
        } catch (error) {
          console.warn('[dsh-notify] frame failed:', error)
        }
      }
    }

    ctx.effect(() => {
      disposed = false
      const loop = async () => {
        while (!disposed) {
          try {
            if (!seeded) await seedCursor()
            await pollOnce()
          } catch (error) {
            if (disposed) return
            if (error?.name === 'AbortError') return
            console.warn('[dsh-notify] poll failed:', error)
            await sleep(RETRY_MS)
          }
        }
      }
      loop()
      return () => {
        disposed = true
        try {
          controller?.abort()
        } catch {}
      }
    }, 'dsh-notify: pending poll')

    // The escape hatch for hands-on checks, and the seam another plugin could
    // drive if it ever wants its own toast: `ctx.get('dshNotify')`.
    const api = {
      get enabled() {
        return enabled
      },
      set enabled(value) {
        enabled = value !== false
        try {
          window.localStorage.setItem('dsh-notify:enabled', enabled ? '1' : '0')
        } catch {}
      },
      /** `false` restores the quiet-while-the-window-is-focused behaviour. */
      get alwaysOn() {
        return alwaysOn
      },
      set alwaysOn(value) {
        alwaysOn = value !== false
        try {
          window.localStorage.setItem('dsh-notify:alwaysOn', alwaysOn ? '1' : '0')
        } catch {}
      },
      permission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
      notify: (frame) => toast(frame),
      /**
       * Hands-on check. Bypasses the focus rule so a person sitting at a
       * focused window gets an answer; only `enabled` and OS permission can
       * still refuse, because those are the two the user must fix themselves.
       */
      test: () => {
        if (!enabled) return 'disabled'
        if (typeof Notification === 'undefined') return 'unsupported'
        if (Notification.permission !== 'granted') return Notification.permission
        const frame = { kind: 'turn-completed' }
        const options = { tag: 'dsh-notify-test', icon: ICON_DATA_URL, silent: false }
        const body = composeBody(frame)
        if (body !== '') options.body = body
        try {
          wireClick(new Notification(titleOf(frame.kind), options), ctx, undefined)
          return 'shown'
        } catch (error) {
          console.warn('[dsh-notify] test toast failed:', error)
          return 'failed'
        }
      },
    }
    window.__dshNotify = api
    ctx.effect(() => ctx.provide('dshNotify', api), 'dsh-notify: service')

  }

  // ── settings page ────────────────────────────────────────────────────────
  //
  // One page under Settings → Уведомления. It owns two switches that the Host
  // enforces, not the browser: whether the webhook channel sends anything, and a
  // window in which it stays silent. The page only reads and writes them; the
  // decision belongs to `settings.allows()` on the Host side, so closing the
  // page (or the whole GUI) does not change what gets sent.

  /** Weekday names in ISO order, Monday first. */
  const DAY_NAMES = {
    ru: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  }

  const PAGE_TEXT = {
    ru: {
      section: 'Уведомления',
      title: 'Куда присылать уведомления',
      modeLabel: 'Канал уведомления',
      modeWindows: 'Только Windows',
      modeWebhook: 'Только вебхук',
      modeBoth: 'Оба',
      quietLabel: 'Тихие часы',
      fromLabel: 'С',
      toLabel: 'До',
      daysLabel: 'Дни',
      quietNow: 'Сейчас тихо — до {to}.',
      quietInactive: 'Сейчас уведомления приходят.',
      off: 'Вебхук выключен — уходит только тост.',
      toastOff: 'Только вебхук — тосты Windows выключены.',
      unavailable: 'Не удалось прочитать настройки: {reason}',
      saving: 'Сохраняю…',
      failed: 'Не удалось сохранить — осталось как было.',
      loading: 'Читаю настройки…',
      wholeDay: 'Весь день',
      everyDay: 'каждый день',
      allWeek: 'вся неделя',
      weekdays: 'будни',
      weekend: 'выходные',
      quietIdle: 'в режиме «Оба»',
      staleHost: 'Переключатель не сохранится: запущенный DSH Desktop старше этой страницы. Перезапустите приложение.',
      webhookLabel: 'Вебхук',
      webhookUrlLabel: 'Адрес',
      webhookTokenLabel: 'Токен',
      webhookTokenPlaceholder: 'Вставьте токен',
      webhookTokenReplace: 'Новый токен, чтобы заменить сохранённый',
      webhookTokenState: 'токен задан',
      webhookTokenAbsent: 'токен не задан',
      webhookConfigured: 'Настроен: {host}',
      webhookMissing: 'Адрес не задан — на вебхук ничего не отправляется.',
      webhookPlaceholder: 'Вставьте адрес вебхука',
      webhookSave: 'Сохранить',
      webhookClear: 'Удалить',
      webhookTest: 'Проверить',
      webhookTesting: 'Отправляю…',
      webhookTestOk: 'Проверка отправлена: {host}.',
      webhookTestFailed: 'Проверка не удалась — подробности в логе DSH.',
      webhookReadOnly: 'Здесь не изменить: в этой сборке нет хранилища учётных данных.',
      webhookMarkdown: 'Жирный заголовок',
      errorInvalidUrl: 'URL должен быть http(s)-адресом без логина и пароля внутри.',
      errorInvalidToken: 'Токен отклонён: пустой или с пробелами внутри.',
      errorMissingUrl: 'Сначала укажите адрес вебхука.',
      errorCredentials: 'В этой сборке нет хранилища учётных данных — секрет сохранить некуда.',
      errorStore: 'Не удалось записать в хранилище — подробности в логе DSH.',
    },
    en: {
      section: 'Notifications',
      title: 'Where notifications go',
      modeLabel: 'Notification channel',
      modeWindows: 'Windows only',
      modeWebhook: 'Webhook only',
      modeBoth: 'Both',
      quietLabel: 'Quiet hours',
      fromLabel: 'From',
      toLabel: 'To',
      daysLabel: 'Days',
      quietNow: 'Quiet right now, until {to}.',
      quietInactive: 'Notifications are being delivered.',
      off: 'The webhook is off — only the toast is shown.',
      toastOff: 'Webhook only — Windows toasts are off.',
      unavailable: 'Could not read the settings: {reason}',
      saving: 'Saving…',
      failed: 'Could not save — left as it was.',
      loading: 'Reading settings…',
      wholeDay: 'All day',
      everyDay: 'every day',
      allWeek: 'all week',
      weekdays: 'weekdays',
      weekend: 'weekends',
      quietIdle: 'in “Both” mode',
      staleHost: 'The switch will not save: the running DSH Desktop is older than this page. Restart the app.',
      webhookLabel: 'Webhook',
      webhookUrlLabel: 'Address',
      webhookTokenLabel: 'Token',
      webhookTokenPlaceholder: 'Paste the token',
      webhookTokenReplace: 'A new token to replace the stored one',
      webhookTokenState: 'token set',
      webhookTokenAbsent: 'no token',
      webhookConfigured: 'Configured: {host}',
      webhookMissing: 'No address yet — nothing is sent to the webhook.',
      webhookPlaceholder: 'Paste the webhook address',
      webhookSave: 'Save',
      webhookClear: 'Remove',
      webhookTest: 'Test',
      webhookTesting: 'Sending…',
      webhookTestOk: 'Test delivered to {host}.',
      webhookTestFailed: 'The test failed — see the DSH log for details.',
      webhookReadOnly: 'Cannot be changed here: this composition has no credential store.',
      webhookMarkdown: 'Bold heading',
      errorInvalidUrl: 'The URL must be an http(s) address without embedded credentials.',
      errorInvalidToken: 'The token was rejected: it is empty or contains whitespace.',
      errorMissingUrl: 'Enter the webhook address first.',
      errorCredentials: 'This composition has no credential store, so the secret cannot be saved.',
      errorStore: 'The secret could not be written to the store — see the DSH log.',
    },
  }

  /** The page language; the bundle ships Russian and English. */
  function pageText() {
    const language = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '')
    return language.toLowerCase().startsWith('en') ? PAGE_TEXT.en : PAGE_TEXT.ru
  }

  /** `[1..7]` → «каждый день», «будни», «выходные», or an explicit list. */
  function describeDays(days, copy) {
    const sorted = [...new Set(days)].sort((a, b) => a - b)
    const key = sorted.join(',')
    if (key === '1,2,3,4,5,6,7') return copy.everyDay
    if (key === '1,2,3,4,5') return copy.weekdays
    if (key === '6,7') return copy.weekend
    const names = DAY_NAMES[copy === PAGE_TEXT.en ? 'en' : 'ru']
    return sorted.map((d) => names[d - 1]).filter(Boolean).join(', ')
  }

  /** Total minutes for an `HH:MM` string; `null` when unusable. */
  function parseTime(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof value === 'string' ? value.trim() : '')
    return match === null ? null : Number(match[1]) * 60 + Number(match[2])
  }

  const PAGE_CSS_TAG = 'dsh-notify/settings.css'

  const pageCss = [
    '.dsn-page{padding:20px 0;max-width:640px}',
    '.dsn-title{font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}',
    '.dsn-desc{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
    '.dsn-card{margin-top:20px;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
    '.dsn-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}',
    '.dsn-row+.dsn-row{margin-top:16px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l2)}',
    '.dsn-main{min-width:0}',
    '.dsn-label{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
    '.dsn-hint{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
    '.dsn-status{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
    '.dsn-status[data-tone="bad"]{color:var(--dsw-alias-state-error-primary,#d9534f)}',
    '.dsn-status[data-tone="quiet"]{color:var(--dsw-alias-state-warn-primary,#c98a00)}',
    '.dsn-switch{flex:none;display:inline-flex;align-items:center;gap:8px;padding:0;border:0;background:0 0;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer}',
    '.dsn-switch:disabled{opacity:.45;cursor:default}',
    '.dsn-track{position:relative;width:38px;height:22px;border-radius:11px;background:var(--dsw-alias-border-l2);transition:background .15s ease}',
    '.dsn-switch[aria-checked="true"] .dsn-track{background:var(--dsw-alias-brand-primary,#4c8dff)}',
    '.dsn-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s ease}',
    '.dsn-switch[aria-checked="true"] .dsn-knob{transform:translateX(16px)}',
    '.dsn-field{display:flex;flex-direction:column;gap:3px;margin-top:10px}',
    '.dsn-sublabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
    '.dsn-token{font-family:var(--dsw-alias-font-mono,ui-monospace,monospace);letter-spacing:.08em}',
    '.dsn-times{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '.dsn-time{padding:4px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
    '.dsn-time:disabled{opacity:.45}',
    '.dsn-sep{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.dsn-days{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}',
    '.dsn-mode{min-width:0;padding:6px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
    '.dsn-mode[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent;color:#fff}',
    '.dsn-mode:disabled{opacity:.45;cursor:default}',
    '.dsn-modes{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '.dsn-day{min-width:38px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
    '.dsn-day[aria-pressed="true"]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent;color:#fff}',
    '.dsn-day:disabled{opacity:.45;cursor:default}',
    '.dsn-url{display:block;width:100%;box-sizing:border-box;min-width:0;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
    '.dsn-url:disabled{opacity:.45}',
    '.dsn-btn{padding:4px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
    '.dsn-btn:disabled{opacity:.45;cursor:default}',
    '.dsn-btn[data-kind="primary"]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent;color:#fff}',
    '.dsn-btn[data-kind="danger"]{color:var(--dsw-alias-state-error-primary,#d9534f)}',
  ].join('')

  function injectPageStyles() {
    if (typeof document === 'undefined') return
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(PAGE_CSS_TAG)}]`) !== null) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-notify'
    tag.dataset.pluginCss = PAGE_CSS_TAG
    tag.textContent = pageCss
    document.head.appendChild(tag)
  }


  window.__ModuleLoader__.load({
    id: 'dsh-notify',
    factory: (require) => {
      const React = require('react')

  /** One switch: the same visual language as a shipped preference row. */
  function Switch({ checked, disabled, label, onChange }) {
    return React.createElement('button', {
      type: 'button',
      className: 'dsn-switch',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': label,
      title: label,
      disabled,
      onClick: () => onChange(!checked),
    },
      React.createElement('span', { className: 'dsn-track', 'aria-hidden': 'true' },
        React.createElement('span', { className: 'dsn-knob' })),
      React.createElement('span', { className: 'dsn-switchLabel' }, label))
  }

  /**
   * The bell in the Settings navigation row.
   *
   * `settings.section.icon` hands the component its own square edge and whether
   * the section is selected; the row keeps the colour, so the glyph is drawn in
   * `currentColor` and an outline weight that sits beside the shell's own icons
   * (user, data, archive, gear). No background and no badge: at 16px a filled
   * tile reads as a foreign object in a list of line drawings.
   */
  function NotifySettingsIcon({ size = 16 }) {
    return React.createElement('svg', {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
    },
      React.createElement('path', {
        d: 'M5.3 7.6V6.2a2.7 2.7 0 0 1 5.4 0v1.4l1 1.8c.17.3-.05.65-.39.65H4.69c-.34 0-.56-.35-.39-.65Z',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinejoin: 'round',
      }),
      React.createElement('path', {
        d: 'M6.75 12.1a1.25 1.25 0 0 0 2.5 0',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
      }))
  }

  /**
   * The settings page.
   *
   * It keeps one snapshot of the Host's answer and writes back through a patch
   * endpoint. The Host is the authority: a failed write leaves the switch where
   * it was rather than pretending, and `quiet` comes from the Host clock so the
   * page never disagrees with what will actually be sent.
   */
  function NotifySettingsPage() {
    injectPageStyles()
    const copy = pageText()
    const [state, setState] = React.useState({ ready: false, ok: true, error: null, busy: false, notice: null })
    const [settings, setSettings] = React.useState(null)
    const [quietNow, setQuietNow] = React.useState(false)
    const [absent, setAbsent] = React.useState(false)
    // The Host's answer about the webhook never carries the address or the
    // token, so the drafts a person is typing are the only copy the page has —
    // and the only ones it sends.
    const [webhook, setWebhook] = React.useState(null)
    const [urlDraft, setUrlDraft] = React.useState('')
    const [tokenDraft, setTokenDraft] = React.useState('')
    const [webhookNotice, setWebhookNotice] = React.useState(null)
    const [testing, setTesting] = React.useState(false)

    const adopt = (payload) => {
      setSettings(payload.settings)
      setQuietNow(payload.quiet === true)
      setAbsent(payload.absent === true)
      setWebhook(payload.webhook ?? null)
      setState((prev) => ({ ...prev, ready: true, ok: true, error: null }))
    }

    const read = React.useCallback(async () => {
      try {
        const response = await fetch(`${ROUTE_PREFIX}/settings`, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw new Error(`settings answered ${response.status}`)
        adopt(await response.json())
      } catch (error) {
        setState((prev) => ({ ...prev, ready: true, ok: false, error: String(error?.message ?? error) }))
      }
    }, [])

    React.useEffect(() => {
      let alive = true
      const tick = () => { if (alive) read() }
      tick()
      // The Host clock decides the quiet window, so the page refreshes while it
      // is open; a closed page costs the Host nothing.
      const timer = setInterval(tick, 15_000)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [read])

    /** One `POST /config`, with the Host's own error code kept for the message. */
    const sendConfig = async (next) => {
      const response = await fetch(`${ROUTE_PREFIX}/config`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(payload.error ?? `config answered ${response.status}`)
        error.code = typeof payload.error === 'string' ? payload.error : 'failed'
        throw error
      }
      return payload
    }

    const patch = async (next, area) => {
      if (state.busy) return false
      setState((prev) => ({ ...prev, busy: true, notice: null }))
      if (area === 'webhook') setWebhookNotice(null)
      try {
        adopt(await sendConfig(next))
        setState((prev) => ({ ...prev, busy: false, notice: null }))
        return true
      } catch (error) {
        const code = error?.code ?? 'failed'
        if (area === 'webhook') {
          setWebhookNotice(code)
        } else {
          setState((prev) => ({ ...prev, busy: false, notice: 'failed' }))
          setTimeout(() => setState((prev) => (prev.notice === 'failed' ? { ...prev, notice: null } : prev)), 8000)
        }
        console.warn('[dsh-notify] saving the notification settings failed:', error)
        return false
      } finally {
        if (area === 'webhook') setState((prev) => ({ ...prev, busy: false }))
      }
    }

    /**
     * Write the pasted address and token into the credential store.
     *
     * Either field may be left empty: the Host then keeps what it already has,
     * which is what makes a token-only change possible without re-pasting the
     * address. Both drafts are cleared on success, so a secret does not linger
     * in the page after it is stored.
     */
    const saveWebhook = async () => {
      const url = addressValue.trim()
      const token = tokenDraft.trim()
      if ((url === '' && token === '') || state.busy) return
      const next = {}
      if (url !== '') next.url = url
      if (token !== '') next.token = token
      if (await patch({ webhook: next }, 'webhook')) {
        setUrlDraft('')
        setTokenDraft('')
      }
    }

    /** Forget the stored address and token: afterwards the webhook channel sends nothing. */
    const clearUrl = async () => {
      if (state.busy) return
      if (await patch({ webhook: { clear: true } }, 'webhook')) {
        setUrlDraft('')
        setTokenDraft('')
      }
    }

    /** Send the fixed test message and report the outcome in the card. */
    const testWebhook = async () => {
      if (testing) return
      setTesting(true)
      setWebhookNotice(null)
      try {
        const response = await fetch(`${ROUTE_PREFIX}/webhook/test`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error ?? `test answered ${response.status}`)
        if (payload.ok === true) setWebhookNotice(`test-ok:${payload.host ?? ''}`)
        else setWebhookNotice(payload.error === 'not-configured' ? 'not-configured' : 'test-failed')
      } catch (error) {
        setWebhookNotice('test-failed')
        console.warn('[dsh-notify] the webhook test failed:', error)
      } finally {
        setTesting(false)
      }
    }

    /** The notice line under the fields, from a Host error code or a test result. */
    const webhookMessage = (code) => {
      if (typeof code !== 'string') return null
      if (code.startsWith('test-ok:')) {
        return { tone: 'normal', text: copy.webhookTestOk.replace('{host}', code.slice('test-ok:'.length) || '—') }
      }
      if (code === 'test-failed') return { tone: 'bad', text: copy.webhookTestFailed }
      if (code === 'invalid-url') return { tone: 'bad', text: copy.errorInvalidUrl }
      if (code === 'invalid-token') return { tone: 'bad', text: copy.errorInvalidToken }
      if (code === 'missing-url') return { tone: 'bad', text: copy.errorMissingUrl }
      if (code === 'credentials-unavailable') return { tone: 'bad', text: copy.errorCredentials }
      if (code === 'webhook-store-failed') return { tone: 'bad', text: copy.errorStore }
      if (code === 'not-configured') return { tone: 'quiet', text: copy.webhookMissing }
      return { tone: 'bad', text: code }
    }

    if (settings === null) {
      return React.createElement('div', { className: 'dsn-page' },
        React.createElement('div', { className: 'dsn-title' }, copy.title),
        React.createElement('div', { className: 'dsn-desc' },
          state.ok ? copy.loading : copy.unavailable.replace('{reason}', state.error ?? '—')))
    }

    const quiet = settings.quietHours
    const disabled = state.busy || absent
    const days = Array.isArray(quiet.days) ? quiet.days : []
    const wholeDay = parseTime(quiet.from) !== null && parseTime(quiet.from) === parseTime(quiet.to)
    const mode = settings.mode
    // The Host owns `mode`. When the running process predates the field it
    // answers without one, and `POST /config` would drop the patch silently —
    // exactly the "buttons do nothing" symptom. Detect it instead of guessing.
    // The same applies to the webhook block this page writes through.
    const staleHost = typeof mode !== 'string' || webhook === null
    // Quiet hours only exist for "Both": the other two modes have no second
    // channel to hold back, so the pickers are visibly inert there.
    const quietRelevant = mode === 'both'

    const MODE_OPTIONS = [
      { id: 'windows', label: copy.modeWindows },
      { id: 'webhook', label: copy.modeWebhook },
      { id: 'both', label: copy.modeBoth },
    ]

    const webhookConfigured = webhook?.configured === true
    const webhookWritable = webhook?.writable !== false
    // The address is not a secret once the token is split out of it, so the
    // field shows the stored one; whatever the person is typing wins.
    const addressValue = urlDraft !== '' ? urlDraft : (webhook?.url ?? '')
    const webhookNote = webhookMessage(webhookNotice)
    // A running Host older than this page has neither `/webhook/test` nor the
    // credential store, so the whole card is inert rather than misleading.
    const webhookBusy = disabled || testing || staleHost

    let status
    let tone = 'normal'
    if (state.notice === 'failed') {
      status = copy.failed
      tone = 'bad'
    } else if (!state.ok) {
      status = copy.unavailable.replace('{reason}', state.error ?? '—')
      tone = 'bad'
    } else if (mode === 'windows') {
      status = copy.off
    } else if (mode === 'webhook') {
      status = copy.toastOff
    } else if (quietNow) {
      status = copy.quietNow.replace('{to}', quiet.to)
      tone = 'quiet'
    } else {
      status = copy.quietInactive
    }

    return React.createElement('div', { className: 'dsn-page', 'data-dsh-notify-settings': 'true' },
      React.createElement('div', { className: 'dsn-title' }, copy.title),

      React.createElement('div', { className: 'dsn-card' },
        // ── the three-position switch ──
        React.createElement('div', { className: 'dsn-row' },
          React.createElement('div', { className: 'dsn-main' },
            React.createElement('div', { className: 'dsn-label' }, copy.modeLabel),
            React.createElement('div', { className: 'dsn-modes', role: 'radiogroup', 'aria-label': copy.modeLabel },
              MODE_OPTIONS.map((option) =>
                React.createElement('button', {
                  key: option.id,
                  type: 'button',
                  className: 'dsn-mode',
                  role: 'radio',
                  'aria-checked': mode === option.id ? 'true' : 'false',
                  'data-dsh-notify-mode': option.id,
                  disabled,
                  onClick: () => patch({ mode: option.id }),
                }, option.label))),
            React.createElement('div', { className: 'dsn-status', 'data-tone': tone, 'data-dsh-notify-status': 'true' },
              state.busy ? copy.saving : status),
            // A Host from before the three-position switch does not know
            // `mode` and drops it instead of refusing it, so a click would
            // silently do nothing. Say so rather than look broken.
            staleHost ? React.createElement('div', { className: 'dsn-status', 'data-tone': 'bad' }, copy.staleHost) : null)),

        // ── quiet hours ──
        React.createElement('div', { className: 'dsn-row' },
          React.createElement('div', { className: 'dsn-main' },
            React.createElement('div', { className: 'dsn-label' }, copy.quietLabel),

            React.createElement('div', { className: 'dsn-times' },
              React.createElement('span', { className: 'dsn-sep' }, copy.fromLabel),
              React.createElement('input', {
                type: 'time',
                className: 'dsn-time',
                value: quiet.from,
                disabled: disabled || !quietRelevant || quiet.enabled !== true,
                onChange: (event) => patch({ quietHours: { from: event.target.value } }),
              }),
              React.createElement('span', { className: 'dsn-sep' }, copy.toLabel),
              React.createElement('input', {
                type: 'time',
                className: 'dsn-time',
                value: quiet.to,
                disabled: disabled || !quietRelevant || quiet.enabled !== true,
                onChange: (event) => patch({ quietHours: { to: event.target.value } }),
              }),
              wholeDay ? React.createElement('span', { className: 'dsn-sep' }, `· ${copy.wholeDay}`) : null),

            React.createElement('div', { className: 'dsn-days' },
              [1, 2, 3, 4, 5, 6, 7].map((day) =>
                React.createElement('button', {
                  key: day,
                  type: 'button',
                  className: 'dsn-day',
                  'aria-pressed': days.includes(day) ? 'true' : 'false',
                  disabled: disabled || !quietRelevant || quiet.enabled !== true,
                  onClick: () => {
                    const next = days.includes(day)
                      ? days.filter((d) => d !== day)
                      : [...days, day].sort((a, b) => a - b)
                    // An empty selection would silently disable the window, so
                    // the last day cannot be switched off.
                    if (next.length === 0) return
                    patch({ quietHours: { days: next } })
                  },
                }, DAY_NAMES[copy === PAGE_TEXT.en ? 'en' : 'ru'][day - 1]))),

            React.createElement('div', { className: 'dsn-hint' }, describeDays(days, copy))),

          React.createElement(Switch, {
            checked: quiet.enabled === true,
            disabled: disabled || !quietRelevant,
            label: quiet.enabled === true ? 'Вкл' : 'Выкл',
            onChange: (value) => patch({ quietHours: { enabled: value } }),
          })),

        // ── the webhook address and its token: write-only, the Host never sends the stored values back ──
        React.createElement('div', { className: 'dsn-row', 'data-dsh-notify-webhook': 'true' },
          React.createElement('div', { className: 'dsn-main' },
            React.createElement('div', { className: 'dsn-label' }, copy.webhookLabel),
            React.createElement('div', {
              className: 'dsn-status',
              'data-tone': webhookConfigured ? 'normal' : 'quiet',
              'data-dsh-notify-webhook-state': webhookConfigured ? 'configured' : 'missing',
            }, webhookConfigured
              ? `${copy.webhookConfigured.replace('{host}', webhook?.host ?? '—')} · ${webhook?.hasToken === true ? copy.webhookTokenState : copy.webhookTokenAbsent}`
              : copy.webhookMissing),

            React.createElement('div', { className: 'dsn-field' },
              React.createElement('div', { className: 'dsn-sublabel' }, copy.webhookUrlLabel),
              React.createElement('input', {
                type: 'password',
                className: 'dsn-url',
                value: addressValue,
                placeholder: copy.webhookPlaceholder,
                disabled: webhookBusy || !webhookWritable,
                autoComplete: 'off',
                spellCheck: false,
                onChange: (event) => setUrlDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') saveWebhook()
                },
              })),

            // The token field is a separate secret: masked on purpose, never
            // prefilled from the store, and appended to the address on the Host.
            React.createElement('div', { className: 'dsn-field' },
              React.createElement('div', { className: 'dsn-sublabel' }, copy.webhookTokenLabel),
              React.createElement('input', {
                type: 'password',
                className: 'dsn-url dsn-token',
                'data-dsh-notify-token': 'true',
                value: tokenDraft,
                placeholder: webhook?.hasToken === true ? copy.webhookTokenReplace : copy.webhookTokenPlaceholder,
                disabled: webhookBusy || !webhookWritable,
                autoComplete: 'off',
                spellCheck: false,
                onChange: (event) => setTokenDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') saveWebhook()
                },
              })),

            React.createElement('div', { className: 'dsn-times' },
              React.createElement('button', {
                type: 'button',
                className: 'dsn-btn',
                'data-kind': 'primary',
                disabled: webhookBusy || !webhookWritable || (addressValue.trim() === '' && tokenDraft.trim() === ''),
                onClick: saveWebhook,
              }, copy.webhookSave),
              webhookConfigured
                ? React.createElement('button', {
                    type: 'button',
                    className: 'dsn-btn',
                    disabled: webhookBusy,
                    onClick: testWebhook,
                  }, testing ? copy.webhookTesting : copy.webhookTest)
                : null,
              webhookConfigured
                ? React.createElement('button', {
                    type: 'button',
                    className: 'dsn-btn',
                    'data-kind': 'danger',
                    disabled: webhookBusy || !webhookWritable,
                    onClick: clearUrl,
                  }, copy.webhookClear)
                : null),

            webhookNote === null
              ? null
              : React.createElement('div', {
                  className: 'dsn-status',
                  'data-tone': webhookNote.tone,
                  'data-dsh-notify-webhook-notice': 'true',
                }, webhookNote.text),
            webhookWritable || webhook === null
              ? null
              : React.createElement('div', { className: 'dsn-status', 'data-tone': 'quiet' }, copy.webhookReadOnly))),

        // ── markdown, which only the webhook renderer cares about ──
        React.createElement('div', { className: 'dsn-row' },
          React.createElement('div', { className: 'dsn-main' },
            React.createElement('div', { className: 'dsn-label' }, copy.webhookMarkdown)),
          React.createElement(Switch, {
            checked: settings.webhook?.markdown === true,
            disabled: disabled || staleHost || !webhookConfigured,
            label: settings.webhook?.markdown === true ? 'Вкл' : 'Выкл',
            onChange: (value) => patch({ webhook: { markdown: value } }, 'webhook'),
          }))))
  }
      /**
       * Registers the settings page. Called from `apply` because it needs the
       * live `ctx`; defined here because only this scope can see the component.
       *
       * The registration is wrapped in `slots.inject('settings.section', …)`
       * rather than issued straight away. On a cold start this half loads before
       * the shell has declared the slot, and a bare `register` into a slot that
       * does not exist yet is simply lost — the section then only appeared after
       * a disable/enable cycle, which re-ran `apply` against an already-declared
       * slot. `inject` runs the callback now if the declaration is live and
       * inside the declaring `register()` otherwise, and the ledger bump makes
       * the shell re-render, so the page shows up either way.
       */
      const registerSettingsPage = (ctx) => {
        if (typeof ctx.inject !== 'function') return
        ctx.effect(() => ctx.inject(['slots'], (child) => {
          child.effect(() => child.slots.inject('settings.section', () => child.slots.register({
            name: 'settings.section',
            id: 'dsh-notify',
            order: 45,
            label: () => pageText().section,
          }, NotifySettingsPage)))
          // The nav glyph is a separate seat, addressed by the same id. Without
          // it the shell keeps its generic gear, which says nothing about
          // notifications; registered beside the section so both disappear
          // together when the slot declaration collapses.
          child.effect(() => child.slots.inject('settings.section.icon', () => child.slots.register({
            name: 'settings.section.icon',
            id: 'dsh-notify',
            order: 45,
          }, NotifySettingsIcon)))
        }), 'dsh-notify: settings page')
      }

      /**
       * The exported entry point. It runs the notification core, then offers the
       * settings page. The page component lives in this scope, so the two have
       * to meet here; the core stays independent of React and of `slots`.
       */
      const apply = (ctx) => {
        applyCore(ctx)
        registerSettingsPage(ctx)
      }

      const module = { exports: {} }
      module.exports = { name: 'dsh-notify', inject: ['locale'], apply }
      return module.exports
    },
  })
})()





