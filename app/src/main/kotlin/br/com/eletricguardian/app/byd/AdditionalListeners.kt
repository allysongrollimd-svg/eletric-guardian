package br.com.eletricguardian.app.byd

import android.util.Log
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy

/**
 * Listeners adicionais para capturar todos os campos que o Overdrive consegue ler.
 * Usa reflexão completa para compilar sem o SDK da BYD. Os listeners são criados
 * dinamicamente via Proxy, igual ao padrão do BydEventBus.
 */
object AdditionalListeners {
    private const val TAG = "EG-AdditionalListeners"

    fun registerTyreListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return register(
            device = device,
            listenerClass = "android.hardware.bydauto.tyre.AbsBYDAutoTyreListener",
            callback = callback,
            name = "Tyre"
        )
    }

    fun registerEngineListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return register(
            device = device,
            listenerClass = "android.hardware.bydauto.engine.AbsBYDAutoEngineListener",
            callback = callback,
            name = "Engine"
        )
    }

    fun registerEnergyListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return register(
            device = device,
            listenerClass = "android.hardware.bydauto.energy.AbsBYDAutoEnergyListener",
            callback = callback,
            name = "Energy"
        )
    }

    fun registerInstrumentListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return register(
            device = device,
            listenerClass = "android.hardware.bydauto.instrument.AbsBYDAutoInstrumentListener",
            callback = callback,
            name = "Instrument"
        )
    }

    private fun register(
        device: Any,
        listenerClass: String,
        callback: (String, Array<out Any?>) -> Unit,
        name: String
    ): Boolean = try {
        val cls = Class.forName(listenerClass)
        val listener = Proxy.newProxyInstance(
            cls.classLoader,
            arrayOf(cls),
            InvocationHandler { _, method, args ->
                callback(method.name, args ?: emptyArray())
                null
            }
        )
        val registerMethod = device.javaClass.methods.first {
            it.name == "registerListener" && it.parameterTypes.size == 1 &&
                it.parameterTypes[0].isInstance(listener)
        }
        registerMethod.invoke(device, listener)
        Log.i(TAG, "$name listener registrado")
        true
    } catch (e: ClassNotFoundException) {
        Log.d(TAG, "$name listener: classe não existe neste firmware")
        false
    } catch (e: NoSuchElementException) {
        Log.d(TAG, "$name listener: método registerListener não encontrado")
        false
    } catch (t: Throwable) {
        Log.d(TAG, "$name listener: falha ao registrar (${t.javaClass.simpleName}: ${t.message})")
        false
    }
}
