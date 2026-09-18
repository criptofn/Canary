param(
  [Parameter(Mandatory=$true)][ValidateSet('low','untrusted')][string]$Integrity,
  [Parameter(Mandatory=$true)][string]$CommandLine,
  [string]$SandboxDirectory
)
$ErrorActionPreference = 'Stop'
if ($SandboxDirectory) {
  Add-Type -Path (Join-Path $PSScriptRoot 'AppContainerRunner.cs')
  exit [CanaryAppContainer]::Run($Integrity, $CommandLine, $SandboxDirectory)
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CanaryRestrictedWin32 {
  const uint QUERY=8, DUP=2, ASSIGN=1, ADJUST_DEFAULT=0x80, DISABLE_MAX=1, PRIMARY=1, IMPERSONATION=2, LOGON_PROFILE=1;
  const int Integrity=25;
  [StructLayout(LayoutKind.Sequential)] struct SI { public uint cb; public string r,d,t; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,res; public IntPtr res2,hin,hout,herr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr t);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr t,uint f,uint dc,IntPtr ds,uint pc,IntPtr ps,uint rc,IntPtr rs,out IntPtr r);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool ConvertStringSidToSid(string s,out IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr t,int c,IntPtr p,int n);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr t,uint f,string a,string c,uint x,IntPtr e,string d,ref SI s,out PI p);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr t,string a,string c,IntPtr pa,IntPtr ta,bool inherit,uint x,IntPtr e,string d,ref SI s,out PI p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint c);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint c);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr LocalFree(IntPtr p);
  static Exception Last(string n) { return new Win32Exception(Marshal.GetLastWin32Error(), n); }
  public static int Run(string level,string command) {
    IntPtr current,restricted,sid=IntPtr.Zero,il=IntPtr.Zero;
    if(!OpenProcessToken(GetCurrentProcess(),QUERY|DUP|ASSIGN|ADJUST_DEFAULT,out current)) throw Last("OpenProcessToken");
    if(!CreateRestrictedToken(current,DISABLE_MAX,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out restricted)) throw Last("CreateRestrictedToken");
    if(!ConvertStringSidToSid(level=="low"?"S-1-16-4096":"S-1-16-0",out sid)) throw Last("ConvertStringSidToSid");
    il=Marshal.AllocHGlobal(IntPtr.Size+8); Marshal.WriteIntPtr(il,sid); Marshal.WriteInt32(il,IntPtr.Size,0x20);
    if(!SetTokenInformation(restricted,Integrity,il,IntPtr.Size+8)) throw Last("SetTokenInformation");
    var si=new SI(); si.cb=(uint)Marshal.SizeOf(si); PI pi;
    if(!CreateProcessWithTokenW(restricted,LOGON_PROFILE,null,command,0,IntPtr.Zero,Environment.CurrentDirectory,ref si,out pi)
       && !CreateProcessAsUserW(restricted,null,command,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,Environment.CurrentDirectory,ref si,out pi)) throw Last("CreateProcessWithTokenW/CreateProcessAsUserW");
    var wait=WaitForSingleObject(pi.process,120000); if(wait!=0) { TerminateProcess(pi.process,124); CloseHandle(pi.thread); CloseHandle(pi.process); return 124; }
    uint code; GetExitCodeProcess(pi.process,out code); CloseHandle(pi.thread); CloseHandle(pi.process); return unchecked((int)code);
  }
}
'@
exit [CanaryRestrictedWin32]::Run($Integrity, $CommandLine)
