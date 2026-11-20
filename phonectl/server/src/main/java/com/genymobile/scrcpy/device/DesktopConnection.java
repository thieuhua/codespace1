// Modified by phonectl: stream transports, authenticated LAN session, video telemetry (Apache-2.0).
package com.genymobile.scrcpy.device;

import com.genymobile.scrcpy.control.ControlChannel;
import com.genymobile.scrcpy.util.Ln;
import com.genymobile.scrcpy.util.StringUtils;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class DesktopConnection implements Closeable {

    private static final int DEVICE_NAME_FIELD_LENGTH = 64;

    private static final String SOCKET_NAME_PREFIX = "scrcpy";

    private final StreamSocket videoSocket;

    private final StreamSocket audioSocket;

    private final StreamSocket controlSocket;
    private final ControlChannel controlChannel;
    private final SocketDiagnostics diagnostics;
    private int videoLatencyMs = 100;
    private int videoMinBitrate = 1_000_000;

    private DesktopConnection(StreamSocket videoSocket, StreamSocket audioSocket, StreamSocket controlSocket) throws IOException {
        this.videoSocket = videoSocket;
        this.audioSocket = audioSocket;
        this.controlSocket = controlSocket;

        controlChannel = controlSocket != null ? new ControlChannel(controlSocket.input(), controlSocket.output()) : null;
        diagnostics = videoSocket != null ? new SocketDiagnostics(videoSocket) : null;
    }

    private static StreamSocket connect(String abstractName) throws IOException {
        LocalSocket localSocket = new LocalSocket();
        try {
            localSocket.connect(new LocalSocketAddress(abstractName));
            return new StreamSocket(localSocket);
        } catch (IOException e) {
            localSocket.close();
            throw e;
        }
    }

    private static String getSocketName(int scid) {
        if (scid == -1) {
            // If no SCID is set, use "scrcpy" to simplify using scrcpy-server alone
            return SOCKET_NAME_PREFIX;
        }

        return SOCKET_NAME_PREFIX + String.format("_%08x", scid);
    }

    public static DesktopConnection open(int scid, boolean tunnelForward, boolean video, boolean audio, boolean control, boolean sendDummyByte)
            throws IOException {
        LanSession session = LanSession.consume(new File(LanSession.PATH), System.currentTimeMillis());
        if (session != null) {
            StreamSocket[] sockets = new LanListener(session, video, audio, control).accept();
            int index = 0;
            try {
                DesktopConnection connection = new DesktopConnection(video ? sockets[index++] : null, audio ? sockets[index++] : null,
                        control ? sockets[index] : null);
                connection.videoLatencyMs = session.latencyMs;
                connection.videoMinBitrate = session.minBitrate;
                return connection;
            } catch (IOException | RuntimeException e) {
                for (StreamSocket socket : sockets) {
                    try {
                        socket.close();
                    } catch (IOException closeError) {
                        e.addSuppressed(closeError);
                    }
                }
                throw e;
            }
        }
        String socketName = getSocketName(scid);

        StreamSocket videoSocket = null;
        StreamSocket audioSocket = null;
        StreamSocket controlSocket = null;
        try {
            if (tunnelForward) {
                try (LocalServerSocket localServerSocket = new LocalServerSocket(socketName)) {
                    if (video) {
                        videoSocket = new StreamSocket(localServerSocket.accept());
                        if (sendDummyByte) {
                            // send one byte so the client may read() to detect a connection error
                            videoSocket.output().write(0);
                            sendDummyByte = false;
                        }
                    }
                    if (audio) {
                        audioSocket = new StreamSocket(localServerSocket.accept());
                        if (sendDummyByte) {
                            // send one byte so the client may read() to detect a connection error
                            audioSocket.output().write(0);
                            sendDummyByte = false;
                        }
                    }
                    if (control) {
                        controlSocket = new StreamSocket(localServerSocket.accept());
                        if (sendDummyByte) {
                            // send one byte so the client may read() to detect a connection error
                            controlSocket.output().write(0);
                            sendDummyByte = false;
                        }
                    }
                }
            } else {
                if (video) {
                    videoSocket = connect(socketName);
                }
                if (audio) {
                    audioSocket = connect(socketName);
                }
                if (control) {
                    controlSocket = connect(socketName);
                }
            }
            return new DesktopConnection(videoSocket, audioSocket, controlSocket);
        } catch (IOException | RuntimeException e) {
            if (videoSocket != null) {
                videoSocket.close();
            }
            if (audioSocket != null) {
                audioSocket.close();
            }
            if (controlSocket != null) {
                controlSocket.close();
            }
            throw e;
        }

    }

    private StreamSocket getFirstSocket() {
        if (videoSocket != null) {
            return videoSocket;
        }
        if (audioSocket != null) {
            return audioSocket;
        }
        return controlSocket;
    }

    public void shutdown() throws IOException {
        finishSockets(true);
    }

    public void close() throws IOException {
        finishSockets(false);
    }

    private void finishSockets(boolean shutdown) throws IOException {
        IOException failure = null;
        for (StreamSocket socket : new StreamSocket[] {videoSocket, audioSocket, controlSocket}) {
            if (socket != null) {
                try {
                    if (shutdown) {
                        socket.shutdown();
                    } else {
                        socket.close();
                    }
                } catch (IOException e) {
                    if (failure == null) {
                        failure = e;
                    } else {
                        failure.addSuppressed(e);
                    }
                }
            }
        }
        if (failure != null) {
            throw failure;
        }
    }

    public void sendDeviceMeta(String deviceName) throws IOException {
        byte[] buffer = new byte[DEVICE_NAME_FIELD_LENGTH];

        byte[] deviceNameBytes = deviceName.getBytes(StandardCharsets.UTF_8);
        int len = StringUtils.getUtf8TruncationIndex(deviceNameBytes, DEVICE_NAME_FIELD_LENGTH - 1);
        System.arraycopy(deviceNameBytes, 0, buffer, 0, len);
        // byte[] are always 0-initialized in java, no need to set '\0' explicitly

        getFirstSocket().output().write(buffer);
    }

    public OutputStream getVideoOutput() throws IOException {
        return videoSocket.output();
    }

    public OutputStream getAudioOutput() throws IOException {
        return audioSocket.output();
    }

    public int getVideoLatencyMs() {
        return videoLatencyMs;
    }

    public int getVideoMinBitrate() {
        return videoMinBitrate;
    }

    public void logVideoSocketStats() {
        diagnostics.sample(System.nanoTime() / 1_000_000);
    }

    public void abortVideo() {
        try {
            videoSocket.close();
        } catch (IOException e) {
            Ln.d("Video transport close: " + e.getClass().getSimpleName());
        }
    }

    public ControlChannel getControlChannel() {
        return controlChannel;
    }
}
