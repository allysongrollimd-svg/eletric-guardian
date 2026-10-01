package br.com.eletricguardian.app.web

import android.content.Context
import android.util.Log
import br.com.eletricguardian.app.Telemetry
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket

/**
 * Servidor web local do coletor, no modelo do Electro/Overdrive: o app do carro
 * serve o painel (webapp) e os dados num `/api/snapshot`, e você abre no
 * navegador do celular pelo IP do carro. É HTTP comum numa porta local — sem
 * nada de privilégio de sistema.
 */
class WebServer(context: Context, private val port: Int = 8731) {

    private val assets = context.applicationContext.assets

    @Volatile
    private var server: ServerSocket? = null

    @Volatile
    private var thread: Thread? = null

    /** URL pra abrir no celular (IP da rede local do carro). */
    fun url(): String = "http://${localIp() ?: "127.0.0.1"}:$port"

    fun start() {
        if (thread != null) return
        thread = Thread({ loop() }, "EG-Web").apply { isDaemon = true; start() }
    }

    fun stop() {
        thread = null
        runCatching { server?.close() }
        server = null
    }

    private fun loop() {
        try {
            val s = ServerSocket(port)
            server = s
            Log.i(TAG, "webapp em ${url()}")
            while (thread != null && !s.isClosed) {
                val socket = try {
                    s.accept()
                } catch (t: Throwable) {
                    if (thread == null) break else continue
                }
                // Uma conexão por vez já basta pro painel; isola falha de cada uma.
                Thread({ runCatching { handle(socket) } }, "EG-Web-conn").apply { isDaemon = true; start() }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "servidor web parou", t)
        }
    }

    private fun handle(socket: Socket) {
        socket.use { sock ->
            val reader = BufferedReader(InputStreamReader(sock.getInputStream()))
            val requestLine = reader.readLine() ?: return
            // Consome o resto dos cabeçalhos.
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
            }
            val path = requestLine.split(' ').getOrNull(1)?.substringBefore('?') ?: "/"
            val out = sock.getOutputStream()
            when (path) {
                "/", "/index.html" -> respondAsset(out, "dashboard.html", "text/html; charset=utf-8")
                "/api/snapshot" -> respond(out, "200 OK", "application/json; charset=utf-8", SnapshotJson.of(Telemetry.state.value).toByteArray())
                else -> respond(out, "404 Not Found", "text/plain; charset=utf-8", "nao encontrado".toByteArray())
            }
        }
    }

    private fun respondAsset(out: OutputStream, name: String, type: String) {
        val body = try {
            assets.open(name).use { it.readBytes() }
        } catch (t: Throwable) {
            respond(out, "500 Internal Server Error", "text/plain; charset=utf-8", "sem $name".toByteArray())
            return
        }
        respond(out, "200 OK", type, body)
    }

    private fun respond(out: OutputStream, status: String, type: String, body: ByteArray) {
        val header = buildString {
            append("HTTP/1.1 ").append(status).append("\r\n")
            append("Content-Type: ").append(type).append("\r\n")
            append("Content-Length: ").append(body.size).append("\r\n")
            append("Access-Control-Allow-Origin: *\r\n")
            append("Connection: close\r\n\r\n")
        }
        out.write(header.toByteArray())
        out.write(body)
        out.flush()
    }

    private fun localIp(): String? = try {
        NetworkInterface.getNetworkInterfaces().asSequence()
            .flatMap { it.inetAddresses.asSequence() }
            .firstOrNull { addr -> !addr.isLoopbackAddress && addr is InetAddress && addr.hostAddress?.contains('.') == true && !addr.hostAddress!!.startsWith("169.254") }
            ?.hostAddress
    } catch (t: Throwable) {
        null
    }

    private companion object {
        const val TAG = "EG-Web"
    }
}
