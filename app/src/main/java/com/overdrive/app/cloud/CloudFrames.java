package com.overdrive.app.cloud;

import java.nio.ByteBuffer;

/**
 * Wire format of the Electric Guardian reverse tunnel (must match webapp/lib/tunnel.js):
 * <pre>[type:u8][streamId:u32 big-endian][payload]</pre>
 * OPEN (server to car), DATA (both ways), CLOSE (both ways), CREDIT (server to car, u32 bytes).
 */
final class CloudFrames {
    static final int OPEN = 1;
    static final int DATA = 2;
    static final int CLOSE = 3;
    static final int CREDIT = 4;
    static final int HEADER = 5;
    static final int INITIAL_CREDIT = 256 * 1024;

    private CloudFrames() {}

    static byte[] encode(int type, int streamId, byte[] payload, int offset, int length) {
        byte[] f = new byte[HEADER + length];
        f[0] = (byte) type;
        f[1] = (byte) (streamId >>> 24);
        f[2] = (byte) (streamId >>> 16);
        f[3] = (byte) (streamId >>> 8);
        f[4] = (byte) streamId;
        if (length > 0) System.arraycopy(payload, offset, f, HEADER, length);
        return f;
    }

    static byte[] encode(int type, int streamId) {
        return encode(type, streamId, null, 0, 0);
    }

    static int type(byte[] frame) {
        return frame[0] & 0xff;
    }

    static int streamId(byte[] frame) {
        return ByteBuffer.wrap(frame, 1, 4).getInt();
    }

    static long creditOf(byte[] frame) {
        return ByteBuffer.wrap(frame, HEADER, 4).getInt() & 0xffffffffL;
    }

    static boolean isValid(byte[] frame) {
        return frame != null && frame.length >= HEADER && type(frame) >= OPEN && type(frame) <= CREDIT;
    }
}
