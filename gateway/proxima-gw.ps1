<#
.SYNOPSIS
    proxima-gw - control the Proxima provider gateway.

.DESCRIPTION
    Thin PowerShell wrapper so the CLI is callable as a normal command
    (proxima-gw status) rather than as `node bin\proxima-gw.js status`.

    Uses whatever `node` is on PATH. The gateway daemon itself is started
    separately with proxima-gw.ps1 -Start.

.EXAMPLE
    proxima-gw status
    proxima-gw login claude --headed
    proxima-gw login claude --cookies .\cookies\claude.json

.EXAMPLE
    Get-Content .\cookies\claude.json -Raw | proxima-gw login claude --stdin
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest
)

$ErrorActionPreference = 'Stop'

# Resolve the CLI relative to this script, so it works from any directory.
$cli = Join-Path $PSScriptRoot 'bin\proxima-gw.js'
if (-not (Test-Path -LiteralPath $cli)) {
    Write-Error "Cannot find $cli"
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "node is not on PATH. Install Node 20+ and try again."
    exit 1
}

# `node` on Windows is node.exe, which PowerShell will not execute without the
# call operator, hence the explicit invocation and argument array.
& $node.Source $cli @Rest
exit $LASTEXITCODE
