# Optional read-only DPAPI sanity check. Uses only ephemeral dummy content.
# Does NOT read Magpie configuration, secrets or vault.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $sample = [System.Text.Encoding]::UTF8.GetBytes('DPAPI_LOCAL_SELFTEST_' + [guid]::NewGuid().ToString('N'))
    $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
        $sample, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ([Convert]::ToBase64String($sample) -ne [Convert]::ToBase64String($decrypted)) {
        throw 'DPAPI round-trip mismatch'
    }
    Write-Host 'PASS: CurrentUser Windows DPAPI protect/unprotect works. No account credentials were used.'
} catch {
    Write-Error 'FAIL: CurrentUser DPAPI is unavailable for this user. Do not activate credential login.'
    exit 1
}
