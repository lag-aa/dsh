/**
 * dsh-notify — the frame-to-text formatter shared by remote channels.
 *
 * The Web half turns a frame into a Windows toast and owns its own wording for
 * the browser locale (see `client.js`). A webhook receiver needs the same verdicts
 * as plain text, in one language, so they live here rather than in the channel
 * that happens to use them first.
 */

/**
 * The six frame kinds the Host half produces, in plain Russian that mirrors
 * the Web toast.
 */
const KIND_TEXT = {
  'turn-completed': 'Запрос выполнен',
  'turn-error': 'Генерация не удалась',
  'turn-truncated': 'Вывод усечён',
  approval: 'Нужно разрешение',
  question: 'Нужен ваш ответ',
  schedule: 'Напоминание выполнено',
}

const ERROR_CODES = {
  RATE_LIMIT: 'Перегрузка провайдера, повторите позже',
  SERVER: 'Ошибка на стороне провайдера',
  TRANSPORT: 'Связь с провайдером прервалась',
  TIMEOUT: 'Провайдер не ответил вовремя',
  AUTH: 'Нужен повторный вход в аккаунт',
  INVALID_CREDENTIAL: 'Ключ доступа отклонён',
  INVALID_REQUEST: 'Провайдер отклонил запрос',
  EMPTY_RESPONSE: 'Провайдер вернул пустой ответ',
  ABORTED: 'Запрос отменён',
  QUOTA: 'Исчерпана квота запросов',
  ACCOUNT_QUOTA: 'Исчерпана квота аккаунта',
  CONTEXT_WINDOW_EXCEEDED: 'Контекст длиннее окна модели',
  IMAGE_OFFLOAD_REQUIRED: 'Изображение слишком велико',
}

function firstLine(value, limit = 150) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return undefined
  const line = text.split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).find((s) => s !== '')
  if (line === undefined) return undefined
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/**
 * One frame to one message a receiver can read. Same verdicts as the toast, in
 * the same order a person would want them: what happened, which conversation,
 * the short reason, and nothing raw.
 *
 * `options.markdown` wraps the verdict line in `**…**`. Only a renderer that
 * understands markdown may set it: the Windows toast body is plain text, so for
 * it the asterisks would show up literally. A webhook receiver is expected to
 * render markdown, so that channel opts in by default.
 */
export function composeText(frame, title, options) {
  const kind = frame?.kind
  const label = KIND_TEXT[kind]
  if (label === undefined) return undefined
  const markdown = options?.markdown === true
  const lines = [markdown ? `**${label}**` : label]
  const session = firstLine(title, 60)
  if (session !== undefined) lines.push(session)

  if (kind === 'turn-error') {
    const verdict = typeof frame.code === 'string' ? ERROR_CODES[frame.code] : undefined
    const detail = firstLine(frame.detail, 150)
    const reason = verdict ?? detail
    if (reason !== undefined) lines.push(reason)
  }

  if (kind === 'turn-truncated') {
    lines.push('модель упёрлась в лимит длины ответа')
  }

  if (kind === 'approval') {
    const access =
      frame.access === 'write'
        ? 'нужен доступ на запись за пределами папки'
        : frame.access === 'full'
          ? 'нужен доступ вне рабочей папки'
          : undefined
    const tool = typeof frame.tool === 'string' && frame.tool !== '' ? `инструмент ${frame.tool}` : undefined
    const parts = [access, tool].filter((p) => p !== undefined)
    if (parts.length > 0) lines.push(parts.join(' · '))
    const note = firstLine(typeof frame.note === 'string' ? frame.note : frame.body, 150)
    if (note !== undefined) lines.push(note)
  }

  if (kind === 'question') {
    const head = firstLine(frame.title, 150) ?? firstLine(frame.detail, 150)
    if (head !== undefined) lines.push(head)
    const count = typeof frame.count === 'number' ? frame.count : 0
    if (count > 1) lines.push(`ещё вопросов: ${count - 1}`)
  }

  if (kind === 'schedule') {
    const note = firstLine(frame.note, 150)
    lines.push(note ?? 'запущено по расписанию')
  }

  return lines.join('\n')
}




