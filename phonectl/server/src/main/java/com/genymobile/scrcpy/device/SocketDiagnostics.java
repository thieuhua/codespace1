package com.genymobile.scrcpy.device;

import com.genymobile.scrcpy.util.Ln;

import java.io.FileDescriptor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** Optional kernel telemetry only; never participates in correctness or the congestion policy. */
final class SocketDiagnostics {
    private final StreamSocket socket;
    private boolean outqUnavailable;
    private boolean tcpInfoUnavailable;
    private long nextSample;

    SocketDiagnostics(StreamSocket socket) {
        this.socket = socket;
    }

    void sample(long now) {
        if (now < nextSample || outqUnavailable && tcpInfoUnavailable) {
            return;
        }
        nextSample = now + 2000;
        FileDescriptor descriptor;
        try {
            descriptor = socket.descriptor();
        } catch (ReflectiveOperationException | RuntimeException e) {
            Ln.d("Video socket fd reflection unavailable; kernel diagnostics disabled");
            outqUnavailable = true;
            tcpInfoUnavailable = true;
            return;
        }
        if (!outqUnavailable) {
            try {
                Class<?> os = Class.forName("android.system.Os");
                Method ioctl = null;
                for (Method method : os.getDeclaredMethods()) {
                    if (method.getName().equals("ioctlInt") && method.getParameterTypes().length == 3) {
                        ioctl = method;
                        break;
                    }
                }
                if (ioctl == null) {
                    throw new NoSuchMethodException();
                }
                ioctl.setAccessible(true);
                Object result = ioctl.getParameterTypes()[2].getConstructor(int.class).newInstance(0);
                ioctl.invoke(null, descriptor, 0x894B, result); // Linux SIOCOUTQNSD
                Field value = result.getClass().getField("value");
                Ln.d("Video SIOCOUTQNSD=" + value.getInt(result));
            } catch (ReflectiveOperationException | RuntimeException e) {
                outqUnavailable = true;
                Ln.d("SIOCOUTQNSD unavailable; ignoring optional telemetry");
            }
        }
        if (!tcpInfoUnavailable) {
            try {
                Method method = Class.forName("android.system.Os").getDeclaredMethod("getsockoptTcpInfo", FileDescriptor.class,
                        int.class, int.class);
                method.setAccessible(true);
                Object info = method.invoke(null, descriptor, 6, 11); // IPPROTO_TCP, TCP_INFO
                Ln.d("Video TCP_INFO=" + info);
            } catch (ReflectiveOperationException | RuntimeException e) {
                tcpInfoUnavailable = true;
                Ln.d("TCP_INFO unavailable; ignoring optional telemetry");
            }
        }
    }
}
