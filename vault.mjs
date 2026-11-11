// Windows-only vault. Actual Control / Runtime keys never enter Magpie's
// plugin-auth.json or plugin options. They are encrypted by Windows DPAPI,
// scoped to the current Windows user, under Magpie's user configuration
// directory (or Windows user app data when the host omits that directory).
// This is NOT a claim that a compromised Windows user cannot access them.
// Both old vault locations remain readable without moving or deleting files.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { validControlKey, validRuntimeKey, validWorkspace } from './core.mjs'

const vaultRef = /^vlt:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
export const validVaultRef = (ref) => typeof ref === 'string' && vaultRef.test(ref)

// A static, non-secret command is passed to PowerShell's argv. The secret
// payload flows exclusively through a pipe on stdin / stdout, not argv.
// No temporary PowerShell script, command history or plaintext credential file.
const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $payload = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($payload)) { throw 'empty' }
  Add-Type -AssemblyName System.Security
  $plain = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $encrypted = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope)
  [Console]::Out.Write([Convert]::ToBase64String($encrypted))
} catch { [Console]::Error.Write('DPAPI_FAILURE'); exit 11 }
`
const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $payload = [Console]::In.ReadToEnd().Trim()
  Add-Type -AssemblyName System.Security
  $cipher = [Convert]::FromBase64String($payload)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, $scope)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
} catch { [Console]::Error.Write('DPAPI_FAILURE'); exit 11 }
`

function assertWindows() {
  if (process.platform !== 'win32') throw new Error('安全凭据存储仅支持 Windows（DPAPI）')
}

export async function dpapi(mode, payload, { signal } = {}) {
  assertWindows()
  const script = mode === 'protect' ? protectScript : mode === 'unprotect' ? unprotectScript : null
  if (!script) throw new Error('Unsupported DPAPI operation')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const exe = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  return new Promise((resolve, reject) => {
    const failure = () => new Error('Windows DPAPI 加/解密失败；请确认在同一 Windows 用户下运行 Magpie')
    const child = execFile(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, shell: false,
      timeout: 15000, maxBuffer: 1024 * 1024, signal,
    }, (error, stdout) => {
      if (error || !stdout?.trim()) reject(error?.name === 'AbortError' ? error : failure())
      else resolve(stdout.trim())
    })
    child.stdin.on('error', () => { child.kill(); reject(failure()) })
    child.stdin.end(payload)
  })
}

// Used only to locate v1.0.2's legacy vault, never for new writes.
export function pluginInstallDirectory(moduleUrl = import.meta.url) {
  if (typeof moduleUrl !== 'string' || !moduleUrl.startsWith('file:')) {
    throw new Error('无法识别插件安装目录（需要本地文件夹安装）')
  }
  return dirname(fileURLToPath(moduleUrl))
}

// Stable fallback when the host does not provide its user configuration path.
export function defaultVaultBase({ env = process.env, home = homedir() } = {}) {
  const clean = (v) => typeof v === 'string' ? v.trim() : ''
  const local = clean(env.LOCALAPPDATA)
  const roaming = clean(env.APPDATA)
  const profile = clean(env.USERPROFILE) || clean(home)
  const base = local || roaming || (profile ? join(profile, 'AppData', 'Local') : '')
  if (!base) throw new Error('Windows user data directory unavailable')
  return join(base, 'Magpie')
}

export function createVault(configDir, cipher = dpapi, { legacyDirs } = {}) {
  const explicit = typeof configDir === 'string' && !!configDir.trim()
  const base = explicit ? configDir.trim() : defaultVaultBase()
  const dir = join(base, 'opendesign-local-routing-vault')
  // Read old refs only when missing from the primary store. No scans,
  // migrations or deletions: another installation may still use those refs.
  const old = legacyDirs ?? [
    join(pluginInstallDirectory(), '.opendesign-local-routing-vault'),
    join(defaultVaultBase(), 'opendesign-local-routing-vault'),
  ]
  const pathOf = (ref) => {
    if (!validVaultRef(ref)) throw new Error('Invalid vault reference')
    return join(dir, ref.slice(4).toLowerCase() + '.dpapi')
  }
  return {
    path: dir,
    assertSupported() { if (cipher === dpapi) assertWindows() },
    async save(record, { signal } = {}) {
      signal?.throwIfAborted()
      const plaintext = JSON.stringify({ controlKey: record.controlKey, runtimeKey: record.runtimeKey || '', workspaceId: record.workspaceId })
      const encrypted = await cipher('protect', plaintext, { signal })
      signal?.throwIfAborted()
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted) || encrypted.length < 20) {
        throw new Error('DPAPI did not return a valid ciphertext')
      }
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }) }
      catch { throw new Error('插件安装目录不可写，无法保存加密凭据') }
      const ref = 'vlt:' + randomUUID()
      const destination = pathOf(ref)
      const temp = destination + '.tmp-' + randomUUID()
      try {
        writeFileSync(temp, encrypted + '\n', { flag: 'wx', mode: 0o600 })
        renameSync(temp, destination)
      } catch {
        try { rmSync(temp, { force: true }) } catch {}
        throw new Error('无法保存 DPAPI 加密后的凭据文件')
      }
      return ref
    },
    async read(ref, { signal } = {}) {
      signal?.throwIfAborted()
      const primary = pathOf(ref) // validates `vlt:` before any disk access
      let cipherText = ''
      let found = false
      const candidates = [primary]
      for (const legacy of new Set(old)) {
        if (legacy && legacy !== dir) candidates.push(join(legacy, ref.slice(4).toLowerCase() + '.dpapi'))
      }
      for (const file of candidates) {
        try {
          cipherText = readFileSync(file, 'utf8').trim()
          found = true
          break
        } catch (error) {
          if (error?.code === 'ENOENT') continue
          throw new Error('加密凭据无法读取；请检查文件权限')
        }
      }
      if (!found) throw new Error('加密凭据不存在；请重新添加该账号')
      const plain = await cipher('unprotect', cipherText, { signal })
      signal?.throwIfAborted()
      let data
      try { data = JSON.parse(plain) } catch { throw new Error('加密凭据内容无效') }
      if (!data || typeof data.controlKey !== 'string' || !validControlKey(data.controlKey) ||
          typeof data.workspaceId !== 'string' || !validWorkspace(data.workspaceId) ||
          typeof data.runtimeKey !== 'string' || (data.runtimeKey && !validRuntimeKey(data.runtimeKey))) {
        throw new Error('加密凭据字段不完整')
      }
      return data
    },
    // Deliberate: Magpie's logout has no plugin callback. Do not silently
    // delete any other account's vault files. On uninstall, back up and
    // remove the vault folder only if desired.
  }
}
