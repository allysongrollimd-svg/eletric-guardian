package br.com.eletricguardian.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import br.com.eletricguardian.app.byd.BydVehicleDataSource
import br.com.eletricguardian.app.byd.MainLooperGuard
import br.com.eletricguardian.app.cloud.CloudUploader
import br.com.eletricguardian.app.location.LocationSource
import br.com.eletricguardian.app.web.WebServer
import br.com.eletricguardian.core.MockVehicleDataSource
import br.com.eletricguardian.core.TripTracker
import br.com.eletricguardian.core.VehicleDataSource
import br.com.eletricguardian.core.pickDataSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Serviço em primeiro plano que lê o carro a cada segundo, junta o GPS e
 * detecta viagens. Sobe no boot e fica rodando enquanto a central estiver ligada.
 */
class MonitorService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loop: Job? = null
    private lateinit var location: LocationSource
    private var source: VehicleDataSource? = null
    private lateinit var candidates: List<VehicleDataSource>
    private val trips = TripTracker()
    private lateinit var web: WebServer
    private lateinit var cloud: CloudUploader

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        MainLooperGuard.install()
        startForeground(NOTIFICATION_ID, buildNotification())
        location = LocationSource(this)
        // Criadas aqui, no thread principal: os devices da BYD podem criar Handlers.
        candidates = buildList {
            add(BydVehicleDataSource(applicationContext))
            if (BuildConfig.DEBUG) add(MockVehicleDataSource(System.currentTimeMillis()))
        }
        web = WebServer(applicationContext)
        web.start()
        Telemetry.update { it.copy(webUrl = web.url()) }
        cloud = CloudUploader(applicationContext)
        cloud.start(scope)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        location.start()
        if (loop == null) loop = scope.launch { runLoop() }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        web.stop()
        cloud.stop()
        location.stop()
        trips.flush()?.let { trip -> Telemetry.update { it.copy(lastTrip = trip, tripInProgress = false) } }
        source?.close()
        super.onDestroy()
    }

    private suspend fun CoroutineScope.runLoop() {
        Log.i(TAG, "Eletric Guardian ${BuildConfig.VERSION_NAME} (${BuildConfig.COMMIT})")
        val picked = pickDataSource(candidates)
        source = picked
        Telemetry.update { it.copy(sourceName = picked?.name) }
        if (picked == null) {
            Log.w(TAG, "nenhuma fonte de dados disponível neste aparelho")
            return
        }

        var ticks = 0L
        while (isActive) {
            val now = System.currentTimeMillis()
            val snapshot = runCatching { picked.read(now) }
                .onFailure { Log.w(TAG, "falha lendo ${picked.name}", it) }
                .getOrNull()
                // O módulo de velocidade da BYD é barrado; sem ele, usa a do GPS.
                ?.let { it.copy(location = location.last, speedKmh = it.speedKmh ?: location.speedKmh(now)) }
            if (snapshot != null) {
                if (ticks++ % LOG_EVERY == 0L) {
                    Log.i(TAG, "leitura: $snapshot")
                    (picked as? BydVehicleDataSource)?.let { Log.i(TAG, "diagnóstico: ${it.diagnostics().replace("\n", " | ")}") }
                }
                val finished = trips.onSnapshot(snapshot)
                val diag = (picked as? BydVehicleDataSource)?.diagnostics()
                Telemetry.update {
                    it.copy(
                        snapshot = snapshot,
                        diagnostics = diag,
                        tripInProgress = trips.inProgress,
                        lastTrip = finished ?: it.lastTrip,
                    )
                }
            }
            delay(POLL_MS)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Monitoramento", NotificationManager.IMPORTANCE_LOW),
            )
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return builder
            .setContentTitle("Eletric Guardian")
            .setContentText("Monitorando o veículo")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "EG-Monitor"
        private const val CHANNEL_ID = "monitor"
        private const val NOTIFICATION_ID = 1
        private const val POLL_MS = 1000L
        private const val LOG_EVERY = 30L

        fun start(context: Context) {
            val intent = Intent(context, MonitorService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Recria o serviço para os módulos da BYD abrirem com as permissões novas. */
        fun restart(context: Context) {
            context.stopService(Intent(context, MonitorService::class.java))
            start(context)
        }
    }
}
