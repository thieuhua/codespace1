package com.genymobile.scrcpy.device;

import android.net.LocalSocket;

import java.io.Closeable;
import java.io.FileDescriptor;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;

/** Socket streams are the only transport I/O entry point, including for TLS. */
final class StreamSocket implements Closeable {
    private final LocalSocket local;
    private final Socket tls;
    private final Socket raw;

    StreamSocket(LocalSocket local) {
        this.local = local;
        tls = null;
        raw = null;
    }

    StreamSocket(Socket tls, Socket raw) {
        this.tls = tls;
        this.raw = raw;
        local = null;
    }

    InputStream input() throws IOException {
        return local != null ? local.getInputStream() : tls.getInputStream();
    }

    OutputStream output() throws IOException {
        return local != null ? local.getOutputStream() : tls.getOutputStream();
    }

    FileDescriptor descriptor() throws ReflectiveOperationException {
        if (local != null) {
            return local.getFileDescriptor();
        }
        // Android exposes this hidden accessor on the underlying plain Socket.
        java.lang.reflect.Method method = Socket.class.getDeclaredMethod("getFileDescriptor$");
        method.setAccessible(true);
        return (FileDescriptor) method.invoke(raw);
    }

    void shutdown() throws IOException {
        if (local != null) {
            try {
                local.shutdownInput();
            } finally {
                local.shutdownOutput();
            }
        } else {
            // Closing the plain transport first interrupts a blocked TLS write, without
            // waiting for SSLSocket's write lock or an unsupported TLS half-close.
            close();
        }
    }

    @Override
    public void close() throws IOException {
        if (local != null) {
            local.close();
        } else {
            try {
                raw.close();
            } finally {
                tls.close();
            }
        }
    }
}
