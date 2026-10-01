package br.com.eletricguardian.app.byd

import android.hardware.bydauto.ac.AbsBYDAutoAcListener
import android.hardware.bydauto.bodywork.AbsBYDAutoBodyworkListener
import android.hardware.bydauto.charging.AbsBYDAutoChargingListener
import android.hardware.bydauto.gearbox.AbsBYDAutoGearboxListener
import android.hardware.bydauto.instrument.AbsBYDAutoInstrumentListener
import android.hardware.bydauto.speed.AbsBYDAutoSpeedListener
import android.hardware.bydauto.statistic.AbsBYDAutoStatisticListener
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
 */
class BydEventBus {

    data class Event(val code: String, val value: Double, val timestampMs: Long)

    /** Último valor de cada código "deviceType|eventType" (event_type em hex minúsculo). */
    val latest = ConcurrentHashMap<String, Event>()

    private val registered = ConcurrentHashMap.newKeySet<String>()
    private val listeners = mutableListOf<Pair<Any, Any>>()

    @Volatile
    private var reader: Thread? = null

    @Volatile
    private var process: java.lang.Process? = null

    fun registeredSummary(): String = registered.sorted().joinToString(" ")

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
    }

    private fun newListener(name: String): Any? = when (name) {
        "charging" -> object : AbsBYDAutoChargingListener() {}
        "bodywork" -> object : AbsBYDAutoBodyworkListener() {}
        "gearbox" -> object : AbsBYDAutoGearboxListener() {}
        "instrument" -> object : AbsBYDAutoInstrumentListener() {}
        "statistic" -> object : AbsBYDAutoStatisticListener() {}
        "speed" -> object : AbsBYDAutoSpeedListener() {}
        "ac" -> object : AbsBYDAutoAcListener() {}
        else -> null
    }

    private companion object {
        const val TAG = "EG-BYD"
    }
}
