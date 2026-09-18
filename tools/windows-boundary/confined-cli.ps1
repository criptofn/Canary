param(
  [Parameter(Mandatory=$true)][ValidateSet('launcher','broker','identity')][string]$Mode,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'CanaryConfinedLauncher.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'CanaryBroker.cs')
# Windows PowerShell collapses a single-element array to a scalar, which would pass one
# space-joined string instead of N arguments. Force enumeration through an explicit array.
function Invoke-Native([object[]]$argv) {
  switch ($Mode) {
    'identity' { $code = [CanaryConfined]::Main([object[]](@('identity') + $argv)); exit $code }
    'launcher' { $code = [CanaryConfined]::Main([object[]](@('run') + $argv)); exit $code }
    'broker'   { $code = [CanaryBroker.Program]::Main($argv); exit $code }
    default    { Write-Error "unknown mode $Mode"; exit 2 }
  }
}
Invoke-Native -argv ([object[]]@($Rest))
