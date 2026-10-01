package br.com.eletricguardian.core

/**
 * Tradução dos códigos de evento do SDK da BYD ("deviceType|eventType") para
 * os campos do [VehicleSnapshot].
 *
 * Os marcados "Dolphin GS" foram observados no carro de teste (DiLink 3.0)
 * carregando em AC (o app da BYD mostrava 90% e 367 km); os marcados "Connect Pulse" vêm do
 * app de referência e ainda não apareceram no Dolphin GS.
 */
object BydEventCodes {
    // 1009|44500020 veio com 50 enquanto o app da BYD mostrava 90%: não é o SoC.

    /** Connect Pulse. */
    const val SOC_ALT = "1014|44400030"

    /** Connect Pulse. */
    const val SOC_FINE_ALT = "1014|4a505038"

    /** Connect Pulse. */
    const val ODOMETER = "1014|4a502010"

    /** Dolphin GS: 364 (V). O código 1014|3d904010 trouxe o mesmo valor. */
    const val PACK_VOLTAGE = "1014|4a50203e"

    /** Dolphin GS: 3377..3380 (mV). */
    const val CELL_VOLTAGE_MIN = "1014|44600010"

    /** Dolphin GS: 3384..3387 (mV). */
    const val CELL_VOLTAGE_MAX = "1014|44600030"

    /** Dolphin GS: 351 (V) carregando. O Connect Pulse usava este código como autonomia. */
    const val CHARGE_VOLTAGE = "1009|44400008"

    /** Dolphin GS: -16,8 (A, negativo = entrando na bateria). O Connect Pulse usava como velocidade. */
    const val CHARGE_CURRENT = "1009|44400018"

    /** Dolphin GS: 16,0 → 17,1 subindo durante a carga (kWh). */
    const val CHARGE_ENERGY = "1009|27c00018"

    /** Corrente abaixo disso (A, em módulo) conta como "não carregando". */
    private const val CHARGING_CURRENT_MIN_A = 0.5

    fun socPct(ev: (String) -> Double?): Double? = ev(SOC_FINE_ALT) ?: ev(SOC_ALT)

    fun packVoltageV(ev: (String) -> Double?): Double? = ev(PACK_VOLTAGE)

    fun cellVoltageMinV(ev: (String) -> Double?): Double? = ev(CELL_VOLTAGE_MIN)?.let { it / 1000 }

    fun cellVoltageMaxV(ev: (String) -> Double?): Double? = ev(CELL_VOLTAGE_MAX)?.let { it / 1000 }

    /** Estado da carga a partir de tensão, corrente e energia; nulo se nenhum chegou. */
    fun charging(ev: (String) -> Double?): ChargingState? {
        val volts = ev(CHARGE_VOLTAGE)
        val amps = ev(CHARGE_CURRENT)
        val energy = ev(CHARGE_ENERGY)
        if (volts == null && amps == null && energy == null) return null
        val charging = amps != null && amps < -CHARGING_CURRENT_MIN_A
        // Calculada aqui porque getChargingPower exige permissão da BYD.
        val power = if (charging && volts != null) volts * -amps!! / 1000 else null
        return ChargingState(
            charging = charging,
            plugConnected = if (charging) true else null,
            powerKw = power,
            energyAddedKwh = energy,
        )
    }
}
