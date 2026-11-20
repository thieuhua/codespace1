// Added by phonectl (Apache-2.0).
package com.genymobile.scrcpy.device;

import com.genymobile.scrcpy.util.Ln;
import com.genymobile.scrcpy.video.BacklogProbe;

import java.io.FileDescriptor;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** Reads SIOCOUTQNSD (unsent bytes in the TCP send queue) through the hidden android.system.Os.ioctlInt. */
final class KernelBacklog implements BacklogProbe {
    private static final int SIOCOUTQNSD = 0x894B;

    private final FileDescriptor fd;
    private final Method ioctl2; // int ioctlInt(FileDescriptor, int) on recent Android
    private final Method ioctl3; // int ioctlInt(FileDescriptor, int, Int32Ref) on older Android
    private final Constructor<?> refConstructor;
    private final Field refValue;
    private volatile boolean disabled;

    private KernelBacklog(FileDescriptor fd) throws ReflectiveOperationException {
        this.fd = fd;
        Method two = null;
        Method three = null;
        for (Method method : Class.forName("android.system.Os").getDeclaredMethods()) {
            if (method.getName().equals("ioctlInt")) {
                Class<?>[] types = method.getParameterTypes();
                if (types.length == 2) {
                    two = method;
                } else if (types.length == 3) {
                    three = method;
                }
            }
        }
        if (two == null && three == null) {
            throw new NoSuchMethodException("android.system.Os.ioctlInt");
        }
        ioctl2 = two;
        ioctl3 = two == null ? three : null;
        if (ioctl2 != null) {
            ioctl2.setAccessible(true);
            refConstructor = null;
            refValue = null;
        } else {
            ioctl3.setAccessible(true);
            Class<?> refType = ioctl3.getParameterTypes()[2];
            refConstructor = refType.getConstructor(int.class);
            refValue = refType.getField("value");
        }
    }

    static BacklogProbe create(StreamSocket socket) {
        if (socket == null || !socket.isTcp()) {
            return BacklogProbe.NONE;
        }
        try {
            KernelBacklog probe = new KernelBacklog(socket.descriptor());
            int unsent = probe.unsentBytes();
            if (unsent >= 0) {
                Ln.i("Video kernel backlog probe: SIOCOUTQNSD available");
                return probe;
            }
        } catch (ReflectiveOperationException | RuntimeException e) {
            // fall through
        }
        Ln.w("Video kernel backlog probe unavailable; relying on the bounded send buffer");
        return BacklogProbe.NONE;
    }

    @Override
    public int unsentBytes() {
        if (disabled) {
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
            disabled = true;
            return -1;
        }
    }
}
