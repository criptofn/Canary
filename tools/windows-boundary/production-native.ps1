param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$requestData = Get-Content -Raw -LiteralPath $Request | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'CanaryConfinedLauncher.cs')
switch ($requestData.mode) {
  'identity' {
    [System.IO.File]::WriteAllText($requestData.result, [CanaryConfined]::Identity([bool]$requestData.delete, $requestData.name))
  }
  'run' {
    $runProfile = if ($requestData.profile) { [string]$requestData.profile } else { $null }
    exit [CanaryConfined]::Run($requestData.command, $requestData.cwd, $requestData.side, $requestData.package, $false, $runProfile, [bool]$requestData.gitDirectoryAlias)
  }
  'broker' {
    Add-Type -Path (Join-Path $PSScriptRoot 'CanaryBroker.cs')
    exit [CanaryBroker.Program]::Main([string[]]$requestData.argv)
  }
  default { throw 'unknown native operation' }
}
