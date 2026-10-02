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

    /** Overdrive: STATISTIC_TOTAL_MILEAGE. Dolphin GS: 346562 = 34.656,2 km (décimos de km). */
    const val ODOMETER = "1014|4a502010"

    /**
     * Já mandou 99 e depois 81 com o carro parado, enquanto o app de referência
     * mostrava saúde 100%. Não é a saúde; fica fora do painel.
     */
    const val UNKNOWN_43A00028 = "1014|43a00028"

    /** Overdrive: STATISTIC_BATTERY_HEALTHY_INDEX. */
    const val SOH_ALT = "1014|44400028"

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

    /**
     * Fica em 5002..5006 tanto parado quanto carregando, enquanto a tensão real do
     * pack (1009|44400008) marcou 351 V na carga. Não é a tensão do pack; o
     * significado ainda é desconhecido, então não aparece no painel.
     */
    const val UNKNOWN_44A00020 = "1014|44a00020"

    /**
     * Tensão do pack (V). Dolphin GS: 351 carregando e 343..347 andando, então
     * chega sempre, não só na carga. O Connect Pulse usava como autonomia.
     */
    const val CHARGE_VOLTAGE = "1009|44400008"

    /**
     * Corrente do pack (A). Dolphin GS: -16,8 carregando (negativo = entrando na
     * bateria), positiva andando (saindo), 0,4 parado. O Connect Pulse usava como
     * velocidade.
     */
    const val CHARGE_CURRENT = "1009|44400018"

    /** Overdrive: CHARGING_CHARGE_CAPACITY. Dolphin GS: 16,0 → 17,5 subindo durante a carga (kWh). */
    const val CHARGE_ENERGY = "1009|27c00018"

    /**
     * Dolphin GS, candidato: 50 → 43 → 41 caindo durante a carga, quando o app
     * da BYD mostrava 47 min e o Electro 44 min restantes.
     */
    const val CHARGE_REMAINING_MIN = "1009|44500020"

    /** Corrente de entrada abaixo disso (A) conta como "não carregando". */
    private const val CHARGING_CURRENT_MIN_A = 0.5

    /** Tensão de carga mínima (V) para a corrente contar como carga. */
    private const val CHARGING_VOLTAGE_MIN_V = 50.0

    fun socPct(ev: (String) -> Double?): Double? =
        ev(SOC_TENTHS)?.let { it / 10 }?.takeIf { it in 0.0..100.0 } ?: ev(SOC_FINE_ALT) ?: ev(SOC_ALT)

    fun sohPct(ev: (String) -> Double?): Double? = ev(SOH_ALT)?.takeIf { it in 1.0..100.0 }

    /**
     * Temperatura da bateria (°C): média, ou máxima, ou mínima. O Dolphin GS mandou
     * 72 na mínima com a bateria perto de 36 °C no Electro: tratamos como °C + 40,
     * o deslocamento usual do CAN. Confirmar.
     */
    fun batteryTempC(ev: (String) -> Double?): Double? =
        (ev(BATTERY_TEMP_AVG) ?: ev(BATTERY_TEMP_MAX) ?: ev(BATTERY_TEMP_MIN))?.let { it - BATTERY_TEMP_OFFSET }

    private const val BATTERY_TEMP_OFFSET = 40.0

    fun rangeKm(ev: (String) -> Double?): Int? = ev(RANGE)?.toInt()

    /** Dolphin GS: 1 = P, 2 = R, 3 = N, 4 = D (teste R → D → N → P em 01/10). */
    const val GEAR = "1011|21200038"

    fun gear(ev: (String) -> Double?): Gear? = when (ev(GEAR)?.toInt()) {
        1 -> Gear.P
        2 -> Gear.R
        3 -> Gear.N
        4 -> Gear.D
        null -> null
        else -> Gear.UNKNOWN
    }

    /**
     * Temperatura externa (°C). Dolphin GS: 23 no ar-condicionado (1000) e no
     * painel (1007) ao mesmo tempo, à noite em 01/10. Confirmar com o painel do carro.
     */
    const val OUTSIDE_TEMP = "1000|40400038"
    const val OUTSIDE_TEMP_ALT = "1007|4a503040"

    fun outsideTempC(ev: (String) -> Double?): Double? =
        (ev(OUTSIDE_TEMP) ?: ev(OUTSIDE_TEMP_ALT))?.takeIf { it in -40.0..70.0 }

    fun odometerKm(ev: (String) -> Double?): Double? = ev(ODOMETER)?.let { it / 10 }

    /**
     * Potência do pack (kW) = tensão × corrente: positiva consumindo (andando),
     * negativa entrando (regeneração ou carga).
     */
    fun packPowerKw(ev: (String) -> Double?): Double? {
        val volts = ev(CHARGE_VOLTAGE)?.takeIf { it > CHARGING_VOLTAGE_MIN_V } ?: return null
        val amps = ev(CHARGE_CURRENT) ?: return null
        return volts * amps / 1000
    }

    /** Tensão do pack (V), pelo 1009|44400008. */
    fun packVoltageV(ev: (String) -> Double?): Double? =
        ev(CHARGE_VOLTAGE)?.takeIf { it in 200.0..900.0 }

    fun cellVoltageMinV(ev: (String) -> Double?): Double? = ev(CELL_VOLTAGE_MIN)?.let { it / 1000 }

    fun cellVoltageMaxV(ev: (String) -> Double?): Double? = ev(CELL_VOLTAGE_MAX)?.let { it / 1000 }

    /** Estado da carga a partir de tensão, corrente e energia; nulo se nenhum chegou. */
    fun charging(ev: (String) -> Double?): ChargingState? {
        val volts = ev(CHARGE_VOLTAGE)
        val amps = ev(CHARGE_CURRENT)
        val energy = ev(CHARGE_ENERGY)
        if (volts == null && amps == null && energy == null) return null
        // Carregando só com corrente entrando na bateria (negativa) e tensão
        // presente. Andando, a corrente é positiva: aquilo é consumo, não carga.
        // O tempo restante não decide: ele para de chegar quando a carga termina.
        val charging = amps != null && amps < -CHARGING_CURRENT_MIN_A && (volts ?: 0.0) > CHARGING_VOLTAGE_MIN_V
        // Calculada aqui porque getChargingPower exige permissão da BYD.
        val power = if (charging) volts!! * abs(amps!!) / 1000 else null
        return ChargingState(
            charging = charging,
            plugConnected = if (charging) true else null,
            powerKw = power,
            energyAddedKwh = energy,
            remainingMinutes = if (charging) ev(CHARGE_REMAINING_MIN)?.toInt()?.takeIf { it in 1..6000 } else null,
        )
    }
}
