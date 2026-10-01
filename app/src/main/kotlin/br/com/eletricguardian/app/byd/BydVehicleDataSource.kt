package br.com.eletricguardian.app.byd

import android.content.Context
import android.util.Log
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
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.ConcurrentHashMap

/**
 * Lê o carro pelo SDK da central BYD (android.hardware.bydauto.*), presente só
 * na central multimídia. Usa reflexão para compilar sem o SDK e para que cada
 * método ausente num modelo vire apenas um campo nulo.
 *
 * Não depende das permissões BYDAUTO_* (que são de assinatura): o Electro lê
 * esses mesmos devices sem elas no Dolphin GS. Criar no thread principal, pois
 * os devices podem criar Handlers no construtor.
 *
 * Toda falha é registrada uma vez no logcat com a tag EG-BYD.
 */
class BydVehicleDataSource(context: Context) : VehicleDataSource {
    override val name = "byd-sdk"

    private val failures = ConcurrentHashMap<String, String>()

    init {
        HiddenApi.exemptAll()
    }

    private val statistic = device(context, "statistic.BYDAutoStatisticDevice")
    private val speed = device(context, "speed.BYDAutoSpeedDevice")
    private val charging = device(context, "charging.BYDAutoChargingDevice")
    private val ac = device(context, "ac.BYDAutoAcDevice")
    private val body = device(context, "bodywork.BYDAutoBodyworkDevice")

    override fun isAvailable() = listOf(statistic, speed, charging, body).any { it != null }

    /** Resumo do que carregou e do que falhou, para a tela de diagnóstico. */
    fun diagnostics(): String {
        val loaded = listOf(
            "statistic" to statistic, "speed" to speed, "charging" to charging, "ac" to ac, "body" to body,
        ).joinToString(" ") { (n, d) -> if (d != null) "$n✓" else "$n✗" }
        val errors = failures.entries.take(4).joinToString("\n") { "${it.key}: ${it.value}" }
        return if (errors.isEmpty()) loaded else "$loaded\n$errors"
    }

    override fun read(nowMs: Long): VehicleSnapshot = VehicleSnapshot(
        timestampMs = nowMs,
        powerState = body.int("getPowerLevel")?.let(::mapPower),
        speedKmh = speed.number("getCurrentSpeed"),
        acceleratorPct = speed.int("getAccelerateDeepness"),
        brakePct = speed.int("getBrakeDeepness"),
        odometerKm = statistic.number("getTotalMileageValue"),
        battery = BatteryState(
            socPct = statistic.number("getElecPercentageValue"),
            rangeKm = statistic.int("getElecDrivingRangeValue"),
        ),
        energy = EnergyCounters(
            totalConsumedKwh = statistic.number("getTotalElecConValue"),
            recentConsumptionKwhPer100Km = statistic.number("getLastElecConPHMValue")?.let { it / 10.0 },
            averageConsumptionKwhPer100Km = statistic.number("getTotalElecConPHMValue")?.let { it / 10.0 },
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
        // O Electro usa getChargerState no DiLink 3; o Connect Pulse, getChargerWorkState.
        val work = charging.int("getChargerState") ?: charging.int("getChargerWorkState") ?: return null
        val gun = charging.int("getChargingGunState")
        return ChargingState(
            charging = work == 1,
            // Dolphin GS reportou 2 com o carregador conectado; o Connect Pulse tratava 1 como conectado.
            plugConnected = gun?.let { it == 1 || it == 2 },
            powerKw = charging.number("getChargingPower")?.let { it / 10.0 },
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

    private fun device(context: Context, cls: String): Any? = try {
        val d = Class.forName("android.hardware.bydauto.$cls")
            .getMethod("getInstance", Context::class.java)
            .invoke(null, context)
        Log.i(TAG, "$cls carregado: ${d?.javaClass?.name}")
        d
    } catch (t: Throwable) {
        fail(cls, t)
        null
    }

    private fun Any?.call(method: String, vararg args: Int): Any? {
        if (this == null) return null
        val key = "${javaClass.simpleName}.$method"
        return try {
            val types = Array<Class<*>>(args.size) { Int::class.javaPrimitiveType!! }
            javaClass.getMethod(method, *types).invoke(this, *args.toTypedArray())
        } catch (t: Throwable) {
            fail(key, t)
            null
        }
    }

    private fun fail(key: String, t: Throwable) {
        val cause = (t as? InvocationTargetException)?.targetException ?: t
        val msg = "${cause.javaClass.simpleName}: ${cause.message}"
        if (failures.putIfAbsent(key, msg) == null) Log.e(TAG, "falha em $key", cause)
    }

    private fun Any?.int(method: String, vararg args: Int): Int? = (call(method, *args) as? Number)?.toInt()

    private fun Any?.number(method: String): Double? = (call(method) as? Number)?.toDouble()

    private fun Any?.string(method: String): String? = (call(method) as? String)?.takeIf { it.isNotBlank() }

    private companion object {
        const val TAG = "EG-BYD"
    }
}
