param(
  [Parameter(Mandatory=$true)][string]$Log,
  # Line 1: the operation. Remaining lines: its argument vector. Windows PowerShell's -File
  # binder consumes the first option pair after a bound parameter, so the operation and its
  # arguments travel as ONE file and this script exposes only one bound parameter.
  [Parameter(Mandatory=$true)][string]$ArgumentsFile
)
# Runs one native boundary operation and writes its record as UTF-8 with the exit code.
# -File redirection is not used because Windows PowerShell writes UTF-16.
$ErrorActionPreference = 'Continue'
$record = New-Object System.Text.StringBuilder
function Save([int]$code) {
  [System.IO.File]::WriteAllText($Log, $record.ToString() + "LAUNCHER-EXIT $code`r`n", (New-Object System.Text.UTF8Encoding($false)))
}
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'CanaryConfinedLauncher.cs')
  Add-Type -Path (Join-Path $PSScriptRoot 'CanaryBroker.cs')
  $lines = @([System.IO.File]::ReadAllLines($ArgumentsFile))
  $operation = $lines[0]
  $argv = @()
  if ($lines.Count -gt 1) { $argv = @($lines[1..($lines.Count - 1)]) }
  [void]$record.AppendLine("RELAY mode=$operation argc=$($argv.Count)")
  $code = 0
  switch ($operation) {
    'identity' { $code = [CanaryConfined]::Main([string[]](@('identity') + $argv)) }
    'launcher' { $code = [CanaryConfined]::Main([string[]](@('run') + $argv)) }
    'broker'   { $code = [CanaryBroker.Program]::Main([string[]]$argv) }
    default    { [void]$record.AppendLine("RELAY-ERROR unknown operation $operation"); Save 2; exit 2 }
  }
  Save ([int]$code)
  exit ([int]$code)
} catch {
  [void]$record.AppendLine("RELAY-ERROR " + $_.Exception.GetType().FullName + ": " + $_.Exception.Message)
  Save 90
  exit 90
}
