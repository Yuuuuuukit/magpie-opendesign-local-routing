// Only used by the opt-in isolated-host test. Unknown destinations never network.
import { readFileSync, writeFileSync } from 'node:fs'

const stateFile = process.env.OD_TEST_STATE
if (!stateFile) throw new Error('Missing isolated vendor state')
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const headers = new Headers(init.headers)
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  if (url.origin === 'https://amr-api.open-design.ai' && url.pathname.endsWith('/billing/preflight')) {
    if (state.outage) return json({}, 503)
    const account = url.pathname.includes('/ws-A/') ? 'A' : 'B'
    if (headers.get('authorization') !== `Bearer vela_ctrl_${account}KEY1234567890`) return json({}, 401)
    return json({ balanceUsd: account === 'A' ? '12.40' : 0, codingPlan: { eligible: true, windows: [
      { durationSeconds: 18000, usedCredits: state.used[account], limitCredits: 100, resetsAt: '2030-11-11T20:00:00Z' },
      { durationSeconds: 604800, usedCredits: 20, limitCredits: 100, resetsAt: '2030-11-17T20:00:00Z' },
    ] } })
  }
  if (url.origin === 'https://amr-api.open-design.ai' && url.pathname === '/api/v1/billing/summary') return json({ membershipTier: 'test' })
  if (url.origin === 'https://amr-link.open-design.ai' && url.pathname === '/v1/models') {
    if (state.runtimeStatus) return json({}, state.runtimeStatus)
    return json({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'claude-haiku-5.5' }, { id: 'glm-5.3-flash' }] })
  }
  if (url.origin === 'https://amr-link.open-design.ai' && ['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url.pathname)) {
    const key = headers.get(url.pathname === '/v1/messages' ? 'x-api-key' : 'authorization')
    const account = key?.includes('AKEY') ? 'A' : key?.includes('BKEY') ? 'B' : ''
    const expected = `${url.pathname === '/v1/messages' ? '' : 'Bearer '}sk-amr-${account}KEY1234567890`
    if (!account || key !== expected) return json({ error: 'wrong test credential' }, 401)
    state.modelCalls.push({ account, path: url.pathname })
    writeFileSync(stateFile, JSON.stringify(state))
    return new Response('data: {"text":"test"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  throw new Error('Isolated test refused an unexpected destination')
}
