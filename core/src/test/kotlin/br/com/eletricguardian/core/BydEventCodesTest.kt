package br.com.eletricguardian.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class BydEventCodesTest {

    /** Valores observados no Dolphin GS carregando em AC. */
    private val dolphinCharging = mapOf(
        "1009|44500020" to 50.0,
        "1009|44400008" to 351.0,
        "1009|44400018" to -16.8,
        "1009|27c00018" to 17.096,
        "1014|4a50203e" to 364.0,
        "1014|44600010" to 3380.0,
        "1014|44600030" to 3387.0,
        "1014|44700028" to 894.0,
    )

    private val ev: (String) -> Double? = { dolphinCharging[it] }

    @Test
    fun `bateria do Dolphin GS`() {
        // 1009|44500020 = 50 não é o SoC (o app da BYD mostrava 90%); é o tempo restante de carga.
        assertEquals(89.4, BydEventCodes.socPct(ev)!!, 1e-9)
        assertNull(BydEventCodes.socPct { if (it == "1009|44500020") 50.0 else null })
        assertEquals(364, BydEventCodes.rangeKm(ev))
        assertEquals(3.380, BydEventCodes.cellVoltageMinV(ev)!!, 1e-9)
        assertEquals(3.387, BydEventCodes.cellVoltageMaxV(ev)!!, 1e-9)
    }

    @Test
    fun `carga calcula potencia por tensao vezes corrente`() {
        val c = BydEventCodes.charging(ev)
        assertNotNull(c)
        assertEquals(true, c.charging)
        assertEquals(5.8968, c.powerKw!!, 1e-9)
        assertEquals(17.096, c.energyAddedKwh)
        assertEquals(50, c.remainingMinutes)
    }

    @Test
    fun `corrente perto de zero nao conta como carregando`() {
        val c = BydEventCodes.charging { mapOf("1009|44400008" to 351.0, "1009|44400018" to -0.2)[it] }
        assertNotNull(c)
        assertEquals(false, c.charging)
        assertNull(c.powerKw)
    }

    @Test
    fun `sem eventos de carga nao ha estado de carga`() {
        assertNull(BydEventCodes.charging { null })
    }
}
