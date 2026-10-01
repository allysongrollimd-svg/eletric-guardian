package br.com.eletricguardian.app.byd

import android.os.Build
import android.util.Log
import java.lang.reflect.Method

/**
 * Libera, para este processo, as APIs ocultas do framework (Android 9+). Parte
 * do SDK da BYD é marcada como oculta e a reflexão nela é negada sem isso.
 * Usa a reflexão "de dentro" de java.lang.Class, que o filtro não bloqueia.
 */
internal object HiddenApi {
    private const val TAG = "EG-BYD"

    @Volatile
    private var done = false

    @Synchronized
    fun exemptAll() {
        if (done || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
        done = true
        try {
            val forName = Class::class.java.getDeclaredMethod("forName", String::class.java)
            val getDeclaredMethod = Class::class.java.getDeclaredMethod(
                "getDeclaredMethod",
                String::class.java,
                arrayOf<Class<*>>()::class.java,
            )
            val vmRuntime = forName.invoke(null, "dalvik.system.VMRuntime") as Class<*>
            val getRuntime = getDeclaredMethod.invoke(vmRuntime, "getRuntime", null) as Method
            val setExemptions = getDeclaredMethod.invoke(
                vmRuntime,
                "setHiddenApiExemptions",
                arrayOf<Class<*>>(Array<String>::class.java),
            ) as Method
            setExemptions.invoke(getRuntime.invoke(null), arrayOf("L"))
            Log.i(TAG, "APIs ocultas liberadas para o processo")
        } catch (t: Throwable) {
            Log.w(TAG, "não consegui liberar APIs ocultas", t)
        }
    }
}
