package br.com.eletricguardian.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Sobe o monitoramento quando a central liga. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        MonitorService.start(context)
    }
}
