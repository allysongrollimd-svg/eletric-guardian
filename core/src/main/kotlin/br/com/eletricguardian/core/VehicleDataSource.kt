package br.com.eletricguardian.core

/**
 * Fonte de dados de uma marca/modelo. Cada marca (BYD, Geely, ...) implementa a
 * sua; o resto do app só conhece esta interface.
 */
interface VehicleDataSource {
    /** Nome curto mostrado no diagnóstico, ex.: "byd-sdk", "simulado". */
    val name: String

    /** Se a fonte consegue ler dados neste aparelho. */
    fun isAvailable(): Boolean

    /** Lê o estado atual. Não deve lançar exceção: campos ilegíveis vêm nulos. */
    fun read(nowMs: Long): VehicleSnapshot

    fun close() {}
}

/** Escolhe a primeira fonte disponível, na ordem dada. */
fun pickDataSource(candidates: List<VehicleDataSource>): VehicleDataSource? =
    candidates.firstOrNull { runCatching { it.isAvailable() }.getOrDefault(false) }
