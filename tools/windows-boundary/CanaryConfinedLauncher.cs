// Canary confined-caller launcher + trusted broker (measurement harness).
//
// The whole untrusted caller runs inside a fresh AppContainer added to the existing
// restricted, low-integrity token. Zero capabilities => no network grant. Only the
// disposable work directory receives a package ACE. The launcher writes a side
// channel describing the ACTUAL suspended child token so the trusted parent can
// provision the store ACLs before the caller runs, and so a later launch can reuse
// the same package SID. Not a HARDENED provider and not an evidence signer.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

public static class CanaryConfined {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI {
    public uint cb; public string reserved, desktop, title; public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort show, reservedSize; public IntPtr reserved2, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct SA { public IntPtr sid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential)] struct CAPS { public IntPtr sid, capabilities; public uint count, reserved; }
  [StructLayout(LayoutKind.Sequential)] struct LIMITS {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
    public uint activeProcesses; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOB {
    public LIMITS basic; public ulong reads, writes, others, readBytes, writeBytes, otherBytes;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long user, kernel, periodUser, periodKernel;
    public uint pageFaults, total, active, terminated;
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr t, int kind, IntPtr info, int size, out int needed);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr t, uint flags, uint ds, IntPtr s, uint dp, IntPtr p, uint rs, IntPtr r, out IntPtr result);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr t, int kind, ref SA label, int size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr p);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, ref CAPS caps, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUserW(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SIX si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JOB info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, ref ACCOUNTING info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);

  static void Check(bool success, string operation) {
    if (!success) { int code = Marshal.GetLastWin32Error(); throw new Win32Exception(code, operation + ": Win32 " + code + " " + new Win32Exception(code).Message); }
  }
  static IntPtr TokenInfo(IntPtr token, int kind) {
    int size; GetTokenInformation(token, kind, IntPtr.Zero, 0, out size);
    if (size <= 0) throw new InvalidOperationException("token query " + kind + " returned no size");
    IntPtr data = Marshal.AllocHGlobal(size);
    try { Check(GetTokenInformation(token, kind, data, size, out size), "GetTokenInformation " + kind); return data; }
    catch { Marshal.FreeHGlobal(data); throw; }
  }

  /// <summary>Measured facts about one child token. Nothing is inferred from the request.</summary>
  public sealed class Measurement {
    public uint pid; public string package; public int capabilities; public string integrity;
    public bool appContainer, restricted, networkCapability;
    public string Describe() {
      return "pid=" + pid + " appContainer=" + appContainer + " restricted=" + restricted +
        " capabilities=" + capabilities + " integrity=" + integrity + " package=" + package;
    }
  }

  static Measurement Measure(IntPtr process, uint pid) {
    IntPtr token = IntPtr.Zero, app = IntPtr.Zero, caps = IntPtr.Zero, label = IntPtr.Zero, sid = IntPtr.Zero, restrictions = IntPtr.Zero, capSid = IntPtr.Zero;
    var m = new Measurement { pid = pid };
    try {
      Check(OpenProcessToken(process, 8, out token), "Open child token");
      app = TokenInfo(token, 29); caps = TokenInfo(token, 30); label = TokenInfo(token, 25); sid = TokenInfo(token, 31);
      m.appContainer = Marshal.ReadInt32(app) != 0;
      m.capabilities = Marshal.ReadInt32(caps);
      var capStruct = (CAPS)Marshal.PtrToStructure(caps, typeof(CAPS));
      m.integrity = new SecurityIdentifier(Marshal.ReadIntPtr(label)).Value;
      m.package = new SecurityIdentifier(Marshal.ReadIntPtr(sid)).Value;
      restrictions = TokenInfo(token, 21);
      m.restricted = Marshal.ReadInt32(restrictions) != 0;
      // A network-granting capability is the thing this boundary must not have.
      for (uint i = 0; i < m.capabilities; i++) {
        IntPtr entry = Marshal.ReadIntPtr(capStruct.capabilities, (int)(i * IntPtr.Size));
        try { if (new SecurityIdentifier(entry).Value.StartsWith("S-1-15-3-1", StringComparison.Ordinal)) m.networkCapability = true; } catch { }
      }
      return m;
    } finally {
      foreach (IntPtr p in new[] { app, caps, label, sid, restrictions, capSid }) if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
      if (token != IntPtr.Zero) CloseHandle(token);
    }
  }

  static string Json(Measurement m, string extra) {
    var sb = new StringBuilder();
    sb.Append("{\"pid\":").Append(m.pid).Append(",\"appContainer\":").Append(m.appContainer ? "true" : "false");
    sb.Append(",\"restricted\":").Append(m.restricted ? "true" : "false").Append(",\"capabilities\":").Append(m.capabilities);
    sb.Append(",\"networkCapability\":").Append(m.networkCapability ? "true" : "false");
    sb.Append(",\"integrity\":\"").Append(m.integrity).Append("\",\"package\":\"").Append(m.package).Append("\"");
    if (extra != null) sb.Append(',').Append(extra);
    return sb.Append('}').ToString();
  }

  /// <summary>Truthful report of the identity this helper hands to the caller.</summary>
  public static string Identity(bool delete) {
    return Identity(delete, "Canary.Confined.Identity");
  }
  public static string Identity(bool delete, string name) {
    if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^Canary\\.Confined\\.[A-Za-z0-9.-]+$"))
      throw new ArgumentException("invalid Canary profile name");
    IntPtr package = IntPtr.Zero;
    string value = null; bool created = false;
    try {
      int hr = CreateAppContainerProfile(name, name, "Canary confined caller identity", IntPtr.Zero, 0, out package);
      if (hr >= 0) { value = new SecurityIdentifier(package).Value; created = true; }
      else {
        // Already present: derive the SID from the profile instead of inventing one.
        IntPtr derived;
        Marshal.ThrowExceptionForHR(DeriveAppContainerSidFromAppContainerName(name, out derived));
        try { value = new SecurityIdentifier(derived).Value; } finally { FreeSid(derived); }
      }
      if (delete) DeleteAppContainerProfile(name);
      return "{\"package\":\"" + value + "\",\"created\":" + (created ? "true" : "false") + ",\"deleted\":" + (delete ? "true" : "false") + "}";
    } finally { if (package != IntPtr.Zero) FreeSid(package); }
  }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

  /// <summary>
  /// Launch one tool inside the confinement. Writes the side channel describing the
  /// ACTUAL suspended child token, then resumes. Fails closed (throws) when any part
  /// of the boundary cannot be established.
  /// </summary>
  public static int Run(string command, string directory, string sideChannel, string packageSid, bool deleteProfile) {
    return Run(command, directory, sideChannel, packageSid, deleteProfile, null);
  }
  public static int Run(string command, string directory, string sideChannel, string packageSid, bool deleteProfile, string profileDirectory) {
    directory = Path.GetFullPath(directory);
    if (!Directory.Exists(directory)) throw new ArgumentException("sandbox must already exist");
    string temp = Path.GetTempPath();
    if (!directory.StartsWith(temp, StringComparison.OrdinalIgnoreCase) || directory.TrimEnd('\\') == temp.TrimEnd('\\'))
      throw new ArgumentException("sandbox must be a disposable directory below the OS temp directory");
    for (var p = new DirectoryInfo(directory); p != null; p = p.Parent)
      if ((p.Attributes & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("reparse ancestor refused");
    string profile = String.IsNullOrEmpty(profileDirectory) ? directory : Path.GetFullPath(profileDirectory);
    if (profile != directory && !profile.StartsWith(directory.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
      throw new ArgumentException("profile must stay inside the sandbox");
    for (var p = new DirectoryInfo(profile); p != null; p = p.Parent)
      if ((p.Attributes & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("reparse profile refused");
    string name = "Canary.Confined." + Guid.NewGuid().ToString("N");
    IntPtr current = IntPtr.Zero, restricted = IntPtr.Zero, low = IntPtr.Zero, package = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, environment = IntPtr.Zero, job = IntPtr.Zero;
    PI child = new PI(); bool initialized = false; FileSystemAccessRule grant = null;
    try {
      // Identity is provisioned once by `identity` and reused, so the store ACL, the pipe
      // ACL and the launched caller all speak about the SAME AppContainer SID.
      if (String.IsNullOrEmpty(packageSid)) throw new ArgumentException("a provisioned package SID is required");
      Check(ConvertStringSidToSid(packageSid, out package), "ConvertStringSidToSid package " + packageSid);
      var packageIdentity = new SecurityIdentifier(package);
      grant = new FileSystemAccessRule(packageIdentity, FileSystemRights.Modify | FileSystemRights.Synchronize,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow);
      var acl = Directory.GetAccessControl(directory); acl.AddAccessRule(grant); Directory.SetAccessControl(directory, acl);
      Check(OpenProcessToken(GetCurrentProcess(), 0x8b, out current), "OpenProcessToken");
      Check(CreateRestrictedToken(current, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted), "CreateRestrictedToken");
      Check(ConvertStringSidToSid("S-1-16-4096", out low), "low SID");
      var label = new SA { sid = low, attributes = 0x20 };
      Check(SetTokenInformation(restricted, 25, ref label, Marshal.SizeOf(label)), "SetTokenInformation low");
      IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList"); initialized = true;
      var caps = new CAPS { sid = package };
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20009), ref caps, new IntPtr(Marshal.SizeOf(caps)), IntPtr.Zero, IntPtr.Zero), "AppContainer capabilities");
      // Never inherit caller environment, handles, profile, credentials or executable search path.
      string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      environment = Marshal.StringToHGlobalUni("APPDATA=" + profile + "\0LOCALAPPDATA=" + profile + "\0SystemRoot=" + windows +
        "\0TEMP=" + profile + "\0TMP=" + profile + "\0USERPROFILE=" + profile + "\0WINDIR=" + windows + "\0\0");
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
      var limits = new JOB(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway allowed
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "Job kill-on-close");
      // The child's CURRENT DIRECTORY is the sandbox and nothing else. A tool resolves its
      // relative paths against the cwd before it runs, so a cwd outside the boundary makes the
      // tool die at startup (measured: Node exits with EPERM on lstat 'C:\' when its cwd is a
      // directory the boundary denies). MEASURED: the caller still does useful work here.
      var startup = new SIX(); startup.info.cb = (uint)Marshal.SizeOf(startup); startup.attributes = attributes;
      // A diagnostic channel: the exact command line and cwd handed to the kernel, so a launch
      // failure can be attributed to the boundary or to the tool without guessing.
      string record = Environment.GetEnvironmentVariable("CANARY_LAUNCH_RECORD");
      if (!String.IsNullOrEmpty(record))
        File.WriteAllText(record, "cwd=" + directory + "\ncmd=" + command + "\n");
      Check(CreateProcessAsUserW(restricted, null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
        0x80000 | 0x400 | 0x4, environment, directory, ref startup, out child), "CreateProcessAsUser AppContainer suspended");
      Check(AssignProcessToJobObject(job, child.process), "AssignProcessToJobObject");
      var measured = Measure(child.process, child.pid);
      // Fail closed: no caller proceeds on a boundary that was not observed.
      if (!measured.appContainer || !measured.restricted || measured.capabilities != 0 ||
          measured.integrity != "S-1-16-4096" || measured.networkCapability)
        throw new InvalidOperationException("boundary not established: " + measured.Describe());
      if (!String.IsNullOrEmpty(packageSid) && measured.package != packageSid)
        throw new InvalidOperationException("child package identity differs from the provisioned one");
      if (!String.IsNullOrEmpty(sideChannel))
        File.WriteAllText(sideChannel, Json(measured, "\"sideChannel\":true"));
      Check(ResumeThread(child.thread) != 0xffffffff, "ResumeThread");
      uint wait = WaitForSingleObject(child.process, 120000);
      uint returnCode;
      if (wait == 258) { returnCode = 124; }
      else {
        Check(wait == 0, "WaitForSingleObject");
        Check(GetExitCodeProcess(child.process, out returnCode), "GetExitCodeProcess");
      }
      // The exit code is part of the evidence file, so an arm can be judged from the record
      // even when the caller's own stdio could not be inherited.
      if (!String.IsNullOrEmpty(sideChannel))
        File.AppendAllText(sideChannel, "\n{\"sideChannel\":false,\"pid\":" + measured.pid + ",\"exit\":" + unchecked((int)returnCode) + "}");
      return unchecked((int)returnCode);
    } finally {
      if (child.process != IntPtr.Zero) TerminateProcess(child.process, 125);
      if (job != IntPtr.Zero) {
        try {
          Check(TerminateJobObject(job, 125), "Terminate job descendants");
          var accounting = new ACCOUNTING();
          var deadline = DateTime.UtcNow.AddSeconds(5);
          do {
            Check(QueryInformationJobObject(job, 1, ref accounting, (uint)Marshal.SizeOf(accounting), IntPtr.Zero), "Query job cessation");
            if (accounting.active == 0) break;
            if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("job cessation unproven");
            Thread.Sleep(10);
          } while (true);
        } finally { CloseHandle(job); }
      }
      if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
      if (child.process != IntPtr.Zero) CloseHandle(child.process);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (current != IntPtr.Zero) CloseHandle(current);
      if (low != IntPtr.Zero) LocalFree(low);
      if (grant != null) { var acl = Directory.GetAccessControl(directory); acl.RemoveAccessRuleSpecific(grant); Directory.SetAccessControl(directory, acl); }
      if (package != IntPtr.Zero) FreeSid(package);
      if (deleteProfile) { try { Marshal.ThrowExceptionForHR(DeleteAppContainerProfile(name)); } catch { } }
    }
  }

  /// <summary>
  /// Argument vector from a FILE, one argument per line. PowerShell's -File argument binder
  /// consumes the first option pair after -Mode on some hosts, so the operation's arguments
  /// never travel through a shell parser: the file is the interface.
  /// </summary>
  public static string[] ArgumentFile(string path) {
    if (!File.Exists(path)) throw new ArgumentException("argument file not found: " + path);
    var list = new List<string>();
    foreach (string line in File.ReadAllLines(path)) list.Add(line);
    while (list.Count > 0 && list[list.Count - 1].Length == 0) list.RemoveAt(list.Count - 1);
    return list.ToArray();
  }

  public static int Main(string[] args) {
    try {
      string[] argv = args;
      if (args.Length > 0 && args[0] == "@argv") {
        if (args.Length < 2) { Console.Error.WriteLine("usage: launcher @argv <file>"); return 2; }
        argv = ArgumentFile(args[1]);
      }
      if (argv.Length > 0 && argv[0] == "identity") {
        // The record goes to a FILE: on Windows PowerShell the captured stdout of a
        // [Type]::Main call is empty, so the file is the only trustworthy channel.
        bool delete = false; string record = null;
        for (int i = 1; i < argv.Length; i++) {
          if (argv[i] == "--delete") delete = true;
          else if (argv[i] == "--record" && i + 1 < argv.Length) { record = argv[i + 1]; i++; }
        }
        string text = Identity(delete);
        Console.WriteLine(text);
        if (record != null) File.WriteAllText(record, text + Environment.NewLine);
        return 0;
      }
      if (argv.Length >= 4 && argv[0] == "run") {
        return Run(argv[1], argv[2], argv[3], argv.Length > 4 ? argv[4] : null, argv.Length > 5 && argv[5] == "keep");
      }
      Console.Error.WriteLine("usage: launcher @argv <file> | launcher run <commandLine> <sandbox> <sideChannel> [packageSid] [keep]");
      return 2;
    } catch (Exception e) { Console.Error.WriteLine("LAUNCHER-FAIL " + e.Message); return 1; }
  }
}
