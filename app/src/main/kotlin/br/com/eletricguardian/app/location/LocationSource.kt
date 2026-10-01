package br.com.eletricguardian.app.location

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import br.com.eletricguardian.core.GeoPoint

/** GPS da central. Guarda a última posição para ser anexada a cada leitura. */
class LocationSource(private val context: Context) {

    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    @Volatile
    var last: GeoPoint? = null
        private set

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            last = location.toGeoPoint()
        }

        @Deprecated("Exigido em APIs antigas")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

        override fun onProviderEnabled(provider: String) {}

        override fun onProviderDisabled(provider: String) {}
    }

    fun hasPermission(): Boolean =
        context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private var started = false

    /** Começa a ouvir o GPS. Pode ser chamado de novo depois que a permissão for dada. */
    @SuppressLint("MissingPermission")
    fun start(minIntervalMs: Long = 1000L) {
        if (started || !hasPermission()) return
        started = true
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (!manager.allProviders.contains(provider)) continue
            runCatching {
                manager.getLastKnownLocation(provider)?.let { if (last == null) last = it.toGeoPoint() }
                manager.requestLocationUpdates(provider, minIntervalMs, 0f, listener, Looper.getMainLooper())
            }
        }
    }

    fun stop() {
        started = false
        runCatching { manager.removeUpdates(listener) }
    }

    private fun Location.toGeoPoint() = GeoPoint(
        latitude = latitude,
        longitude = longitude,
        altitudeM = if (hasAltitude()) altitude else null,
        bearingDeg = if (hasBearing()) bearing.toDouble() else null,
        accuracyM = if (hasAccuracy()) accuracy.toDouble() else null,
        timestampMs = time,
    )
}
