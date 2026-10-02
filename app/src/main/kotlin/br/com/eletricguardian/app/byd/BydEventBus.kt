package br.com.eletricguardian.app.byd

import android.hardware.bydauto.BYDAutoEventValue
import android.hardware.bydauto.ac.AbsBYDAutoAcListener
import android.hardware.bydauto.bodywork.AbsBYDAutoBodyworkListener
import android.hardware.bydauto.charging.AbsBYDAutoChargingListener
import android.hardware.bydauto.gearbox.AbsBYDAutoGearboxListener
import android.hardware.bydauto.instrument.AbsBYDAutoInstrumentListener
import android.hardware.bydauto.speed.AbsBYDAutoSpeedListener
import android.hardware.bydauto.statistic.AbsBYDAutoStatisticListener
import android.content.Context
import android.os.Process
import android.util.Log
import br.com.eletricguardian.core.BydLogParser
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap

/**
 * Recebe os eventos que o serviço da BYD empurra para quem registrou listener.
 *
 * No Dolphin GS os getters do SDK exigem permissões de assinatura da BYD, mas
 * os eventos chegam ao processo que registrou um listener (é assim que o Electro
 * lê o carro). O SDK registra cada evento no logcat do próprio processo
 * ("postEvent ... device_type=… event_type=… value=…"), e um app sempre pode ler
 * o próprio log; daí extraímos device_type, event_type e valor.
 *
 * O carro só manda um evento quando o valor muda (com a bateria cheia, SoC e
 * autonomia param de chegar). Por isso os valores de bateria/estatística
 * (device 1014) ficam salvos e são recarregados quando o app abre. Os de carga
 * (1009) não, para não mostrar uma carga que já terminou.
 */
class BydEventBus(context: Context) {

    data class Event(val code: String, val value: Double, val timestampMs: Long)

    /** Último valor de cada código "deviceType|eventType" (event_type em hex minúsculo). */
    val latest = ConcurrentHashMap<String, Event>()

    init {
        current = latest
    }

    private val saved = context.getSharedPreferences("byd-eventos", Context.MODE_PRIVATE)

    init {
        for ((code, raw) in saved.all) {
            val parts = (raw as? String)?.split(';') ?: continue
            val value = parts.getOrNull(0)?.toDoubleOrNull() ?: continue
            val ts = parts.getOrNull(1)?.toLongOrNull() ?: 0L
            latest[code] = Event(code, value, ts)
        }
        if (latest.isNotEmpty()) Log.i(TAG, "recarregados ${latest.size} valores salvos")
    }

    private val registered = ConcurrentHashMap.newKeySet<String>()
    private val listeners = mutableListOf<Pair<Any, Any>>()

    @Volatile
    private var reader: Thread? = null

    @Volatile
    private var process: java.lang.Process? = null

    fun registeredSummary(): String = registered.sorted().joinToString(" ")

    /**
     * Segundo registro, com a lista de IDs que interessam. O SDK da BYD costuma
     * reemitir o valor atual de cada ID no momento em que você registra com
     * essa lista (é como o Overdrive mostra tudo com o carro parado, sem chamar
     * getter nem permissão). Se não houver a sobrecarga de dois parâmetros ou os
     * IDs não baterem, o registro simples acima continua recebendo as mudanças.
     */
    private fun requestCurrent(name: String, device: Any) {
        val ids = CURRENT_VALUE_IDS[name] ?: return
        val listener = newListener(name) ?: return
        try {
            val method = device.javaClass.methods.firstOrNull {
                it.name == "registerListener" && it.parameterTypes.size == 2 &&
                    it.parameterTypes[0].isInstance(listener) && it.parameterTypes[1] == IntArray::class.java
            } ?: return
            method.invoke(device, listener, ids)
            listeners += device to listener
            Log.i(TAG, "pedido de valores atuais em $name (${ids.size} IDs)")
        } catch (t: Throwable) {
            Log.i(TAG, "sem pedido de valores atuais em $name: ${t.message}")
        }
    }

    /** Registra um listener vazio em cada device carregado, só para receber os eventos. */
    fun register(devices: Map<String, Any?>) {
        for ((name, device) in devices) {
            if (device == null) continue
            val listener = try {
                newListener(name)
            } catch (t: Throwable) {
                Log.w(TAG, "sem classe de listener para $name: $t")
                null
            } ?: continue
            try {
                val method = device.javaClass.methods.first {
                    it.name == "registerListener" && it.parameterTypes.size == 1 &&
                        it.parameterTypes[0].isInstance(listener)
                }
                method.invoke(device, listener)
                listeners += device to listener
                registered += name
                Log.i(TAG, "listener registrado em $name")
                requestCurrent(name, device)
            } catch (t: Throwable) {
                Log.e(TAG, "falha ao registrar listener em $name", (t as? java.lang.reflect.InvocationTargetException)?.targetException ?: t)
            }
        }
    }

    /** Lê o logcat do próprio processo em segundo plano. */
    fun startLogReader() {
        if (reader != null) return
        reader = Thread({ readLoop() }, "EG-BydLog").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        reader?.interrupt()
        reader = null
        process?.destroy()
        process = null
        for ((device, listener) in listeners) {
            runCatching {
                device.javaClass.methods.first {
                    it.name == "unregisterListener" && it.parameterTypes.size == 1 &&
                        it.parameterTypes[0].isInstance(listener)
                }.invoke(device, listener)
            }
        }
        listeners.clear()
        registered.clear()
    }

    private fun readLoop() {
        try {
            // -T 1: só linhas novas a partir de agora.
            val p = Runtime.getRuntime().exec(
                arrayOf("logcat", "-v", "brief", "--pid=${Process.myPid()}", "-T", "1"),
            )
            process = p
            BufferedReader(InputStreamReader(p.inputStream)).useLines { lines ->
                for (line in lines) {
                    if (Thread.currentThread().isInterrupted) break
                    BydLogParser.parse(line)?.let { accept(Event(it.code, it.value, System.currentTimeMillis())) }
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "leitor de logcat parou", t)
        }
    }

    private fun accept(e: Event) {
        val previous = latest.put(e.code, e)
        // Cada código novo vai para o log, para mapearmos o que é cada um.
        if (previous == null) Log.i(TAG, "novo código ${e.code} = ${e.value}")
        if ((e.code.startsWith(PERSISTED_DEVICE) || e.code in PERSISTED_CODES) && previous?.value != e.value) {
            saved.edit().putString(e.code, "${e.value};${e.timestampMs}").apply()
        }
    }

    // Cada listener sobrescreve onDataChanged sem chamar super: a versão da BYD
    // chama getters protegidos por permissão (ex.: getChargingPower) e derruba o
    // app com SecurityException. O valor do evento já chega pelo log.
    private fun newListener(name: String): Any? = when (name) {
        "charging" -> object : AbsBYDAutoChargingListener() {
            override fun onDataChanged(eventType: Int, value: BYDAutoEventValue?) {}
        }
        "bodywork" -> object : AbsBYDAutoBodyworkListener() {
            override fun onDataChanged(eventType: Int, value: BYDAutoEventValue?) {}
        }
        "gearbox" -> object : AbsBYDAutoGearboxListener() {
            override fun onDataChanged(eventType: Int, value: BYDAutoEventValue?) {}
        }
        "instrument" -> object : AbsBYDAutoInstrumentListener() {
            override fun onDataChanged(eventType: Int, value: BYDAutoEventValue?) {}
        }
        "statistic" -> object : AbsBYDAutoStatisticListener() {
            override fun onDataChanged(eventType: Int, value: BYDAutoEventValue?) {}
        }
        "speed" -> object : AbsBYDAutoSpeedListener() {
            override fun onDataChanged(eventType: Int, value: BYDAutoEventValue?) {}
        }
        "ac" -> object : AbsBYDAutoAcListener() {
            override fun onDataChanged(eventType: Int, value: BYDAutoEventValue?) {}
        }
        else -> null
    }

    companion object {
        /** Últimos valores do bus ativo, para o JSON do painel mostrar os códigos crus. */
        @Volatile
        var current: Map<String, Event>? = null
            private set

        private const val TAG = "EG-BYD"
        private const val PERSISTED_DEVICE = "1014|"

        // A marcha só chega quando muda; salva para o app reabrir já com ela.
        // O mesmo para a temperatura externa.
        private val PERSISTED_CODES = setOf("1011|21200038", "1000|40400038", "1007|4a503040")

        // IDs (event_type) para pedir o valor atual ao registrar. São os que já
        // vimos chegar do Dolphin GS mais os equivalentes da tabela do Overdrive.
        private val CURRENT_VALUE_IDS = mapOf(
            "statistic" to intArrayOf(
                0x44700028, 0x4a50203e, 0x3d904010, 0x44600010, 0x44600030,
                0x44700010, 0x44700020, 0x44700038, 0x44400028, 0x44400030, 0x43a00028,
                0x4a505038, 0x4a502010, 0x44a00020, 0x34500018,
            ),
            "charging" to intArrayOf(
                0x44400008, 0x44400018, 0x27c00018, 0x44500020,
            ),
            "gearbox" to intArrayOf(0x21200038),
        )
    }
}
