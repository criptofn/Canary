param([string]$NodeExe, [string]$Instrument, [string]$ArgumentFile, [string]$WorkingDir, [string]$JobRoot)
$ErrorActionPreference = 'Stop'
$jobArguments = @($Instrument) + @(Get-Content -Raw -LiteralPath $ArgumentFile | ConvertFrom-Json)
foreach ($argument in $jobArguments) {
  if ($argument.Contains('"') -or $argument.EndsWith('\')) { throw 'Unsupported job argument quoting' }
}
$quotedArguments = ($jobArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
$producer = Start-Process -FilePath $NodeExe -ArgumentList $quotedArguments -WorkingDirectory $WorkingDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $JobRoot 'producer.stdout.log') -RedirectStandardError (Join-Path $JobRoot 'producer.stderr.log') -PassThru
@{ pid = $producer.Id; startedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
