using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace PhoneCtl {
    // A crash must end with an exit code and a stderr line, never a Windows error dialog
    // (the launcher runs the relay unattended and restarts the session on failure).
    static class Crash {
        [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
        public static void Quiet() {
            SetErrorMode(0x0001 | 0x0002); // SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX
            AppDomain.CurrentDomain.UnhandledException += (sender, e) => {
                try { Console.Error.WriteLine("Unhandled exception: " + e.ExceptionObject); } catch (Exception) { }
                Environment.Exit(70);
            };
        }
    }
    public sealed class RelaySession : IDisposable {
        readonly IPAddress phone;
        readonly int phonePort;
        readonly byte[] token, pin;
        readonly TcpListener listener;
        readonly object gate = new object();
        readonly List<TcpClient> clients = new List<TcpClient>();
        readonly Action<string> log;
        bool stopped;
        public int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }
        public bool IsStopped { get { lock (gate) return stopped; } }
        // Set when the session ends because of an error (pin, upstream connect), not a normal client close.
        public volatile bool Failed;
        public RelaySession(IPAddress phone, int phonePort, byte[] token, X509Certificate2 cert, Action<string> log) {
            this.phone = phone; this.phonePort = phonePort; this.token = token; this.log = log;
            using (SHA256 hash = SHA256.Create()) pin = hash.ComputeHash(cert.RawData);
            listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(3);
        }
        bool Track(TcpClient client) {
            lock (gate) { if (stopped) { client.Close(); return false; } clients.Add(client); return true; }
        }
        void Release(TcpClient client) { lock (gate) clients.Remove(client); client.Close(); }
        public void Stop() {
            lock (gate) {
                if (stopped) return;
                stopped = true; listener.Stop();
                // Close raw sockets first: this also interrupts concurrent SslStream reads/writes.
                foreach (TcpClient client in clients) client.Close();
                clients.Clear();
            }
        }
        SslStream Connect(byte role) {
            Stopwatch deadline = Stopwatch.StartNew();
            while (!IsStopped && deadline.ElapsedMilliseconds < 3000) {
                TcpClient upstream = new TcpClient(AddressFamily.InterNetwork); upstream.NoDelay = true;
                if (!Track(upstream)) return null;
                SslStream tls = null;
                bool pinRejected = false;
                try {
                    IAsyncResult pending = upstream.BeginConnect(phone, phonePort, null, null);
                    using (WaitHandle wait = pending.AsyncWaitHandle) {
                        int remaining = Math.Max(1, 3000 - (int)deadline.ElapsedMilliseconds);
                        if (!wait.WaitOne(Math.Min(1000, remaining))) throw new IOException("Upstream connect timeout");
                        upstream.EndConnect(pending);
                    }
                    tls = new SslStream(upstream.GetStream(), false, delegate(object sender, X509Certificate cert, X509Chain chain, SslPolicyErrors errors) {
                        byte[] actual; using (SHA256 hash = SHA256.Create()) actual = cert == null ? new byte[0] : hash.ComputeHash(cert.GetRawCertData());
                        int diff = actual.Length ^ pin.Length;
                        for (int i = 0; i < Math.Min(actual.Length, pin.Length); i++) diff |= actual[i] ^ pin[i];
                        pinRejected = diff != 0; return !pinRejected;
                    });
                    IAsyncResult auth = tls.BeginAuthenticateAsClient("phonectl", null, SslProtocols.Tls12, false, null, null);
                    using (WaitHandle wait = auth.AsyncWaitHandle) {
                        int remaining = Math.Max(1, 3000 - (int)deadline.ElapsedMilliseconds);
                        if (!wait.WaitOne(remaining)) throw new IOException("Upstream TLS timeout");
                        tls.EndAuthenticateAsClient(auth);
                    }
                    byte[] header = new byte[33]; Buffer.BlockCopy(token, 0, header, 0, 32); header[32] = role;
                    tls.WriteTimeout = Math.Max(1, 3000 - (int)deadline.ElapsedMilliseconds);
                    tls.Write(header, 0, header.Length); tls.Flush(); tls.WriteTimeout = Timeout.Infinite;
                    return tls;
                } catch (Exception e) {
                    upstream.Close(); if (tls != null) tls.Dispose(); Release(upstream);
                    if (pinRejected) { log("Certificate pin rejected"); Failed = true; Stop(); return null; }
                    if (IsStopped) return null;
                    if (!(e is IOException || e is SocketException || e is AuthenticationException || e is ObjectDisposedException || e is System.ComponentModel.Win32Exception)) throw;
                    int delay = Math.Min(100, 3000 - (int)deadline.ElapsedMilliseconds);
                    if (delay > 0) Thread.Sleep(delay);
                }
            }
            return null;
        }
        void Pump(Stream from, Stream to) {
            try {
                byte[] buffer = new byte[16384]; int count;
                while ((count = from.Read(buffer, 0, buffer.Length)) > 0) to.Write(buffer, 0, count);
            } catch (IOException) { } catch (ObjectDisposedException) { }
            finally { Stop(); }
        }
        public void Run() {
            byte role = 0;
            DateTime firstRoleAt = DateTime.MinValue;
            try {
                while (!IsStopped) {
                    TcpClient local = listener.AcceptTcpClient(); local.NoDelay = true;
                    if (!Track(local)) break;
                    // A stray local connection (another process, or more connects than enabled roles) must not
                    // kill the live session: drop only that connection.
                    if (role > 2) { log("Ignoring extra local connection"); Release(local); continue; }
                    SslStream tls = Connect(role);
                    if (tls == null) {
                        Release(local);
                        // scrcpy retries its initial forward connection. Do not consume role 0.
                        if (role == 0 && !IsStopped) continue;
                        // The client opens its roles back to back; a failure seconds later is a stray connection.
                        if ((DateTime.UtcNow - firstRoleAt).TotalSeconds > 5 && !IsStopped) { log("Ignoring late local connection"); continue; }
                        Failed = true; Stop(); break;
                    }
                    NetworkStream plain = local.GetStream();
                    Thread outbound = new Thread(() => Pump(plain, tls)); outbound.IsBackground = true;
                    Thread inbound = new Thread(() => { try { Pump(tls, plain); } finally { tls.Dispose(); } }); inbound.IsBackground = true;
                    if (role == 0) firstRoleAt = DateTime.UtcNow;
                    role++; outbound.Start(); inbound.Start();
                }
            } catch (SocketException) { if (!IsStopped) throw; }
              catch (ObjectDisposedException) { if (!IsStopped) throw; }
            finally { Stop(); }
        }
        public void Dispose() { Stop(); Array.Clear(token, 0, token.Length); }
    }

    public static class Program {
        public static IPAddress GetPeer(IPAddress phone) {
            using (Socket udp = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)) {
                udp.Connect(new IPEndPoint(phone, 9)); return ((IPEndPoint)udp.LocalEndPoint).Address;
            }
        }
        static void WriteSession(string path, int port, IPAddress peer, byte[] token, SessionIdentity identity) {
            long created = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
            string text = "version=1\ncreated=" + created + "\nport=" + port + "\npeer=" + peer +
                "\ntoken=" + Convert.ToBase64String(token) + "\npfx=" + Convert.ToBase64String(identity.Pfx) + "\npfxpass=" + identity.Password + "\n";
            FileSecurity security = new FileSecurity(); security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
            using (FileStream file = new FileStream(path, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, security)) {
                byte[] bytes = Encoding.ASCII.GetBytes(text); file.Write(bytes, 0, bytes.Length); Array.Clear(bytes, 0, bytes.Length);
            }
        }
        public static int Main(string[] args) {
            Crash.Quiet();
            if (args.Length != 0) { Console.Error.WriteLine("Use three stdin lines: phone IPv4, port, session path"); return 1; }
            string path = null; bool wrote = false;
            try {
                IPAddress phone;
                if (!IPAddress.TryParse(Console.ReadLine(), out phone) || phone.AddressFamily != AddressFamily.InterNetwork) throw new ArgumentException("Expected phone IPv4");
                int port;
                if (!Int32.TryParse(Console.ReadLine(), out port) || port < 20000 || port > 60999) throw new ArgumentException("Expected phone port 20000..60999");
                path = Console.ReadLine(); if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path)) throw new ArgumentException("Expected absolute session path");
                IPAddress peer;
                string requestedPeer = Environment.GetEnvironmentVariable("PHONECTL_PEER");
                if (!String.IsNullOrEmpty(requestedPeer)) {
                    if (!IPAddress.TryParse(requestedPeer, out peer) || peer.AddressFamily != AddressFamily.InterNetwork) throw new ArgumentException("Expected peer IPv4");
                } else {
                    peer = GetPeer(phone);
                }
                byte[] token = CertificateFactory.RandomBytes(32);
                using (SessionIdentity identity = CertificateFactory.Create())
                using (RelaySession relay = new RelaySession(phone, port, token, identity.Certificate, s => Console.Error.WriteLine(s))) {
                    WriteSession(path, port, peer, token, identity); wrote = true;
                    Thread stdin = new Thread(() => { try { while (Console.ReadLine() != null) { } } finally { relay.Stop(); } });
                    stdin.IsBackground = true; stdin.Start();
                    Console.WriteLine("READY " + relay.Port); Console.Out.Flush();
                    relay.Run(); return relay.Failed ? 2 : 0;
                }
            } catch (Exception e) { Console.Error.WriteLine("Relay failed: " + e.GetType().Name); return 1; }
            finally { if (wrote && File.Exists(path)) File.Delete(path); }
        }
    }
}
