// Pure data / model / policy functions. No secrets, filesystem or network.
import { MODELS } from './models.mjs'
import { RATES } from './rates.mjs'

export const PROVIDER = 'opendesign-local'
export const CONTROL = 'https://amr-api.open-design.ai'
export const MODEL_API = 'https://amr-link.open-design.ai/v1'
export const HOURS5 = 18000
export const DAYS7 = 604800
const HOUR = 3600
const WEEK = DAYS7

export const text = (s) => typeof s === 'string' ? s.trim() : ''
export const stripBearer = (s) => text(s).replace(/^Bearer\s+/i, '').trim()
export const validWorkspace = (s) => /^[A-Za-z0-9_-]{2,128}$/.test(s)
export const validControlKey = (s) => /^vela_ctrl_[A-Za-z0-9_\-]+$/.test(s) && s.length >= 16
export const validRuntimeKey = (s) => /^sk-amr-[A-Za-z0-9_\-]+$/.test(s) && s.length >= 12
export const bounded = (s, max = 60) => text(s).slice(0, max)

export function normalizeInput(data = {}) {
  const label = text(data.label || data.accountName)
  const workspaceId = text(data.workspaceId)
  const controlKey = stripBearer(data.controlKey)
  const runtimeKey = stripBearer(data.runtimeKey)
  if (!label || label.length > 60 || /[\r\n\x00-\x1f]/.test(label)) throw new Error('账号名称必填，最长 60 字符')
  if (!validControlKey(controlKey)) throw new Error('Control Key 格式不正确（应为 vela_ctrl_…）')
  if (!validWorkspace(workspaceId)) throw new Error('Workspace ID 格式不正确')
  if (runtimeKey && !validRuntimeKey(runtimeKey)) throw new Error('Runtime Key 格式不正确（应为 sk-amr-…）；不路由可留空')
  return { label, workspaceId, controlKey, runtimeKey, monitorOnly: !runtimeKey }
}

export function timestamp(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number'
    ? (value < 1e11 ? value * 1000 : value)
    : (typeof value === 'string' && /^\d{10,13}$/.test(value)
      ? (Number(value) < 1e11 ? Number(value) * 1000 : Number(value))
      : Date.parse(value))
  if (!Number.isFinite(parsed)) return undefined
  try { return new Date(parsed).toISOString() } catch { return undefined }
}

export function quotaName(seconds) {
  if (seconds === HOURS5) return '5 hours'
  if (seconds === DAYS7) return '7 days'
  if (seconds % WEEK === 0) return `${seconds / WEEK * 7} days`
  if (seconds % HOUR === 0) return `${seconds / HOUR} hours`
  return `${Math.ceil(seconds / 60)} minutes`
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

export function formatWalletBalance(value) {
  if (typeof value === 'string' && /^0[xbo]/i.test(value.trim())) return undefined
  const amount = num(value)
  return amount === null ? undefined : `$${amount.toFixed(2)}`
}

// On invalid/incomplete quota do NOT pretend zero use. Throw so the caller
// produces a hard block window and prevents any account routing.
export function quotaWindows(plan) {
  if (!plan || plan.eligible === false || !Array.isArray(plan.windows) || !plan.windows.length) {
    throw new Error('该 Workspace 没有可读的 Design Plan 额度')
  }
  const windows = []
  const seen = new Set()
  for (const raw of plan.windows) {
    const duration = num(raw?.durationSeconds)
    const used = num(raw?.usedCredits)
    const limit = num(raw?.limitCredits)
    const resetsAt = timestamp(raw?.resetsAt)
    if (!Number.isInteger(duration) || duration < 60 || limit === null || limit <= 0 || used === null || used < 0 || !resetsAt) {
      throw new Error('额度窗口缺少长度、已用、上限或重置时间')
    }
    if (seen.has(duration)) throw new Error('重复的额度窗口，无法安全识别')
    seen.add(duration)
    windows.push({
      name: quotaName(duration),
      used: Math.round((used / limit) * 1000) / 10,
      span: duration,
      resetsAt,
      display: `${Math.round(used * 100) / 100} / ${Math.round(limit * 100) / 100} credits`,
      amount: used,
      limit,
      unit: 'credits',
      aside: false
    })
  }
  // Go has 5h and 7d windows. Some higher plans have only 7d; don't create
  // a fake 5h quota. Reject mixed unrecognized duration windows only when
  // the server didn't give any known 5h or 7d window at all.
  if (!seen.has(HOURS5) && !seen.has(DAYS7)) throw new Error('接口没有返回可识别的 5h/7d 窗口')
  return windows.sort((a, b) => a.span - b.span)
}

export function blockedUsage(message = '额度不可用，已禁止路由', signIn = 'kept') {
  return {
    plan: 'OpenDesign · Quota blocked',
    error: message,
    windows: [{ name: 'Quota unavailable (routing blocked)', used: 100, span: HOURS5, aside: false }],
    signIn
  }
}

export function usable(windows) {
  return Array.isArray(windows) && windows.length > 0 && windows.every(w => Number.isFinite(w.used) && w.used < 100 && !w.aside)
}

export function modelWire(id) {
  if (id === 'claude-haiku-5.5' || id === 'deepseek-v4-pro') return '@ai-sdk/openai'
  if (id === 'glm-5.3-flash') return '@ai-sdk/anthropic'
  return '@ai-sdk/openai-compatible'
}

const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf']
const modelSeed = (id, facts = {}) => {
  const m = MODELS[id] ?? {}
  const meta = facts?.metadata ?? {}
  const inputFromVendor = facts?.architecture?.input_modalities
  const input = new Set(['text', ...(m.input ?? []), ...(Array.isArray(inputFromVendor) ? inputFromVendor : [])])
  // OpenDesign uses "file" in catalog; Magpie calls generic files "pdf".
  if (input.has('file')) input.add('pdf')
  const context = Number(meta.context_limit) > 0 ? Number(meta.context_limit) : (m.context ?? 200000)
  const vendorOutput = Number(meta.context_budget) > 0 ? Number(meta.context_budget) : (m.output ?? 32000)
  const cap = ({ 'glm-5.3-flash': 131072, 'gemini-3.8-flash': 65536 })[id] ?? Infinity
  const output = Math.min(vendorOutput, cap)
  const rate = RATES[id]
  const efforts = m.efforts ?? []
  const npm = modelWire(id)
  return {
    id, name: m.name || text(facts?.name) || id,
    api: { id, url: MODEL_API, npm },
    provider: { npm, api: MODEL_API },
    limit: { context, output },
    tool_call: true, attachment: true,
    reasoning: efforts.length > 0 || text(meta.capability) === 'advanced',
    ...(efforts.length && { variants: Object.fromEntries(efforts.map(e => [e, { reasoningEffort: e }])) }),
    ...(rate !== undefined ? { rate: `x${rate}` } : {}),
    modalities: { input: MODALITIES.filter(k => input.has(k)), output: ['text'] }
  }
}

export function seedModels() {
  return Object.fromEntries(Object.keys(MODELS).map(id => [id, modelSeed(id)]))
}

export function liveModels(catalog) {
  if (!Array.isArray(catalog?.data)) throw new Error('模型接口未返回 data 数组')
  const mapped = Object.fromEntries(catalog.data
    .filter(m => text(m?.id))
    .map(m => [m.id, modelSeed(m.id, m)]))
  if (!Object.keys(mapped).length) throw new Error('模型列表为空')
  return mapped
}

export function responseForBlock(reason = 'OpenDesign allowance is unavailable') {
  return new Response(JSON.stringify({ error: { type: 'rate_limit_error', code: 'quota_guard_blocked', message: reason } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '30',
      'x-magpie-sign-in': 'kept',
      'cache-control': 'no-store'
    }
  })
}

export function allowedModelUrl(input) {
  let url
  try { url = new URL(input instanceof Request ? input.url : String(input)) } catch { return false }
  return url.protocol === 'https:' && url.hostname === 'amr-link.open-design.ai' && !url.port &&
    (/^\/v1\/(chat\/completions|responses|messages)(?:\/count_tokens)?\/?$/.test(url.pathname) || /^\/messages(?:\/count_tokens)?\/?$/.test(url.pathname))
}
