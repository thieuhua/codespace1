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
        run("severe backlog (3x budget) drops pending media frames, preserves config packets, waits for IDR and logs decisions", () -> {
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

            // At t=325ms, oldest non-protected packet (frame1 queued at t=20ms) has age 305ms > 3 x 100ms budget.
            check(!policy.offer(pFrameAfterCongestion, false, false, 325), "non-IDR on congestion must be dropped");
            check(policy.size() == 2, "only protected packets (header + config) must survive drop");
            check(policy.getBitrate() == 5_600_000, "bitrate must decrease by 0.7x to 5600000");

            CongestionPolicy.Actions actions = policy.actions(325);
            check(actions.bitrate == 5_600_000, "actions must report updated bitrate");
            check(actions.requestSync, "actions must request sync frame on congestion");

            // Protected config packet arriving while waiting for IDR must still be accepted.
            check(policy.offer(configDuringRecovery, true, false, 330), "config packet during IDR wait must never be dropped");
            check(!policy.offer(new byte[] {1, 1}, false, false, 340), "P-frame during IDR wait must be dropped");

            // IDR arrives at t=350ms: exits drop-until-IDR mode.
            check(policy.offer(idrFrame, false, true, 350), "IDR keyframe must be accepted");
            check(policy.offer(frameAfterIdr, false, false, 360), "P-frame after IDR must be accepted");

            // Verify order of surviving packets: header, config, configDuringRecovery, idrFrame, frameAfterIdr.
            check(Arrays.equals(header, policy.poll(360).data), "first polled packet must be header");
            check(Arrays.equals(config, policy.poll(360).data), "second polled packet must be config");
            check(Arrays.equals(configDuringRecovery, policy.poll(360).data), "third polled packet must be configDuringRecovery");
            check(Arrays.equals(idrFrame, policy.poll(360).data), "fourth polled packet must be IDR");
            check(Arrays.equals(frameAfterIdr, policy.poll(360).data), "fifth polled packet must be post-IDR frame");
            check(policy.poll(360) == null, "queue must be empty");
            check(!logs.isEmpty(), "decisions must be logged");
        });

        run("sync frame requests are rate-limited to at least 1s apart and stop once IDR arrives", () -> {
            List<String> logs = new ArrayList<>();
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 4_000_000, 1_000_000, 0, logs::add);

            policy.onWriteCompleted(350, 400); // Write took 350ms > 3 x 100ms budget at t=400ms
            CongestionPolicy.Actions first = policy.actions(400);
            check(first.requestSync, "first sync request must fire immediately at t=400ms");
            check(first.bitrate == 2_800_000, "bitrate must drop to 2800000");

            check(!policy.actions(700).requestSync, "sync must not fire at +300ms");
            check(!policy.actions(1399).requestSync, "sync must not fire at +999ms");

            CongestionPolicy.Actions retry = policy.actions(1400);
            check(retry.requestSync, "sync retry must fire at +1000ms while still waiting for IDR");
            check(retry.bitrate == 0, "unchanged bitrate must report 0");

            // Accept and send IDR at t=1500ms: sync requests must stop.
            check(policy.offer(new byte[] {42}, false, true, 1500), "IDR must be accepted");
            check(policy.poll(1505) != null, "IDR polled by sender");
            check(!policy.actions(2700).requestSync, "no sync request after IDR accepted");
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
            // Single writer: the 2nd slow write starts after the 1st episode (t=580..700).
            policy.onWriteCompleted(120, 700);
            check(policy.actions(700).bitrate == 1_000_000, "expected floor at vminbr 1000000");
            check(policy.offer(new byte[] {1}, false, true, 710), "recover with IDR");
            policy.poll(710);

            // Before 2s uncongested since last adjustment (t=700): no increase at t=2699
            check(policy.actions(2699).bitrate == 0, "no increase before 2000ms");

            // At t=2700 (+2000ms): +10% of 2_000_000 (+200_000) -> 1_200_000
            policy.onWriteCompleted(1, 2299, 600_000); // link busy at the current rate
            check(policy.actions(2700).bitrate == 1_200_000, "expected additive increase to 1200000");
            policy.onWriteCompleted(1, 4299, 600_000); // link busy at the current rate
            check(policy.actions(4700).bitrate == 1_400_000, "expected additive increase to 1400000");
            policy.onWriteCompleted(1, 6299, 600_000); // link busy at the current rate
            check(policy.actions(6700).bitrate == 1_600_000, "expected additive increase to 1600000");
            policy.onWriteCompleted(1, 8299, 600_000); // link busy at the current rate
            check(policy.actions(8700).bitrate == 1_800_000, "expected additive increase to 1800000");
            policy.onWriteCompleted(1, 10299, 600_000); // link busy at the current rate
            check(policy.actions(10700).bitrate == 2_000_000, "expected additive increase capped at 2000000");
            policy.onWriteCompleted(1, 12299, 600_000); // link busy at the current rate
            check(policy.actions(12700).bitrate == 0, "must not exceed requested bitrate");
        });

        run("a slow write already handled by the encoder thread does not cut bitrate twice or drop the recovery IDR", () -> {
            List<String> logs = new ArrayList<>();
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 2_000_000, 1_000_000, 0, logs::add);
            check(policy.offer(new byte[] {1}, false, true, 0), "first frame queued");
            policy.poll(0); // the sender starts writing it at t=0
            check(policy.offer(new byte[] {2}, false, false, 10), "second frame queued");
            // While that write is stuck, the queued frame ages past the budget: the encoder thread reacts once.
            check(!policy.offer(new byte[] {3}, false, false, 320), "P-frame dropped while waiting for IDR");
            check(policy.actions(320).bitrate == 1_400_000, "one decrease");
            check(policy.offer(new byte[] {4}, false, true, 330), "recovery IDR accepted");
            // The stuck write (t=0..350) completes: same episode, no second reaction.
            policy.onWriteCompleted(350, 350);
            check(policy.actions(350).bitrate == 0, "no second decrease");
            CongestionPolicy.Packet next = policy.poll(350);
            check(next != null && next.data[0] == 4, "recovery IDR still queued");
        });

        run("kernel backlog budget is half the latency budget at the current bitrate, with a 16 KiB floor", () -> {
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 8_000_000, 1_000_000, 0, s -> { });
            check(policy.kernelBudgetBytes() == 50_000, "8 Mbps x 50 ms = 50000 bytes");
            policy.onWriteCompleted(150, 150); // congestion: 8 -> 5.6 Mbps
            check(policy.kernelBudgetBytes() == 35_000, "budget follows the lowered bitrate");
            CongestionPolicy slow = new CongestionPolicy(32, 65536, 100, 1_000_000, 1_000_000, 0, s -> { });
            check(slow.kernelBudgetBytes() == 16 * 1024, "16 KiB floor at low bitrate");
        });

        run("a still screen (little data sent) holds the bitrate instead of probing upwards", () -> {
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 8_000_000, 1_000_000, 0, s -> { });
            policy.onWriteCompleted(150, 150); // congestion: 8 -> 5.6 Mbps
            check(policy.actions(150).bitrate == 5_600_000, "decrease reported");
            check(policy.offer(new byte[] {1}, false, true, 160), "recover with IDR");
            policy.poll(160);
            policy.onWriteCompleted(1, 1000, 2_000); // a few small frames only
            check(policy.actions(2200).bitrate == 0, "no increase while the link is idle");
            policy.onWriteCompleted(1, 4100, 1_000_000); // interaction: the link is busy again
            check(policy.actions(4200).bitrate == 6_400_000, "increase once the link carries the current rate");
        });

        run("mild backlog lowers the bitrate at most every 500 ms and keeps every frame", () -> {
            CongestionPolicy policy = new CongestionPolicy(32, 65536, 100, 8_000_000, 1_000_000, 0, x -> { });
            check(policy.offer(new byte[] {1}, false, true, 0), "IDR queued");
            check(policy.offer(new byte[] {2}, false, false, 150), "mild (age 150 ms): frame kept");
            check(policy.getBitrate() == 5_600_000, "one decrease");
            check(policy.offer(new byte[] {3}, false, false, 200), "still mild: frame kept");
            check(policy.getBitrate() == 5_600_000, "no second decrease within 500 ms");
            check(!policy.actions(200).requestSync, "no IDR request for mild congestion");
            check(policy.size() == 3, "nothing dropped");
            policy.onWriteCompleted(150, 700); // slow write later on: another mild step
            check(policy.getBitrate() == 3_919_999, "second decrease after 500 ms");
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
