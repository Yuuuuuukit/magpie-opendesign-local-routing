import test from 'node:test'
import assert from 'node:assert/strict'
import { quotaWindows, blockedUsage, normalizeInput, usable, timestamp, seedModels, liveModels, allowedModelUrl, responseForBlock, PROVIDER } from '../core.mjs'

const at = '2026-11-12T10:11:00.000Z'
const w5 = { durationSeconds: 18000, usedCredits: 25, limitCredits: 100, resetsAt: at }
const w7 = { durationSeconds: 604800, usedCredits: 78.21, limitCredits: 100, resetsAt: at }

test('5h/7d windows are ordered by duration, routeable, with ISO resets', () => {
  const windows = quotaWindows({ eligible:true, windows: [w7, w5] })
  assert.deepEqual(windows.map(w => w.name), ['5 hours', '7 days'])
  assert.deepEqual(windows.map(w => w.used), [25, 78.2])
  assert.equal(windows[0].resetsAt, at)
  assert.equal(windows[0].span, 18000)
  assert.equal(windows[1].span, 604800)
  assert.equal(windows[0].aside, false)
  assert.equal(usable(windows), true)
})

test('7d only plan does not invent a 5h window', () => {
  assert.deepEqual(quotaWindows({ windows:[w7] }).map(w => w.name), ['7 days'])
})

test('refuses missing, ineligible, zero-cap and malformed windows', () => {
  for (const v of [null, {}, { eligible:false, windows:[w7] }, { windows:[] },
    { windows:[{...w5,limitCredits:0}] }, {windows:[{...w5,resetsAt:'invalid'}]},
    { windows:[w5,w5] }, {windows:[{...w5,durationSeconds:1000}]}]) {
    assert.throws(() => quotaWindows(v))
  }
})

test('100%-used blocks either window; bad data yields an explicit 100% block', () => {
  assert.equal(usable(quotaWindows({windows:[w5,{...w7,usedCredits:100}]})),false)
  const b = blockedUsage('test')
  assert.equal(b.windows[0].used,100)
  assert.equal(b.windows[0].aside,false)
})

test('normalize input validates prefixes and allows monitoring-only account', () => {
  const d=normalizeInput({accountName:'OD-01',controlKey:'Bearer vela_ctrl_ABCDEFGHIJKLMNOP',workspaceId:'ws-test-123'})
  assert.equal(d.controlKey,'vela_ctrl_ABCDEFGHIJKLMNOP')
  assert.equal(d.runtimeKey,'')
  assert.equal(d.monitorOnly,true)
  const enabled=normalizeInput({...d,runtimeKey:'sk-amr-abcdefghijklmnop'})
  assert.equal(enabled.monitorOnly,false)
  assert.throws(()=>normalizeInput({...d,workspaceId:'https://bad/'}))
  assert.throws(()=>normalizeInput({...d,controlKey:'sk-amr-abcdef'}))
})

test('timestamp, live/seed model API bindings, and fixed host guard', async () => {
  assert.equal(timestamp(1794478260),new Date(1794478260000).toISOString())
  assert.ok(seedModels()['deepseek-v4.1-flash'])
  const model=liveModels({data:[{id:'deepseek-v4.1-flash',metadata:{context_limit:800000,context_budget:64000}}]})['deepseek-v4.1-flash']
  assert.equal(model.limit.context,800000)
  assert.equal(model.rate,'x0.5')
  assert.equal(model.api.url,'https://amr-link.open-design.ai/v1')
  assert.equal(PROVIDER,'opendesign-local')
  assert.equal(allowedModelUrl('https://amr-link.open-design.ai/v1/chat/completions'),true)
  assert.equal(allowedModelUrl('https://amr-link.open-design.ai/messages'),true)
  assert.equal(allowedModelUrl('https://evil.example/v1/chat/completions'),false)
  assert.equal(allowedModelUrl('http://amr-link.open-design.ai/v1/chat/completions'),false)
  assert.equal(allowedModelUrl('https://amr-link.open-design.ai:433/v1/chat/completions'),false)
  assert.equal(allowedModelUrl('https://amr-link.open-design.ai/v1/models'),false)
  const res=responseForBlock()
  assert.equal(res.status,429)
  assert.equal(res.headers.get('x-magpie-sign-in'),'kept')
})
