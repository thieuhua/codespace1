using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Threading;

namespace PhoneCtl {
    sealed class FakePhone : IDisposable {
        readonly TcpListener listener;
        readonly X509Certificate2 cert;
        readonly object gate = new object();
        readonly List<TcpClient> clients = new List<TcpClient>();
        public readonly List<byte[]> Headers = new List<byte[]>();
        public int Accepted, ApplicationBytes;
        volatile bool stopped;
        public bool StallTls;
        public int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }
        public FakePhone(X509Certificate2 cert, int port) {
            this.cert = cert; listener = new TcpListener(IPAddress.Loopback, port); listener.Start();
            Thread accept = new Thread(Accept); accept.IsBackground = true; accept.Start();
        }
        void Accept() {
            try { while (!stopped) {
                TcpClient client = listener.AcceptTcpClient();
                lock (gate) { if (stopped) { client.Close(); break; } clients.Add(client); }
                Interlocked.Increment(ref Accepted);
                Thread t = new Thread(() => Serve(client)); t.IsBackground = true; t.Start();
            }} catch (SocketException) { } catch (ObjectDisposedException) { }
        }
        void Serve(TcpClient client) {
            try {
                if (StallTls) { while (!stopped && client.GetStream().ReadByte() >= 0) { } return; }
                using (SslStream tls = new SslStream(client.GetStream(), false)) {
                    tls.AuthenticateAsServer(cert, false, SslProtocols.Tls12, false);
                    byte[] header = new byte[33]; int offset = 0;
                    while (offset < 33) {
                        int count = tls.Read(header, offset, 33 - offset); if (count == 0) return;
                        Interlocked.Add(ref ApplicationBytes, count); offset += count;
                    }
                    lock (Headers) Headers.Add(header);
                    if (header[32] == 0) tls.WriteByte(0);
                    int value; while ((value = tls.ReadByte()) >= 0) tls.WriteByte((byte)value);
                }
            } catch (IOException) { } catch (AuthenticationException) { } catch (ObjectDisposedException) { }
              catch (System.ComponentModel.Win32Exception e) { Console.WriteLine("  TLS platform error: " + e.Message); }
            finally { client.Close(); }
        }
        public void Dispose() { lock (gate) { stopped = true; listener.Stop(); foreach (var c in clients) c.Close(); } }
    }
    public static class Tests {
        static int passed, failed;
        static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
        static void Wait(Func<bool> condition, int ms, string message) {
            Stopwatch clock = Stopwatch.StartNew(); while (!condition() && clock.ElapsedMilliseconds < ms) Thread.Sleep(20);
            Assert(condition(), message);
        }
        static void Test(string name, Action body) {
            try { body(); passed++; Console.WriteLine("PASS " + name); }
            catch (Exception e) { failed++; Console.WriteLine("FAIL " + name + ": " + e); }
        }
        static Thread Start(RelaySession relay) { Thread t = new Thread(relay.Run); t.IsBackground = true; t.Start(); return t; }
        static TcpClient Local(RelaySession relay) {
            TcpClient c = new TcpClient(); c.Connect(IPAddress.Loopback, relay.Port); c.ReceiveTimeout = 5000; return c;
        }
        static void Closed(TcpClient c) {
            try { Assert(c.GetStream().ReadByte() == -1, "Expected EOF"); } catch (IOException) { }
        }
        static int FreePort() { TcpListener l = new TcpListener(IPAddress.Loopback, 0); l.Start(); int p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p; }
        public static int Main(string[] args) {
            Crash.Quiet();
            using (SessionIdentity identity = CertificateFactory.Create()) {
                Test("PFX roundtrip: private key, P256 or RSA2048, legacy 3DES/SHA1", () => {
                    Assert(identity.Certificate.HasPrivateKey, "PFX lost private key");
                    string oid = identity.Certificate.PublicKey.Oid.Value;
                    Assert(oid == "1.2.840.10045.2.1" || (oid == "1.2.840.113549.1.1.1" && identity.Certificate.PublicKey.Key.KeySize == 2048), "Unexpected key");
                    byte[] pbe = { 6, 10, 42, 134, 72, 134, 247, 13, 1, 12, 1, 3 };
                    int found = 0; for (int i = 0; i <= identity.Pfx.Length - pbe.Length; i++) if (identity.Pfx.Skip(i).Take(pbe.Length).SequenceEqual(pbe)) found++;
                    Assert(found == 2, "Both safe contents must use SHA1/3DES");
                    Console.WriteLine("  certificate key OID: " + oid);
                });
                Test("lazy connect, token bytes, ordered roles 0/1/2, bidirectional forwarding and teardown", () => {
                    byte[] token = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
                    using (FakePhone phone = new FakePhone(identity.Certificate, 0))
                    using (RelaySession relay = new RelaySession(IPAddress.Loopback, phone.Port, token, identity.Certificate, s => {})) {
                        Thread thread = Start(relay); Thread.Sleep(100); Assert(phone.Accepted == 0, "Not lazy");
                        TcpClient[] local = new TcpClient[3];
                        try {
                            for (int i = 0; i < 3; i++) {
                                local[i] = Local(relay);
                                if (i == 0) Assert(local[i].GetStream().ReadByte() == 0, "Missing server dummy byte");
                                local[i].GetStream().WriteByte((byte)(80 + i));
                                Assert(local[i].GetStream().ReadByte() == 80 + i, "Echo mismatch");
                            }
                            lock (phone.Headers) {
                                Assert(phone.Headers.Count == 3, "Expected three TLS legs");
                                for (int i = 0; i < 3; i++) {
                                    Assert(phone.Headers[i][32] == i, "Wrong role order");
                                    Assert(phone.Headers[i].Take(32).SequenceEqual(token), "Wrong 32-byte token");
                                }
                            }
                            local[1].Close(); Assert(thread.Join(3000), "Relay did not tear down");
                            Closed(local[0]); Closed(local[2]);
                        } finally { foreach (TcpClient c in local) if (c != null) c.Close(); }
                    }
                });
                Test("pin rejection sends zero token or payload bytes", () => {
                    using (SessionIdentity wrong = CertificateFactory.Create())
                    using (FakePhone phone = new FakePhone(wrong.Certificate, 0))
                    using (RelaySession relay = new RelaySession(IPAddress.Loopback, phone.Port, new byte[32], identity.Certificate, s => {})) {
                        Thread thread = Start(relay);
                        using (TcpClient local = Local(relay)) { Closed(local); Assert(thread.Join(4000), "Pin rejection did not stop relay"); }
                        Assert(phone.ApplicationBytes == 0, "Leaked preface before pin validation");
                    }
                });
                Test("role 0 failure is retryable and does not consume role index; two enabled roles", () => {
                    int port = FreePort();
                    using (RelaySession relay = new RelaySession(IPAddress.Loopback, port, new byte[32], identity.Certificate, s => {})) {
                        Start(relay); Stopwatch clock = Stopwatch.StartNew();
                        using (TcpClient first = Local(relay)) Closed(first);
                        Assert(clock.ElapsedMilliseconds >= 2700 && clock.ElapsedMilliseconds < 4500, "Retry budget must be 3s");
                        Assert(!relay.IsStopped, "Initial unavailable server killed relay");
                        using (FakePhone phone = new FakePhone(identity.Certificate, port))
                        using (TcpClient retry = Local(relay)) {
                            Assert(retry.GetStream().ReadByte() == 0, "Retry role is not 0");
                            using (TcpClient second = Local(relay)) {
                                second.GetStream().WriteByte(91); Assert(second.GetStream().ReadByte() == 91, "Second leg echo");
                                lock (phone.Headers) Assert(phone.Headers[1][32] == 1, "Disabled roles must not leave gaps");
                                phone.Dispose(); Wait(() => relay.IsStopped, 3000, "Upstream EOF did not stop all legs"); Closed(retry); Closed(second);
                            }
                        }
                    }
                });
                Test("TLS handshake is bounded by 3s and role 0 can retry", () => {
                    using (FakePhone phone = new FakePhone(identity.Certificate, 0))
                    using (RelaySession relay = new RelaySession(IPAddress.Loopback, phone.Port, new byte[32], identity.Certificate, s => {})) {
                        phone.StallTls = true; Start(relay); Stopwatch clock = Stopwatch.StartNew();
                        using (TcpClient local = Local(relay)) Closed(local);
                        Assert(clock.ElapsedMilliseconds < 4500 && !relay.IsStopped, "TLS timeout/retry failed");
                    }
                });
                Test("later role failure tears down established role 0", () => {
                    using (FakePhone phone = new FakePhone(identity.Certificate, 0))
                    using (RelaySession relay = new RelaySession(IPAddress.Loopback, phone.Port, new byte[32], identity.Certificate, s => {})) {
                        Start(relay);
                        using (TcpClient first = Local(relay)) {
                            Assert(first.GetStream().ReadByte() == 0, "Dummy missing");
                            phone.StallTls = true;
                            using (TcpClient second = Local(relay)) { Closed(second); Wait(() => relay.IsStopped, 1000, "Failed role 1 must end session"); Closed(first); }
                        }
                    }
                });
            }
            Test("executable stdin protocol, session contents/ACL, stdin EOF and session cleanup", () => {
                string path = Path.Combine(args[1], "session-" + Guid.NewGuid().ToString("N"));
                ProcessStartInfo info = new ProcessStartInfo(args[0]); info.UseShellExecute = false; info.CreateNoWindow = true;
                info.RedirectStandardInput = info.RedirectStandardOutput = info.RedirectStandardError = true;
                using (Process process = Process.Start(info)) try {
                    process.StandardInput.WriteLine("127.0.0.1"); process.StandardInput.WriteLine("23456"); process.StandardInput.WriteLine(path); process.StandardInput.Flush();
                    var ready = process.StandardOutput.ReadLineAsync(); Assert(ready.Wait(10000), "READY timeout");
                    Assert(ready.Result != null && ready.Result.StartsWith("READY "), "Missing READY: " + process.StandardError.ReadToEndAsync().Status);
                    Dictionary<string,string> fields = File.ReadAllLines(path).ToDictionary(l => l.Substring(0, l.IndexOf('=')), l => l.Substring(l.IndexOf('=') + 1));
                    Assert(fields["version"] == "1" && fields["peer"] == "127.0.0.1" && fields["port"] == "23456", "Session fields mismatch");
                    Assert(Convert.FromBase64String(fields["token"]).Length == 32, "Token length");
                    using (X509Certificate2 c = new X509Certificate2(Convert.FromBase64String(fields["pfx"]), fields["pfxpass"], X509KeyStorageFlags.EphemeralKeySet)) Assert(c.HasPrivateKey, "Session PFX invalid");
                    Assert(File.GetAccessControl(path).AreAccessRulesProtected, "Session ACL inherited");
                    process.StandardInput.Close(); Assert(process.WaitForExit(4000), "stdin EOF did not exit");
                    Assert(process.ExitCode == 0 && !File.Exists(path), "Session cleanup/exit failed");
                } finally { if (!process.HasExited) { process.Kill(); process.WaitForExit(); } if (File.Exists(path)) File.Delete(path); }
            });
            Console.WriteLine("Tests: " + passed + " passed, " + failed + " failed"); return failed == 0 ? 0 : 1;
        }
    }
}
