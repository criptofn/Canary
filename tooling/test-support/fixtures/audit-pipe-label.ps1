$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../../../tools/windows-boundary/CanaryBroker.cs')
Add-Type -TypeDefinition @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
public static class CanaryAuditPipeLabel {
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll")]
  static extern uint SetSecurityInfo(IntPtr handle,int type,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)]
  static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static string Run(Action<IntPtr> verify) {
    IntPtr descriptor; uint size;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NW;;;LW)",1,out descriptor,out size))
      throw new InvalidOperationException("SDDL conversion failed");
    try {
      using(var pipe=new NamedPipeServerStream("canary-audit-"+Guid.NewGuid().ToString("N"),PipeDirection.InOut)) {
        IntPtr handle=pipe.SafePipeHandle.DangerousGetHandle();
        bool missingRejected=false;
        try { verify(handle); }
        catch(Exception) { missingRejected=true; }
        uint original=SetSecurityInfo(handle,1,0x18,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,descriptor);
        bool present,defaulted; IntPtr acl;
        if(!GetSecurityDescriptorSacl(descriptor,out present,out acl,out defaulted) || !present)
          throw new InvalidOperationException("SACL extraction failed");
        uint corrected=SetSecurityInfo(handle,6,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,acl);
        verify(handle);
        return "{\"originalDWORD\":"+original+",\"originalBoolWouldAccept\":"+(original!=0?"true":"false")+",\"correctedDWORD\":"+corrected+",\"missingRejected\":"+(missingRejected?"true":"false")+",\"readbackVerified\":true}";
      }
    } finally { LocalFree(descriptor); }
  }
}
'@
[CanaryAuditPipeLabel]::Run([Action[IntPtr]]{ param($handle) [CanaryBroker.Broker]::VerifyLowMandatoryLabel($handle) })
