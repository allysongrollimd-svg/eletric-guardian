package br.com.eletricguardian.app

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import br.com.eletricguardian.app.ui.DashboardView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : Activity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var dashboard: DashboardView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        dashboard = DashboardView(this)
        setContentView(dashboard)

        val missing = RUNTIME_PERMISSIONS.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), REQUEST_PERMISSIONS)
        MonitorService.start(this)

        scope.launch { Telemetry.state.collect { dashboard.render(it) } }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_PERMISSIONS && grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
            // GPS e módulos da BYD só abrem com as permissões já dadas.
            MonitorService.restart(this)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private companion object {
        const val REQUEST_PERMISSIONS = 1

        private val BYD_MODULES = listOf(
            "STATISTIC", "SPEED", "GEARBOX", "INSTRUMENT", "BODYWORK", "AC", "CHARGING",
            "ENERGY", "ENGINE", "TYRE", "LIGHT", "DOOR_LOCK", "SAFETY_BELT", "RADAR",
            "SETTING", "TIME", "PM2P5",
        )

        /**
         * Localização e as permissões *_COMMON da BYD. No DiLink 3.0 estas são
         * "dangerous" (o usuário libera na tela); as *_GET são de assinatura.
         */
        val RUNTIME_PERMISSIONS = listOf(Manifest.permission.ACCESS_FINE_LOCATION) +
            BYD_MODULES.map { "android.permission.BYDAUTO_${it}_COMMON" }
    }
}
