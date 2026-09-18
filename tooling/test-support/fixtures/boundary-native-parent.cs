using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BoundaryNativeParent {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int size; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags;
    public short show,extra; public IntPtr extraPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint sharing,ref SA security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref SI info,out PI process);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
  public static IntPtr OpenFile(string path) {
    var sa=new SA { size=Marshal.SizeOf(typeof(SA)),inherit=true };
    var handle=CreateFileW(path,0x80000000,7,ref sa,3,0,IntPtr.Zero);
    if(handle==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    return handle;
  }
  public static IntPtr OpenSelf() {
    var handle=OpenProcess(0x40,true,System.Diagnostics.Process.GetCurrentProcess().Id);
    if(handle==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    return handle;
  }
  public static int RunControl(string command,string cwd) {
    var si=new SI {size=Marshal.SizeOf(typeof(SI))}; PI pi;
    if(!CreateProcessW(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0,IntPtr.Zero,cwd,ref si,out pi)) throw new System.ComponentModel.Win32Exception();
    try {
      if(WaitForSingleObject(pi.process,15000)!=0) { TerminateProcess(pi.process,99); return 99; }
      uint exit; if(!GetExitCodeProcess(pi.process,out exit)) throw new System.ComponentModel.Win32Exception();
      return (int)exit;
    } finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
  }
}
