# Trusted-side MS-DOS device helper for the confined-Git and sandbox-alias audits.
# Deterministic, file-backed, one operation per invocation. Never used to change a
# machine-wide mapping as part of a probe: `define` exists so a probe can create and
# remove its OWN alias in a controlled measurement, and reports the raw API result.
param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$r = Get-Content -Raw -LiteralPath $Request | ConvertFrom-Json
Add-Type -Namespace CanaryDos -Name Device -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint QueryDosDeviceW(string name, System.Text.StringBuilder target, uint size);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool DefineDosDeviceW(uint flags, string name, string target);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetShortPathNameW(string longPath, System.Text.StringBuilder shortPath, uint size);
'@
$out = [ordered]@{ op = $r.op }
function Fail([string]$operation) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $script:out.code = $code
  $script:out.error = [ComponentModel.Win32Exception]::new($code).Message
}
try {
  switch ($r.op) {
    'query' {
      $sb = New-Object System.Text.StringBuilder 32768
      $n = [CanaryDos.Device]::QueryDosDeviceW([string]$r.name, $sb, 32768)
      if ($n -eq 0) { Fail 'QueryDosDeviceW' } else { $out.target = $sb.ToString() }
    }
    'list' {
      $map = [ordered]@{}
      foreach ($c in [char[]]'ZYXWVUTSRQPONMLKJIHGFEDCBA') {
        $sb = New-Object System.Text.StringBuilder 32768
        if ([CanaryDos.Device]::QueryDosDeviceW([string]$c + ':', $sb, 32768) -ne 0) { $map[[string]$c + ':'] = $sb.ToString() }
      }
      $out.map = $map
    }
    'define' {
      $ok = [CanaryDos.Device]::DefineDosDeviceW([uint32]$r.flags, [string]$r.name, [string]$r.target)
      $out.ok = $ok
      if (-not $ok) { Fail 'DefineDosDeviceW' }
    }
    'short' {
      $sb = New-Object System.Text.StringBuilder 32768
      $n = [CanaryDos.Device]::GetShortPathNameW([string]$r.path, $sb, 32768)
      if ($n -eq 0) { Fail 'GetShortPathNameW' } else { $out.short = $sb.ToString() }
    }
    'launcher-pids' {
      # Trusted-side only: which processes are hosting the confined launcher right now.
      $out.pids = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -like '*production-native.ps1*' } | Select-Object -ExpandProperty ProcessId)
    }
    'stop-process' {
      # Trusted-side only, and only ever used by the alias audit to measure what a hard
      # kill of the launcher does. Never part of a confinement decision.
      Stop-Process -Id ([int]$r.pid) -Force
      $out.stopped = [int]$r.pid
    }
    default { throw "unknown dos-device operation: $($r.op)" }
  }
} catch { $out.error = $_.Exception.Message }
[IO.File]::WriteAllText($r.out, ($out | ConvertTo-Json -Depth 6 -Compress))
