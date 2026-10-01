package br.com.eletricguardian.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class BydLogParserTest {

    @Test
    fun `le evento com valor decimal`() {
        val e = BydLogParser.parse(
            "D/BYDAutoChargingDevice(15532): postEvent device_type=1009, event_type=0x27C00018, value=16.023",
        )
        assertEquals(BydLogParser.Event("1009|27c00018", 16.023), e)
    }

    @Test
    fun `le evento com separador dois pontos e valor negativo`() {
        val e = BydLogParser.parse("postEvent device_type: 1009 event_type: 44400018 value: -16.7")
        assertEquals(BydLogParser.Event("1009|44400018", -16.7), e)
    }

    @Test
    fun `ignora linhas que nao sao evento`() {
        assertNull(BydLogParser.parse("I/EG-Monitor(13949): leitura: VehicleSnapshot(...)"))
        assertNull(BydLogParser.parse("event_type=27c00018 sem os outros campos"))
    }
}
