/**
 * Pure normalisers for the gateway's four input-request events —
 * `approval.request`, `clarify.request`, `sudo.request`, `secret.request` —
 * and their `*.expire` counterparts.
 *
 * Shared so every structured client (desktop, mobile) reads the wire the same
 * way and cannot drift. Field semantics follow `tui_gateway/server.py`
 * (`_approval_request_payload`, `_clarify_block`, `_block`) and the desktop's
 * `gateway-event/input-requests.ts`:
 *
 * - Approval `choices` are rendered VERBATIM when the gateway sends them —
 *   that is how it enforces Tirith warnings (`allow_permanent: false`) and
 *   smart-mode denials (`smart_denied` → only `once`/`deny`). The derivation
 *   here only fills in for older gateways that omit `choices`, mirroring the
 *   server's own rule.
 * - Clarify choices are trimmed, single-line, ≤200 chars (bare of the
 *   "(Recommended)" suffix); an empty result means "free text".
 * - Sudo carries only a request id; the prompt copy is the client's.
 */

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export const APPROVAL_CHOICES: readonly ApprovalChoice[] = ['once', 'session', 'always', 'deny']

export interface ApprovalRequest {
  kind: 'approval'
  sessionId: string
  requestId: string
  /** Already redacted by the gateway (`gateway.run._redact_approval_command`). */
  command: string
  description: string
  choices: ApprovalChoice[]
  smartDenied: boolean
  patternKeys: string[]
}

export interface ClarifyQuestion {
  /** Server-generated wire id (q0..qN); `clarify.respond` keys answers by it. */
  qid: string
  question: string
  choices: string[] | null
  multiSelect: boolean
}

export interface ClarifyRequest {
  kind: 'clarify'
  sessionId: string
  requestId: string
  question: string
  choices: string[] | null
  multiSelect: boolean
  /** Batch (multi-question) clarify: present instead of question/choices. */
  questions?: ClarifyQuestion[]
  /** Answers already locked server-side (reconnect replay): qid → answer. */
  lockedAnswers?: Record<string, string>
  /** Unix seconds at receipt. */
  receivedAt: number
}

export interface SudoRequest {
  kind: 'sudo'
  sessionId: string
  requestId: string
}

export interface SecretRequest {
  kind: 'secret'
  sessionId: string
  requestId: string
  envVar: string
  prompt: string
}

export type InputRequest = ApprovalRequest | ClarifyRequest | SudoRequest | SecretRequest

export interface InputRequestExpiry {
  kind: 'expire'
  of: 'clarify' | 'sudo' | 'secret'
  sessionId: string
  requestId: string
}

export const RECOMMENDED_LABEL = '(Recommended)'

const MAX_CHOICE_CHARS = 200

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** `"Yes (Recommended)"` → `"Yes"`. */
export function bareChoice(choice: string): string {
  const trimmed = choice.trim()
  return trimmed.endsWith(RECOMMENDED_LABEL)
    ? trimmed.slice(0, trimmed.length - RECOMMENDED_LABEL.length).trim()
    : trimmed
}

/** Keep non-blank, single-line choices whose bare text is ≤200 chars. */
export function normalizeChoices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || trimmed.includes('\n')) continue
    if (bareChoice(trimmed).length > MAX_CHOICE_CHARS) continue
    out.push(trimmed)
  }
  return out
}

export function normalizeQuestions(raw: unknown): ClarifyQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: ClarifyQuestion[] = []
  for (const item of raw) {
    const rec = record(item)
    const qid = str(rec.qid)
    const question = str(rec.question)
    if (!qid || !question) continue
    const choices = normalizeChoices(rec.choices)
    out.push({
      qid,
      question,
      choices: choices.length ? choices : null,
      multiSelect: rec.multi_select === true
    })
  }
  return out
}

/**
 * The gateway sends `choices` explicitly; honour them verbatim (unknown
 * strings dropped). For an older gateway that omits them, derive exactly as
 * `_approval_request_payload` does.
 */
export function approvalChoicesFromPayload(payload: Record<string, unknown>): ApprovalChoice[] {
  if (Array.isArray(payload.choices)) {
    const known = payload.choices.filter(
      (c): c is ApprovalChoice => typeof c === 'string' && (APPROVAL_CHOICES as readonly string[]).includes(c)
    )
    if (known.length) return known
  }
  if (payload.smart_denied === true) return ['once', 'deny']
  const choices: ApprovalChoice[] = ['once']
  if (payload.allow_session !== false) {
    choices.push('session')
    if (payload.allow_permanent !== false) choices.push('always')
  }
  choices.push('deny')
  return choices
}

/**
 * Normalise one gateway event. Returns `null` for events that are not input
 * requests (so callers can chain this in a generic dispatcher).
 */
export function parseInputRequest(
  type: string,
  payload: unknown,
  sessionId: string,
  nowMs: number = Date.now()
): InputRequest | InputRequestExpiry | null {
  const p = record(payload)
  const requestId = str(p.request_id)

  switch (type) {
    case 'approval.request': {
      if (!requestId) return null
      const patternKeys = Array.isArray(p.pattern_keys) ? p.pattern_keys.filter((k): k is string => typeof k === 'string') : []
      return {
        kind: 'approval',
        sessionId,
        requestId,
        command: str(p.command),
        description: str(p.description) || 'dangerous command',
        choices: approvalChoicesFromPayload(p),
        smartDenied: p.smart_denied === true,
        patternKeys
      }
    }
    case 'clarify.request': {
      if (!requestId) return null
      const questions = normalizeQuestions(p.questions)
      const lockedRaw = record(p.answers)
      const lockedAnswers: Record<string, string> = {}
      for (const [qid, answer] of Object.entries(lockedRaw)) {
        if (typeof answer === 'string') lockedAnswers[qid] = answer
      }
      const base = {
        kind: 'clarify' as const,
        sessionId,
        requestId,
        receivedAt: nowMs / 1000,
        ...(Object.keys(lockedAnswers).length ? { lockedAnswers } : {})
      }
      if (questions.length) {
        return { ...base, question: '', choices: null, multiSelect: false, questions }
      }
      const choices = normalizeChoices(p.choices)
      return {
        ...base,
        question: str(p.question),
        choices: choices.length ? choices : null,
        multiSelect: p.multi_select === true
      }
    }
    case 'sudo.request':
      return requestId ? { kind: 'sudo', sessionId, requestId } : null
    case 'secret.request':
      return requestId
        ? { kind: 'secret', sessionId, requestId, envVar: str(p.env_var), prompt: str(p.prompt) }
        : null
    case 'clarify.expire':
      return requestId ? { kind: 'expire', of: 'clarify', sessionId, requestId } : null
    case 'sudo.expire':
      return requestId ? { kind: 'expire', of: 'sudo', sessionId, requestId } : null
    case 'secret.expire':
      return requestId ? { kind: 'expire', of: 'secret', sessionId, requestId } : null
    default:
      return null
  }
}

/** Parse a settled single-clarify tool result (`{question, user_response}`). */
export function readClarifyResult(result: unknown): { question: string; answer: string } | null {
  const rec = record(result)
  const question = str(rec.question)
  if (!question && !('user_response' in rec)) return null
  return { question, answer: str(rec.user_response) }
}
