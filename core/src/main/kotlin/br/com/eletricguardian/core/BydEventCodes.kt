package br.com.eletricguardian.core

import kotlin.math.abs

/**
 * Tradução dos códigos de evento do SDK da BYD ("deviceType|eventType") para
 * os campos do [VehicleSnapshot].
 *
 * Os marcados "Dolphin GS" foram observados no carro de teste (DiLink 3.0)
 * carregando em AC (o app da BYD mostrava 90% e 367 km); os marcados "Connect Pulse" vêm do
 * app de referência e ainda não apareceram no Dolphin GS.
 */
object BydEventCodes {
    /** Dolphin GS: 894 → 913 (décimos de %) carregando; o app da BYD mostrava 90%. */
    const val SOC_TENTHS = "1014|44700028"

    /** Connect Pulse. */
    const val SOC_ALT = "1014|44400030"

    /** Connect Pulse; Overdrive: STATISTIC_ELEC_PERCENTAGE. */
    const val SOC_FINE_ALT = "1014|4a505038"

    // Nomes abaixo marcados "Overdrive" vêm da tabela de IDs do app Overdrive
    // (STATISTIC_*); escala ainda a confirmar no Dolphin GS.

    /** Overdrive: STATISTIC_TOTAL_MILEAGE. */
    const val ODOMETER = "1014|4a502010"

    /** Overdrive: STATISTIC_BATTERY_HEALTHY_INDEX. */
    const val SOH = "1014|44400028"

    /** Overdrive: STATISTIC_LOWEST_BATTERY_TEMP. */
    const val BATTERY_TEMP_MIN = "1014|44700010"

    /** Overdrive: STATISTIC_HIGHEST_BATTERY_TEMP. */
    const val BATTERY_TEMP_MAX = "1014|44700020"

    /** Overdrive: STATISTIC_AVERAGE_BATTERY_TEMP. */
    const val BATTERY_TEMP_AVG = "1014|44700038"

    /**
     * Overdrive: STATISTIC_ELEC_DRIVING_RANGE. Dolphin GS: 364 → 372 (km)
     * subindo com a carga; o app da BYD mostrava 367.
     * O código 1014|3d904010 traz o mesmo valor.
     */
    const val RANGE = "1014|4a50203e"

    /** Overdrive: STATISTIC_LOWEST_BATTERY_VOLTAGE. Dolphin GS: 3377..3382 (mV). */
    const val CELL_VOLTAGE_MIN = "1014|44600010"

    /** Overdrive: STATISTIC_HIGHEST_BATTERY_VOLTAGE. Dolphin GS: 3384..3391 (mV). */
    const val CELL_VOLTAGE_MAX = "1014|44600030"

    /** Dolphin GS: 351 (V) carregando. O Connect Pulse usava este código como autonomia. */
    const val CHARGE_VOLTAGE = "1009|44400008"

    /** Dolphin GS: -16,8 (A, negativo = entrando na bateria). O Connect Pulse usava como velocidade. */
    const val CHARGE_CURRENT = "1009|44400018"

    /** Overdrive: CHARGING_CHARGE_CAPACITY. Dolphin GS: 16,0 → 17,5 subindo durante a carga (kWh). */
    const val CHARGE_ENERGY = "1009|27c00018"

    /**
     * Dolphin GS, candidato: 50 → 43 → 41 caindo durante a carga, quando o app
     * da BYD mostrava 47 min e o Electro 44 min restantes.
     */
    const val CHARGE_REMAINING_MIN = "1009|44500020"

    /** Corrente abaixo disso (A, em módulo) conta como "não carregando". */
    private const val CHARGING_CURRENT_MIN_A = 0.5

    /** Tensão de carga mínima (V) para a corrente contar como carga. */
    private const val CHARGING_VOLTAGE_MIN_V = 50.0

    fun socPct(ev: (String) -> Double?): Double? =
        ev(SOC_TENTHS)?.let { it / 10 }?.takeIf { it in 0.0..100.0 } ?: ev(SOC_FINE_ALT) ?: ev(SOC_ALT)

    fun sohPct(ev: (String) -> Double?): Double? = ev(SOH)?.takeIf { it in 1.0..100.0 }

    /** Temperatura da bateria (°C): média, ou a máxima se a média não veio. */
    fun batteryTempC(ev: (String) -> Double?): Double? = ev(BATTERY_TEMP_AVG) ?: ev(BATTERY_TEMP_MAX)

    fun rangeKm(ev: (String) -> Double?): Int? = ev(RANGE)?.toInt()

    fun cellVoltageMinV(ev: (String) -> Double?): Double? = ev(CELL_VOLTAGE_MIN)?.let { it / 1000 }

    fun cellVoltageMaxV(ev: (String) -> Double?): Double? = ev(CELL_VOLTAGE_MAX)?.let { it / 1000 }

    /** Estado da carga a partir de tensão, corrente e energia; nulo se nenhum chegou. */
    fun charging(ev: (String) -> Double?): ChargingState? {
        val volts = ev(CHARGE_VOLTAGE)
        val amps = ev(CHARGE_CURRENT)
        val energy = ev(CHARGE_ENERGY)
        if (volts == null && amps == null && energy == null) return null
        val remaining = ev(CHARGE_REMAINING_MIN)?.toInt()?.takeIf { it in 1..6000 }
        // O sinal da corrente não é confiável entre leituras (a 0.1.13/0.1.14 mostravam
        // "Desconectado" carregando a 16 A): conta o módulo, exigindo tensão de carga,
        // ou o tempo restante de carga.
        val flowing = amps != null && abs(amps) > CHARGING_CURRENT_MIN_A && (volts ?: 0.0) > CHARGING_VOLTAGE_MIN_V
        val charging = flowing || remaining != null
        // Calculada aqui porque getChargingPower exige permissão da BYD.
        val power = if (flowing) volts!! * abs(amps!!) / 1000 else null
        return ChargingState(
            charging = charging,
            plugConnected = if (charging) true else null,
            powerKw = power,
            energyAddedKwh = energy,
            remainingMinutes = if (charging) remaining else null,
        )
    }
}
