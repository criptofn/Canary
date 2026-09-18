// Adds AppContainer access checks to the existing restricted/low token. No capabilities means
// no network grant. Only the caller-provisioned disposable work directory receives a package ACE.
// This is a launcher primitive, not a HARDENED provider or an evidence signer.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class CanaryAppContainer {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reservedSize; public IntPtr reserved2,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct SA { public IntPtr sid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr sid,capabilities; public uint count,reserved; }
  [StructLayout(LayoutKind.Sequential)] struct LIMITS {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOB {
    public LIMITS basic; public ulong reads,writes,others,readBytes,writeBytes,otherBytes;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long user,kernel,periodUser,periodKernel;
    public uint pageFaults,total,active,terminated;
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr t,int kind,IntPtr info,int size,out int needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr t,uint flags,uint ds,IntPtr s,uint dp,IntPtr p,uint rs,IntPtr r,out IntPtr result);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string s,out IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr t,int kind,ref SA label,int size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr p);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string desc,IntPtr caps,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,ref CAPS caps,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref JOB info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,ref ACCOUNTING info,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
  static void Check(bool success,string operation) { if(!success) { int code=Marshal.GetLastWin32Error(); throw new Win32Exception(code,operation+": Win32 "+code+" "+new Win32Exception(code).Message); } }
  static IntPtr TokenInfo(IntPtr token,int kind) {
    int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
    if(size<=0) throw new InvalidOperationException("token query returned no size");
    IntPtr data=Marshal.AllocHGlobal(size);
    try { Check(GetTokenInformation(token,kind,data,size,out size),"GetTokenInformation "+kind); return data; }
    catch { Marshal.FreeHGlobal(data); throw; }
  }
  static void MeasureChild(IntPtr process,uint pid) {
    IntPtr token=IntPtr.Zero,app=IntPtr.Zero,caps=IntPtr.Zero,label=IntPtr.Zero,sid=IntPtr.Zero,restrictions=IntPtr.Zero;
    try {
      Check(OpenProcessToken(process,8,out token),"Open child token");
      app=TokenInfo(token,29); caps=TokenInfo(token,30); label=TokenInfo(token,25); sid=TokenInfo(token,31);
      bool isApp=Marshal.ReadInt32(app)!=0;
      int count=Marshal.ReadInt32(caps);
      string integrity=new SecurityIdentifier(Marshal.ReadIntPtr(label)).Value;
      string package=new SecurityIdentifier(Marshal.ReadIntPtr(sid)).Value;
      restrictions=TokenInfo(token,21);
      bool restricted=Marshal.ReadInt32(restrictions)!=0;
      Console.WriteLine("TOKEN pid="+pid+" appContainer="+isApp+" restricted="+restricted+" capabilities="+count+" integrity="+integrity+" package="+package);
      if(!isApp || !restricted || count!=0 || integrity!="S-1-16-4096") throw new InvalidOperationException("child token measurement failed");
    } finally {
      foreach(IntPtr p in new[]{app,caps,label,sid,restrictions}) if(p!=IntPtr.Zero) Marshal.FreeHGlobal(p);
      if(token!=IntPtr.Zero) CloseHandle(token);
    }
  }

  public static int Run(string level,string command,string directory) {
    if(level!="low") throw new ArgumentException("AppContainer requires the existing low-integrity token");
    directory=Path.GetFullPath(directory);
    if(!Directory.Exists(directory)) throw new ArgumentException("sandbox must already exist");
    // No host root grants. The controller provisions a fresh directory and retains its parent.
    if(!directory.StartsWith(Path.GetTempPath(),StringComparison.OrdinalIgnoreCase) || directory==Path.GetTempPath().TrimEnd('\\'))
      throw new ArgumentException("sandbox must be a disposable directory below the OS temp directory");
    for(var p=new DirectoryInfo(directory);p!=null;p=p.Parent)
      if((p.Attributes&FileAttributes.ReparsePoint)!=0) throw new ArgumentException("reparse ancestor refused");
    string name="Canary.Probe."+Guid.NewGuid().ToString("N");
    IntPtr current=IntPtr.Zero,restricted=IntPtr.Zero,low=IntPtr.Zero,package=IntPtr.Zero;
    IntPtr attributes=IntPtr.Zero,environment=IntPtr.Zero,job=IntPtr.Zero;
    PI child=new PI(); bool profile=false,initialized=false; FileSystemAccessRule grant=null;
    try {
      Marshal.ThrowExceptionForHR(CreateAppContainerProfile(name,name,"Canary disposable restricted runner",IntPtr.Zero,0,out package)); profile=true;
      var packageIdentity=new SecurityIdentifier(package);
      grant=new FileSystemAccessRule(packageIdentity,FileSystemRights.Modify|FileSystemRights.Synchronize,
        InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow);
      var acl=Directory.GetAccessControl(directory); acl.AddAccessRule(grant); Directory.SetAccessControl(directory,acl);
      Check(OpenProcessToken(GetCurrentProcess(),0x8b,out current),"OpenProcessToken");
      Check(CreateRestrictedToken(current,1,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out restricted),"CreateRestrictedToken");
      Check(ConvertStringSidToSid("S-1-16-4096",out low),"low SID");
      var label=new SA{sid=low,attributes=0x20};
      Check(SetTokenInformation(restricted,25,ref label,Marshal.SizeOf(label)),"SetTokenInformation low");
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      attributes=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes,1,0,ref size),"InitializeProcThreadAttributeList"); initialized=true;
      var caps=new CAPS{sid=package};
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20009),ref caps,new IntPtr(Marshal.SizeOf(caps)),IntPtr.Zero,IntPtr.Zero),"AppContainer capabilities");
      // Never inherit caller environment, handles, profile, credentials or executable search path.
      string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      environment=Marshal.StringToHGlobalUni("APPDATA="+directory+"\0LOCALAPPDATA="+directory+"\0SystemRoot="+windows+"\0TEMP="+directory+"\0TMP="+directory+"\0USERPROFILE="+directory+"\0WINDIR="+windows+"\0\0");
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJobObject");
      var limits=new JOB(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway allowed
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)),"Job kill-on-close");
      var startup=new SIX(); startup.info.cb=(uint)Marshal.SizeOf(startup); startup.attributes=attributes;
      Check(CreateProcessAsUserW(restricted,null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,
        0x80000|0x400|0x4,environment,directory,ref startup,out child),"CreateProcessAsUser AppContainer suspended");
      Check(AssignProcessToJobObject(job,child.process),"AssignProcessToJobObject");
      MeasureChild(child.process,child.pid); // trusted parent observes the actual suspended token
      Check(ResumeThread(child.thread)!=0xffffffff,"ResumeThread");
      uint wait=WaitForSingleObject(child.process,120000);
      if(wait==258) return 124;
      Check(wait==0,"WaitForSingleObject");
      uint code; Check(GetExitCodeProcess(child.process,out code),"GetExitCodeProcess");
      return unchecked((int)code);
    } finally {
      if(child.process!=IntPtr.Zero) TerminateProcess(child.process,125);
      if(job!=IntPtr.Zero) {
        try {
          Check(TerminateJobObject(job,125),"Terminate job descendants");
          var accounting=new ACCOUNTING();
          var deadline=DateTime.UtcNow.AddSeconds(5);
          do {
            Check(QueryInformationJobObject(job,1,ref accounting,(uint)Marshal.SizeOf(accounting),IntPtr.Zero),"Query job cessation");
            if(accounting.active==0) break;
            if(DateTime.UtcNow>=deadline) throw new InvalidOperationException("job cessation unproven");
            System.Threading.Thread.Sleep(10);
          } while(true);
        } finally { CloseHandle(job); }
      }
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      if(initialized) DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
      if(restricted!=IntPtr.Zero) CloseHandle(restricted);
      if(current!=IntPtr.Zero) CloseHandle(current);
      if(low!=IntPtr.Zero) LocalFree(low);
      if(grant!=null) { var acl=Directory.GetAccessControl(directory); acl.RemoveAccessRuleSpecific(grant); Directory.SetAccessControl(directory,acl); }
      if(package!=IntPtr.Zero) FreeSid(package);
      if(profile) Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(name));
    }
  }
}
