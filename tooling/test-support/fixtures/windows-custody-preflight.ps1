param([Parameter(Mandatory=$true)][string]$Repository)
$ErrorActionPreference = 'Stop'
# Read-only access checks: no CreateService, firewall mutation, ownership or ACL writes.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CanaryCustodyPreflight {
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern IntPtr OpenSCManager(string machine,string database,uint access);
  [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
  [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)]
  static extern uint FwpmEngineOpen0(string server,uint auth,IntPtr identity,IntPtr session,out IntPtr handle);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineGetOption0(IntPtr handle,int option,out IntPtr value);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr handle);
  [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr memory);
  public static int ServiceAccess(uint access) {
    IntPtr handle=OpenSCManager(null,null,access);
    if(handle==IntPtr.Zero) return Marshal.GetLastWin32Error();
    CloseServiceHandle(handle); return 0;
  }
  public static uint[] FilteringAccess() {
    IntPtr engine=IntPtr.Zero,value=IntPtr.Zero;
    uint opened=FwpmEngineOpen0(null,10,IntPtr.Zero,IntPtr.Zero,out engine);
    if(opened!=0) return new[]{opened,UInt32.MaxValue};
    try { return new[]{opened,FwpmEngineGetOption0(engine,0,out value)}; }
    finally { if(value!=IntPtr.Zero) FwpmFreeMemory0(ref value); FwpmEngineClose0(engine); }
  }
}
'@
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$wfp = [CanaryCustodyPreflight]::FilteringAccess()
$store = if ($env:CANARY_TRUST_STORE) { $env:CANARY_TRUST_STORE } else { Join-Path $env:LOCALAPPDATA 'canary/trust' }
$storeOwner = if ([IO.Directory]::Exists($store)) { [IO.Directory]::GetAccessControl($store).GetOwner([Security.Principal.NTAccount]).Value } else { $null }
[ordered]@{
  schema = 'canary-custody-preflight/1'
  identity = $identity.Name
  elevatedAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  repositoryOwner = [IO.Directory]::GetAccessControl($Repository).GetOwner([Security.Principal.NTAccount]).Value
  gitOwner = [IO.Directory]::GetAccessControl((Join-Path $Repository '.git')).GetOwner([Security.Principal.NTAccount]).Value
  storeOwner = $storeOwner
  scmConnect = [ordered]@{ executed=$true; win32=[CanaryCustodyPreflight]::ServiceAccess(1) }
  scmCreateServiceAccess = [ordered]@{ executed=$true; win32=[CanaryCustodyPreflight]::ServiceAccess(2) }
  wfpOpen = [ordered]@{ executed=$true; win32=$wfp[0] }
  wfpReadOptions = [ordered]@{ executed=($wfp[0] -eq 0); win32=$wfp[1] }
} | ConvertTo-Json -Depth 4 -Compress
