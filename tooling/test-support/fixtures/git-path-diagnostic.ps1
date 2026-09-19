param([string]$Work,[string]$Side,[string]$Identity,[string]$Node)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../../../tools/windows-boundary/CanaryConfinedLauncher.cs')
$profileName = 'Canary.Confined.GitDiagnostic.' + [guid]::NewGuid().ToString('N')
$enrolled = [CanaryConfined]::Identity($false, $profileName) | ConvertFrom-Json
[IO.File]::WriteAllText($Identity, ($enrolled | ConvertTo-Json -Compress))
$exe = Join-Path $Work 'git-path-diagnostic.exe'
$aliasName = $null
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'git-path-diagnostic.cs') -OutputAssembly $exe -OutputType ConsoleApplication -ReferencedAssemblies @('System.dll','System.Web.Extensions.dll')
  [void][Reflection.Assembly]::LoadFrom($exe)
  $aliasName = [GitPathDiagnostic]::CreateAlias($Work)
  Push-Location -LiteralPath $Work
  try { & $exe (Join-Path $Work 'control.json') $Work $aliasName; if ($LASTEXITCODE -ne 0) { throw 'control failed' } }
  finally { Pop-Location }
  # Restore the same initial unstaged state: the unrestricted add is not evidence
  # that the restricted add can mutate the index.
  & 'C:\Program Files\Git\cmd\git.exe' -C $Work reset --quiet HEAD -- implementation.txt
  if ($LASTEXITCODE -ne 0) { throw 'index restoration failed' }
  $command = '"' + $exe + '" "' + (Join-Path $Work 'restricted.json') + '" "' + $Work + '" "' + $aliasName + '"'
  $code = [CanaryConfined]::Run($command,$Work,$Side,$enrolled.package,$false)
  if ($code -ne 0) { throw "restricted diagnostic exit $code" }
  $script = Join-Path $Work 'git-command-diagnostic.cjs'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'git-command-diagnostic.cjs') -Destination $script
  Push-Location -LiteralPath $Work
  try { & $Node --preserve-symlinks-main $script (Join-Path $Work 'git-control.json'); if ($LASTEXITCODE -ne 0) { throw 'Git control runner failed' } }
  finally { Pop-Location }
  $command = '"' + $Node + '" --preserve-symlinks-main "' + $script + '" "' + (Join-Path $Work 'git-restricted.json') + '"'
  $code = [CanaryConfined]::Run($command,$Work,($Side + '.git'),$enrolled.package,$false)
  if ($code -ne 0) { throw "restricted Git runner exit $code" }
} finally {
  if ($aliasName) { [GitPathDiagnostic]::RemoveAlias($aliasName,$Work) }
  [void][CanaryConfined]::Identity($true, $profileName)
}
