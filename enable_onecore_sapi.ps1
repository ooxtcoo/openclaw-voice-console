param(
  [string]$BackupDir = "$env:USERPROFILE\\Desktop\\openclaw-tts-reg-backup"
)

$ErrorActionPreference = 'Stop'

$srcRoot = 'HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens'
$dstRoot = 'HKLM:\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens'

Write-Host "Source: $srcRoot"
Write-Host "Dest:   $dstRoot"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$srcReg = Join-Path $BackupDir "Speech_OneCore_Tokens-$ts.reg"
$dstReg = Join-Path $BackupDir "Speech_SAPI5_Tokens-$ts.reg"

Write-Host "Backing up registry keys to: $BackupDir" -ForegroundColor Cyan
& reg.exe export "HKLM\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens" "$srcReg" /y | Out-Null
& reg.exe export "HKLM\SOFTWARE\Microsoft\Speech\Voices\Tokens" "$dstReg" /y | Out-Null

if (-not (Test-Path $srcRoot)) {
  throw "Source root not found: $srcRoot"
}

# Ensure destination keys exist (PowerShell New-Item can be flaky on some machines)
& reg.exe add "HKLM\SOFTWARE\Microsoft\Speech\Voices" /f | Out-Null
& reg.exe add "HKLM\SOFTWARE\Microsoft\Speech\Voices\Tokens" /f | Out-Null

function Convert-ToRegExeKey {
  param([Parameter(Mandatory=$true)][string]$RegProviderPath)
  # $RegProviderPath can be like:
  # - HKLM:\SOFTWARE\...
  # - Microsoft.PowerShell.Core\Registry::HKEY_LOCAL_MACHINE\SOFTWARE\...
  # - HKEY_LOCAL_MACHINE\SOFTWARE\...
  $p = [string]$RegProviderPath
  $p = $p -replace '^Microsoft\.PowerShell\.Core\\Registry::',''
  $p = $p -replace '^HKLM:\\','HKEY_LOCAL_MACHINE\\'
  if ($p -match '^HKEY_LOCAL_MACHINE\\') {
    $p = 'HKLM\\' + $p.Substring('HKEY_LOCAL_MACHINE\'.Length)
  }
  # normalize accidental double slashes (reg.exe rejects them)
  while ($p -match '\\\\') {
    $p = $p -replace '\\\\','\\'
  }
  $p = $p.TrimEnd('\\')
  return $p
}

function Copy-RegKeyRecursive {
  param(
    [Parameter(Mandatory=$true)][string]$From,
    [Parameter(Mandatory=$true)][string]$To
  )

  if (-not (Test-Path $To)) {
    $toKey = Convert-ToRegExeKey $To
    $null = & reg.exe add "$toKey" /f
    if ($LASTEXITCODE -ne 0) {
      Write-Host "reg add failed (create key): $toKey" -ForegroundColor Yellow
    }
  }

  # copy values
  $item = Get-Item -Path $From
  $fromRegKey = Convert-ToRegExeKey $item.Name

  $props = $item.Property
  foreach ($p in $props) {
    try {
      $val = (Get-ItemProperty -Path $From -Name $p).$p
      # Determine value kind using reg.exe query (PowerShell registry provider doesn't expose kind directly)
      $q = & reg.exe query $fromRegKey /v $p 2>$null
      $kind = 'REG_SZ'
      foreach ($line in $q) {
        if ($line -match "\s+$p\s+([A-Z_0-9]+)\s+") { $kind = $Matches[1]; break }
      }

      $toKey = Convert-ToRegExeKey $To
      switch ($kind) {
        'REG_DWORD' { $null = & reg.exe add "$toKey" /v "$p" /t REG_DWORD /d $val /f }
        'REG_QWORD' { $null = & reg.exe add "$toKey" /v "$p" /t REG_QWORD /d $val /f }
        'REG_MULTI_SZ' {
          if ($val -is [array]) { $data = ($val -join '\0') + '\0\0' } else { $data = "$val\0\0" }
          $null = & reg.exe add "$toKey" /v "$p" /t REG_MULTI_SZ /d "$data" /f
        }
        'REG_EXPAND_SZ' { $null = & reg.exe add "$toKey" /v "$p" /t REG_EXPAND_SZ /d "$val" /f }
        'REG_BINARY' {
          if ($val -is [byte[]]) { $hex = ($val | ForEach-Object { $_.ToString('x2') }) -join '' } else { $hex = [string]$val }
          $null = & reg.exe add "$toKey" /v "$p" /t REG_BINARY /d "$hex" /f
        }
        default { $null = & reg.exe add "$toKey" /v "$p" /t REG_SZ /d "$val" /f }
      }
      if ($LASTEXITCODE -ne 0) {
        Write-Host "reg add failed: key=$toKey value=$p kind=$kind" -ForegroundColor Yellow
      }
    } catch {
      Write-Host "copy value failed: key=$toKey value=$p" -ForegroundColor Yellow
    }
  }

  # copy subkeys
  Get-ChildItem -Path $From | ForEach-Object {
    $childFrom = $_.PSPath
    $childName = $_.PSChildName
    $childTo = Join-Path $To $childName
    Copy-RegKeyRecursive -From $childFrom -To $childTo
  }
}

Write-Host "Mirroring OneCore voices into SAPI5…" -ForegroundColor Cyan
Copy-RegKeyRecursive -From $srcRoot -To $dstRoot

Write-Host "DONE. Restart apps that use SAPI5 (and restart Voice Console) to refresh voices." -ForegroundColor Green
Write-Host "Backup files:" -ForegroundColor DarkGray
Write-Host "  $srcReg" -ForegroundColor DarkGray
Write-Host "  $dstReg" -ForegroundColor DarkGray
