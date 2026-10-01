package br.com.eletricguardian.app.byd

import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Impede que uma SecurityException lançada pelo SDK da BYD dentro de um
 * callback derrube o app. Os callbacks rodam no looper principal; aqui o loop
 * é reiniciado depois de cada exceção do SDK. Qualquer outra exceção segue o
 * caminho normal (o app fecha e o erro aparece no log).
 */
object MainLooperGuard {
    private const val TAG = "EG-BYD"

    @Volatile
    private var installed = false
    private var swallowed = 0

    fun install() {
        if (installed) return
        installed = true
        Handler(Looper.getMainLooper()).post {
            while (true) {
                try {
                    Looper.loop()
                } catch (t: Throwable) {
                    if (!fromBydSdk(t)) throw t
                    swallowed++
                    // Registra as primeiras e depois só de vez em quando.
                    if (swallowed <= 5 || swallowed % 100 == 0) {
                        Log.w(TAG, "SDK da BYD lançou no callback (ignorado, total $swallowed)", t)
                    }
                }
            }
        }
    }

    private fun fromBydSdk(t: Throwable): Boolean =
        t is SecurityException && t.stackTrace.any { it.className.startsWith("android.hardware.bydauto") }
}
