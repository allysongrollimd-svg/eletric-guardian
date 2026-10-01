package br.com.eletricguardian.app.byd

import android.content.Context
import android.net.Uri
import android.os.IBinder
import android.os.Parcel
import android.os.Parcelable
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * Lê o serviço de propriedades do próprio carro pelo provider com.byd.car.server
 * (ICarPropertyService). É como o Overdrive lê velocidade, marcha, odômetro, 12V,
 * temperatura externa etc. sem a assinatura da BYD: a permissão
 * com.byd.car.server.PROVIDER é normal (basta declarar no manifesto) e o provider
 * entrega um binder do serviço de propriedades.
 *
 * Nada de ADB, chave de plataforma ou app de sistema: é IPC comum de Android.
 */
class ProviderReader(context: Context) {

    private val appContext = context.applicationContext

    @Volatile
    private var service: IBinder? = null

    /** Último valor lido de cada propriedade, para diagnóstico/descoberta. */
    val resolved = ConcurrentHashMap<String, String>()

    private fun binder(): IBinder? {
        service?.takeIf { it.isBinderAlive }?.let { return it }
        service = fromProvider() ?: fromServiceManager()
        return service
    }

    /** Pega o binder do serviço de propriedades no Bundle de extras do cursor. */
    private fun fromProvider(): IBinder? = try {
        appContext.contentResolver.query(PROVIDER_URI, null, null, null, null)?.use { cursor ->
            val extras = cursor.extras
            extras?.classLoader = javaClass.classLoader
            val parcelable = extras?.getParcelable<Parcelable>("binder")
            parcelable?.let(::binderField)
        }
    } catch (t: Throwable) {
        Log.i(TAG, "provider não respondeu: ${t.message}")
        null
    }

    private fun fromServiceManager(): IBinder? = try {
        val sm = Class.forName("android.os.ServiceManager")
        val get = sm.getMethod("getService", String::class.java)
        SERVICE_NAMES.asSequence()
            .mapNotNull { get.invoke(null, it) as? IBinder }
            .firstOrNull { it.isBinderAlive }
    } catch (t: Throwable) {
        null
    }

    /** O binder vem embrulhado num Parcelable; pega o campo IBinder por reflexão. */
    private fun binderField(p: Parcelable): IBinder? {
        for (field in p.javaClass.declaredFields) {
            if (IBinder::class.java.isAssignableFrom(field.type)) {
                return try {
                    field.isAccessible = true
                    field.get(p) as? IBinder
                } catch (t: Throwable) {
                    null
                }
            }
        }
        return null
    }

    /**
     * Lê uma propriedade pelo nome (ex.: "Statistic.STATISTIC_TOTAL_MILEAGE").
     * Transação 2 do ICarPropertyService, igual ao Overdrive.
     */
    fun read(name: String): Any? {
        val b = binder() ?: return null
        val req = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            req.writeInterfaceToken(INTERFACE)
            req.writeString(name)
            b.transact(TRANSACTION_GET, req, reply, 0)
            reply.readException()
            if (reply.readInt() == 0) return null
            // status (code, msg) via writeParcelable: nome da classe + campos
            if (reply.readString() != null) {
                reply.readInt() // código
                reply.readString() // mensagem
            }
            // valor (CarPropertyValue): nome da classe + key, id, tipo, valor
            if (reply.readString() == null) return null
            reply.readString() // key
            reply.readString() // id
            val value = readValue(reply)
            if (value != null) resolved[name] = value.toString()
            value
        } catch (t: Throwable) {
            Log.i(TAG, "falha lendo $name: ${t.message}")
            null
        } finally {
            reply.recycle()
            req.recycle()
        }
    }

    /** Valor tipado, no mesmo formato que o Overdrive lê (CarPropertyValue). */
    private fun readValue(p: Parcel): Any? = when (p.readString()) {
        "java.lang.String" -> p.readString()
        "java.lang.Integer" -> p.readInt()
        "java.lang.Long" -> p.readLong()
        "java.lang.Float" -> p.readFloat()
        "java.lang.Double" -> p.readDouble()
        "java.lang.Boolean" -> p.readInt() != 0
        else -> null
    }

    fun readD(name: String): Double? = when (val v = read(name)) {
        is Number -> v.toDouble()
        is Boolean -> if (v) 1.0 else 0.0
        else -> null
    }

    fun isAvailable(): Boolean = binder() != null

    /**
     * Varredura de descoberta: tenta ler cada nome e guarda os que responderam
     * com valor. Roda uma vez (carro parado) para sabermos, no carro real, quais
     * propriedades o provider entrega e com que valor — daí calibramos os cards.
     */
    fun sweep(names: List<String>): Int {
        if (binder() == null) {
            Log.i(TAG, "varredura ignorada: provider indisponível")
            return 0
        }
        var ok = 0
        for (name in names) {
            if (read(name) != null) ok++
        }
        Log.i(TAG, "varredura: $ok de ${names.size} propriedades com valor")
        Log.i(TAG, "varredura valores: ${diagnostics()}")
        return ok
    }

    fun diagnostics(): String =
        if (resolved.isEmpty()) {
            "provider sem valores"
        } else {
            resolved.entries.sortedBy { it.key }.joinToString("  ") { "${it.key}=${it.value}" }
        }

    private companion object {
        const val TAG = "EG-Provider"
        const val INTERFACE = "com.byd.car.property.ICarPropertyService"
        const val TRANSACTION_GET = 2
        val PROVIDER_URI: Uri = Uri.parse("content://com.byd.car.server.provider.CarServiceProvider")
        val SERVICE_NAMES = listOf("car_service", "byd_car_property", "car_property_service", "byd_car_service")
    }
}
