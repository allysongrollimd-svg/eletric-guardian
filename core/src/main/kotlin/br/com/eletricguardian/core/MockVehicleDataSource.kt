package br.com.eletricguardian.core

import kotlin.math.max
import kotlin.math.sin

/**
 * Fonte simulada para rodar o app fora do carro (emulador, celular). Gera uma
 * volta de ~10 minutos: anda, regenera, para.
 */
class MockVehicleDataSource(private val startMs: Long = 0L) : VehicleDataSource {
    override val name = "simulado"

    private var odometerKm = 12_345.0
    private var consumedKwh = 2_100.0
    private var socPct = 80.0
    private var lastMs: Long? = null

    override fun isAvailable() = true

    override fun read(nowMs: Long): VehicleSnapshot {
        val t = (nowMs - startMs) / 1000.0
        val speed = max(0.0, 60 * sin(t / 95.0) + 20)
        val power = speed * 0.25 + 15 * sin(t / 7.0)

        val dtH = lastMs?.let { (nowMs - it) / 3_600_000.0 } ?: 0.0
        lastMs = nowMs
        odometerKm += speed * dtH
        val usedKwh = max(0.0, power) * dtH
        consumedKwh += usedKwh
        socPct = max(5.0, socPct - usedKwh / 44.9 * 100)

        return VehicleSnapshot(
            timestampMs = nowMs,
            powerState = PowerState.ON,
            gear = if (speed > 0.5) Gear.D else Gear.P,
            speedKmh = speed,
            powerKw = power,
            odometerKm = odometerKm,
            battery = BatteryState(
                socPct = socPct,
                sohPct = 98.0,
                rangeKm = (socPct * 4.2).toInt(),
                voltage12V = 13.8,
            ),
            energy = EnergyCounters(totalConsumedKwh = consumedKwh),
            climate = ClimateState(acOn = true, cabinTempC = 22.0, outsideTempC = 29.0),
            body = BodyState(locked = false, anyDoorOpen = false),
            vehicle = VehicleIdentity(brand = "Simulado", model = "Dolphin GS"),
        )
    }
}
