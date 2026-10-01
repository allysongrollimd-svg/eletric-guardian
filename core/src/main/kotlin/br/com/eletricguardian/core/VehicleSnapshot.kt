package br.com.eletricguardian.core

/**
 * Leitura instantânea do carro. Todo campo é opcional: cada marca/modelo expõe
 * um subconjunto diferente, e a UI mostra "—" para o que não veio.
 */
data class VehicleSnapshot(
    val timestampMs: Long,
    val powerState: PowerState? = null,
    val gear: Gear? = null,
    val speedKmh: Double? = null,
    /** Potência no motor em kW. Positivo = consumindo, negativo = regenerando. */
    val powerKw: Double? = null,
    val acceleratorPct: Int? = null,
    val brakePct: Int? = null,
    val odometerKm: Double? = null,
    val battery: BatteryState = BatteryState(),
    val energy: EnergyCounters = EnergyCounters(),
    val charging: ChargingState? = null,
    val climate: ClimateState? = null,
    val body: BodyState? = null,
    val tyres: TyreState? = null,
    val location: GeoPoint? = null,
    val vehicle: VehicleIdentity? = null,
)

enum class PowerState { OFF, ACC, ON, UNKNOWN }

enum class Gear { P, R, N, D, UNKNOWN }

data class BatteryState(
    val socPct: Double? = null,
    val sohPct: Double? = null,
    val rangeKm: Int? = null,
    val packVoltageV: Double? = null,
    val cellVoltageMinV: Double? = null,
    val cellVoltageMaxV: Double? = null,
    val cellTempMinC: Double? = null,
    val cellTempMaxC: Double? = null,
    val voltage12V: Double? = null,
)

/** Contadores acumulados do carro, usados para calcular consumo por viagem. */
data class EnergyCounters(
    /** Energia elétrica total consumida desde a fabricação, em kWh. */
    val totalConsumedKwh: Double? = null,
    val recentConsumptionKwhPer100Km: Double? = null,
    val averageConsumptionKwhPer100Km: Double? = null,
)

data class ChargingState(
    val charging: Boolean,
    val plugConnected: Boolean? = null,
    val powerKw: Double? = null,
    val mode: ChargingMode = ChargingMode.UNKNOWN,
    val remainingMinutes: Int? = null,
    val targetSocPct: Int? = null,
    /** Energia acumulada na sessão de carga atual, em kWh. */
    val energyAddedKwh: Double? = null,
)

enum class ChargingMode { AC, DC, UNKNOWN }

data class ClimateState(
    val acOn: Boolean? = null,
    val cabinTempC: Double? = null,
    val outsideTempC: Double? = null,
)

data class BodyState(
    val locked: Boolean? = null,
    val anyDoorOpen: Boolean? = null,
    val alarmArmed: Boolean? = null,
)

data class TyreState(
    val pressureFrontLeft: Double? = null,
    val pressureFrontRight: Double? = null,
    val pressureRearLeft: Double? = null,
    val pressureRearRight: Double? = null,
)

data class GeoPoint(
    val latitude: Double,
    val longitude: Double,
    val altitudeM: Double? = null,
    val bearingDeg: Double? = null,
    val accuracyM: Double? = null,
    val timestampMs: Long,
)

data class VehicleIdentity(
    val brand: String? = null,
    val model: String? = null,
    val vin: String? = null,
)
