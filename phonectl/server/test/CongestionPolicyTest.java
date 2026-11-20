package com.genymobile.scrcpy.video;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class CongestionPolicyTest {
    private static int passed;
    private static int failed;

    private CongestionPolicyTest() {
    }

    private static void check(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    private static void run(String name, Runnable test) {
        try {
            test.run();
            ++passed;
            System.out.println("PASS " + name);
        } catch (Throwable t) {
            ++failed;
            System.err.println("FAIL " + name + ": " + t);
        }
    }

    public static void main(String[] args) {
        run("queue age budget drops pending media frames, preserves config packets, waits for IDR and logs decisions", () -> {
            List<String> logs = new ArrayList<>();
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 8_000_000, 1_000_000, 0, logs::add);

            byte[] header = {1, 2, 3, 4};
            byte[] config = {9, 9, 9};
            byte[] frame1 = {10, 11};
            byte[] frame2 = {12, 13};
            byte[] pFrameAfterCongestion = {14, 15};
            byte[] configDuringRecovery = {8, 8};
            byte[] idrFrame = {99, 100};
            byte[] frameAfterIdr = {101, 102};

            check(policy.offer(header, true, false, 0), "header must be accepted");
            check(policy.offer(config, true, false, 10), "config must be accepted");
            check(policy.offer(frame1, false, true, 20), "initial IDR must be accepted");
            check(policy.offer(frame2, false, false, 50), "P-frame within budget must be accepted");
            check(policy.size() == 4, "expected 4 packets queued");

            // At t=125ms, oldest non-protected packet (frame1 queued at t=20ms) has age 105ms > 100ms budget.
            check(!policy.offer(pFrameAfterCongestion, false, false, 125), "non-IDR on congestion must be dropped");
            check(policy.size() == 2, "only protected packets (header + config) must survive drop");
            check(policy.getBitrate() == 5_600_000, "bitrate must decrease by 0.7x to 5600000");

            CongestionPolicy.Actions actions = policy.actions(125);
            check(actions.bitrate == 5_600_000, "actions must report updated bitrate");
            check(actions.requestSync, "actions must request sync frame on congestion");

            // Protected config packet arriving while waiting for IDR must still be accepted.
            check(policy.offer(configDuringRecovery, true, false, 130), "config packet during IDR wait must never be dropped");
            check(!policy.offer(new byte[] {1, 1}, false, false, 140), "P-frame during IDR wait must be dropped");

            // IDR arrives at t=150ms: exits drop-until-IDR mode.
            check(policy.offer(idrFrame, false, true, 150), "IDR keyframe must be accepted");
            check(policy.offer(frameAfterIdr, false, false, 160), "P-frame after IDR must be accepted");

            // Verify order of surviving packets: header, config, configDuringRecovery, idrFrame, frameAfterIdr.
            check(Arrays.equals(header, policy.poll(160).data), "first polled packet must be header");
            check(Arrays.equals(config, policy.poll(160).data), "second polled packet must be config");
            check(Arrays.equals(configDuringRecovery, policy.poll(160).data), "third polled packet must be configDuringRecovery");
            check(Arrays.equals(idrFrame, policy.poll(160).data), "fourth polled packet must be IDR");
            check(Arrays.equals(frameAfterIdr, policy.poll(160).data), "fifth polled packet must be post-IDR frame");
            check(policy.poll(160) == null, "queue must be empty");
            check(!logs.isEmpty(), "decisions must be logged");
        });

        run("sync frame requests are rate-limited to at least 1s apart and stop once IDR arrives", () -> {
            List<String> logs = new ArrayList<>();
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 4_000_000, 1_000_000, 0, logs::add);

            policy.onWriteCompleted(150, 200); // Write took 150ms > 100ms budget at t=200ms
            CongestionPolicy.Actions first = policy.actions(200);
            check(first.requestSync, "first sync request must fire immediately at t=200ms");
            check(first.bitrate == 2_800_000, "bitrate must drop to 2800000");

            check(!policy.actions(500).requestSync, "sync must not fire at +300ms");
            check(!policy.actions(1199).requestSync, "sync must not fire at +999ms");

            CongestionPolicy.Actions retry = policy.actions(1200);
            check(retry.requestSync, "sync retry must fire at +1000ms while still waiting for IDR");
            check(retry.bitrate == 0, "unchanged bitrate must report 0");

            // Accept and send IDR at t=1300ms: sync requests must stop.
            check(policy.offer(new byte[] {42}, false, true, 1300), "IDR must be accepted");
            check(policy.poll(1305) != null, "IDR polled by sender");
            check(!policy.actions(2500).requestSync, "no sync request after IDR accepted");
        });

        run("AIMD bitrate floors at vminbr and increases by 10% every 2s uncongested up to requested bitrate", () -> {
            List<String> logs = new ArrayList<>();
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 2_000_000, 1_000_000, 0, logs::add);

            // 1st congestion: 2_000_000 * 0.7 = 1_400_000
            policy.onWriteCompleted(120, 100);
            check(policy.actions(100).bitrate == 1_400_000, "expected 1400000");
            check(policy.offer(new byte[] {1}, false, true, 110), "recover with IDR");
            policy.poll(110);

            // 2nd congestion: 1_400_000 * 0.7 = 980_000 -> clamped to vminbr 1_000_000
            policy.onWriteCompleted(120, 200);
            check(policy.actions(200).bitrate == 1_000_000, "expected floor at vminbr 1000000");
            check(policy.offer(new byte[] {1}, false, true, 210), "recover with IDR");
            policy.poll(210);

            // Before 2s uncongested since last adjustment (t=200): no increase at t=2199
            check(policy.actions(2199).bitrate == 0, "no increase before 2000ms");

            // At t=2200 (+2000ms): +10% of 2_000_000 (+200_000) -> 1_200_000
            check(policy.actions(2200).bitrate == 1_200_000, "expected additive increase to 1200000");
            check(policy.actions(4200).bitrate == 1_400_000, "expected additive increase to 1400000");
            check(policy.actions(6200).bitrate == 1_600_000, "expected additive increase to 1600000");
            check(policy.actions(8200).bitrate == 1_800_000, "expected additive increase to 1800000");
            check(policy.actions(10200).bitrate == 2_000_000, "expected additive increase capped at 2000000");
            check(policy.actions(12200).bitrate == 0, "must not exceed requested bitrate");
        });

        run("queue capacity overflow drops media frames but never drops protected config packets", () -> {
            List<String> logs = new ArrayList<>();
            CongestionPolicy policy = new CongestionPolicy(2, 16, 100, 4_000_000, 1_000_000, 0, logs::add);

            check(policy.offer(new byte[8], true, false, 0), "first protected packet accepted");
            check(policy.offer(new byte[8], false, true, 10), "IDR accepted");
            // Queue is full (2 packets, 16 bytes). Offering another protected packet must evict the media frame and accept config.
            check(policy.offer(new byte[8], true, false, 20), "second protected packet must evict media packet and succeed");
            check(policy.size() == 2, "two protected packets in queue");

            // Now queue is full of protected packets only: offering a 3rd protected packet must throw rather than drop config.
            boolean threw = false;
            try {
                policy.offer(new byte[4], true, false, 30);
            } catch (IllegalStateException expected) {
                threw = true;
            }
            check(threw, "protected overflow must fail rather than drop config");
        });

        System.out.println("Tests: " + passed + " passed, " + failed + " failed");
        if (failed != 0) {
            System.exit(1);
        }
    }
}
