package com.overdrive.app.cloud;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The tunnel wire format must stay byte-compatible with webapp/lib/tunnel.js. */
public class CloudFramesTest {

    @Test
    public void dataFrameRoundTrip() {
        byte[] payload = {10, 20, 30, 40, 50};
        byte[] f = CloudFrames.encode(CloudFrames.DATA, 0x01020304, payload, 1, 3);
        assertEquals(CloudFrames.HEADER + 3, f.length);
        assertEquals(CloudFrames.DATA, CloudFrames.type(f));
        assertEquals(0x01020304, CloudFrames.streamId(f));
        assertArrayEquals(new byte[]{20, 30, 40}, java.util.Arrays.copyOfRange(f, CloudFrames.HEADER, f.length));
    }

    @Test
    public void streamIdIsBigEndianAndUnsignedSafe() {
        byte[] f = CloudFrames.encode(CloudFrames.OPEN, 0xFFFFFFF0);
        assertEquals((byte) 0xFF, f[1]);
        assertEquals((byte) 0xF0, f[4]);
        assertEquals(0xFFFFFFF0, CloudFrames.streamId(f));
    }

    @Test
    public void creditIsReadAsUnsigned32() {
        byte[] f = CloudFrames.encode(CloudFrames.CREDIT, 7, new byte[]{(byte) 0x80, 0, 0, 1}, 0, 4);
        assertEquals(0x80000001L, CloudFrames.creditOf(f));
    }

    @Test
    public void rejectsMalformedFrames() {
        assertFalse(CloudFrames.isValid(null));
        assertFalse(CloudFrames.isValid(new byte[3]));
        assertFalse(CloudFrames.isValid(new byte[]{9, 0, 0, 0, 1}));      // unknown type
        assertTrue(CloudFrames.isValid(CloudFrames.encode(CloudFrames.CLOSE, 1)));
    }

    @Test
    public void mqttUrlGetsAnExplicitPortSoTheAppParserAcceptsIt() {
        assertEquals("wss://app.example.com:443/mqtt", CloudConfig.withExplicitPort("wss://app.example.com/mqtt"));
        assertEquals("ws://localhost:80/mqtt", CloudConfig.withExplicitPort("ws://localhost/mqtt"));
        assertEquals("ssl://broker.example.com:8883", CloudConfig.withExplicitPort("ssl://broker.example.com"));
        assertEquals("wss://app.example.com:8443/mqtt", CloudConfig.withExplicitPort("wss://app.example.com:8443/mqtt"));
    }

    @Test
    public void serverUrlIsValidatedAndNormalized() {
        assertEquals("https://app.example.com", CloudConfig.normalizeServerUrl(" https://app.example.com/ "));
        assertEquals("http://192.168.1.10:8790", CloudConfig.normalizeServerUrl("http://192.168.1.10:8790"));
        assertEquals("", CloudConfig.normalizeServerUrl("ftp://x.com"));
        assertEquals("", CloudConfig.normalizeServerUrl("https://app.example.com/path"));
        assertEquals("", CloudConfig.normalizeServerUrl("javascript:alert(1)"));
        assertEquals("", CloudConfig.normalizeServerUrl(null));
    }
}
