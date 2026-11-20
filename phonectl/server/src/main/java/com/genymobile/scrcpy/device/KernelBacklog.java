// Added by phonectl (Apache-2.0).
package com.genymobile.scrcpy.device;

import com.genymobile.scrcpy.util.Ln;
import com.genymobile.scrcpy.video.BacklogProbe;

import android.system.Os;

import java.io.FileDescriptor;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Bounds and observes the unsent data of the video TCP socket.
 *
 * <p>Control: TCP_NOTSENT_LOWAT makes a blocking write() wait while the kernel holds more unsent bytes than the limit, so the
 * write duration becomes the congestion signal and stale frames age (and get dropped) in the policy queue instead of in the
 * kernel. Measured on Android 15: without it the kernel accepted 12 MB before blocking (tens of seconds at 3 Mbps).
 *
 * <p>Observation: SIOCOUTQNSD through the hidden Os.ioctlInt, when SELinux allows socket ioctls (the shell domain on Android 15
 * gets EACCES). Optional only.
 */
final class KernelBacklog implements BacklogProbe {
    private static final int IPPROTO_TCP = 6;
    private static final int TCP_NOTSENT_LOWAT = 25;
    private static final int SIOCOUTQNSD = 0x894B;
    private static final int FALLBACK_SEND_BUFFER = 64 * 1024;

    private final StreamSocket socket;
    private final FileDescriptor fd;
    private Method ioctl2; // int ioctlInt(FileDescriptor, int) on recent Android
    private Method ioctl3; // int ioctlInt(FileDescriptor, int, Int32Ref) on older Android
    private Constructor<?> refConstructor;
    private Field refValue;
    private volatile boolean ioctlDisabled;
    private boolean lowatFailed;
    private boolean lowatLogged;

    private KernelBacklog(StreamSocket socket, FileDescriptor fd) {
        this.socket = socket;
        this.fd = fd;
        try {
            for (Method method : Class.forName("android.system.Os").getDeclaredMethods()) {
                if (method.getName().equals("ioctlInt")) {
                    Class<?>[] types = method.getParameterTypes();
                    if (types.length == 2) {
                        ioctl2 = method;
                    } else if (types.length == 3) {
                        ioctl3 = method;
                    }
                }
            }
            if (ioctl2 != null) {
                ioctl2.setAccessible(true);
                ioctl3 = null;
            } else if (ioctl3 != null) {
                ioctl3.setAccessible(true);
                Class<?> refType = ioctl3.getParameterTypes()[2];
                refConstructor = refType.getConstructor(int.class);
                refValue = refType.getField("value");
            } else {
                ioctlDisabled = true;
            }
        } catch (ReflectiveOperationException | RuntimeException e) {
            ioctlDisabled = true;
        }
    }

    static BacklogProbe create(StreamSocket socket) {
        if (socket == null || !socket.isTcp()) {
            return BacklogProbe.NONE;
        }
        try {
            KernelBacklog probe = new KernelBacklog(socket, socket.descriptor());
            if (probe.unsentBytes() < 0) {
                Ln.i("Video SIOCOUTQNSD unreadable (SELinux); congestion is detected from blocking writes");
            }
            return probe;
        } catch (ReflectiveOperationException | RuntimeException e) {
            Ln.w("Video socket descriptor unavailable; using a small fixed send buffer");
            socket.setSendBufferSize(FALLBACK_SEND_BUFFER);
            return BacklogProbe.NONE;
        }
    }

    @Override
    public int unsentBytes() {
        if (ioctlDisabled) {
            return -1;
        }
        try {
            if (ioctl2 != null) {
                return (Integer) ioctl2.invoke(null, fd, SIOCOUTQNSD);
            }
            Object ref = refConstructor.newInstance(0);
            ioctl3.invoke(null, fd, SIOCOUTQNSD, ref);
            return refValue.getInt(ref);
        } catch (ReflectiveOperationException | RuntimeException e) {
            ioctlDisabled = true;
            return -1;
        }
    }

    @Override
    public void setUnsentLimit(int bytes) {
        if (lowatFailed) {
            return;
        }
        try {
            Os.setsockoptInt(fd, IPPROTO_TCP, TCP_NOTSENT_LOWAT, bytes);
            if (!lowatLogged) {
                lowatLogged = true;
                Ln.i("Video TCP_NOTSENT_LOWAT active (" + bytes + " bytes, follows bitrate)");
            }
        } catch (Exception e) {
            lowatFailed = true;
            Ln.w("TCP_NOTSENT_LOWAT unavailable (" + e.getClass().getSimpleName() + "); using a small fixed send buffer");
            socket.setSendBufferSize(FALLBACK_SEND_BUFFER);
        }
    }
}
