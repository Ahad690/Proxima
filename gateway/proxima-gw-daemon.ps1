<#
.SYNOPSIS
    Start the Proxima provider gateway as a background process.

.DESCRIPTION
    Starts the daemon and waits until it is actually answering on its port, so a
    following `proxima-gw status` does not race the startup.

    The daemon writes ipc-port.json to the same directory the legacy automation
    client reads, so cli\proxima-cli.cjs and scripts\proxima-loop.cjs can find it
    with no environment variable set.

.EXAMPLE
    .\proxima-gw.ps1 -Start

.EXAMPLE
    .\proxima-gw.ps1 -Start -Port 19322

.EXAMPLE
    .\proxima-gw.ps1 -Stop
#>
[CmdletBinding(DefaultParameterSetName = 'Start')]
param(
    [Parameter(ParameterSetName = 'Start')]
    [int] $Port = 0,

    [Parameter(ParameterSetName = 'Start')]
    [string] $LogDir = '',

    [Parameter(ParameterSetName = 'Stop')]
    [switch] $Stop
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Get-GatewayState {
    $fact = $null
    if ($env:APPDATA) {
        $legacy = Join-Path $env:APPDATA 'proxima\ipc-port.json'
        if (Test-Path -LiteralPath $legacy) {
            $fact = Get-Content -LiteralPath $legacy -Raw | ConvertFrom-Json
        }
    }
    return $fact
}

if ($PSCmdlet.ParameterSetName -eq 'Stop') {
    $fact = Get-GatewayState
    if (-not $fact) {
        Write-Output 'Gateway not running (no ipc-port.json).'
        exit 0
    }
    $proc = Get-Process -Id $fact.pid -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Output "No process with pid $($fact.pid); the fact file is stale."
        exit 0
    }
    Stop-Process -Id $fact.pid
    Write-Output "Stopped gateway pid $($fact.pid)."
    exit 0
}

# ---- start --------------------------------------------------------------------

$existing = Get-GatewayState
if ($existing) {
    $proc = Get-Process -Id $existing.pid -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Output "Gateway already running: pid $($existing.pid) on port $($existing.port)."
        exit 0
    }
}

if (-not $LogDir) {
    $LogDir = Join-Path $env:USERPROFILE '.proxima-gateway\logs'
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $LogDir "gateway-$stamp.out.log"
$err = Join-Path $LogDir "gateway-$stamp.err.log"

$nodeArgs = @('src\index.js')
if ($Port -gt 0) {
    $env:AGENT_HUB_PORT = "$Port"
}

$proc = Start-Process -FilePath 'node' -ArgumentList $nodeArgs `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err

# Wait for the port fact to appear and name this pid. Bail out rather than report
# success for a process that died on startup.
$deadline = (Get-Date).AddSeconds(30)
$ready = $false
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    $fact = Get-GatewayState
    if ($fact -and $fact.pid -eq $proc.Id) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
}

if ($ready) {
    $fact = Get-GatewayState
    Write-Output "Gateway started: pid $($proc.Id) on port $($fact.port)."
    Write-Output "  logs: $out"
    Write-Output "  next: proxima-gw status"
    exit 0
}

Write-Output "Gateway did not start. Recent stderr:"
if (Test-Path -LiteralPath $err) {
    Get-Content -LiteralPath $err -Tail 20 | ForEach-Object { Write-Output "  $_" }
}
exit 1
