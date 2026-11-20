// Modified by phonectl: accept socket streams for both adb and TLS (Apache-2.0).
package com.genymobile.scrcpy.control;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public final class ControlChannel {

    private final ControlMessageReader reader;
    private final DeviceMessageWriter writer;

    public ControlChannel(InputStream input, OutputStream output) {
        reader = new ControlMessageReader(input);
        writer = new DeviceMessageWriter(output);
    }

    public ControlMessage recv() throws IOException {
        return reader.read();
    }

    public void send(DeviceMessage msg) throws IOException {
        writer.write(msg);
    }
}
