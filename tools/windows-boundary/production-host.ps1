$ErrorActionPreference = 'Stop'
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$profileKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $ownerSid)
if ($null -eq $profileKey) { throw 'OS profile registration unavailable' }
try { $profilePath = $profileKey.GetValue('ProfileImagePath', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
finally { $profileKey.Dispose() }
if (-not [System.IO.Path]::IsPathRooted($profilePath) -or $profilePath.Contains('%')) { throw 'ambiguous OS profile registration' }
@{ user = $ownerSid; host = [Environment]::MachineName; profile = $profilePath } | ConvertTo-Json -Compress
