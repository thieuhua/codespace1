using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace PhoneCtl {
    // Minimal DER/PKCS#12 writer: no certificate store, persisted keys or NuGet.
    // Both encrypted safe contents use pbeWithSHAAnd3-KeyTripleDES-CBC; MAC is SHA1.
    public sealed class SessionIdentity : IDisposable {
        public readonly byte[] Pfx;
        public readonly string Password;
        public readonly X509Certificate2 Certificate;
        public SessionIdentity(byte[] pfx, string password) {
            Pfx = pfx; Password = password;
            Certificate = new X509Certificate2(pfx, password,
                X509KeyStorageFlags.Exportable | X509KeyStorageFlags.UserKeySet);
        }
        public void Dispose() { Certificate.Dispose(); Array.Clear(Pfx, 0, Pfx.Length); }
    }

    public static class CertificateFactory {
        static byte[] Join(params byte[][] parts) { return parts.SelectMany(p => p).ToArray(); }
        static byte[] Der(byte tag, params byte[][] parts) {
            byte[] body = Join(parts);
            List<byte> length = new List<byte>(); int n = body.Length;
            do { length.Insert(0, (byte)n); n >>= 8; } while (n != 0);
            if (body.Length < 128) length = new List<byte> { (byte)body.Length };
            else length.Insert(0, (byte)(128 | length.Count));
            return Join(new byte[] { tag }, length.ToArray(), body);
        }
        static byte[] Seq(params byte[][] parts) { return Der(0x30, parts); }
        static byte[] Oct(byte[] b) { return Der(4, b); }
        static byte[] Int(byte[] b) {
            int i = 0; while (i < b.Length - 1 && b[i] == 0) i++;
            b = b.Skip(i).ToArray();
            return Der(2, b[0] >= 128 ? Join(new byte[] { 0 }, b) : b);
        }
        static byte[] Number(int n) { return Int(new byte[] { (byte)(n >> 24), (byte)(n >> 16), (byte)(n >> 8), (byte)n }); }
        static byte[] Oid(string value) {
            long[] arcs = value.Split('.').Select(Int64.Parse).ToArray();
            List<byte> b = new List<byte> { (byte)(40 * arcs[0] + arcs[1]) };
            foreach (long arc in arcs.Skip(2)) {
                long n = arc; List<byte> piece = new List<byte> { (byte)(n & 127) };
                while ((n >>= 7) != 0) piece.Insert(0, (byte)(128 | (n & 127)));
                b.AddRange(piece);
            }
            return Der(6, b.ToArray());
        }
        public static byte[] RandomBytes(int length) {
            byte[] b = new byte[length]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(b); return b;
        }
        static byte[] Time(DateTime time) { return Der(0x17, Encoding.ASCII.GetBytes(time.ToString("yyMMddHHmmss'Z'", System.Globalization.CultureInfo.InvariantCulture))); }
        static byte[] MakeCertificate(byte[] publicKey, byte[] signatureAlgorithm, Func<byte[], byte[]> sign) {
            byte[] name = Seq(Der(0x31, Seq(Oid("2.5.4.3"), Der(12, Encoding.UTF8.GetBytes("phonectl session")))));
            byte[] tbs = Seq(Der(0xa0, Number(2)), Int(RandomBytes(16)), signatureAlgorithm, name,
                Seq(Time(DateTime.UtcNow.AddMinutes(-5)), Time(DateTime.UtcNow.AddDays(1))), name, publicKey);
            return Seq(tbs, signatureAlgorithm, Der(3, Join(new byte[] { 0 }, sign(tbs))));
        }
        public static SessionIdentity Create() {
            string password = Convert.ToBase64String(RandomBytes(24));
            try {
                using (CngKey key = CngKey.Create(CngAlgorithm.ECDsaP256, null, new CngKeyCreationParameters {
                    ExportPolicy = CngExportPolicies.AllowPlaintextExport }))
                using (ECDsaCng ec = new ECDsaCng(key)) {
                    ec.HashAlgorithm = CngAlgorithm.Sha256;
                    byte[] blob = key.Export(CngKeyBlobFormat.EccPublicBlob);
                    byte[] spki = Seq(Seq(Oid("1.2.840.10045.2.1"), Oid("1.2.840.10045.3.1.7")),
                        Der(3, Join(new byte[] { 0, 4 }, blob.Skip(8).ToArray())));
                    byte[] cert = MakeCertificate(spki, Seq(Oid("1.2.840.10045.4.3.2")), delegate(byte[] data) {
                        byte[] sig = ec.SignData(data); return Seq(Int(sig.Take(32).ToArray()), Int(sig.Skip(32).ToArray()));
                    });
                    return new SessionIdentity(MakePfx(cert, key.Export(CngKeyBlobFormat.Pkcs8PrivateBlob), password), password);
                }
            } catch (CryptographicException) {
                // Older CNG/Schannel installations may not export/import an EC PFX.
            } catch (NotSupportedException) { }
            using (RSACryptoServiceProvider rsa = new RSACryptoServiceProvider(2048)) {
                rsa.PersistKeyInCsp = false;
                RSAParameters p = rsa.ExportParameters(true);
                byte[] alg = Seq(Oid("1.2.840.113549.1.1.1"), Der(5));
                byte[] spki = Seq(alg, Der(3, Join(new byte[] { 0 }, Seq(Int(p.Modulus), Int(p.Exponent)))));
                byte[] cert = MakeCertificate(spki, Seq(Oid("1.2.840.113549.1.1.11"), Der(5)),
                    data => rsa.SignData(data, CryptoConfig.MapNameToOID("SHA256")));
                byte[] pkcs1 = Seq(Number(0), Int(p.Modulus), Int(p.Exponent), Int(p.D), Int(p.P), Int(p.Q), Int(p.DP), Int(p.DQ), Int(p.InverseQ));
                return new SessionIdentity(MakePfx(cert, Seq(Number(0), alg, Oct(pkcs1)), password), password);
            }
        }
        // RFC 7292 appendix B derivation (SHA1, u=20, v=64).
        static byte[] Kdf(string password, byte[] salt, byte id, int size) {
            byte[] pass = Encoding.BigEndianUnicode.GetBytes(password + "\0");
            byte[] d = Enumerable.Repeat(id, 64).ToArray();
            byte[] input = new byte[64 * ((salt.Length + 63) / 64 + (pass.Length + 63) / 64)];
            int saltSize = 64 * ((salt.Length + 63) / 64);
            for (int i = 0; i < input.Length; i++) input[i] = i < saltSize ? salt[i % salt.Length] : pass[(i - saltSize) % pass.Length];
            List<byte> result = new List<byte>();
            using (SHA1 sha = SHA1.Create()) while (result.Count < size) {
                byte[] a = sha.ComputeHash(Join(d, input));
                for (int j = 1; j < 2048; j++) a = sha.ComputeHash(a);
                result.AddRange(a);
                for (int offset = 0; offset < input.Length; offset += 64) {
                    int carry = 1;
                    for (int j = 63; j >= 0; j--) { carry += input[offset + j] + a[j % 20]; input[offset + j] = (byte)carry; carry >>= 8; }
                }
            }
            return result.Take(size).ToArray();
        }
        static byte[] Encrypt(byte[] data, string password, byte[] salt) {
            using (TripleDES des = TripleDES.Create()) {
                des.Key = Kdf(password, salt, 1, 24); des.IV = Kdf(password, salt, 2, 8);
                using (ICryptoTransform transform = des.CreateEncryptor()) return transform.TransformFinalBlock(data, 0, data.Length);
            }
        }
        static byte[] Pbe(byte[] salt) { return Seq(Oid("1.2.840.113549.1.12.1.3"), Seq(Oct(salt), Number(2048))); }
        static byte[] Content(byte[] data) { return Seq(Oid("1.2.840.113549.1.7.1"), Der(0xa0, Oct(data))); }
        static byte[] MakePfx(byte[] cert, byte[] privateKey, string password) {
            byte[] salt = RandomBytes(20), certSalt = RandomBytes(20), macSalt = RandomBytes(20);
            byte[] attributes = Der(0x31, Seq(Oid("1.2.840.113549.1.9.21"), Der(0x31, Oct(new byte[] { 1 }))));
            byte[] keyBag = Seq(Oid("1.2.840.113549.1.12.10.1.2"), Der(0xa0,
                Seq(Pbe(salt), Oct(Encrypt(privateKey, password, salt)))), attributes);
            byte[] certBag = Seq(Oid("1.2.840.113549.1.12.10.1.3"), Der(0xa0,
                Seq(Oid("1.2.840.113549.1.9.22.1"), Der(0xa0, Oct(cert)))), attributes);
            byte[] encrypted = Seq(Oid("1.2.840.113549.1.7.6"), Der(0xa0, Seq(Number(0),
                Seq(Oid("1.2.840.113549.1.7.1"), Pbe(certSalt), Der(0x80, Encrypt(Seq(certBag), password, certSalt))))));
            byte[] safe = Seq(Content(Seq(keyBag)), encrypted);
            byte[] mac; using (HMACSHA1 h = new HMACSHA1(Kdf(password, macSalt, 3, 20))) mac = h.ComputeHash(safe);
            Array.Clear(privateKey, 0, privateKey.Length);
            return Seq(Number(3), Content(safe), Seq(Seq(Seq(Oid("1.3.14.3.2.26"), Der(5)), Oct(mac)), Oct(macSalt), Number(2048)));
        }
    }
}
