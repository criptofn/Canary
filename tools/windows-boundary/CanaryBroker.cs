// Canary authenticated native transport: production controller plus legacy blob harness.
//
// Runs OUTSIDE the confinement, under the normal user identity. Owns the custody key,
// the trusted store, the review verdict and the promotion target. It authenticates
// every request by impersonating the named-pipe client and measuring the CLIENT's real
// token (AppContainer SID, restricted, zero capabilities, low integrity). The confined
// caller receives no key material and never applies anything itself.
//
// Deliberately dependency-free JSON writing and a minimal reader, so what this file
// claims to have observed is visible in the same file that observed it.
//
// --controller pins the production verifier/promoter. Without it, only the
// legacy non-activating diagnostic protocol is served. No elevation or service.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CanaryBroker {
  /// <summary>Minimal, dependency-free JSON strings and field reader for the audit path.</summary>
  internal static class MiniJson {
    public static string Str(string value) {
      if (value == null) return "null";
      var sb = new StringBuilder("\"");
      foreach (char c in value) {
        switch (c) {
          case '"': sb.Append("\\\""); break;
          case '\\': sb.Append("\\\\"); break;
          case '\n': sb.Append("\\n"); break;
          case '\r': sb.Append("\\r"); break;
          case '\t': sb.Append("\\t"); break;
          default:
            if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c);
            break;
        }
      }
      return sb.Append('"').ToString();
    }
    public static string Str(object value) { return Str(value == null ? null : Convert.ToString(value)); }

    /// <summary>
    /// Value of the first "key": ... occurrence at ANY depth, unescaped. Null when absent.
    /// A real scanner, not a depth counter: the request genuinely nests the caller's claim, and
    /// a reader that cannot see nested keys would silently see no claim at all.
    /// </summary>
    public static string Field(string json, string key) {
      if (json == null) return null;
      string needle = "\"" + key + "\"";
      for (int index = 0; index < json.Length; index++) {
        if (json[index] != '"') continue;
        if (String.CompareOrdinal(json, index, needle, 0, needle.Length) == 0
            && index + needle.Length < json.Length && json[index + needle.Length] == ':') {
          int i = index + needle.Length + 1;
          while (i < json.Length && Char.IsWhiteSpace(json[i])) i++;
          return Value(json, i);
        }
        // Not the key: skip the whole string literal so keys inside values are never matched.
        index = SkipString(json, index) - 1;
        if (index < 0) return null;
      }
      return null;
    }

    static int SkipString(string json, int start) {
      for (int i = start + 1; i < json.Length; i++) {
        if (json[i] == '\\') { i++; continue; }
        if (json[i] == '"') return i + 1;
      }
      return json.Length;
    }

    static string Value(string json, int start) {
      if (start >= json.Length) return null;
      if (json[start] == '"') {
        var sb = new StringBuilder(); bool escaped = false;
        for (int j = start + 1; j < json.Length; j++) {
          char c = json[j];
          if (escaped) {
            if (c == 'n') sb.Append('\n');
            else if (c == 'r') sb.Append('\r');
            else if (c == 't') sb.Append('\t');
            else if (c == 'u' && j + 4 < json.Length) { sb.Append((char)Convert.ToInt32(json.Substring(j + 1, 4), 16)); j += 4; }
            else sb.Append(c);
            escaped = false; continue;
          }
          if (c == '\\') { escaped = true; continue; }
          if (c == '"') break;
          sb.Append(c);
        }
        return sb.ToString();
      }
      int end = start;
      while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != ']') end++;
      return json.Substring(start, end - start).Trim();
    }
  }

  public static class Program {
    /// <summary>Argument vector from a file, one argument per line (see the relay's contract).</summary>
    static string[] ArgumentFile(string path) {
      if (!File.Exists(path)) throw new ArgumentException("argument file not found: " + path);
      var list = new List<string>(File.ReadAllLines(path));
      while (list.Count > 0 && list[list.Count - 1].Length == 0) list.RemoveAt(list.Count - 1);
      return list.ToArray();
    }

    public static int Main(string[] args) {
      try {
        // The argument vector arrives from a file: shells on this host consume the first option
        // pair after a bound parameter, so operation arguments never travel through a parser.
        string[] argv = args;
        if (args.Length > 0 && args[0] == "@argv") {
          if (args.Length < 2) { Console.Error.WriteLine("usage: broker @argv <file>"); return 2; }
          argv = ArgumentFile(args[1]);
        }
        var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i + 1 < argv.Length; i += 2) options[argv[i].TrimStart('-')] = argv[i + 1];
        if (!options.ContainsKey("pipe") || !options.ContainsKey("store") || !options.ContainsKey("target")) {
          Console.Error.WriteLine("usage: broker --pipe <name> --store <dir> --target <dir> --package <sid> --key <secret> [--ready <file>] [--identity <sid>] [--log <file>]");
          return 2;
        }
        return new Broker(options).Serve();
      } catch (Exception e) { Console.Error.WriteLine("BROKER-FAIL " + e.Message); return 1; }
    }
  }

  public sealed class Broker {
    static string J(string s) { return MiniJson.Str(s); }
    const string StoreSecretName = "custody-key-material.txt";
    const string StoreEvidenceName = "evidence.log";
    const string TargetName = "promoted.bin";
    // Only a trusted operator can enroll this non-secret review artifact. Never review keys.
    const string ReviewName = "review-artifact.bin";
    byte[] _reviewedBytes;
    string _reviewReceipt, _reviewRevision;

    readonly string _pipe, _store, _target, _expectedPackage, _key, _readyFile, _expectedIdentity, _logFile;
    readonly string _controller, _node;
    public Broker(Dictionary<string, string> o) {
      _pipe = o["pipe"]; _store = o["store"]; _target = o["target"];
      _controller = o.ContainsKey("controller") ? o["controller"] : null;
      _node = o.ContainsKey("node") ? o["node"] : null;
      _expectedPackage = o.ContainsKey("package") ? o["package"] : null;
      _expectedIdentity = o.ContainsKey("identity") ? o["identity"] : null;
      _key = o.ContainsKey("key") ? o["key"] : Guid.NewGuid().ToString("N");
      _readyFile = o.ContainsKey("ready") ? o["ready"] : null;
      _logFile = o.ContainsKey("log") ? o["log"] : null;
      if (_logFile != null) File.WriteAllText(_logFile, DateTime.UtcNow.ToString("o") + " broker starting\n");
    }
    void Note(string message) {
      if (_logFile != null) { try { File.AppendAllText(_logFile, DateTime.UtcNow.ToString("o") + " " + message + "\n"); } catch { } }
    }
    string Key { get { return _key; } }
    string StoreSecretPath { get { return Path.Combine(_store, StoreSecretName); } }
    string StoreEvidencePath { get { return Path.Combine(_store, StoreEvidenceName); } }
    string TargetPath { get { return Path.Combine(_target, TargetName); } }

    static string Hex(byte[] bytes) {
      var sb = new StringBuilder(bytes.Length * 2);
      foreach (byte b in bytes) sb.Append(b.ToString("x2"));
      return sb.ToString();
    }
    internal static string Hmac(string key, string payload) {
      using (var h = new HMACSHA256(Encoding.UTF8.GetBytes(key)))
        return Hex(h.ComputeHash(Encoding.UTF8.GetBytes(payload)));
    }
    static string Sha(byte[] bytes) { using (var h = SHA256.Create()) return Hex(h.ComputeHash(bytes)); }

    // ---- identity authentication -------------------------------------------------------
    sealed class Client {
      public string package, identity, integrity; public int capabilities;
      public bool appContainer, restricted, networkCapability;
      public string Describe() {
        return "package=" + package + " appContainer=" + appContainer + " restricted=" + restricted +
          " capabilities=" + capabilities + " networkCapability=" + networkCapability +
          " integrity=" + integrity + " identity=" + identity;
      }
      public string Json() {
        return "{\"package\":" + J(package) + ",\"appContainer\":" + (appContainer ? "true" : "false") +
          ",\"restricted\":" + (restricted ? "true" : "false") + ",\"capabilities\":" + capabilities +
          ",\"networkCapability\":" + (networkCapability ? "true" : "false") + ",\"integrity\":" + J(integrity) +
          ",\"identity\":" + J(identity) + "}";
      }
    }

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr t, int kind, IntPtr info, int size, out int needed);

    /// <summary>Key: a SecurityIdentifier value, or "-" when the query yields nothing usable.</summary>
    static string SidAt(IntPtr buffer) {
      IntPtr pointer = Marshal.ReadIntPtr(buffer);
      if (pointer == IntPtr.Zero) return "-";
      try { return new SecurityIdentifier(pointer).Value; } catch { return "unreadable"; }
    }

    static IntPtr Info(IntPtr token, int kind) {
      int size; GetTokenInformation(token, kind, IntPtr.Zero, 0, out size);
      if (size <= 0) throw new InvalidOperationException("token query " + kind + " returned no size");
      IntPtr data = Marshal.AllocHGlobal(size);
      if (!GetTokenInformation(token, kind, data, size, out size)) {
        int code = Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(data);
        throw new InvalidOperationException("GetTokenInformation " + kind + " Win32 " + code);
      }
      return data;
    }

    /// <summary>
    /// Measure the token of whoever is currently impersonated on this thread. TOKEN_USER is a
    /// SID_AND_ATTRIBUTES, so its SID pointer is the first field; TOKEN_CAPABILITIES holds its
    /// count at offset 0 and its array at offset IntPtr.Size. Both are read at those explicit
    /// offsets rather than through a marshalled struct.
    /// </summary>
    static Client MeasureThreadToken() {
      IntPtr token = IntPtr.Zero, app = IntPtr.Zero, caps = IntPtr.Zero, label = IntPtr.Zero, sid = IntPtr.Zero, restrictions = IntPtr.Zero, user = IntPtr.Zero;
      try {
        if (!OpenThreadToken(GetCurrentThread(), 0x8, false, out token))
          throw new InvalidOperationException("OpenThreadToken Win32 " + Marshal.GetLastWin32Error());
        app = Info(token, 29); caps = Info(token, 30); label = Info(token, 25); sid = Info(token, 31); restrictions = Info(token, 21); user = Info(token, 1);
        uint capabilityCount = unchecked((uint)Marshal.ReadInt32(caps));
        IntPtr capabilityArray = IntPtr.Add(caps, IntPtr.Size);
        var client = new Client {
          appContainer = Marshal.ReadInt32(app) != 0,
          capabilities = capabilityCount > 1024 ? -1 : (int)capabilityCount,
          restricted = Marshal.ReadInt32(restrictions) != 0,
          integrity = SidAt(label),
          package = SidAt(sid),
          identity = SidAt(user)
        };
        for (uint i = 0; i < capabilityCount && i < 1024; i++) {
          IntPtr entry = Marshal.ReadIntPtr(capabilityArray, (int)(i * IntPtr.Size * 2));
          if (entry == IntPtr.Zero) continue;
          try { if (new SecurityIdentifier(entry).Value.StartsWith("S-1-15-3-1", StringComparison.Ordinal)) client.networkCapability = true; } catch { }
        }
        return client;
      } finally {
        foreach (IntPtr p in new[] { app, caps, label, sid, restrictions, user }) if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
        if (token != IntPtr.Zero) CloseHandle(token);
      }
    }

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateNamedPipeClient(IntPtr pipe);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();
    [DllImport("Firewallapi.dll", CharSet = CharSet.Unicode)]
    static extern uint NetworkIsolationDiagnoseConnectFailureAndGetInfo(string server, out int error);

    /// <summary>
    /// Run one operation with the connected pipe client impersonated, then always revert. The
    /// broker never trusts a field the caller sent about itself: the identity check and every
    /// file decision read the token the kernel attached to this very connection.
    /// </summary>
    T AsClient<T>(NamedPipeServerStream pipe, Func<Client, T> operation) {
      IntPtr handle = pipe.SafePipeHandle.DangerousGetHandle();
      if (!ImpersonateNamedPipeClient(handle))
        throw new InvalidOperationException("ImpersonateNamedPipeClient Win32 " + Marshal.GetLastWin32Error());
      try { return operation(MeasureThreadToken()); }
      finally {
        if (!RevertToSelf()) Environment.FailFast("broker could not revert client impersonation");
      }
    }

    // ---- pipe creation with an explicit DACL -------------------------------------------
    static NamedPipeServerStream Listen(string pipeName, string callerSid, SecurityIdentifier owner) {
      var security = new PipeSecurity();
      security.SetOwner(owner);
      security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.FullControl, AccessControlType.Allow));
      if (!String.IsNullOrEmpty(callerSid) && callerSid != owner.Value)
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(callerSid),
          PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance | PipeAccessRights.Synchronize,
          AccessControlType.Allow));
      // Set and read back our chosen low label separately from the DACL. A package
      // grant can allow AppContainer access to a medium-label object too; medium
      // integrity alone is NOT a connection-denial control. See the paired ACL probe.
      var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous, 1 << 16, 1 << 16, security);
      ApplyLowMandatoryLabel(pipe.SafePipeHandle.DangerousGetHandle());
      return pipe;
    }

    // ---- mandatory label -----------------------------------------------------------------
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint securityInformation, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint information, out IntPtr owner,
      out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

    /// <summary>Attach SACL S:(ML;;NW;;;LW) to the pipe: the label an AppContainer needs.</summary>
    static void ApplyLowMandatoryLabel(IntPtr handle) {
      IntPtr descriptor; uint size;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;;NW;;;LW)", 1, out descriptor, out size))
        throw new InvalidOperationException("low-label SDDL Win32 " + Marshal.GetLastWin32Error());
      try {
        bool present, defaulted; IntPtr acl;
        if (!GetSecurityDescriptorSacl(descriptor, out present, out acl, out defaulted) || !present || acl == IntPtr.Zero)
          throw new InvalidOperationException("mandatory label ACL is absent");
        uint error = SetSecurityInfo(handle, 6 /*SE_KERNEL_OBJECT*/, 0x10 /*LABEL_SECURITY_INFORMATION*/,
          IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, acl);
        if (error != 0) throw new InvalidOperationException("SetSecurityInfo low label Win32 " + error);
        VerifyLowMandatoryLabel(handle);
      } finally { LocalFree(descriptor); }
    }

    public static void VerifyLowMandatoryLabel(IntPtr handle) {
      IntPtr owner, group, dacl, sacl, descriptor;
      uint error = GetSecurityInfo(handle, 6, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
      if (error != 0) throw new InvalidOperationException("GetSecurityInfo label Win32 " + error);
      try {
        byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
        Marshal.Copy(descriptor, bytes, 0, bytes.Length);
        var security = new RawSecurityDescriptor(bytes, 0);
        if (security.SystemAcl == null || security.SystemAcl.Count != 1)
          throw new InvalidOperationException("pipe label absent or ambiguous");
        byte[] ace = new byte[security.SystemAcl[0].BinaryLength];
        security.SystemAcl[0].GetBinaryForm(ace, 0);
        // SYSTEM_MANDATORY_LABEL_ACE: type 0x11, mask NO_WRITE_UP, low-integrity SID.
        if (ace.Length < 12 || ace[0] != 0x11 || BitConverter.ToUInt32(ace, 4) != 1 ||
            new SecurityIdentifier(ace, 8).Value != "S-1-16-4096")
          throw new InvalidOperationException("pipe label is not low-integrity NO_WRITE_UP");
      } finally { LocalFree(descriptor); }
    }

    // ---- serving -----------------------------------------------------------------------
    public int Serve() {
      var owner = WindowsIdentity.GetCurrent().User;
      NamedPipeServerStream pipe;
      try { pipe = Listen(_pipe, _expectedPackage, owner); }
      catch (Exception e) { Note("BROKER-FAIL listen " + e.GetType().Name + ": " + e.Message); throw; }
      Note("broker listening pipe=" + _pipe + " owner=" + owner.Value + " expectedCaller=" + (_expectedPackage ?? "any"));
      // One caller at a time, but many callers in sequence: the broker serves the whole
      // session, so each connected caller is authenticated on its own connection.
      while (true) {
        pipe.WaitForConnection();
        Note("broker accepted a caller");
        // Readiness is announced only after a caller is connected: a StreamReader on a pipe
        // with no connection throws, so announcing earlier would lie about being able to serve.
        if (_readyFile != null) File.WriteAllText(_readyFile, owner.Value);
        var reader = new StreamReader(pipe, new UTF8Encoding(false));
        var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
        string line;
        while ((line = reader.ReadLine()) != null) {
          if (line.Length == 0) continue;
          string request = line;
          string response;
          try {
            // Which identity a verb runs under is part of the protocol, not an accident:
            // "probe" verbs run as the CALLER (so the caller's own boundary decides), and
            // "custody" verbs run as the BROKER (that is what custody means). Both are still
            // gated on the caller's authenticated token.
            string verb = MiniJson.Field(request, "verb");
            bool asCaller = verb == "current" || verb == "network-diagnostic";
            if (_controller != null) {
              Client client = AsClient<Client>(pipe, c => c);
              bool heartbeat = verb == "heartbeat" && client.identity == _expectedIdentity && !client.appContainer;
              response = (IdentityOk(client) || heartbeat) ? Production(request, client) : Refusal(request, client);
            } else if (asCaller) {
              response = AsClient(pipe, client => IdentityOk(client)
                ? Dispatch(request, client)
                : Refusal(request, client));
            } else {
              Client client = AsClient<Client>(pipe, c => c);
              response = IdentityOk(client) ? Dispatch(request, client) : Refusal(request, client);
            }
          } catch (Exception e) { Note("BROKER-FAIL dispatch " + e.GetType().Name + ": " + e.Message); response = Response(500, "error", e.Message, null); }
          writer.WriteLine(response);
          Note("broker answered verb=" + MiniJson.Field(request, "verb") + " status=" + response.Substring(0, Math.Min(24, response.Length)));
        }
        Note("broker caller disconnected; awaiting the next connection");
        pipe.Disconnect();
      }
    }

    string Refusal(string request, Client client) {
      return Response(403, MiniJson.Field(request, "verb"),
        "broker refuses: caller identity is not the provisioned confined caller",
        "{\"identityOk\":false,\"requiredPackage\":" + J(_expectedPackage) + ",\"brokerSees\":" + client.Json() + "}");
    }

    string Production(string request, Client client) {
      if (String.IsNullOrEmpty(_expectedIdentity) || client.identity != _expectedIdentity)
        return Response(403, "production", "foreign owner identity", null);
      if (request.Length > 4 * 1024 * 1024) return Response(413, "production", "request too large", null);
      if (String.IsNullOrEmpty(_node)) throw new InvalidOperationException("trusted Node runtime missing");
      // Only trusted operator configuration selects executable/controller/store.
      foreach (string value in new[] { _node, _controller, _store })
        if (value.Contains("\"") || !Path.IsPathRooted(value)) throw new InvalidOperationException("invalid controller path");
      var start = new System.Diagnostics.ProcessStartInfo(_node,
        "\"" + _controller + "\" provider authority \"" + _store + "\"") {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
      };
      using (var process = System.Diagnostics.Process.Start(start)) {
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        process.StandardInput.Write("{\"client\":" + client.Json() + ",\"request\":" + request + "}");
        process.StandardInput.Close();
        if (!process.WaitForExit(600000)) { process.Kill(); throw new InvalidOperationException("controller deadline exceeded"); }
        string response = output.Result.Trim();
        File.AppendAllText(Path.Combine(_store, "controller.log"), errors.Result);
        if (process.ExitCode != 0 || response.Length == 0 || response.Length > 1048576)
          return Response(403, "production", "controller refused the request", null);
        File.AppendAllText(Path.Combine(_store, "authority.jsonl"),
          "{\"at\":" + J(DateTime.UtcNow.ToString("o")) + ",\"client\":" + client.Json() +
          ",\"request\":" + request + ",\"response\":" + response + "}\n");
        return response;
      }
    }

    bool IdentityOk(Client c) {
      return !String.IsNullOrEmpty(_expectedPackage) && c.package == _expectedPackage && c.appContainer && c.restricted &&
             c.capabilities == 0 && !c.networkCapability && c.integrity == "S-1-16-4096";
    }

    static string Response(int status, string verb, string detail, string verification) {
      var sb = new StringBuilder();
      sb.Append("{\"status\":").Append(status).Append(",\"verb\":").Append(J(verb)).Append(",\"detail\":").Append(J(detail));
      if (verification != null) sb.Append(",\"verification\":").Append(verification);
      return sb.Append('}').ToString();
    }

    string Dispatch(string request, Client client) {
      string verb = MiniJson.Field(request, "verb");
      switch (verb) {
        case "network-diagnostic": {
          int isolationError;
          uint result = NetworkIsolationDiagnoseConnectFailureAndGetInfo("127.0.0.1", out isolationError);
          return Response(200, verb, "Windows network isolation diagnostic under authenticated client impersonation",
            "{\"nativeResult\":" + result + ",\"isolationError\":" + isolationError + "}");
        }
        case "hello": {
          string claim = MiniJson.Field(request, "package");
          return Response(200, verb, "boundary measured on the caller's live token",
            "{\"brokerSees\":" + client.Json() + ",\"clientClaimPackage\":" + J(claim) +
            ",\"packageMatchesClaim\":" + (claim == client.package ? "true" : "false") +
            ",\"expectedIdentity\":" + J(_expectedIdentity) + "}");
        }
        case "current": {
          // Impersonated read: this runs with the CALLER's access. If the caller cannot read
          // the trusted store, the broker refuses under the caller's effective access.
          // The path is the broker's own; no path ever arrives from the caller.
          string content = null, failure = null;
          try { content = File.ReadAllText(StoreSecretPath); }
          catch (Exception e) { failure = e.GetType().Name + ": " + e.Message; }
          return Response(content != null ? 200 : 403, verb,
            content != null ? "read under impersonated caller access" : "trusted read refused under caller access: " + failure,
            "{\"path\":\"broker-configured\",\"readSucceeded\":" + (content != null ? "true" : "false") + ",\"failure\":" + J(failure) + "}");
        }
        case "review": {
          // Trusted review path: the broker reads its OWN artifact under its OWN token and
          // mints the receipt from that read. This is the custody operation the confined
          // caller can request but cannot perform or forge.
          _reviewedBytes = null; _reviewReceipt = null; _reviewRevision = null;
          string artifact = Path.Combine(_store, ReviewName);
          if ((File.GetAttributes(artifact) & FileAttributes.ReparsePoint) != 0)
            return Response(403, verb, "review artifact cannot be a reparse point", null);
          byte[] bytes = File.ReadAllBytes(artifact);
          _reviewRevision = Sha(bytes);
          // Session-local, one-use authority. Neither artifact nor destination is caller-selected.
          _reviewReceipt = "v2|" + _reviewRevision + "|" + Hmac(Key,
            Guid.NewGuid().ToString("N") + "|" + _store + "|" + _target + "|" + _expectedPackage + "|" + _reviewRevision);
          _reviewedBytes = bytes;
          File.AppendAllText(StoreEvidencePath, DateTime.UtcNow.ToString("o") + " reviewed revision=" + _reviewRevision + "\n");
          return Response(200, verb, "broker read the enrolled non-secret artifact",
            "{\"revision\":" + J(_reviewRevision) + ",\"receipt\":" + J(_reviewReceipt) + "}");
        }
        case "self": {
          // Control: the broker's own running identity, so the probe can show that the
          // confinement is a property of the CALLER, not of the host.
          using (var identity = WindowsIdentity.GetCurrent()) {
            return Response(200, verb, "broker self-identity",
              "{\"name\":" + J(identity.Name) + ",\"identity\":" + J(identity.User.Value) + ",\"isSystem\":" + (identity.IsSystem ? "true" : "false") + "}");
          }
        }
        case "sign": {
          return Response(403, verb, "generic signing is not a broker operation", null);
        }
        case "promote": {
          string revision = MiniJson.Field(request, "revision");
          string signature = MiniJson.Field(request, "receipt");
          string body = MiniJson.Field(request, "body");
          string receipt;
          if (String.IsNullOrEmpty(revision) || String.IsNullOrEmpty(signature) || _reviewedBytes == null) {
            receipt = "{\"accepted\":false,\"reason\":\"incomplete request\"}";
          } else {
            if (signature != _reviewReceipt || revision != _reviewRevision) {
              receipt = "{\"accepted\":false,\"reason\":\"receipt signature is not broker custody\"}";
            } else if (body != null || MiniJson.Field(request, "project") != null ||
                       MiniJson.Field(request, "candidate") != null || MiniJson.Field(request, "target") != null) {
              receipt = "{\"accepted\":false,\"reason\":\"body does not match the reviewed revision\"}";
            } else {
              Directory.CreateDirectory(_target);
              byte[] verified = _reviewedBytes;
              _reviewedBytes = null; _reviewReceipt = null; _reviewRevision = null;
              File.WriteAllBytes(TargetPath, verified); // broker-held bytes, not caller body
              if (Sha(File.ReadAllBytes(TargetPath)) != revision)
                throw new InvalidOperationException("promoted bytes failed readback");
              File.AppendAllText(StoreEvidencePath, DateTime.UtcNow.ToString("o") + " promoted revision=" + revision + "\n");
              receipt = "{\"accepted\":true,\"reason\":\"verified against broker review\",\"appliedBy\":\"broker\"}";
            }
          }
          return Response(200, verb, "promotion verification", "{\"receipt\":" + receipt + "}");
        }
        default:
          return Response(400, verb, "unknown verb", null);
      }
    }
  }
}
