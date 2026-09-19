using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public static class GitPathDiagnostic {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetCurrentDirectoryW(uint n, StringBuilder value);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetLongPathNameW(string path, StringBuilder value, uint n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder value, uint n, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint QueryDosDeviceW(string name, StringBuilder value, uint n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetCurrentDirectoryW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DefineDosDeviceW(uint flags, string name, string target);
  public static string CreateAlias(string work) {
    for (char drive = 'Z'; drive >= 'D'; drive--) {
      var value = new StringBuilder(32768); string name = drive + ":";
      if (QueryDosDeviceW(name, value, 32768) != 0 || Marshal.GetLastWin32Error() != 2) continue;
      if (!DefineDosDeviceW(9, name, "\\??\\" + work)) throw new System.ComponentModel.Win32Exception();
      return name;
    }
    throw new InvalidOperationException("no unused per-session drive alias");
  }
  public static void RemoveAlias(string name, string work) {
    if (!DefineDosDeviceW(15, name, "\\??\\" + work)) throw new System.ComponentModel.Win32Exception();
  }
  static readonly List<object> rows = new List<object>();
  static void Record(string api, string path, uint result, StringBuilder value) {
    int error = result == 0 ? Marshal.GetLastWin32Error() : 0;
    rows.Add(new { api, path, result, error, value = result == 0 ? null : value.ToString() });
  }
  static void Inspect(string path) {
    var value = new StringBuilder(32768);
    Record("GetLongPathNameW", path, GetLongPathNameW(path, value, 32768), value);
    foreach (uint access in new uint[] { 0, 0x80, 0x80000000 }) {
      IntPtr h = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
      int error = h == new IntPtr(-1) ? Marshal.GetLastWin32Error() : 0;
      rows.Add(new { api = "CreateFileW", path, access, error });
      if (h == new IntPtr(-1)) continue;
      try {
        if (access == 0) foreach (uint flag in new uint[] { 0, 2, 4, 8 }) {
          value.Clear();
          Record("GetFinalPathNameByHandleW:" + flag, path, GetFinalPathNameByHandleW(h, value, 32768, flag), value);
        }
      } finally { CloseHandle(h); }
    }
  }
  public static int Main(string[] args) {
    var value = new StringBuilder(32768);
    Record("GetCurrentDirectoryW", "cwd", GetCurrentDirectoryW(32768, value), value);
    string work = args[1];
    for (string p = work; p != null; p = Path.GetDirectoryName(p.TrimEnd('\\'))) {
      Inspect(p);
      if (p == Path.GetPathRoot(p)) break;
    }
    foreach (string rel in new[] { ".git", ".git\\HEAD", ".git\\index", ".git\\config", ".git\\objects", ".git\\refs", ".git\\hooks", ".git\\worktrees", "implementation.txt" }) Inspect(Path.Combine(work, rel));
    Inspect("\\\\?\\" + work);
    IntPtr directory = CreateFileW(work, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (directory != new IntPtr(-1)) {
      value.Clear();
      if (GetFinalPathNameByHandleW(directory, value, 32768, 2) > 0) {
        string ntPath = "\\\\?\\GLOBALROOT" + value.ToString();
        Inspect(ntPath);
        bool changed = SetCurrentDirectoryW(ntPath);
        rows.Add(new { api = "SetCurrentDirectoryW:NT", path = ntPath, error = changed ? 0 : Marshal.GetLastWin32Error() });
        if (changed) { value.Clear(); Record("GetCurrentDirectoryW:NT", "cwd", GetCurrentDirectoryW(32768, value), value); }
        SetCurrentDirectoryW(work);
      }
      CloseHandle(directory);
    }
    foreach (string variable in new[] { "TEMP", "TMP", "HOME", "USERPROFILE" }) {
      string p = Environment.GetEnvironmentVariable(variable);
      rows.Add(new { api = "environment", path = variable, value = p });
      if (!String.IsNullOrEmpty(p)) Inspect(p);
    }
    value.Clear(); Record("QueryDosDeviceW", "C:", QueryDosDeviceW("C:", value, 32768), value);
    Inspect("\\\\.\\MountPointManager");
    if (args.Length > 2) {
      string alias = args[2];
      value.Clear(); Record("QueryDosDeviceW:alias", alias, QueryDosDeviceW(alias, value, 32768), value);
      Inspect(alias + "\\");
      bool changed = SetCurrentDirectoryW(alias + "\\");
      rows.Add(new { api = "SetCurrentDirectoryW:alias", path = alias, error = changed ? 0 : Marshal.GetLastWin32Error() });
      if (changed) {
        value.Clear(); Record("GetCurrentDirectoryW:alias", alias, GetCurrentDirectoryW(32768, value), value);
        foreach (string command in new[] { "rev-parse --show-toplevel", "status --porcelain", "diff", "diff --cached", "add -- implementation.txt", "diff --cached" }) try {
          var start = new System.Diagnostics.ProcessStartInfo("C:\\Program Files\\Git\\cmd\\git.exe", command);
          start.UseShellExecute = false; start.RedirectStandardOutput = true; start.RedirectStandardError = true; start.CreateNoWindow = true;
          start.EnvironmentVariables["GIT_CONFIG_NOSYSTEM"] = "1";
          start.EnvironmentVariables["GIT_CONFIG_GLOBAL"] = "NUL";
          var child = System.Diagnostics.Process.Start(start);
          string stdout = child.StandardOutput.ReadToEnd(), stderr = child.StandardError.ReadToEnd(); child.WaitForExit();
          rows.Add(new { api = "git:alias", path = alias, command, status = child.ExitCode, stdout, stderr });
        } catch (Exception error) { rows.Add(new { api = "git:alias", path = alias, command, error = error.Message }); }
        SetCurrentDirectoryW(work);
      }
    }
    File.WriteAllText(args[0], new JavaScriptSerializer().Serialize(rows));
    return 0;
  }
}
