package br.com.eletricguardian.core

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

data class TripSummary(
    val startMs: Long,
    val endMs: Long,
    val distanceKm: Double,
    val socStartPct: Double?,
    val socEndPct: Double?,
    /** Energia gasta na viagem, pelo contador do carro. Nulo se o carro não expõe. */
    val energyKwh: Double?,
    val maxSpeedKmh: Double,
    val start: GeoPoint?,
    val end: GeoPoint?,
) {
    val durationMs: Long get() = endMs - startMs

    val consumptionKwhPer100Km: Double?
        get() = if (energyKwh != null && distanceKm >= 0.1) energyKwh / distanceKm * 100 else null

    val averageSpeedKmh: Double
        get() = if (durationMs > 0) distanceKm / (durationMs / 3_600_000.0) else 0.0
}

/**
 * Detecta viagens a partir da sequência de leituras.
 *
 * Abre uma viagem quando o carro se move ligado; fecha quando é desligado ou
 * fica parado por [idleCloseMs]. A distância vem do odômetro quando existe,
 * senão do GPS.
 */
class TripTracker(private val idleCloseMs: Long = 5 * 60_000L) {

    private var open: Accumulator? = null

    val inProgress: Boolean get() = open != null

    /** Processa uma leitura. Retorna o resumo quando uma viagem acaba de fechar. */
    fun onSnapshot(s: VehicleSnapshot): TripSummary? {
        val moving = (s.speedKmh ?: 0.0) > 1.0
        val off = s.powerState == PowerState.OFF || s.powerState == PowerState.ACC
        val current = open

        if (current == null) {
            if (moving && !off) open = Accumulator(s)
            return null
        }

        if (off) return close(current)
        current.add(s, moving)
        if (s.timestampMs - current.lastMovingMs >= idleCloseMs) return close(current)
        return null
    }

    /** Fecha a viagem aberta (ex.: o serviço vai parar). */
    fun flush(): TripSummary? = open?.let { close(it) }

    private fun close(acc: Accumulator): TripSummary {
        open = null
        return acc.summary()
    }

    private class Accumulator(first: VehicleSnapshot) {
        val startMs = first.timestampMs
        var lastMovingMs = first.timestampMs
        var last = first
        val odoStart = first.odometerKm
        val energyStart = first.energy.totalConsumedKwh
        val socStart = first.battery.socPct
        val startPoint = first.location
        var lastPoint = first.location
        var gpsKm = 0.0
        var maxSpeed = first.speedKmh ?: 0.0

        fun add(s: VehicleSnapshot, moving: Boolean) {
            if (moving) lastMovingMs = s.timestampMs
            maxSpeed = max(maxSpeed, s.speedKmh ?: 0.0)
            val p = s.location
            val prev = lastPoint
            if (p != null) {
                if (prev != null) gpsKm += haversineKm(prev, p)
                lastPoint = p
            }
            last = s
        }

        fun summary(): TripSummary {
            val odoEnd = last.odometerKm
            val odoKm = if (odoStart != null && odoEnd != null && odoEnd >= odoStart) odoEnd - odoStart else null
            val energyEnd = last.energy.totalConsumedKwh
            val energy = if (energyStart != null && energyEnd != null && energyEnd >= energyStart) {
                energyEnd - energyStart
            } else {
                null
            }
            return TripSummary(
                startMs = startMs,
                // Para viagens fechadas por inatividade, o fim é a última vez em movimento.
                endMs = minOf(last.timestampMs, lastMovingMs).coerceAtLeast(startMs),
                distanceKm = odoKm ?: gpsKm,
                socStartPct = socStart,
                socEndPct = last.battery.socPct,
                energyKwh = energy,
                maxSpeedKmh = maxSpeed,
                start = startPoint,
                end = lastPoint,
            )
        }
    }
}

fun haversineKm(a: GeoPoint, b: GeoPoint): Double {
    val r = 6371.0
    val dLat = Math.toRadians(b.latitude - a.latitude)
    val dLon = Math.toRadians(b.longitude - a.longitude)
    val h = sin(dLat / 2).pow(2) +
        cos(Math.toRadians(a.latitude)) * cos(Math.toRadians(b.latitude)) * sin(dLon / 2).pow(2)
    return 2 * r * asin(sqrt(h))
}
