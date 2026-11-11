import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Opt-in: the caller supplies its installed Magpie host, never an account file.
test('installed Windows Magpie host loads the release with isolated accounts and real DPAPI', {
  skip: process.platform !== 'win32' || !process.env.MAGPIE_HOST_SCRIPT,
  timeout: 60000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'od-isolated-host-'))
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const stateFile = join(root, 'state.json'), authPath = join(root, 'plugin-auth.json')
  writeFileSync(stateFile, JSON.stringify({ used: { A: 10, B: 30 }, outage: false, modelCalls: [] }))
  const child = spawn(process.execPath, ['--preload', join(source, 'tests', 'fixtures', 'mock-vendor-preload.mjs'), process.env.MAGPIE_HOST_SCRIPT], {
    cwd: root, env: { ...process.env, OD_TEST_STATE: stateFile }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const pending = new Map(), notices = []
  let sequence = 0, errors = ''
  child.stderr.on('data', data => { errors += data })
  child.on('error', error => { for (const p of pending.values()) p.reject(error); pending.clear() })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const message = JSON.parse(line), slot = pending.get(message.id)
    if (!slot) { notices.push(message); return }
    if (message.event) { slot.events.push(message); return }
    clearTimeout(slot.timer); pending.delete(message.id)
    if (message.error) slot.reject(new Error(message.error.message))
    else slot.resolve({ value: message.result, events: slot.events })
  })
  const rpc = (method, params) => new Promise((resolveResult, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Isolated host timeout: ${method}; ${errors}`)) }, 20000)
    pending.set(id, { resolve: resolveResult, reject, timer, events: [] })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const changeState = change => { const value = state(); change(value); writeFileSync(stateFile, JSON.stringify(value)) }
  try {
    const init = await rpc('init', { directory: root, authPath, plugins: [{ spec: 'isolated-local-release', target: source }] })
    assert.equal(init.value.plugins.length, 1)
    assert.equal(init.value.plugins[0].error, undefined)
    const accounts = {}
    for (const name of ['A', 'B']) {
      const step = await rpc('authorize', { provider: 'opendesign-local', method: 0, inputs: { accountName: name, controlKey: `vela_ctrl_${name}KEY1234567890`, workspaceId: `ws-${name}`, runtimeKey: `sk-amr-${name}KEY1234567890` } })
      assert.equal(step.value.ok, true)
      assert.equal(step.value.url, '')
      assert.equal(readdirSync(root).some(file => file.endsWith('.dpapi')), false)
      const signedIn = await rpc('callback', { session: step.value.session })
      assert.equal(signedIn.value.ok, true)
      accounts[name] = signedIn.value.account
    }
    const serializedAuth = readFileSync(authPath, 'utf8')
    assert.equal(serializedAuth.includes('KEY1234567890'), false)
    assert.equal(readdirSync(join(root, 'opendesign-local-routing-vault')).length, 2)
    const usageA = (await rpc('usage', { provider: 'opendesign-local', account: accounts.A })).value
    const usageB = (await rpc('usage', { provider: 'opendesign-local', account: accounts.B })).value
    assert.equal(usageA.windows[0].used, 10)
    assert.equal(usageB.windows[0].used, 30)
    assert.equal(usageA.signIn, 'renewed')
    changeState(value => { value.runtimeStatus = 401 })
    const refused = (await rpc('usage', { provider: 'opendesign-local', account: accounts.A })).value
    assert.equal(refused.signIn, 'expired')
    assert.equal(refused.windows[0].used, 10)
    changeState(value => { value.runtimeStatus = 503 })
    assert.equal((await rpc('usage', { provider: 'opendesign-local', account: accounts.A })).value.signIn, 'kept')
    changeState(value => { value.runtimeStatus = 0 })
    assert.equal((await rpc('usage', { provider: 'opendesign-local', account: accounts.A })).value.signIn, 'renewed')
    const options = (await rpc('load', { provider: 'opendesign-local', account: accounts.A })).value
    assert.ok(options.apiKey)
    assert.equal(options.apiKey.includes('KEY1234567890'), false)
    const fetch = (account, path, npm) => rpc('fetch', { provider: 'opendesign-local', account, model: 'test', npm, url: 'https://amr-link.open-design.ai' + path, method: 'POST', body: Buffer.from('{"model":"test","stream":true}').toString('base64') })
    for (const [path, npm] of [['/v1/chat/completions', '@ai-sdk/openai-compatible'], ['/v1/responses', '@ai-sdk/openai'], ['/v1/messages', '@ai-sdk/anthropic']]) {
      const response = await fetch(accounts.A, path, npm)
      assert.equal(response.events.find(event => event.event === 'head').status, 200)
      const body = response.events.filter(event => event.event === 'chunk').map(event => Buffer.from(event.data, 'base64').toString()).join('')
      assert.equal(body, 'data: {"text":"test"}\n\ndata: [DONE]\n\n')
    }
    changeState(value => { value.used.A = 100 })
    assert.equal((await fetch(accounts.A, '/v1/chat/completions', '@ai-sdk/openai-compatible')).events[0].status, 429)
    assert.equal((await fetch(accounts.B, '/v1/chat/completions', '@ai-sdk/openai-compatible')).events[0].status, 200)
    changeState(value => { value.outage = true })
    assert.equal((await fetch(accounts.B, '/v1/chat/completions', '@ai-sdk/openai-compatible')).events[0].status, 429)
    assert.equal(state().modelCalls.length, 4)
    assert.deepEqual(state().modelCalls.map(call => call.account), ['A', 'A', 'A', 'B'])
    assert.equal(existsSync(join(source, '.opendesign-local-routing-vault')), false)
    assert.equal(JSON.stringify(notices).includes('KEY1234567890'), false)
  } finally {
    for (const slot of pending.values()) clearTimeout(slot.timer)
    lines.close()
    const stopped = once(child, 'close')
    child.stdin.end()
    child.kill()
    await stopped
    rmSync(root, { recursive: true, force: true })
  }
})
