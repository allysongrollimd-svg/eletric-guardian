package br.com.eletricguardian.app.byd

import android.content.Context
import br.com.eletricguardian.core.ClimateState
import br.com.eletricguardian.core.Gear
import br.com.eletricguardian.core.VehicleSnapshot

class OverdriveReader : ExtraCarReader {
    override fun fill(context: Context, base: VehicleSnapshot): VehicleSnapshot {
        // ===== PARTE 1: LER OS VALORES (você escreve, copiando do Overdrive aberto) =====
        // Troque cada "null" pela leitura real, usando a técnica do BydDeviceHelper/
        // BydDataCollector (repo Overdrive-release). Deixe null o que não ler.
        val speedKmh: Double? = null       // velocidade (BYDAutoSpeedDevice.getCurrentSpeed)
        val gear: Gear? = null             // marcha P/R/N/D
        val powerKw: Double? = null        // potência (ENGINE_POWER)
        val odometerKm: Double? = null     // odômetro (STAT_TOTAL_MILEAGE)
        val voltage12V: Double? = null     // bateria 12V
        val outsideTempC: Double? = null   // temperatura externa

        // ===== PARTE 2: MONTAR O RESULTADO (pronto — não precisa mexer) =====
        return base.copy(
            speedKmh = base.speedKmh ?: speedKmh,
            gear = base.gear ?: gear,
            powerKw = base.powerKw ?: powerKw,
            odometerKm = base.odometerKm ?: odometerKm,
            battery = base.battery.copy(
                voltage12V = base.battery.voltage12V ?: voltage12V,
            ),
            climate = (base.climate ?: ClimateState()).copy(
                outsideTempC = base.climate?.outsideTempC ?: outsideTempC,
            ),
        )
    }
}
