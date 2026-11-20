package com.genymobile.scrcpy.video;

import com.genymobile.scrcpy.util.Ln;

import java.io.IOException;
import java.io.OutputStream;

/** One writer owns complete wire packets. The encoder never waits for socket I/O. */
public final class VideoSender {
    private final OutputStream output;
    private final CongestionPolicy policy;
    private final Runnable diagnostics;
    private final BacklogProbe backlog;
    private final Runnable onFailure;
    private final Thread thread;
    private volatile IOException failure;
    private volatile boolean closed;
    private boolean finishing;

    public VideoSender(OutputStream output, CongestionPolicy policy, Runnable diagnostics, Runnable onFailure) {
        this(output, policy, diagnostics, BacklogProbe.NONE, onFailure);
    }

    public VideoSender(OutputStream output, CongestionPolicy policy, Runnable diagnostics, BacklogProbe backlog, Runnable onFailure) {
        this.output = output;
        this.policy = policy;
        this.diagnostics = diagnostics;
        this.backlog = backlog;
        this.onFailure = onFailure;
        thread = new Thread(this::send, "video-sender");
    }

    public void start() {
        thread.start();
    }

    public synchronized void offer(byte[] data, boolean protectedPacket, boolean keyFrame) throws IOException {
        checkFailure();
        if (closed || finishing) {
            throw new IOException("Video sender closed");
        }
        try {
            policy.offer(data, protectedPacket, keyFrame, now());
        } catch (IllegalStateException e) {
            throw new IOException(e);
        }
        notifyAll();
    }

    private void send() {
        try {
            while (!closed) {
                // Do not hand more data to the kernel while it still holds old video: packets then age in the policy queue,
                // where stale frames can still be dropped, instead of in the TCP send buffer, where they cannot.
                waitForKernel();
                CongestionPolicy.Packet packet;
                synchronized (this) {
                    packet = policy.poll(now());
                    if (packet == null) {
                        if (finishing) {
                            return;
                        }
                        wait(20);
                        continue;
                    }
                }
                long started = now();
                output.write(packet.data); // Never interrupt/drop part of an in-flight packet.
                long completed = now();
                policy.onWriteCompleted(completed - started, completed);
                diagnostics.run();
            }
        } catch (IOException e) {
            failure = e;
            Ln.w("Video sender I/O failed (" + e.getClass().getSimpleName() + ")");
            onFailure.run();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            Ln.d("Video sender stopped");
        }
    }

    private void waitForKernel() throws InterruptedException {
        while (!closed) {
            int unsent = backlog.unsentBytes();
            if (unsent < 0 || unsent <= policy.kernelBudgetBytes()) {
                return;
            }
            Thread.sleep(4);
        }
    }

    public void checkFailure() throws IOException {
        if (failure != null) {
            throw failure;
        }
    }

    public boolean hasFailed() {
        return failure != null;
    }

    /** Normal EOS drains protected records; shutdown closes the transport before joining this thread. */
    public synchronized void finish() {
        finishing = true;
        notifyAll();
    }

    public synchronized void stop() {
        closed = true;
        notifyAll();
    }

    public void join() throws InterruptedException {
        thread.join();
    }

    /** Returns true if the sender thread has terminated within the timeout. */
    public boolean join(long timeoutMs) throws InterruptedException {
        thread.join(timeoutMs);
        return !thread.isAlive();
    }

    public static long now() {
        return System.nanoTime() / 1_000_000;
    }
}
