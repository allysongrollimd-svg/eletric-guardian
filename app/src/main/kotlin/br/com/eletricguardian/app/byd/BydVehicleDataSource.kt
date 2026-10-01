package br.com.eletricguardian.app.byd

import android.content.Context
import br.com.eletricguardian.core.BatteryState
import br.com.eletricguardian.core.BodyState
import br.com.eletricguardian.core.ChargingMode
import br.com.eletricguardian.core.ChargingState
import br.com.eletricguardian.core.ClimateState
import br.com.eletricguardian.core.EnergyCounters
import br.com.eletricguardian.core.PowerState
import br.com.eletricguardian.core.VehicleDataSource
import br.com.eletricguardian.core.VehicleIdentity
import br.com.eletricguardian.core.VehicleSnapshot

/**
 * Lê o carro pelo SDK da central BYD (android.hardware.bydauto.*), presente só
 * na central multimídia. Usa reflexão para compilar sem o SDK e para que cada
 * método ausente num modelo vire apenas um campo nulo.
 *
 * Métodos e escalas conferidos no Connect Pulse (BydSdkDataSource).
 */
class BydVehicleDataSource(context: Context) : VehicleDataSource {
    override val name = "byd-sdk"

    private val statistic = device(context, "statistic.BYDAutoStatisticDevice")
    private val speed = device(context, "speed.BYDAutoSpeedDevice")
    private val charging = device(context, "charging.BYDAutoChargingDevice")
    private val ac = device(context, "ac.BYDAutoAcDevice")
    private val body = device(context, "bodywork.BYDAutoBodyworkDevice")

    override fun isAvailable() = statistic != null || speed != null

    override fun read(nowMs: Long): VehicleSnapshot = VehicleSnapshot(
        timestampMs = nowMs,
        powerState = body.int("getPowerLevel")?.let(::mapPower),
        speedKmh = speed.int("getCurrentSpeed")?.toDouble(),
        acceleratorPct = speed.int("getAccelerateDeepness"),
        brakePct = speed.int("getBrakeDeepness"),
        odometerKm = statistic.int("getTotalMileageValue")?.toDouble(),
        battery = BatteryState(
            socPct = statistic.int("getElecPercentageValue")?.toDouble(),
            rangeKm = statistic.int("getElecDrivingRangeValue"),
            // Nível bruto do 12 V; escala ainda não confirmada no Dolphin GS.
            voltage12V = null,
        ),
        energy = EnergyCounters(
            totalConsumedKwh = statistic.number("getTotalElecConValue"),
            recentConsumptionKwhPer100Km = statistic.int("getLastElecConPHMValue")?.let { it / 10.0 },
            averageConsumptionKwhPer100Km = statistic.int("getTotalElecConPHMValue")?.let { it / 10.0 },
        ),
        charging = readCharging(),
        climate = ac?.let {
            ClimateState(
                acOn = ac.int("getAcStartState")?.let { it == 1 },
                cabinTempC = ac.int("getTemprature", 0)?.let { it / 2.0 },
            )
        },
        body = body?.let {
            BodyState(
                locked = readLocked(),
                anyDoorOpen = (0..5).mapNotNull { i -> body.int("getDoorState", i) }
                    .takeIf { it.isNotEmpty() }?.any { it == 1 },
                alarmArmed = body.int("getAlarmState")?.let { it == 1 },
            )
        },
        vehicle = VehicleIdentity(
            brand = "BYD",
            model = body.string("getAutoModelName"),
            vin = body.string("getAutoVIN"),
        ),
    )

    private fun readCharging(): ChargingState? {
        val work = charging.int("getChargerWorkState") ?: return null
        return ChargingState(
            charging = work == 1,
            plugConnected = charging.int("getChargingGunState")?.let { it == 1 },
            powerKw = charging.int("getChargingPower")?.let { it / 10.0 },
            mode = when (charging.int("getChargingMode")) {
                1 -> ChargingMode.AC
                2 -> ChargingMode.DC
                else -> ChargingMode.UNKNOWN
            },
            remainingMinutes = charging.int("getChargingRestTime"),
            targetSocPct = charging.int("getSOCTarget"),
        )
    }

    private fun readLocked(): Boolean? {
        val states = (0..3).map { body.int("getDoorLockStatus", it) ?: return null }
        // Convenção do Connect Pulse: 0 = porta travada. Confirmar no Dolphin GS.
        return states.all { it == 0 }
    }

    private fun mapPower(v: Int) = when (v) {
        0 -> PowerState.OFF
        1 -> PowerState.ACC
        2 -> PowerState.ON
        else -> PowerState.UNKNOWN
    }

    private companion object {
        fun device(context: Context, cls: String): Any? = try {
            Class.forName("android.hardware.bydauto.$cls")
                .getMethod("getInstance", Context::class.java)
                .invoke(null, context)
        } catch (t: Throwable) {
            null
        }

        fun Any?.call(method: String, vararg args: Int): Any? {
            if (this == null) return null
            return try {
                val types = Array<Class<*>>(args.size) { Int::class.javaPrimitiveType!! }
                javaClass.getMethod(method, *types).invoke(this, *args.toTypedArray())
            } catch (t: Throwable) {
                null
            }
        }

        fun Any?.int(method: String, vararg args: Int): Int? = (call(method, *args) as? Number)?.toInt()

        fun Any?.number(method: String): Double? = (call(method) as? Number)?.toDouble()

        fun Any?.string(method: String): String? = (call(method) as? String)?.takeIf { it.isNotBlank() }
    }
}
