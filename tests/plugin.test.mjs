import test from 'node:test'
import assert from 'node:assert/strict'
import * as entry from '../index.mjs'
const { createPlugin } = entry._internal

const mockControl = name => `vela_ctrl_${name}KEY1234567890`
const mockRuntime = name => `sk-amr-${name}KEY1234567890`
const w5=(u)=>({durationSeconds:18000,usedCredits:u,limitCredits:100,resetsAt:'2026-11-11T20:00:00Z'})
const w7=(u)=>({durationSeconds:604800,usedCredits:u,limitCredits:100,resetsAt:'2026-11-17T20:00:00Z'})
const js=(value,code=200)=>new Response(JSON.stringify(value),{status:code,headers:{'content-type':'application/json'}})

function mockServer() {
  const used = { A: [10,20], B:[50,85] }
  const req=[]
  let outage=false
  const fetcher=async(url, init={})=>{
    const header=new Headers(init.headers)
    const bearer=header.get('authorization') || header.get('x-api-key') || ''
    req.push({url, bearer, method:init.method})
    if (url.includes('/billing/preflight')) {
      if (outage) throw new Error('mock outage')
      const a=bearer.includes('AKEY')?'A': 'B'
      return js({balanceUsd:'12.40',codingPlan:{eligible:true,windows:[w5(used[a][0]),w7(used[a][1])]}})
    }
    if (url.endsWith('/billing/summary')) return js({membershipTier:'go'})
    if (url.endsWith('/models')) return js({data:[{id:'deepseek-v4.1-flash'}]})
    if (url.endsWith('/chat/completions')) return js({model:'deepseek-v4.1-flash',choices:[{message:{content:'yes'}}]})
    return js({error:'notfound'},404)
  }
  return {used,req,fetcher,setOutage(v){outage=v}}
}
function memoryVault(){
  const values=new Map()
  let seq=0
  return {save(v){const ref=`vlt:${String(++seq).padStart(32,'0')}`;values.set(ref,v);return ref},read(ref){const v=values.get(ref);if(!v)throw new Error('encrypted credentials missing');return v}}
}

async function login(hooks, name, monitorOnly=false) {
  const method=hooks.auth.methods[0]
  const s=await method.authorize({ accountName:name,controlKey:mockControl(name),workspaceId:`ws-${name}`,runtimeKey:monitorOnly?'':mockRuntime(name)})
  assert.equal(s.method,'auto')
  const auth=await s.callback()
  assert.equal(auth.type,'success')
  assert.equal(JSON.stringify(auth).includes('KEY1234567890'),false)
  return auth
}

test('two account dialogs, independent windows, model listing and request credentials',async()=>{
  const mock=mockServer(),vault=memoryVault(),hooks=createPlugin({configDir:'/not-used',vault,fetcher:mock.fetcher})
  const cfg={provider:{}}
  await hooks.config(cfg)
  assert.ok(cfg.provider['opendesign-local'].models['deepseek-v4.1-flash'])
  assert.deepEqual(hooks.auth.methods[0].prompts.filter(p=>p.type==='password').map(p=>p.key),['controlKey','runtimeKey'])
  const a=await login(hooks,'A')
  const b=await login(hooks,'B')
  const au=await hooks.auth.usage(async()=>a)
  const bu=await hooks.auth.usage(async()=>b)
  assert.equal(au.windows[0].used,10)
  assert.equal(bu.windows[0].used,50)
  assert.equal(au.windows[1].used,20)
  assert.equal(bu.windows[1].used,85)
  assert.ok(au.windows[0].resetsAt)
  assert.ok(bu.windows[0].resetsAt)
  const modelsA=await hooks.provider.models(cfg.provider['opendesign-local'],{auth:a})
  assert.ok(modelsA['deepseek-v4.1-flash'])
  const loadA=await hooks.auth.loader(async()=>a)
  const res=await loadA.fetch('https://amr-link.open-design.ai/v1/chat/completions',{method:'POST',body:'{"model":"deepseek-v4.1-flash"}'})
  assert.equal(res.status,200)
  const last=mock.req.at(-1)
  assert.equal(last.bearer,`Bearer ${mockRuntime('A')}`)
  assert.equal(mock.req.filter(x=>x.url.endsWith('/chat/completions')).length,1)
})

test('fails closed at 5h >=100 even if 7d remains; preflight outage blocks model without wallet spill',async()=>{
  const mock=mockServer(),hooks=createPlugin({configDir:'/none',vault:memoryVault(),fetcher:mock.fetcher})
  const a=await login(hooks,'A')
  mock.used.A=[100,20]
  const usage=await hooks.auth.usage(async()=>a)
  assert.equal(usage.balance,'$12.40')
  assert.equal(usage.windows[0].used,100)
  assert.equal(usage.signIn, 'renewed')
  const load=await hooks.auth.loader(async()=>a)
  assert.equal((await load.fetch('https://amr-link.open-design.ai/v1/chat/completions',{method:'POST'})).status,429)
  assert.equal(mock.req.filter(x=>x.url.endsWith('/chat/completions')).length,0)
  mock.used.A=[20,20]
  mock.setOutage(true)
  const refused=await load.fetch('https://amr-link.open-design.ai/v1/chat/completions',{method:'POST'})
  assert.equal(refused.status,429)
  assert.equal(mock.req.filter(x=>x.url.endsWith('/chat/completions')).length,0)
  const bad=await hooks.auth.usage(async()=>a)
  assert.equal(bad.windows[0].used,100)
  assert.equal(bad.error.length>0,true)
})

test('usage displays the account wallet balance when billing reports a valid USD amount', async () => {
  const mock = mockServer()
  for (const { preflight, summary, summaryStatus, expected } of [
    { preflight: 0, summary: '9.99', expected: '$0.00' },
    { preflight: '4.5', summaryStatus: 503, expected: '$4.50' },
    { summary: '9.99', expected: '$9.99' },
    { preflight: ' ', summary: 2.75, expected: '$2.75' },
    { preflight: '0x10', summary: 2.75, expected: '$2.75' },
    { preflight: null, summary: false, expected: undefined },
    { expected: undefined },
  ]) {
    const hooks = createPlugin({ vault: memoryVault(), fetcher: (url, init) => {
      if (url.includes('/billing/preflight')) {
        return js({ balanceUsd: preflight, codingPlan: { eligible: true, windows: [w5(10), w7(20)] } })
      }
      if (url.endsWith('/billing/summary')) return js({ membershipTier: 'go', balanceUsd: summary }, summaryStatus)
      return mock.fetcher(url, init)
    } })
    const auth = await login(hooks, 'A', true)
    const usage = await hooks.auth.usage(async () => auth)
    assert.equal(usage.balance, expected, JSON.stringify({ preflight, summary, summaryStatus }))
  }
})

test('monitor-only account has quota card but no routed models / calls', async()=>{
  const mock=mockServer(), hooks=createPlugin({configDir:'/none',vault:memoryVault(),fetcher:mock.fetcher})
  const a=await login(hooks,'A',true)
  assert.equal(a.monitorOnly,true)
  const quota=await hooks.auth.usage(async()=>a)
  assert.equal(quota.windows.length,2)
  assert.equal(quota.signIn, 'renewed')
  assert.equal(mock.req.filter(request => request.url.endsWith('/models')).length, 0)
  assert.deepEqual(await hooks.provider.models({models:{}},{auth:a}),{})
  const loader=await hooks.auth.loader(async()=>a)
  assert.equal((await loader.fetch('https://amr-link.open-design.ai/v1/chat/completions',{method:'POST'})).status,429)
})

test('invalid route URL is refused before touching vendor',async()=>{
  const mock=mockServer(),hooks=createPlugin({configDir:'/none',vault:memoryVault(),fetcher:mock.fetcher})
  const a=await login(hooks,'A');const before=mock.req.length
  const load=await hooks.auth.loader(async()=>a)
  assert.equal((await load.fetch('https://untrusted.example/v1/chat/completions',{method:'POST'})).status,429)
  assert.equal(mock.req.length,before)
})

test('when A exhausts, B remains a viable candidate (host routing stays native)',async()=>{
  const mock=mockServer(),hooks=createPlugin({configDir:'/none',vault:memoryVault(),fetcher:mock.fetcher})
  const a=await login(hooks,'A'),b=await login(hooks,'B')
  mock.used.A=[100,25]
  mock.used.B=[20,30]
  const loadA=await hooks.auth.loader(async()=>a)
  const loadB=await hooks.auth.loader(async()=>b)
  const p='https://amr-link.open-design.ai/v1/chat/completions'
  const respA=await loadA.fetch(p,{method:'POST',body:'{}'})
  const respB=await loadB.fetch(p,{method:'POST',body:'{}'})
  assert.equal(respA.status,429)
  assert.equal(respB.status,200)
  const modelCalls=mock.req.filter(x=>x.url.endsWith('/chat/completions'))
  assert.equal(modelCalls.length,1)
  assert.equal(modelCalls[0].bearer,`Bearer ${mockRuntime('B')}`)
})

test('401 control read disables the account without exposing a token',async()=>{
  const mock=mockServer(),vault=memoryVault(),hooks=createPlugin({configDir:'/none',vault,fetcher:async(u,init)=>{
    if(u.includes('/billing/preflight') && mock.used.A[0]===999) return js({error:'unauthorized'},401)
    return mock.fetcher(u,init)
  }})
  const a=await login(hooks,'A')
  mock.used.A=[999,1]
  const result=await hooks.auth.usage(async()=>a)
  assert.equal(result.signIn,'expired')
  assert.equal(result.windows[0].used,100)
  assert.equal(JSON.stringify(result).includes('KEY1234567890'),false)
})

test('host discovers exactly one provider plugin from function exports', async () => {
  const registrations = []
  for (const value of Object.values(entry)) {
    if (typeof value === 'function') registrations.push((await value({})).auth.provider)
  }
  assert.deepEqual(registrations, ['opendesign-local'])
})

test('abandoned sign-in writes nothing until its completion callback', async () => {
  const mock = mockServer(), vault = memoryVault()
  let saves = 0
  const originalSave = vault.save
  vault.save = data => { saves++; return originalSave(data) }
  const hooks = createPlugin({ vault, fetcher: mock.fetcher })
  const step = await hooks.auth.methods[0].authorize({ accountName: 'A', controlKey: mockControl('A'), workspaceId: 'ws-A', runtimeKey: mockRuntime('A') })
  assert.equal(step.method, 'auto')
  assert.equal(saves, 0)
  const result = await step.callback()
  assert.equal(result.type, 'success')
  assert.equal(saves, 1)
})

test('cancelled sign-in callback writes no vault record', async () => {
  const mock = mockServer(), vault = memoryVault()
  let saves = 0
  vault.save = () => { saves++; return 'vlt:unused' }
  const hooks = createPlugin({ vault, fetcher: mock.fetcher })
  const step = await hooks.auth.methods[0].authorize({ accountName: 'A', controlKey: mockControl('A'), workspaceId: 'ws-A' })
  const controller = new AbortController()
  controller.abort()
  assert.equal((await step.callback(undefined, { signal: controller.signal })).type, 'failed')
  assert.equal(saves, 0)
})

test('runtime credential rejection gives a specific sanitized sign-in error', async () => {
  const mock = mockServer()
  const hooks = createPlugin({ vault: memoryVault(), fetcher: (url, init) => url.endsWith('/models') ? js({ error: mockRuntime('A') }, 401) : mock.fetcher(url, init) })
  const result = await hooks.auth.methods[0].authorize({ accountName: 'A', controlKey: mockControl('A'), workspaceId: 'ws-A', runtimeKey: mockRuntime('A') })
  assert.equal(result.type, 'failed')
  assert.match(result.error, /Runtime Key.*401/)
  assert.equal(result.error.includes('KEY1234567890'), false)
  assert.equal(result.error.includes('暂停'), false)
})

test('loader supplies a non-secret SDK key and replaces both SDK authentication headers', async () => {
  const mock = mockServer(), calls = []
  const hooks = createPlugin({ vault: memoryVault(), fetcher: (url, init) => {
    if (/\/messages|\/responses/.test(url)) { calls.push({ url, init }); return js({ ok: true }) }
    return mock.fetcher(url, init)
  } })
  const auth = await login(hooks, 'A'), loader = await hooks.auth.loader(async () => auth)
  assert.equal(typeof loader.apiKey, 'string')
  assert.ok(loader.apiKey.length > 0)
  assert.equal(loader.apiKey.includes('KEY1234567890'), false)
  for (const path of ['/v1/messages', '/v1/messages/count_tokens', '/v1/responses']) {
    const request = new Request('https://amr-link.open-design.ai' + path, { method: 'POST', headers: { authorization: 'Bearer placeholder', 'x-api-key': 'placeholder', 'content-type': 'application/json' }, body: '{"model":"test"}' })
    assert.equal((await loader.fetch(request)).status, 200)
    const { init } = calls.at(-1), headers = new Headers(init.headers)
    const anthropic = path.includes('/messages')
    assert.equal(headers.get(anthropic ? 'x-api-key' : 'authorization'), anthropic ? mockRuntime('A') : `Bearer ${mockRuntime('A')}`)
    assert.equal(headers.has(anthropic ? 'authorization' : 'x-api-key'), false)
    assert.equal(init.body, '{"model":"test"}')
    assert.equal(init.redirect, 'error')
  }
})

test('model catalog auth rejection expires only that account while outages keep its catalog', async () => {
  const mock = mockServer()
  let status = 200
  const hooks = createPlugin({ vault: memoryVault(), fetcher: (url, init) => url.endsWith('/models') && status !== 200 ? js({}, status) : mock.fetcher(url, init) })
  const auth = await login(hooks, 'A'), provider = { models: { 'known-model': {} } }
  status = 401
  await assert.rejects(hooks.provider.models(provider, { auth }), error => error.signIn === 'expired')
  status = 503
  assert.deepEqual(await hooks.provider.models(provider, { auth }), provider.models)
})

test('Request cancellation reaches the model transport', async () => {
  const mock = mockServer()
  let forwarded
  const hooks = createPlugin({ vault: memoryVault(), fetcher: (url, init) => {
    if (url.endsWith('/chat/completions')) forwarded = init.signal
    return mock.fetcher(url, init)
  } })
  const auth = await login(hooks, 'A'), loader = await hooks.auth.loader(async () => auth)
  const controller = new AbortController()
  const req = new Request('https://amr-link.open-design.ai/v1/chat/completions', { method: 'POST', body: '{}', signal: controller.signal })
  await loader.fetch(req)
  controller.abort()
  assert.ok(forwarded)
  assert.equal(forwarded.aborted, true)
})

test('cancelling one waiter promptly leaves the shared preflight usable by its peer', async () => {
  const mock = mockServer()
  let hold = false, release, started, preflights = 0, modelCalls = 0
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
    if (hold && url.includes('/billing/preflight')) { preflights++; started(); await gate }
    if (url.endsWith('/chat/completions')) { modelCalls++; init.signal?.throwIfAborted() }
    return mock.fetcher(url, init)
  } })
  const auth = await login(hooks, 'A'), loader = await hooks.auth.loader(async () => auth)
  hold = true
  const controller = new AbortController(), url = 'https://amr-link.open-design.ai/v1/chat/completions'
  const cancelled = loader.fetch(url, { method: 'POST', signal: controller.signal }).then(() => 'resolved', error => error.name)
  const peer = loader.fetch(url, { method: 'POST' })
  await ready
  controller.abort()
  let timer
  try {
    const outcome = await Promise.race([cancelled, new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 200) })])
    assert.equal(outcome, 'AbortError')
    assert.equal(modelCalls, 0)
  } finally { clearTimeout(timer); release(); await cancelled }
  assert.equal((await peer).status, 200)
  assert.equal(preflights, 1)
  assert.equal(modelCalls, 1)
})

test('successful quota and fresh runtime validation report sign-in recovery', async () => {
  const mock = mockServer(), hooks = createPlugin({ vault: memoryVault(), fetcher: mock.fetcher })
  const auth = await login(hooks, 'A')
  const before = mock.req.filter(request => request.url.endsWith('/models')).length
  const usage = await hooks.auth.usage(async () => auth)
  assert.equal(usage.signIn, 'renewed')
  assert.equal(usage.windows[0].used, 10)
  assert.equal(mock.req.filter(request => request.url.endsWith('/models')).length, before + 1)
  assert.equal(mock.req.filter(request => request.url.endsWith('/models')).at(-1).bearer, `Bearer ${mockRuntime('A')}`)
})

test('runtime 401 or 403 keeps real quota visible and expires the routed account', async () => {
  for (const status of [401, 403]) {
    const mock = mockServer()
    let rejected = false
    const hooks = createPlugin({ vault: memoryVault(), fetcher: (url, init) => rejected && url.endsWith('/models') ? js({ error: mockRuntime('A') }, status) : mock.fetcher(url, init) })
    const auth = await login(hooks, 'A')
    rejected = true
    const usage = await hooks.auth.usage(async () => auth)
    assert.equal(usage.signIn, 'expired')
    assert.equal(usage.windows[0].used, 10)
    assert.equal(usage.windows[1].used, 20)
    assert.match(usage.error, new RegExp(`Runtime Key.*${status}`))
    assert.equal(JSON.stringify(usage).includes('KEY1234567890'), false)
  }
})

test('uncertain runtime availability preserves sign-in and the real quota without claiming recovery', async () => {
  for (const failure of ['server', 'malformed', 'network']) {
    const mock = mockServer()
    let failing = false
    const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
      if (failing && url.endsWith('/models')) {
        if (failure === 'network') throw new Error(mockRuntime('A'))
        return failure === 'server' ? js({}, 503) : js({ data: [] })
      }
      return mock.fetcher(url, init)
    } })
    const auth = await login(hooks, 'A')
    failing = true
    const usage = await hooks.auth.usage(async () => auth)
    assert.equal(usage.signIn, 'kept')
    assert.equal(usage.windows[0].used, 10)
    assert.ok(usage.error)
    assert.equal(JSON.stringify(usage).includes('KEY1234567890'), false)
  }
})

test('optional summary rejection does not veto verified sign-in recovery', async () => {
  const mock = mockServer()
  const hooks = createPlugin({ vault: memoryVault(), fetcher: (url, init) => url.endsWith('/billing/summary') ? js({}, 401) : mock.fetcher(url, init) })
  const auth = await login(hooks, 'A'), usage = await hooks.auth.usage(async () => auth)
  assert.equal(usage.signIn, 'renewed')
  assert.equal(usage.windows[0].used, 10)
})

test('one runtime rejection and recovery stays scoped to its account without logging in again', async () => {
  const mock = mockServer(), vault = memoryVault()
  let saves = 0, rejectA = false
  const save = vault.save
  vault.save = value => { saves++; return save(value) }
  const hooks = createPlugin({ vault, fetcher: (url, init) => rejectA && url.endsWith('/models') && new Headers(init.headers).get('authorization').includes('AKEY') ? js({}, 401) : mock.fetcher(url, init) })
  const a = await login(hooks, 'A'), b = await login(hooks, 'B')
  rejectA = true
  assert.equal((await hooks.auth.usage(async () => a)).signIn, 'expired')
  assert.equal((await hooks.auth.usage(async () => b)).signIn, 'renewed')
  rejectA = false
  assert.equal((await hooks.auth.usage(async () => a)).signIn, 'renewed')
  assert.equal(saves, 2)
})

test('an older quota read cannot overwrite a newer sign-in decision in either direction', async () => {
  for (const scenario of [{ older: 200, newer: 401, want: 'expired' }, { older: 401, newer: 200, want: 'renewed' }]) {
    const mock = mockServer()
    let status = 200, summaries = 0, release, started
    const gate = new Promise(resolve => { release = resolve })
    const ready = new Promise(resolve => { started = resolve })
    const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
      if (url.endsWith('/models') && status !== 200) return js({}, status)
      if (url.endsWith('/billing/summary') && ++summaries === 1) { started(); await gate }
      return mock.fetcher(url, init)
    } })
    const auth = await login(hooks, 'A')
    status = scenario.older
    const older = hooks.auth.usage(async () => auth)
    await ready
    status = scenario.newer
    try { assert.equal((await hooks.auth.usage(async () => auth)).signIn, scenario.want) }
    finally { release() }
    const late = await older
    assert.equal(late.signIn, 'kept')
    assert.equal(late.windows[0].used, 10)
  }
})

test('a newer model-catalog rejection supersedes an older successful quota read', async () => {
  const mock = mockServer()
  let status = 200, release, started
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
    if (url.endsWith('/models') && status !== 200) return js({}, status)
    if (url.endsWith('/billing/summary')) { started(); await gate }
    return mock.fetcher(url, init)
  } })
  const auth = await login(hooks, 'A'), older = hooks.auth.usage(async () => auth)
  await ready
  status = 401
  try { await assert.rejects(hooks.provider.models({ models: {} }, { auth }), error => error.signIn === 'expired') }
  finally { release() }
  assert.equal((await older).signIn, 'kept')
})

test('a newer model response supersedes an older catalog rejection without a quota read', async () => {
  const mock = mockServer()
  let hold = false, release, started
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
    if (hold && url.endsWith('/models')) { started(); await gate; return js({}, 401) }
    return mock.fetcher(url, init)
  } })
  const auth = await login(hooks, 'A'), loader = await hooks.auth.loader(async () => auth)
  hold = true
  const older = hooks.provider.models({ models: {} }, { auth })
  const observed = older.then(() => 'resolved', error => error.signIn)
  await ready
  try { assert.equal((await loader.fetch('https://amr-link.open-design.ai/v1/chat/completions', { method: 'POST' })).status, 200) }
  finally { release() }
  assert.equal(await observed, 'kept')
})

test('a newer catalog check or cancelled request prevents an older model response from changing sign-in', async () => {
  for (const scenario of [{ next: 'catalog', older: 401, catalog: 200 }, { next: 'catalog', older: 200, catalog: 401 }, { next: 'cancelled', older: 401, catalog: 200 }]) {
    const mock = mockServer()
    let release, started, catalogStatus = 200
    const gate = new Promise(resolve => { release = resolve })
    const ready = new Promise(resolve => { started = resolve })
    const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
      if (url.endsWith('/models') && catalogStatus !== 200) return js({}, catalogStatus)
      if (url.endsWith('/chat/completions')) {
        if (init.signal) { init.signal.throwIfAborted(); return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) }
        started(); await gate
        return new Response('data: payload\n\n', { status: scenario.older, headers: { 'content-type': 'text/event-stream', 'x-test': 'preserved' } })
      }
      return mock.fetcher(url, init)
    } })
    const auth = await login(hooks, 'A'), loader = await hooks.auth.loader(async () => auth)
    const older = loader.fetch('https://amr-link.open-design.ai/v1/chat/completions', { method: 'POST' })
    await ready
    try {
      if (scenario.next === 'catalog') {
        catalogStatus = scenario.catalog
        const catalog = hooks.provider.models({ models: {} }, { auth })
        if (scenario.catalog === 401) await assert.rejects(catalog, error => error.signIn === 'expired')
        else await catalog
      }
      else {
        const controller = new AbortController()
        const newer = loader.fetch('https://amr-link.open-design.ai/v1/chat/completions', { method: 'POST', signal: controller.signal })
        controller.abort()
        await assert.rejects(newer, { name: 'AbortError' })
      }
    } finally { release() }
    const response = await older
    assert.equal(response.status, scenario.older)
    assert.equal(response.headers.get('x-magpie-sign-in'), 'kept')
    assert.equal(response.headers.get('x-test'), 'preserved')
    assert.equal(await response.text(), 'data: payload\n\n')
  }
})

test('a current model response keeps native status semantics and supersedes an older quota result', async () => {
  const mock = mockServer()
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
    if (url.endsWith('/billing/summary')) { started(); await gate }
    if (url.endsWith('/chat/completions')) return js({}, 401)
    return mock.fetcher(url, init)
  } })
  const auth = await login(hooks, 'A'), loader = await hooks.auth.loader(async () => auth)
  const older = hooks.auth.usage(async () => auth)
  await ready
  try {
    const newer = await loader.fetch('https://amr-link.open-design.ai/v1/chat/completions', { method: 'POST' })
    assert.equal(newer.status, 401)
    assert.notEqual(newer.headers.get('x-magpie-sign-in'), 'kept')
  } finally { release() }
  assert.equal((await older).signIn, 'kept')
})

test('a different account does not supersede a pending sign-in recovery', async () => {
  const mock = mockServer()
  let hold = false, release, started
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  const hooks = createPlugin({ vault: memoryVault(), fetcher: async (url, init) => {
    const bearer = new Headers(init.headers).get('authorization')
    if (hold && url.endsWith('/billing/summary') && bearer.includes('AKEY')) { started(); await gate }
    if (hold && url.endsWith('/models') && bearer.includes('BKEY')) return js({}, 401)
    return mock.fetcher(url, init)
  } })
  const a = await login(hooks, 'A'), b = await login(hooks, 'B')
  hold = true
  const older = hooks.auth.usage(async () => a)
  await ready
  try { await assert.rejects(hooks.provider.models({ models: {} }, { auth: b }), error => error.signIn === 'expired') }
  finally { release() }
  assert.equal((await older).signIn, 'renewed')
})
