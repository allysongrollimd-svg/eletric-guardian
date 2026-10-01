package br.com.eletricguardian.app.web

import android.util.Base64
import android.util.Log
import java.io.BufferedReader
import java.io.OutputStream
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Handler WebSocket para streaming de dados em tempo real.
 * Implementação simples do protocolo WebSocket (RFC 6455) sem dependências externas.
 */
object WebSocketHandler {
    private const val TAG = "EG-WebSocket"
    private const val MAGIC_KEY = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    private val clients = CopyOnWriteArraySet<WebSocketClient>()

    data class WebSocketClient(val socket: Socket, val output: OutputStream)

    fun handleUpgrade(socket: Socket, reader: BufferedReader, headers: Map<String, String>): Boolean {
        val key = headers["sec-websocket-key"] ?: return false
        val acceptKey = computeAcceptKey(key)

        try {
            val response = buildString {
                append("HTTP/1.1 101 Switching Protocols\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Accept: $acceptKey\r\n\r\n")
            }

            val output = socket.getOutputStream()
            output.write(response.toByteArray())
            output.flush()

            val client = WebSocketClient(socket, output)
            clients.add(client)
            Log.i(TAG, "WebSocket conectado (${clients.size} clientes)")

            // Thread para manter a conexão viva e detectar desconexão
            Thread({
                try {
                    val input = socket.getInputStream()
                    while (!socket.isClosed && input.read() != -1) {
                        // Apenas mantém a conexão viva, ignora mensagens do cliente
                    }
                } catch (t: Throwable) {
                    // Cliente desconectou
                } finally {
                    clients.remove(client)
                    runCatching { socket.close() }
                    Log.i(TAG, "WebSocket desconectado (${clients.size} clientes)")
                }
            }, "EG-WS-client").apply { isDaemon = true; start() }

            return true
        } catch (t: Throwable) {
            Log.e(TAG, "Erro no WebSocket handshake", t)
            return false
        }
    }

    fun broadcast(message: String) {
        if (clients.isEmpty()) return

        val frame = encodeTextFrame(message)
        val deadClients = mutableListOf<WebSocketClient>()

        for (client in clients) {
            try {
                if (client.socket.isClosed) {
                    deadClients.add(client)
                    continue
                }
                client.output.write(frame)
                client.output.flush()
            } catch (t: Throwable) {
                deadClients.add(client)
            }
        }

        if (deadClients.isNotEmpty()) {
            clients.removeAll(deadClients.toSet())
            Log.d(TAG, "Removidos ${deadClients.size} clientes mortos")
        }
    }

    fun clientCount(): Int = clients.size

    private fun computeAcceptKey(key: String): String {
        val concat = key + MAGIC_KEY
        val sha1 = MessageDigest.getInstance("SHA-1").digest(concat.toByteArray())
        return Base64.encodeToString(sha1, Base64.NO_WRAP)
    }

    private fun encodeTextFrame(text: String): ByteArray {
        val payload = text.toByteArray(Charsets.UTF_8)
        val payloadLength = payload.size

        return when {
            payloadLength <= 125 -> {
                byteArrayOf(0x81.toByte(), payloadLength.toByte()) + payload
            }
            payloadLength <= 65535 -> {
                byteArrayOf(
                    0x81.toByte(),
                    126.toByte(),
                    (payloadLength shr 8).toByte(),
                    (payloadLength and 0xFF).toByte()
                ) + payload
            }
            else -> {
                byteArrayOf(
                    0x81.toByte(),
                    127.toByte(),
                    0, 0, 0, 0,
                    (payloadLength shr 24).toByte(),
                    (payloadLength shr 16 and 0xFF).toByte(),
                    (payloadLength shr 8 and 0xFF).toByte(),
                    (payloadLength and 0xFF).toByte()
                ) + payload
            }
        }
    }
}
