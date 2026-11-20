package com.genymobile.scrcpy.device;

import com.genymobile.scrcpy.util.Ln;

import android.util.Base64;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

final class LanSession {
    static final String PATH = "/data/local/tmp/phonectl-session";
    final int port;
    final InetAddress peer;
    final byte[] token;
    final SSLContext context;
    final int latencyMs;
    final int minBitrate;

    private LanSession(Map<String, String> values) throws IOException, GeneralSecurityException {
        port = positive(values, "port", 0);
        if (port < 20000 || port > 60999) {
            throw new IOException("Session port outside 20000..60999");
        }
        String address = required(values, "peer");
        if (!address.matches("[0-9a-fA-F:.]+")) {
            throw new IOException("Session peer must be a numeric IP address");
        }
        peer = InetAddress.getByName(address);
        token = decode(required(values, "token"));
        if (token.length != 32) {
            throw new IOException("Session token must contain 32 bytes");
        }
        latencyMs = positive(values, "vlat", 100);
        minBitrate = positive(values, "vminbr", 1_000_000);

        byte[] pfx = decode(required(values, "pfx"));
        char[] password = required(values, "pfxpass").toCharArray();
        try {
            KeyStore store = KeyStore.getInstance("PKCS12");
            store.load(new ByteArrayInputStream(pfx), password);
            KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            managers.init(store, password);
            context = SSLContext.getInstance("TLSv1.2");
            context.init(managers.getKeyManagers(), null, null);
        } finally {
            Arrays.fill(password, '\0');
            Arrays.fill(pfx, (byte) 0);
        }
    }

    static LanSession consume(File file, long nowMs) throws IOException {
        if (!file.exists()) {
            Ln.i("No LAN session; using stock adb tunnel");
            return null;
        }
        byte[] bytes;
        try {
            try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 131072) {
                        throw new IOException("Session file too large");
                    }
                    output.write(buffer, 0, count);
                }
                bytes = output.toByteArray();
            }
        } finally {
            if (!file.delete()) {
                throw new IOException("Cannot delete consumed LAN session");
            }
            Ln.i("Consumed and deleted LAN session file");
        }
        try {
            Map<String, String> values = new HashMap<>();
            for (byte value : bytes) {
                if (value < 0 || value == 0) {
                    throw new IOException("Session file must be ASCII text");
                }
            }
            for (String line : new String(bytes, StandardCharsets.US_ASCII).split("\n")) {
                if (line.endsWith("\r")) {
                    line = line.substring(0, line.length() - 1);
                }
                if (line.isEmpty()) {
                    continue;
                }
                int equals = line.indexOf('=');
                if (equals <= 0 || values.put(line.substring(0, equals), line.substring(equals + 1)) != null) {
                    throw new IOException("Malformed or duplicate session key");
                }
            }
            long created = Long.parseLong(required(values, "created"));
            if (created < 0 || created > nowMs + 120_000) {
                throw new IOException("Invalid session creation time");
            }
            if (nowMs - created > 120_000) {
                Ln.w("Ignoring expired LAN session (TTL 120s); using adb tunnel");
                return null;
            }
            if (!"1".equals(required(values, "version"))) {
                throw new IOException("Unsupported LAN session version");
            }
            LanSession session = new LanSession(values);
            Ln.i("Loaded LAN session: port=" + session.port + ", vlat=" + session.latencyMs + ", vminbr=" + session.minBitrate);
            return session;
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            // Never include parser/provider messages: they could contain session secrets.
            throw new IOException("Invalid LAN session or PKCS#12 material");
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private static String required(Map<String, String> values, String key) throws IOException {
        String value = values.get(key);
        if (value == null) {
            throw new IOException("Missing session key: " + key);
        }
        return value;
    }

    private static int positive(Map<String, String> values, String key, int fallback) throws IOException {
        String text = values.get(key);
        int value = text == null ? fallback : Integer.parseInt(text);
        if (value <= 0) {
            throw new IOException("Invalid positive session field: " + key);
        }
        return value;
    }

    private static byte[] decode(String text) {
        return Base64.decode(text, Base64.DEFAULT);
    }
}
