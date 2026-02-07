$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Read token from openclaw.json
$cfgPath = Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
$cfg = Get-Content -Raw -Path $cfgPath | ConvertFrom-Json
$token = $cfg.gateway.auth.token

Write-Host "Token loaded from $cfgPath" -ForegroundColor DarkGray

# 1) Install whisper.cpp + model if missing
python (Join-Path $root 'setup_whisper.py')
if ($LASTEXITCODE -ne 0) {
  Write-Host "Whisper setup failed. You can still open the UI, but STT will fail until whisper.cpp is installed." -ForegroundColor Yellow
}

# 2) Start server
$env:OPENCLAW_URL = "ws://127.0.0.1:18789"
# Use an isolated session key for voice to avoid "bleeding" chat context.
$env:OPENCLAW_SESSION = "voice"
$env:OPENCLAW_TOKEN = "$token"
$env:VOICE_PORT = "4888"

Write-Host "Starting Voice Console…" -ForegroundColor Cyan
Write-Host "Open: http://127.0.0.1:$env:VOICE_PORT/" -ForegroundColor Green
node (Join-Path $root 'node_server.mjs')
