package com.genymobile.scrcpy.device;

import com.genymobile.scrcpy.util.Ln;

import java.io.DataInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLSocket;

/** Accept keeps running while each peer performs TLS and authentication independently. */
final class LanListener {
    private final LanSession session;
    private final String[] roles;
    private final StreamSocket[] sockets;
    private final boolean[] reserved;
    private final Set<Socket> pending = new HashSet<>();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "lan-timeouts");
        thread.setDaemon(true);
        return thread;
    });
    private boolean accepting = true;
    private int completed;

    LanListener(LanSession session, boolean video, boolean audio, boolean control) {
        this.session = session;
        roles = enabledRoles(video, audio, control);
        sockets = new StreamSocket[roles.length];
        reserved = new boolean[roles.length];
    }

    static String[] enabledRoles(boolean video, boolean audio, boolean control) {
        java.util.List<String> list = new java.util.ArrayList<>();
        if (video) {
            list.add("video");
        }
        if (audio) {
            list.add("audio");
        }
        if (control) {
            list.add("control");
        }
        return list.toArray(new String[0]);
    }

    StreamSocket[] accept() throws IOException {
        boolean success = false;
        try (ServerSocket listener = new ServerSocket()) {
            listener.bind(new InetSocketAddress(session.port));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            Ln.i("TLS 1.2 listener on port " + session.port + ", roles=" + Arrays.toString(roles) + ", deadline=20s");
            while (true) {
                synchronized (this) {
                    if (completed == roles.length) {
                        success = true;
                        Ln.i("All LAN roles authenticated; closing listener");
                        return sockets;
                    }
                }
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) {
                    Ln.e("LAN role deadline exceeded (20s)");
                    throw new SocketTimeoutException("LAN roles incomplete after 20s");
                }
                listener.setSoTimeout((int) Math.max(1, Math.min(200, TimeUnit.NANOSECONDS.toMillis(remaining))));
                Socket raw;
                try {
                    raw = listener.accept();
                } catch (SocketTimeoutException e) {
                    continue;
                } catch (SocketException e) {
                    synchronized (this) {
                        if (completed == roles.length) {
                            continue; // Last worker closed the listener as soon as all roles arrived.
                        }
                    }
                    throw e;
                }
                if (!session.peer.equals(raw.getInetAddress())) {
                    Ln.w("LAN peer rejected by IP filter");
                    close(raw);
                    continue;
                }
                synchronized (this) {
                    if (pending.size() >= 16 || completed == roles.length) {
                        Ln.w("LAN connection rejected: pending limit or roles already complete");
                        close(raw);
                        continue;
                    }
                    pending.add(raw);
                }
                Thread worker = new Thread(() -> authenticate(raw, listener, deadline), "lan-handshake");
                worker.setDaemon(true);
                worker.start();
            }
        } finally {
            synchronized (this) {
                accepting = false;
                for (Socket socket : pending) {
                    close(socket);
                }
                pending.clear();
                if (!success) {
                    for (StreamSocket socket : sockets) {
                        close(socket);
                    }
                }
            }
            Arrays.fill(session.token, (byte) 0);
            timer.shutdownNow();
        }
    }

    private void authenticate(Socket raw, ServerSocket listener, long deadline) {
        StreamSocket transport = null;
        int index = -1;
        boolean transferred = false;
        byte[] token = new byte[32];
        // SO_TIMEOUT bounds each read; the watchdog also bounds slow trickles across multiple reads.
        long allowance = Math.max(1, Math.min(TimeUnit.SECONDS.toNanos(3), deadline - System.nanoTime()));
        ScheduledFuture<?> timeout = timer.schedule(() -> {
            Ln.w("LAN handshake/authentication timed out");
            close(raw);
        }, allowance, TimeUnit.NANOSECONDS);
        try {
            raw.setSoTimeout(3000);
            SSLSocket tls = (SSLSocket) session.context.getSocketFactory().createSocket(raw, raw.getInetAddress().getHostAddress(),
                    raw.getPort(), true);
            transport = new StreamSocket(tls, raw);
            tls.setUseClientMode(false);
            tls.setEnabledProtocols(new String[] {"TLSv1.2"});
            tls.setSoTimeout(3000);
            tls.startHandshake();
            DataInputStream input = new DataInputStream(tls.getInputStream());
            input.readFully(token);
            int requested = input.readUnsignedByte();
            if (!MessageDigest.isEqual(session.token, token)) {
                Ln.w("LAN token rejected");
                return;
            }
            synchronized (this) {
                if (!accepting || requested >= roles.length || reserved[requested]) {
                    Ln.w("LAN role rejected: invalid, duplicate or session closed (index=" + requested + ")");
                    return;
                }
                reserved[requested] = true;
                index = requested;
            }
            if (!"video".equals(roles[index])) {
                raw.setTcpNoDelay(true);
                tls.setTcpNoDelay(true);
                try {
                    raw.setTrafficClass(0xB8);
                    Ln.i("LAN " + roles[index] + ": NODELAY, traffic class 0xB8");
                } catch (SocketException e) {
                    Ln.w("LAN " + roles[index] + ": traffic class unavailable; NODELAY enabled");
                }
            }
            if (index == 0) {
                tls.getOutputStream().write(0);
                tls.getOutputStream().flush();
                Ln.i("LAN role 0: dummy byte sent");
            }
            tls.setSoTimeout(0);
            synchronized (this) {
                if (!accepting || raw.isClosed() || System.nanoTime() >= deadline || timeout.isDone()) {
                    Ln.w("LAN role discarded after deadline/timeout");
                    return;
                }
                timeout.cancel(false);
                sockets[index] = transport;
                pending.remove(raw);
                transferred = true;
                ++completed;
                Ln.i("LAN role_index=" + index + " mapped to " + roles[index]);
                if (completed == roles.length) {
                    close(listener);
                }
            }
        } catch (IOException | RuntimeException e) {
            Ln.w("LAN TLS/authentication failed (" + e.getClass().getSimpleName() + ")");
        } finally {
            timeout.cancel(false);
            Arrays.fill(token, (byte) 0);
            synchronized (this) {
                pending.remove(raw);
                if (!transferred && index >= 0) {
                    reserved[index] = false;
                }
            }
            if (!transferred) {
                close(transport != null ? transport : raw);
            }
        }
    }

    private static void close(java.io.Closeable socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException e) {
                Ln.d("LAN socket close: " + e.getClass().getSimpleName());
            }
        }
    }
}
