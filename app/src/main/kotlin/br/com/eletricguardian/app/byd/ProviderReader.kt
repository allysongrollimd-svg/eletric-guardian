package br.com.eletricguardian.app.byd

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.IBinder
import android.os.Parcel
import android.os.Parcelable
import android.os.Process
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * Lê o serviço de propriedades do próprio carro pelo provider com.byd.car.server
 * (ICarPropertyService). É como o Overdrive lê velocidade, marcha, odômetro, 12V,
 * temperatura externa etc. sem a assinatura da BYD, como app comum.
 *
 * O provider não devolve o binder numa query normal: é preciso (1) mandar no
 * Bundle de argumentos a chave android:query-arg-sql-selection-args com o nome
 * da interface ("com.byd.car.property.ICarPropertyService") — é assim que ele
 * sabe qual serviço entregar — e (2) pegar o provider direto por
 * getContentProviderExternal (API oculta, em processo), porque a central não
 * expõe esse provider para apps comuns pelo ContentResolver padrão.
 *
 * Nada de ADB, chave de plataforma ou app de sistema: é reflexão de API oculta
 * no próprio processo, igual ao que o Overdrive faz.
 */
class ProviderReader(context: Context) {

    private val appContext = context.applicationContext

    @Volatile
    private var service: IBinder? = null

    /** Último valor lido de cada propriedade, para diagnóstico/descoberta. */
    val resolved = ConcurrentHashMap<String, String>()

    /** Como chegamos ao serviço (para diagnóstico): provider, external, sm ou nenhum. */
    @Volatile
    var route: String = "nenhum"
        private set

    /** Bundle que diz ao provider qual serviço queremos. */
    private val queryArgs = Bundle().apply {
        putStringArray(QUERY_ARG_SELECTION_ARGS, arrayOf(INTERFACE))
    }

    private fun binder(): IBinder? {
        service?.takeIf { it.isBinderAlive }?.let { return it }
        service = fromContentResolver()?.also { route = "provider" }
            ?: fromExternalProvider()?.also { route = "external" }
            ?: fromServiceManager()?.also { route = "sm" }
        if (service == null) route = "nenhum"
        return service
    }

    /** Caminho 1: ContentResolver com o Bundle de selection-args. App comum. */
    private fun fromContentResolver(): IBinder? = try {
        appContext.contentResolver.query(PROVIDER_URI, null, queryArgs, null)
            ?.use(::binderFromCursor)
            .also { if (it == null) Log.i(TAG, "contentResolver sem binder") }
    } catch (t: Throwable) {
        Log.i(TAG, "contentResolver falhou: ${t.message}")
        null
    }

    /**
     * Caminho 2: pega o provider direto por getContentProviderExternal e chama
     * IContentProvider.query, como o Overdrive. Reflexão de API oculta, tudo no
     * próprio processo. Solta o provider com removeContentProviderExternal no fim.
     */
    private fun fromExternalProvider(): IBinder? {
        val authority = PROVIDER_URI.authority ?: return null
        val token = Binder()
        var am: Any? = null
        return try {
            am = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null)
            val amClass = am?.javaClass ?: return null
            val get = amClass.methods.firstOrNull {
                it.name == "getContentProviderExternal" && it.parameterTypes.size == 4 &&
                    it.parameterTypes[0] == String::class.java && it.parameterTypes[1] == Int::class.javaPrimitiveType &&
                    it.parameterTypes[2] == IBinder::class.java && it.parameterTypes[3] == String::class.java
            } ?: return null.also { Log.i(TAG, "sem getContentProviderExternal") }
            val userId = Process.myUid() / 100000
            val holder = get.invoke(am, authority, userId, token, TAG) ?: return null
            val provider = holder.javaClass.getField("provider").get(holder) ?: return null
            val pkg = if (Process.myUid() == SHELL_UID) "com.android.shell" else appContext.packageName
            binderFromCursor(queryProvider(provider, pkg) ?: return null)
        } catch (t: Throwable) {
            Log.i(TAG, "getContentProviderExternal falhou: ${t.message}")
            null
        } finally {
            runCatching {
                am?.javaClass?.methods?.firstOrNull {
                    it.name == "removeContentProviderExternal" && it.parameterTypes.size == 2 &&
                        it.parameterTypes[0] == String::class.java && it.parameterTypes[1] == IBinder::class.java
                }?.invoke(am, authority, token)
            }
        }
    }

    /** Invoca IContentProvider.query cobrindo as variações de assinatura por API. */
    private fun queryProvider(provider: Any, pkg: String): Cursor? {
        val method = provider.javaClass.methods.firstOrNull { m ->
            m.name == "query" && m.parameterTypes.let { p ->
                p.any { it == Uri::class.java } && p.any { it == Bundle::class.java } &&
                    p.any { it == Array<String>::class.java }
            }
        } ?: return null.also { Log.i(TAG, "sem IContentProvider.query") }
        var stringSlot = 0
        val args = method.parameterTypes.map { type ->
            when {
                type == Uri::class.java -> PROVIDER_URI
                type == Bundle::class.java -> queryArgs
                type == Array<String>::class.java -> null // projection
                type == String::class.java -> if (stringSlot++ == 0) pkg else null // callingPkg, attributionTag
                else -> null // ICancellationSignal
            }
        }.toTypedArray()
        return method.invoke(provider, *args) as? Cursor
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

    /** Pega o binder do serviço de propriedades no Bundle de extras do cursor. */
    private fun binderFromCursor(cursor: Cursor): IBinder? {
        val extras = cursor.extras ?: return null
        extras.classLoader = javaClass.classLoader
        val parcelable = extras.getParcelable<Parcelable>("binder") ?: return null
        return binderField(parcelable)
    }

    /** O binder vem embrulhado num Parcelable; pega o campo IBinder por reflexão. */
    private fun binderField(p: Parcelable): IBinder? {
        // O Overdrive procura primeiro um campo chamado "mBinder".
        runCatching {
            val f = p.javaClass.getDeclaredField("mBinder")
            f.isAccessible = true
            (f.get(p) as? IBinder)?.let { return it }
        }
        for (field in p.javaClass.declaredFields) {
            if (IBinder::class.java.isAssignableFrom(field.type)) {
                runCatching {
                    field.isAccessible = true
                    (field.get(p) as? IBinder)?.let { return it }
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
            Log.i(TAG, "varredura ignorada: provider indisponível (rota=$route)")
            return 0
        }
        Log.i(TAG, "varredura começando pela rota $route")
        var ok = 0
        for (name in names) {
            if (read(name) != null) ok++
        }
        Log.i(TAG, "varredura: $ok de ${names.size} propriedades com valor (rota=$route)")
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
        const val SHELL_UID = 2000
        const val QUERY_ARG_SELECTION_ARGS = "android:query-arg-sql-selection-args"
        val PROVIDER_URI: Uri = Uri.parse("content://com.byd.car.server.provider.CarServiceProvider")
        val SERVICE_NAMES = listOf("car_service", "byd_car_property", "car_property_service", "byd_car_service")
    }
}
