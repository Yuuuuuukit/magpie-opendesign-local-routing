import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVault, defaultVaultBase, pluginInstallDirectory, validVaultRef, dpapi } from '../vault.mjs'

test('vault writes only protected blob; account metadata uses a reference', async () => {
  const dir=mkdtempSync(join(tmpdir(),'od-plugin-test-'))
  try {
    // This fake cipher validates file routing only; real Windows uses DPAPI.
    const cipher = (mode, val) => mode==='protect'
      ? Buffer.from('ENCRYPTED/'+val).toString('base64')
      : Buffer.from(val,'base64').toString('utf8').slice('ENCRYPTED/'.length)
    const v=createVault(dir,cipher)
    const ref=await v.save({controlKey:'vela_ctrl_SAMPLETESTSECRET',runtimeKey:'sk-amr-SAMPLETESTSECRET',workspaceId:'ws-12345'})
    assert.ok(validVaultRef(ref))
    assert.deepEqual(await v.read(ref),{
      controlKey:'vela_ctrl_SAMPLETESTSECRET',runtimeKey:'sk-amr-SAMPLETESTSECRET',workspaceId:'ws-12345'
    })
    const path=join(v.path,readdirSync(v.path)[0]);const content=readFileSync(path,'utf8')
    assert.ok(!content.includes('SAMPLETESTSECRET'))
    assert.ok(!content.includes('vela_ctrl'))
    await assert.rejects(async()=>v.read('vlt:../../../other'))
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('DPAPI refuses plaintext fallback on other operating systems', {skip: process.platform==='win32'}, async () => {
  await assert.rejects(async()=>dpapi('protect','secret'),/Windows/)
})


test('legacy user data path is retained for v1.0.1 migration, not for new writes', () => {
  assert.equal(defaultVaultBase({env:{LOCALAPPDATA:'/users/a/AppData/Local', APPDATA:'/users/a/AppData/Roaming'},home:'/home/unused'}),
    join('/users/a/AppData/Local','Magpie'))
  assert.equal(defaultVaultBase({env:{APPDATA:'/users/a/Roaming'},home:'/home/unused'}), join('/users/a/Roaming','Magpie'))
  assert.equal(defaultVaultBase({env:{USERPROFILE:'/users/a'},home:'/home/unused'}), join('/users/a','AppData','Local','Magpie'))
})

test('missing host directory is no longer an initialization blocker', async () => {
  const {OpenDesignManualRoutingPlugin}=await import('../index.mjs')
  const hooks=await OpenDesignManualRoutingPlugin()
  assert.equal(hooks.auth.provider,'opendesign-local')
  assert.ok(hooks.auth.methods[0].prompts.some(p=>p.key==='workspaceId'))
})


test('default vault uses stable user data while the old install path stays discoverable', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..')
  assert.equal(pluginInstallDirectory(), src)
  assert.equal(createVault().path, join(defaultVaultBase(), 'opendesign-local-routing-vault'))
  assert.equal(pluginInstallDirectory(new URL('../vault.mjs', import.meta.url).href), src)
})

test('new records use the host directory and both old vault locations remain read-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'od-vault-upgrade-'))
  const cipher = (mode, val) => mode === 'protect'
    ? Buffer.from('ENCRYPTED/' + val).toString('base64')
    : Buffer.from(val, 'base64').toString('utf8').slice('ENCRYPTED/'.length)
  try {
    const install = join(root, 'host config folder')
    const legacy = join(root, 'old-localappdata-vault')
    const legacyInstall = join(root, 'old-plugin-vault')
    mkdirSync(install)
    mkdirSync(legacy)
    mkdirSync(legacyInstall)
    const record = {controlKey: 'vela_ctrl_OLDTESTSECRET', runtimeKey: 'sk-amr-OLDTESTSECRET', workspaceId: 'ws-legacy'}
    const legacySource = createVault(join(root,'legacy-source'), cipher)
    const oldRef = await legacySource.save(record)
    copyFileSync(join(legacySource.path, oldRef.slice(4)+'.dpapi'), join(legacy,oldRef.slice(4)+'.dpapi'))
    const secondRef = await legacySource.save({ ...record, workspaceId: 'ws-install' })
    copyFileSync(join(legacySource.path, secondRef.slice(4)+'.dpapi'), join(legacyInstall, secondRef.slice(4)+'.dpapi'))
    const selected = createVault(install, cipher, {legacyDirs:[legacy, legacyInstall]})
    assert.deepEqual(await selected.read(oldRef), record)
    assert.deepEqual(await selected.read(secondRef), { ...record, workspaceId: 'ws-install' })
    assert.equal(existsSync(selected.path), false, 'reading legacy must not create new data files')
    const newRef = await selected.save({controlKey:'vela_ctrl_NEWTESTSECRET', runtimeKey:'', workspaceId:'ws-new'})
    assert.ok(existsSync(join(install, 'opendesign-local-routing-vault', newRef.slice(4)+'.dpapi')))
    assert.ok(!existsSync(join(legacy, newRef.slice(4)+'.dpapi')))
    assert.equal(readdirSync(legacy).length, 1)
    assert.equal(readdirSync(legacyInstall).length, 1)
    assert.deepEqual(await selected.read(oldRef), record)
    assert.deepEqual(await selected.read(newRef), {controlKey:'vela_ctrl_NEWTESTSECRET', runtimeKey:'', workspaceId:'ws-new'})
  } finally {
    rmSync(root, {recursive:true,force:true})
  }
})

test('invalid references do not reach legacy lookup', async () => {
  const base = mkdtempSync(join(tmpdir(), 'od-vault-ref-'))
  try {
    const v = createVault(base, () => { throw Error('cipher should not be reached') }, {legacyDir:join(base,'old')})
    await assert.rejects(async() => v.read('vlt:../malicious'), /Invalid vault reference/)
  } finally { rmSync(base, {recursive:true,force:true}) }
})

test('Windows production DPAPI yields the event loop and roundtrips UTF-8', { skip: process.platform !== 'win32' }, async () => {
  let timerRan = false
  const timer = setTimeout(() => { timerRan = true }, 0)
  try {
    const encrypted = await dpapi('protect', 'DPAPI-TEST-中文-123')
    assert.equal(timerRan, true, 'DPAPI must allow host timers and streams to progress')
    assert.equal(encrypted.includes('DPAPI-TEST'), false)
    assert.equal(await dpapi('unprotect', encrypted), 'DPAPI-TEST-中文-123')
    await assert.rejects(async () => dpapi('unprotect', 'corrupt'), /DPAPI/)
  } finally { clearTimeout(timer) }
})

test('Windows production vault saves and reads only disposable test credentials', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'od-real-dpapi-test-'))
  try {
    const vault = createVault(root)
    const record = { controlKey: 'vela_ctrl_DISPOSABLE_TEST', runtimeKey: 'sk-amr-DISPOSABLE_TEST', workspaceId: 'ws-disposable' }
    const ref = await vault.save(record)
    assert.deepEqual(await vault.read(ref), record)
    const blob = readFileSync(join(vault.path, ref.slice(4) + '.dpapi'), 'utf8')
    assert.equal(blob.includes('DISPOSABLE_TEST'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('invalid decrypted credential fields are rejected before they can reach a vendor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'od-invalid-record-'))
  const ref = 'vlt:00000000-0000-4000-8000-000000000000'
  const good = { controlKey: 'vela_ctrl_DISPOSABLE_TEST', runtimeKey: 'sk-amr-DISPOSABLE_TEST', workspaceId: 'ws-disposable' }
  try {
    for (const bad of [{ ...good, runtimeKey: 42 }, { ...good, controlKey: 'untrusted' }, { ...good, workspaceId: '../other' }]) {
      const vault = createVault(root, () => JSON.stringify(bad))
      mkdirSync(vault.path, { recursive: true })
      writeFileSync(join(vault.path, ref.slice(4) + '.dpapi'), 'test-ciphertext')
      await assert.rejects(async () => vault.read(ref), /加密凭据/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cancelling encryption before save leaves no credential file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'od-cancel-save-'))
  const controller = new AbortController()
  try {
    const cipher = async () => { controller.abort(); return Buffer.from('protected-ciphertext-test').toString('base64') }
    const vault = createVault(root, cipher)
    await assert.rejects(async () => vault.save({ controlKey: 'vela_ctrl_DISPOSABLE_TEST', workspaceId: 'ws-disposable' }, { signal: controller.signal }), { name: 'AbortError' })
    assert.equal(existsSync(vault.path), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
