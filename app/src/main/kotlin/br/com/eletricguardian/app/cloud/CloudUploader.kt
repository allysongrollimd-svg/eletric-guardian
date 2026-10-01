package br.com.eletricguardian.app.cloud

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import br.com.eletricguardian.app.BuildConfig
import br.com.eletricguardian.app.Telemetry
import br.com.eletricguardian.app.web.SnapshotJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.UUID

/**
 * Envia o estado do carro para o servidor na nuvem (pasta `server/` do repo),
 * para o painel abrir de qualquer lugar e não só na mesma rede.
 *
 * Um app comum não consegue ligar os dados móveis sozinho (isso exige permissão
 * de sistema). O que ele pode, e faz aqui, é pedir a rede celular ao Android:
 * enquanto o pedido estiver ativo o sistema mantém o 4G de pé (mesmo com Wi-Fi
 * conectado), e o envio sai por ele. Sem 4G, usa a rede padrão.
 */
class CloudUploader(context: Context) {

    private val app = context.applicationContext
    private val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val baseUrl = BuildConfig.CLOUD_URL.trimEnd('/')
    private val identity = Identity.load(app)

    @Volatile private var cellular: Network? = null
    private var job: Job? = null

    private val cellularCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            cellular = network
            Log.i(TAG, "4G disponível")
        }

        override fun onLost(network: Network) {
            if (cellular == network) cellular = null
            Log.i(TAG, "4G perdido")
        }
    }

    /** Link do painel na nuvem para este carro (vazio se o servidor não foi configurado). */
    fun viewerUrl(): String? =
        if (baseUrl.isEmpty()) null else "$baseUrl/car/${identity.id}?k=${identity.key}"

    fun start(scope: CoroutineScope) {
        if (baseUrl.isEmpty()) {
            Telemetry.update { it.copy(cloudStatus = "nuvem não configurada neste APK") }
            return
        }
        Telemetry.update { it.copy(cloudUrl = viewerUrl(), cloudStatus = "conectando…") }
        runCatching {
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            cm.requestNetwork(request, cellularCallback)
        }.onFailure { Log.w(TAG, "não deu para pedir o 4G; usa a rede padrão", it) }
        if (job == null) job = scope.launch { loop() }
    }

    fun stop() {
        job?.cancel()
        job = null
        runCatching { cm.unregisterNetworkCallback(cellularCallback) }
    }

    private suspend fun CoroutineScope.loop() {
        var backoff = MIN_BACKOFF_MS
        while (isActive) {
            val state = Telemetry.state.value
            if (state.snapshot == null) {
                delay(INTERVAL_MS)
                continue
            }
            val net = cellular
            val result = runCatching { post(SnapshotJson.of(state), net) }
            if (result.isSuccess) {
                backoff = MIN_BACKOFF_MS
                Telemetry.update { it.copy(cloudStatus = "enviando pela ${if (net != null) "rede 4G" else "rede padrão"}") }
                delay(INTERVAL_MS)
            } else {
                val err = result.exceptionOrNull()
                Log.w(TAG, "falha no envio, tenta de novo em ${backoff / 1000}s: $err")
                Telemetry.update { it.copy(cloudStatus = "sem conexão com a nuvem, tentando de novo") }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
            }
        }
    }

    private fun post(json: String, network: Network?) {
        val url = URL("$baseUrl/api/car/${identity.id}")
        val conn = (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("X-Car-Key", identity.key)
            conn.outputStream.use { it.write(json.toByteArray()) }
            val code = conn.responseCode
            if (code !in 200..299) error("HTTP $code")
        } finally {
            conn.disconnect()
        }
    }

    /** Id e chave do carro, gerados uma vez e guardados no aparelho. */
    private class Identity(val id: String, val key: String) {
        companion object {
            fun load(context: Context): Identity {
                val prefs = context.getSharedPreferences("cloud", Context.MODE_PRIVATE)
                val id = prefs.getString("id", null) ?: UUID.randomUUID().toString().also {
                    prefs.edit().putString("id", it).apply()
                }
                val key = prefs.getString("key", null) ?: randomKey().also {
                    prefs.edit().putString("key", it).apply()
                }
                return Identity(id, key)
            }

            private fun randomKey(): String {
                val bytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
                return bytes.joinToString("") { "%02x".format(it) }
            }
        }
    }

    companion object {
        private const val TAG = "EG-Cloud"
        private const val INTERVAL_MS = 3_000L
        private const val MIN_BACKOFF_MS = 2_000L
        private const val MAX_BACKOFF_MS = 60_000L
    }
}
