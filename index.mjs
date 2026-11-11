// Derived from the MIT-licensed community OpenDesign plugin:
// https://github.com/magpie-community/plugins/tree/main/packages/opendesign
// Magpie OpenCode-v1 provider plugin, no third-party dependencies.
import { createHash } from 'node:crypto'
import { createVault } from './vault.mjs'
import {
  PROVIDER, CONTROL, MODEL_API, HOURS5, text,
  validWorkspace, normalizeInput, quotaWindows, blockedUsage,
  usable, seedModels, liveModels, modelWire, allowedModelUrl, responseForBlock,
  timestamp
} from './core.mjs'

const TEN_SECONDS = 10000
const API_TIMEOUT = 12000
const SESSION_HEADER = 'OpenDesign local quota guard'

// These are fixed vendor-owned hosts. No credential may be sent to a user
// specified URL. Redirects are disabled to avoid accidental key forwarding.
async function requestJSON(fetcher, base, path, key, { timeout = API_TIMEOUT, signal } = {}) {
  if (![CONTROL, MODEL_API].includes(base)) throw new Error('Untrusted API endpoint')
  const r = await fetcher(base + path, {
    method: 'GET',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    redirect: 'error'
  })
  let body = null
  if (r.ok) body = await r.json().catch(() => null)
  return { ok: r.ok, status: r.status, body }
}

async function preflight(fetcher, controlKey, workspaceId, signal) {
  if (!validWorkspace(workspaceId)) throw new Error('Invalid Workspace ID')
  const r = await requestJSON(fetcher, CONTROL,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`, controlKey, { signal })
  if (!r.ok) {
    const e = new Error(`OpenDesign 额度查询 HTTP ${r.status}`)
    e.status = r.status
    throw e
  }
  return { body: r.body, windows: quotaWindows(r.body?.codingPlan) }
}

async function runtimeModels(fetcher, runtimeKey, signal) {
  const result = await requestJSON(fetcher, MODEL_API, '/models', runtimeKey, { signal })
  if (!result.ok) throw Object.assign(new Error('Runtime Key 校验失败'), { status: result.status, api: 'runtime' })
  try { return liveModels(result.body) } catch { throw new Error('Runtime Key 模型列表无效') }
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 22)
// Only explicit local validation messages may be shown. Upstream errors are
// not surfaced verbatim (even if an SDK accidentally embeds a credential).
const PUBLIC_ERRORS = new Set([
  '账号名称必填，最长 60 字符',
  'Control Key 格式不正确（应为 vela_ctrl_…）',
  'Workspace ID 格式不正确',
  'Runtime Key 格式不正确（应为 sk-amr-…）；不路由可留空',
  '该 Workspace 没有可读的 Design Plan 额度',
  '额度窗口缺少长度、已用、上限或重置时间',
  '重复的额度窗口，无法安全识别',
  '接口没有返回可识别的 5h/7d 窗口',
  '账号未绑定本机凭据，请重新添加',
  'Workspace 与凭据不匹配',
  '加密凭据不存在；请重新添加该账号',
  '加密凭据字段不完整',
  '加密凭据内容无效',
  '无法保存 DPAPI 加密后的凭据文件',
  '插件安装目录不可写，无法保存加密凭据',
  '加密凭据无法读取；请检查文件权限',
  '无法识别插件安装目录（需要本地文件夹安装）',
  'Windows DPAPI 加/解密失败；请确认在同一 Windows 用户下运行 Magpie',
  '安全凭据存储仅支持 Windows（DPAPI）',
  'Runtime Key 模型列表无效'
])
const safeError = (error, signingIn = false) => {
  if (signingIn && error?.name === 'AbortError') return '登录已取消，未保存凭据'
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599)
    return `${error.api === 'runtime' ? 'Runtime Key' : 'OpenDesign 接口'}校验失败（HTTP ${error.status}）`
  const value = typeof error?.message === 'string' ? error.message : ''
  if (PUBLIC_ERRORS.has(value)) return value
  return signingIn ? 'OpenDesign 登录校验失败，请检查连接和账号信息' : 'OpenDesign 额度查询、模型校验或连接失败，已暂停该账号路由'
}

const expired = (e) => e?.status === 401 || e?.status === 403

// Cancelling one model call must not cancel a preflight shared by its peers.
function waitForPreflight(pending, signal) {
  if (!signal) return pending
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => { signal.removeEventListener('abort', onAbort); settle(value) }
    const onAbort = () => finish(reject, signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(value => finish(resolve, value), error => finish(reject, error))
  })
}

function planName(summary) {
  const name = text(summary?.membershipTier)
  return name ? `Design Plan ${name.slice(0, 1).toUpperCase()}${name.slice(1)}` : 'OpenDesign Design Plan'
}

function createPlugin({ configDir, fetcher = globalThis.fetch, vault = createVault(configDir) }) {
  // Cross-account state contains only temporary in-flight work markers.
  // Credentials are read by reference from the correct scoped getAuth().
  const running = new Map()
  const authentication = new Map()
  const beginAuthentication = (auth) => {
    const ref = text(auth?.access) || Symbol()
    const state = authentication.get(ref) ?? { active: 0, latest: null }
    const marker = Symbol()
    state.active++
    state.latest = marker
    authentication.set(ref, state)
    return {
      current: () => state.latest === marker,
      finish() {
        if (--state.active === 0) authentication.delete(ref)
      },
    }
  }
  const getVault = async (auth, signal) => {
    if (!auth || !text(auth.access).startsWith('vlt:')) throw new Error('账号未绑定本机凭据，请重新添加')
    const secret = await vault.read(auth.access, { signal })
    if (secret.workspaceId !== auth.workspaceId) throw new Error('Workspace 与凭据不匹配')
    return secret
  }
  // For concurrent requests from the same account, share only the pending
  // preflight GET. Never keep a stale "unlimited" pass result.
  const guardedRead = async (ref, keys) => {
    const had = running.get(ref)
    if (had) return had
    const pending = preflight(fetcher, keys.controlKey, keys.workspaceId)
    running.set(ref, pending)
    try { return await pending } finally { if (running.get(ref) === pending) running.delete(ref) }
  }
  const verifyAccount = async (inputs, signal) => {
    signal?.throwIfAborted()
    vault.assertSupported?.()
    const data = normalizeInput(inputs)
    // First verify ownership and data shape. Authentication is never saved
    // before a successful plan read; 401/403 never become a usable account.
    await preflight(fetcher, data.controlKey, data.workspaceId, signal)
    if (data.runtimeKey) await runtimeModels(fetcher, data.runtimeKey, signal)
    return data
  }
  const saveAccount = async (data, signal) => {
    signal?.throwIfAborted()
    const ref = await vault.save(data, { signal })
    // The Magpie account store sees only ref, label, workspace and a hash.
    // It never sees the Control or Runtime key in plaintext.
    return {
      type: 'success', access: ref, refresh: '', expires: 0,
      accountId: data.label,
      uid: sha(data.controlKey + '\0' + data.workspaceId),
      workspaceId: data.workspaceId,
      monitorOnly: data.monitorOnly,
      source: 'windows-dpapi-local',
    }
  }
  const readUsage = async (auth) => {
    let keys
    try { keys = await getVault(auth) } catch (e) { return blockedUsage(safeError(e), 'expired') }
    try {
      const reading = await guardedRead(auth.access, keys)
      // Quota access alone cannot prove a routed account's Runtime Key works.
      // Optional billing details never decide its sign-in status.
      const [runtime, billing] = await Promise.allSettled([
        !auth.monitorOnly && keys.runtimeKey ? runtimeModels(fetcher, keys.runtimeKey) : Promise.resolve(null),
        requestJSON(fetcher, CONTROL, '/api/v1/billing/summary', keys.controlKey),
      ])
      const summary = billing.status === 'fulfilled' && billing.value.ok ? billing.value.body : null
      const signIn = runtime.status === 'fulfilled' ? 'renewed' : expired(runtime.reason) ? 'expired' : 'kept'
      const error = runtime.status === 'rejected'
        ? expired(runtime.reason) ? safeError(runtime.reason) : 'Runtime Key 暂时无法验证，登录状态保持不变'
        : undefined
      const renewEnd = timestamp(summary?.subscriptionCurrentPeriodEnd)
      return {
        user: text(auth.accountId),
        plan: planName(summary),
        windows: reading.windows,
        ...(renewEnd ? { until: renewEnd } : {}),
        ...(text(summary?.subscriptionStatus) ? {
          renew: summary?.subscriptionCancelAtPeriodEnd ? 'off' : 'auto'
        } : {}),
        signIn,
        ...(error ? { error } : {}),
      }
    } catch (e) { return blockedUsage(safeError(e), expired(e) ? 'expired' : 'kept') }
  }

  const usage = async (getAuth) => {
    const auth = await getAuth().catch(() => null)
    if (!auth) return blockedUsage('OpenDesign 账号未绑定', 'kept')
    const observation = beginAuthentication(auth)
    try {
      const reading = await readUsage(auth)
      // A late read must not undo a newer decision for the same credentials.
      return observation.current() ? reading : { ...reading, signIn: 'kept' }
    } finally {
      observation.finish()
    }
  }

  const fetchModel = async (auth, input, init, signal) => {
    const req = input instanceof Request ? input : null
    let keys
    try { keys = await getVault(auth, signal) }
    catch { signal?.throwIfAborted(); return responseForBlock('Local credentials unavailable') }
    if (!keys.runtimeKey) return responseForBlock('Monitoring-only account has no Runtime Key')
    // Enforce a fresh read before every upstream model request. This is
    // intentional: if the Magpie GUI quota snapshot lags, do not fall
    // through to OpenDesign's paid wallet silently.
    let reading
    try {
      signal?.throwIfAborted()
      reading = await waitForPreflight(guardedRead(auth.access, keys), signal)
    } catch { signal?.throwIfAborted(); return responseForBlock('OpenDesign allowance could not be verified') }
    if (!usable(reading.windows)) return responseForBlock('OpenDesign 5h or 7d allowance exhausted')
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init?.headers ?? req?.headers)
    const isAnthropic = /\/messages(?:\/count_tokens)?\/?$/.test(new URL(url).pathname)
    headers.delete('authorization')
    headers.delete('x-api-key')
    if (isAnthropic) {
      headers.set('x-api-key', keys.runtimeKey)
      if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
    } else {
      headers.set('authorization', `Bearer ${keys.runtimeKey}`)
    }
    const body = init.body ?? (req && !['GET', 'HEAD'].includes(req.method) ? await req.text() : undefined)
    signal?.throwIfAborted()
    // All model traffic stays on the vendor host, never follows redirects.
    return fetcher(url, {
      ...(req ? { method: req.method } : {}),
      ...init,
      signal,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: 'error',
    })
  }

  const loader = async (getAuth) => {
    const auth = await getAuth().catch(() => null)
    return {
      baseURL: MODEL_API,
      apiKey: 'opendesign-local-dpapi',
      async fetch(input, init = {}) {
        const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
        signal?.throwIfAborted()
        if (!allowedModelUrl(input)) return responseForBlock('Refused non-OpenDesign model endpoint')
        const observation = beginAuthentication(auth)
        try {
          const response = await fetchModel(auth, input, init, signal)
          if (observation.current()) return response
          const headers = new Headers(response.headers)
          headers.set('x-magpie-sign-in', 'kept')
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
        } catch (error) {
          if (!observation.current() && ['expired', 'renewed'].includes(error?.signIn)) {
            throw Object.assign(new Error(safeError(error)), { signIn: 'kept' })
          }
          throw error
        } finally { observation.finish() }
      }
    }
  }

  const models = async (provider, { auth } = {}) => {
    if (auth?.monitorOnly) return {} // Monitor-only accounts never enter routing.
    const observation = beginAuthentication(auth)
    try {
      let keys
      try { keys = await getVault(auth) } catch {
        throw Object.assign(new Error('本机密钥不可用，请重新绑定账号'), { signIn: observation.current() ? 'expired' : 'kept' })
      }
      if (!keys.runtimeKey) return {}
      try {
        return await runtimeModels(fetcher, keys.runtimeKey)
      } catch (e) {
        if (expired(e)) throw Object.assign(new Error('Runtime Key 已失效，请重新绑定'), { signIn: observation.current() ? 'expired' : 'kept' })
        return provider.models // Keep last known catalog for temporary outage.
      }
    } finally { observation.finish() }
  }

  return {
    config: async cfg => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'OpenDesign Local (DPAPI)',
        npm: '@ai-sdk/openai-compatible',
        api: MODEL_API,
        models: seedModels(),
      }
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 3,
      methods: [
        {
          type: 'oauth',
          label: '手动添加账号：Control Key + Workspace（Runtime Key 可选）',
          prompts: [
            { type: 'text', key: 'accountName', message: '账号备注名称（唯一，例：OD-Go-01）', placeholder: 'OD-Go-01', validate: v => text(v) && text(v).length <= 60 ? undefined : '请填写 1～60 字符名称' },
            { type: 'password', key: 'controlKey', message: 'OpenDesign Control Key（隐藏输入）', placeholder: 'vela_ctrl_…', validate: v => text(v) ? undefined : '请输入 Control Key' },
            { type: 'text', key: 'workspaceId', message: 'Workspace ID', placeholder: 'ws……', validate: v => validWorkspace(text(v)) ? undefined : 'Workspace ID 格式不正确' },
            { type: 'password', key: 'runtimeKey', message: 'Runtime Key（sk-amr-…；留空则仅监控不参与路由）', placeholder: 'sk-amr-…（可留空）', validate: v => !text(v) || text(v).startsWith('sk-amr-') ? undefined : 'Runtime Key 格式不正确' },
          ],
          async authorize(inputs, { signal } = {}) {
            try {
              const data = await verifyAccount(inputs, signal)
              return {
                url: '', instructions: '额度验证成功，完成登录时以 Windows DPAPI 保存凭据。',
                method: 'auto', callback: async (_code, { signal: callbackSignal } = {}) => {
                  try { return await saveAccount(data, callbackSignal ?? signal) }
                  catch (e) { return { type: 'failed', error: safeError(e, true) } }
                }
              }
            } catch (e) {
              // Errors are sanitized; never return the values from inputs.
              const msg = safeError(e, true)
              return { type: 'failed', error: msg }
            }
          },
        },
      ],
      loader,
      usage,
    },
    provider: { id: PROVIDER, models }
  }
}

export const OpenDesignManualRoutingPlugin = async (input = {}) => {
  // Magpie supplies its user configuration directory. Older hosts may omit
  // it; createVault then falls back to the Windows user's app-data directory.
  // Provider id remains isolated from pre-existing `open-design` routes.
  return createPlugin({ configDir: text(input.directory) || undefined })
}

// Magpie treats exported functions as plugins and ignores this plain object.
export const _internal = { createPlugin, preflight, requestJSON, safeError, planName, SESSION_HEADER, TEN_SECONDS, HOURS5 }
