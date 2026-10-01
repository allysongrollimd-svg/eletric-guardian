package br.com.eletricguardian.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VehicleDataSourceTest {

    private class Fake(override val name: String, private val ok: () -> Boolean) : VehicleDataSource {
        override fun isAvailable() = ok()
        override fun read(nowMs: Long) = VehicleSnapshot(nowMs)
    }

    @Test
    fun `escolhe a primeira fonte disponivel`() {
        val picked = pickDataSource(listOf(Fake("byd") { false }, Fake("geely") { true }, Fake("mock") { true }))
        assertEquals("geely", picked?.name)
    }

    @Test
    fun `fonte que lanca excecao conta como indisponivel`() {
        val picked = pickDataSource(listOf(Fake("byd") { error("sem SDK") }))
        assertNull(picked)
    }
}
