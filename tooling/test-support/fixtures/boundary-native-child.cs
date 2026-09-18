using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;

public static class BoundaryNativeChild {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file, byte[] bytes, uint length, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileExW(string source,string target,uint flags);
  [DllImport("Firewallapi.dll", CharSet=CharSet.Unicode)] static extern uint NetworkIsolationDiagnoseConnectFailureAndGetInfo(string server, out int error);
  static readonly List<object> Attempts = new List<object>();
  static void Record(string id, bool allowed, int error, string target=null) {
    Attempts.Add(new { id=id, executed=true, allowed=allowed, error=error, target=target });
  }
  static void ReadHandle(string id, IntPtr handle) {
    byte[] data = new byte[256]; uint read;
    try {
      bool result=ReadFile(handle,data,(uint)data.Length,out read,IntPtr.Zero);
      Record(id,result && read>0,result?0:Marshal.GetLastWin32Error());
    } catch(SEHException) {
      Record(id,false,Marshal.GetExceptionCode());
    }
  }
  public static int Main(string[] args) {
    if(args.Length == 3 && args[0] == "--descendant") {
      IntPtr file=CreateFileW(args[1],0x80000000,7,IntPtr.Zero,3,0,IntPtr.Zero);
      bool allowed=file!=new IntPtr(-1); int error=allowed?0:Marshal.GetLastWin32Error();
      if(allowed) CloseHandle(file);
      File.WriteAllText(args[2],new JavaScriptSerializer().Serialize(new { pid=System.Diagnostics.Process.GetCurrentProcess().Id, allowed=allowed, error=error }));
      return 0;
    }
    // report, protected file, own work, inherited file/process handles, parent PID,
    // listener host and port. All resources are disposable test fixtures.
    string output=args[0], secret=args[1], work=args[2];
    IntPtr inheritedFile=new IntPtr(Int64.Parse(args[3])), inheritedProcess=new IntPtr(Int64.Parse(args[4]));
    uint parent=UInt32.Parse(args[5]);
    try {
      ReadHandle("inherited-file",inheritedFile);
      IntPtr duplicate;
      bool copied=false; duplicate=IntPtr.Zero; int copyError=0;
      try { copied=DuplicateHandle(inheritedProcess,inheritedFile,GetCurrentProcess(),out duplicate,0,false,2); copyError=copied?0:Marshal.GetLastWin32Error(); }
      catch(SEHException) { copyError=Marshal.GetExceptionCode(); }
      Record("inherited-process-duplicate",copied,copyError);
      if(copied) CloseHandle(duplicate);
      IntPtr process=OpenProcess(0x40,false,parent);
      int openError=process==IntPtr.Zero?Marshal.GetLastWin32Error():0;
      // One chained attack: obtain PROCESS_DUP_HANDLE, then duplicate the file.
      // A denied OpenProcess prevents the second syscall; do not count it twice.
      bool dup=process!=IntPtr.Zero && DuplicateHandle(process,inheritedFile,GetCurrentProcess(),out duplicate,0,false,2);
      Record("acquire-and-duplicate-broker-file",dup,process==IntPtr.Zero?openError:(dup?0:Marshal.GetLastWin32Error()));
      if(dup) CloseHandle(duplicate);
      if(process!=IntPtr.Zero) CloseHandle(process);
      var paths = new Dictionary<string,string> {
        {"direct",secret}, {"extended",@"\\?\"+secret},
        {"relative",Uri.UnescapeDataString(new Uri(work+Path.DirectorySeparatorChar).MakeRelativeUri(new Uri(secret)).ToString()).Replace('/',Path.DirectorySeparatorChar)},
        {"dot-components",Path.Combine(Path.GetDirectoryName(secret),"..",Path.GetFileName(Path.GetDirectoryName(secret)),Path.GetFileName(secret))},
        {"junction",Path.Combine(work,"escape",Path.GetFileName(secret))}
      };
      if(args.Length > 8 && args[8] == "symlink") paths.Add("symlink",Path.Combine(work,"secret-link"));
      foreach(var entry in paths) {
        IntPtr file=CreateFileW(entry.Value,0x80000000,7,IntPtr.Zero,3,0,IntPtr.Zero);
        bool opened=file!=new IntPtr(-1);
        Record(entry.Key,opened,opened?0:Marshal.GetLastWin32Error(),entry.Value);
        if(opened) CloseHandle(file);
      }
      if(args.Length > 9 && args[9] != "absent") {
        var targets = new JavaScriptSerializer().Deserialize<string[]>(File.ReadAllText(args[9]));
        for(int i=0;i<targets.Length;i++) {
          // Ask for actual write authority without corrupting a production key/ref.
          IntPtr file=CreateFileW(targets[i],0x40000000,7,IntPtr.Zero,3,0,IntPtr.Zero);
          bool opened=file!=new IntPtr(-1);
          Record("authority-write-"+i,opened,opened?0:Marshal.GetLastWin32Error(),targets[i]);
          if(opened) CloseHandle(file);
        }
        string childOutput=Path.Combine(work,"descendant-"+Guid.NewGuid().ToString("N")+".json");
        var start=new System.Diagnostics.ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,
          "--descendant \""+secret+"\" \""+childOutput+"\"") { UseShellExecute=false,CreateNoWindow=true };
        using(var child=System.Diagnostics.Process.Start(start)) {
          if(!child.WaitForExit(5000) || child.ExitCode!=0) throw new Exception("descendant execution unproven");
          var observed=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(childOutput));
          if(Convert.ToInt32(observed["pid"])!=child.Id) throw new Exception("descendant identity mismatch");
          Record("descendant-read",Convert.ToBoolean(observed["allowed"]),Convert.ToInt32(observed["error"]),secret);
        }
      }
      try { File.Copy(secret,Path.Combine(work,"copied-secret")); Record("temp-copy",true,0); }
      catch(UnauthorizedAccessException) { Record("temp-copy",false,5); }
      catch(Exception e) { Record("temp-copy",false,Marshal.GetHRForException(e)); }
      // Rename a dedicated canary file, never a real custody key.
      bool renamed=MoveFileExW(secret+".rename",Path.Combine(work,"renamed-secret"),0);
      Record("rename-out",renamed,renamed?0:Marshal.GetLastWin32Error());
      string host=args[6]; int port=Int32.Parse(args[7]);
      int diagnostic; uint native;
      string network="NOT-ATTEMPTED";
      using(var socket=new Socket(AddressFamily.InterNetwork,SocketType.Stream,ProtocolType.Tcp)) {
        try {
          var pending=socket.BeginConnect(IPAddress.Parse(host),port,null,null);
          if(!pending.AsyncWaitHandle.WaitOne(2500)) network="TIMEOUT";
          else { socket.EndConnect(pending); byte[] ack=new byte[64]; socket.ReceiveTimeout=2500;
            network=socket.Receive(ack)>0?"CONNECTED":"NO-ACK"; }
        } catch(SocketException e) { network="WSA-"+e.NativeErrorCode; }
      }
      native=NetworkIsolationDiagnoseConnectFailureAndGetInfo(host,out diagnostic);
      File.WriteAllText(output,new JavaScriptSerializer().Serialize(new {
        pid=System.Diagnostics.Process.GetCurrentProcess().Id, attempts=Attempts,
        environment=Environment.GetEnvironmentVariable("CANARY_PRODUCTION_SENTINEL"),
        network=new { executed=true,host=host,port=port,result=network,diagnosticReturn=native,isolationError=diagnostic }
      }));
      return 0;
    } catch(Exception e) { File.WriteAllText(output,new JavaScriptSerializer().Serialize(new {error=e.ToString(),attempts=Attempts})); return 3; }
  }
}
