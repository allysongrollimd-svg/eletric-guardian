package com.overdrive.app.cloud;

import com.overdrive.app.logging.DaemonLogger;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Reverse tunnel client. Keeps ONE outbound WebSocket to the Electric Guardian server; for every
 * stream the server opens, it connects to this car's own web server on 127.0.0.1 and pipes bytes
 * both ways (live view, recordings and the sentry UI all travel through it unchanged).
 *
 * Flow control: the car may send at most {@link CloudFrames#INITIAL_CREDIT} bytes per stream until
 * the server grants more (CREDIT frames), and it also pauses while the WebSocket send queue is full.
 */
final class CloudTunnel {
    private static final DaemonLogger LOG = DaemonLogger.getInstance("EgCloud/Tunnel");
    private static final int READ_CHUNK = 16 * 1024;
    private static final long MAX_QUEUE_BYTES = 2L * 1024 * 1024;
    private static final int LOCAL_CONNECT_TIMEOUT_MS = 3000;
    private static final byte[] EOF = new byte[0];

    interface Listener {
        void onConnected();

        /** @param httpCode HTTP status of a rejected handshake (e.g. 401), or 0 */
        void onDisconnected(String reason, int httpCode);
    }

    private final OkHttpClient client;
    private final String wsUrl;
    private final String bearer;
    private final int localPort;
    private final Listener listener;
    private final ConcurrentHashMap<Integer, Stream> streams = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "EgCloud-stream");
        t.setDaemon(true);
        return t;
    });
    private volatile WebSocket ws;
    private volatile boolean closed;

    CloudTunnel(OkHttpClient client, String wsUrl, String bearer, int localPort, Listener listener) {
        this.client = client;
        this.wsUrl = wsUrl;
        this.bearer = bearer;
        this.localPort = localPort;
        this.listener = listener;
    }

    void connect() {
        Request req = new Request.Builder().url(wsUrl).header("Authorization", "Bearer " + bearer).build();
        ws = client.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                LOG.info("tunnel connected");
                listener.onConnected();
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                handleFrame(bytes.toByteArray());
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                finish("closed " + code + (reason == null || reason.isEmpty() ? "" : " " + reason), 0);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                finish(t == null ? "failure" : t.getClass().getSimpleName() + ": " + t.getMessage(),
                        response == null ? 0 : response.code());
            }
        });
    }

    void close() {
        closed = true;
        WebSocket w = ws;
        if (w != null) w.cancel();
        closeAllStreams();
        pool.shutdownNow();
    }

    private void finish(String reason, int httpCode) {
        closeAllStreams();
        if (!closed) listener.onDisconnected(reason, httpCode);
    }

    private void closeAllStreams() {
        for (Stream s : streams.values()) s.close(false);
        streams.clear();
    }

    private void handleFrame(byte[] f) {
        if (!CloudFrames.isValid(f)) return;
        int type = CloudFrames.type(f);
        int id = CloudFrames.streamId(f);
        switch (type) {
            case CloudFrames.OPEN: {
                if (streams.size() >= 64) {                     // never let one viewer exhaust the car
                    send(CloudFrames.encode(CloudFrames.CLOSE, id));
                    return;
                }
                Stream s = new Stream(id);
                streams.put(id, s);
                pool.execute(s::run);
                break;
            }
            case CloudFrames.DATA: {
                Stream s = streams.get(id);
                if (s != null) s.inbox.offer(java.util.Arrays.copyOfRange(f, CloudFrames.HEADER, f.length));
                break;
            }
            case CloudFrames.CREDIT: {
                Stream s = streams.get(id);
                if (s != null && f.length >= CloudFrames.HEADER + 4) s.addCredit(CloudFrames.creditOf(f));
                break;
            }
            case CloudFrames.CLOSE: {
                Stream s = streams.remove(id);
                if (s != null) s.close(false);
                break;
            }
            default:
                break;
        }
    }

    private boolean send(byte[] frame) {
        WebSocket w = ws;
        return w != null && w.send(ByteString.of(frame));
    }

    /** One tunneled connection to the car's local web server. */
    private final class Stream {
        private final int id;
        private final LinkedBlockingQueue<byte[]> inbox = new LinkedBlockingQueue<>();
        private final Object creditLock = new Object();
        private long credit = CloudFrames.INITIAL_CREDIT;
        private volatile Socket sock;
        private volatile boolean done;

        Stream(int id) {
            this.id = id;
        }

        void addCredit(long n) {
            synchronized (creditLock) {
                credit += n;
                creditLock.notifyAll();
            }
        }

        void run() {
            try {
                Socket s = new Socket();
                s.connect(new InetSocketAddress("127.0.0.1", localPort), LOCAL_CONNECT_TIMEOUT_MS);
                s.setTcpNoDelay(true);
                sock = s;
                if (done) {
                    s.close();
                    return;
                }
                final OutputStream out = s.getOutputStream();
                Thread writer = new Thread(() -> {
                    try {
                        while (true) {
                            byte[] b = inbox.take();
                            if (b == EOF) break;
                            out.write(b);
                            out.flush();
                        }
                    } catch (Exception ignored) {
                        // local socket closed: the reader notices and ends the stream
                    }
                }, "EgCloud-writer");
                writer.setDaemon(true);
                writer.start();

                InputStream in = s.getInputStream();
                byte[] buf = new byte[READ_CHUNK];
                int n;
                while (!done && (n = in.read(buf)) > 0) {
                    waitForCredit(n);
                    waitForQueue();
                    if (done) break;
                    if (!send(CloudFrames.encode(CloudFrames.DATA, id, buf, 0, n))) break;
                }
            } catch (Exception e) {
                // fall through: the stream is over either way
            } finally {
                close(true);
            }
        }

        private void waitForCredit(int n) throws InterruptedException {
            synchronized (creditLock) {
                while (credit <= 0 && !done) creditLock.wait(1000);
                credit -= n;
            }
        }

        private void waitForQueue() throws InterruptedException {
            WebSocket w = ws;
            while (!done && w != null && w.queueSize() > MAX_QUEUE_BYTES) Thread.sleep(5);
        }

        void close(boolean notifyServer) {
            if (done) return;
            done = true;
            streams.remove(id);
            inbox.offer(EOF);
            synchronized (creditLock) {
                creditLock.notifyAll();
            }
            Socket s = sock;
            if (s != null) {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // already closed
                }
            }
            if (notifyServer) send(CloudFrames.encode(CloudFrames.CLOSE, id));
        }
    }
}
