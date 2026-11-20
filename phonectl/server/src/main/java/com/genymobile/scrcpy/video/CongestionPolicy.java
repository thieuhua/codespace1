package com.genymobile.scrcpy.video;

import java.util.ArrayDeque;
import java.util.Iterator;

/** Pure Java policy. Times are monotonic milliseconds supplied by the caller. No socket/codec I/O under its lock. */
public final class CongestionPolicy {
    public interface Logger {
        void log(String message);
    }

    public static final class Packet {
        public final byte[] data;
        public final boolean protectedPacket;
        public final boolean keyFrame;
        final long queuedAt;

        private Packet(byte[] data, boolean protectedPacket, boolean keyFrame, long queuedAt) {
            this.data = data;
            this.protectedPacket = protectedPacket;
            this.keyFrame = keyFrame;
            this.queuedAt = queuedAt;
        }
    }

    public static final class Actions {
        public final int bitrate;
        public final boolean requestSync;

        private Actions(int bitrate, boolean requestSync) {
            this.bitrate = bitrate;
            this.requestSync = requestSync;
        }
    }

    private final ArrayDeque<Packet> queue = new ArrayDeque<>();
    private final int maxPackets;
    private final int maxBytes;
    private final long budgetMs;
    private final int maximumBitrate;
    private final int minimumBitrate;
    private final Logger logger;
    private int queuedBytes;
    private int bitrate;
    private int reportedBitrate;
    private boolean waitingForKeyFrame;
    private boolean syncPending;
    private boolean syncEverRequested;
    private long lastSync;
    private long lastAdjustment;

    public CongestionPolicy(int maxPackets, int maxBytes, long budgetMs, int requestedBitrate, int minimumBitrate, long now, Logger logger) {
        if (maxPackets <= 0 || maxBytes <= 0 || budgetMs <= 0 || requestedBitrate <= 0 || minimumBitrate <= 0) {
            throw new IllegalArgumentException("Congestion policy limits must be positive");
        }
        this.maxPackets = maxPackets;
        this.maxBytes = maxBytes;
        this.budgetMs = budgetMs;
        maximumBitrate = requestedBitrate;
        this.minimumBitrate = Math.min(minimumBitrate, requestedBitrate);
        bitrate = requestedBitrate;
        reportedBitrate = bitrate;
        lastAdjustment = now;
        this.logger = logger;
    }

    /** False means a whole media packet was discarded. Protected overflow fails instead of dropping configuration. */
    public synchronized boolean offer(byte[] data, boolean protectedPacket, boolean keyFrame, long now) {
        checkAge(now);
        if (queue.size() >= maxPackets || data.length > maxBytes - queuedBytes) {
            congested(now, "queue capacity");
        }
        if (!protectedPacket && waitingForKeyFrame && !keyFrame) {
            logger.log("video drop incoming frame: waiting for IDR");
            return false;
        }
        if (queue.size() >= maxPackets || data.length > maxBytes - queuedBytes) {
            if (protectedPacket) {
                logger.log("video protected queue exhausted: fail session rather than drop config/metadata");
                throw new IllegalStateException("Protected video packets exceed bounded queue");
            }
            logger.log("video drop oversized/capacity frame");
            return false;
        }
        if (!protectedPacket && waitingForKeyFrame) {
            waitingForKeyFrame = false;
            syncPending = false;
            logger.log("video IDR accepted: resume frames");
        }
        queue.addLast(new Packet(data, protectedPacket, keyFrame, now));
        queuedBytes += data.length;
        return true;
    }

    public synchronized Packet poll(long now) {
        checkAge(now);
        Packet packet = queue.pollFirst();
        if (packet != null) {
            queuedBytes -= packet.data.length;
        }
        return packet;
    }

    private void checkAge(long now) {
        // Config/session records cannot expire, and must not repeatedly retrigger congestion by themselves.
        for (Packet packet : queue) {
            if (!packet.protectedPacket) {
                if (now - packet.queuedAt > budgetMs) {
                    congested(now, "oldest queue age=" + (now - packet.queuedAt) + "ms");
                }
                break;
            }
        }
    }

    public synchronized void onWriteCompleted(long durationMs, long now) {
        if (durationMs > budgetMs) {
            congested(now, "write duration=" + durationMs + "ms");
        }
    }

    private void congested(long now, String reason) {
        int dropped = 0;
        for (Iterator<Packet> iterator = queue.iterator(); iterator.hasNext();) {
            Packet packet = iterator.next();
            if (!packet.protectedPacket) {
                queuedBytes -= packet.data.length;
                iterator.remove();
                ++dropped;
            }
        }
        waitingForKeyFrame = true;
        syncPending = true;
        logger.log("video congestion: " + reason + "; dropped=" + dropped + "; wait for IDR");
        int next = Math.max(minimumBitrate, (int) (bitrate * 0.7));
        setBitrate(next, "decrease");
        lastAdjustment = now;
    }

    public synchronized Actions actions(long now) {
        checkAge(now);
        if (!waitingForKeyFrame && now - lastAdjustment >= 2000) {
            int next = (int) Math.min(maximumBitrate, (long) bitrate + Math.max(1, maximumBitrate / 10));
            setBitrate(next, "increase after 2s uncongested");
            lastAdjustment = now;
        }
        // Retry while waiting: the codec may ignore a sync request during a reset.
        boolean sync = waitingForKeyFrame && syncPending && (!syncEverRequested || now - lastSync >= 1000);
        if (sync) {
            syncEverRequested = true;
            lastSync = now;
            logger.log("video request sync frame");
        }
        int changed = bitrate != reportedBitrate ? bitrate : 0;
        reportedBitrate = bitrate;
        return new Actions(changed, sync);
    }

    private void setBitrate(int next, String reason) {
        if (next != bitrate) {
            logger.log("video bitrate " + bitrate + " -> " + next + " (" + reason + ")");
            bitrate = next;
        }
    }

    public synchronized int getBitrate() {
        return bitrate;
    }

    public synchronized int size() {
        return queue.size();
    }

    public synchronized int bytes() {
        return queuedBytes;
    }
}
