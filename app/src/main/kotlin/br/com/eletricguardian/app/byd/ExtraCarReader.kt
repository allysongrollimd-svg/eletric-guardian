package br.com.eletricguardian.app.byd

import android.content.Context
import br.com.eletricguardian.core.VehicleSnapshot

/**
 * Encaixe para uma leitura extra do carro, plugada por fora do app comum.
 *
 * O app comum (eventos bydauto) lê bateria/SoH/temp/células/SoC e, andando,
 * velocidade/odômetro. Campos protegidos PARADO (velocidade, marcha, odômetro,
 * 12V, temperatura externa, potência/torque) dependem da técnica do Overdrive
 * (código aberto, MIT): https://github.com/yash-srivastava/Overdrive-release
 * — app/src/main/java/com/overdrive/app/byd/BydDeviceHelper.java.
 *
 * Para ligar esses campos, adicione AO PROJETO uma classe que implemente esta
 * interface, no pacote e nome exatos:
 *
 *     package br.com.eletricguardian.app.byd
 *     class OverdriveReader : ExtraCarReader {
 *         override fun fill(context: Context, base: VehicleSnapshot): VehicleSnapshot {
 *             // Ler os getters do SDK bydauto (BYDAutoSpeedDevice, Statistic,
 *             // Gearbox, Energy, etc.) usando a técnica do BydDeviceHelper do
 *             // repo aberto, e devolver uma cópia de `base` com os campos
 *             // que vieram preenchidos (base.copy(speedKmh = ..., ...)).
 *             // Preencher só o que ainda está nulo em `base`.
 *         }
 *     }
 *
 * O coletor carrega essa classe por reflexão se ela existir; sem ela, o app
 * segue normal com os campos protegidos em "—". Nada aqui faz leitura
 * privilegiada: esta é só a tomada onde a sua implementação pluga.
 */
interface ExtraCarReader {
    /** Recebe o snapshot do app comum e devolve ele com os campos extras preenchidos. */
    fun fill(context: Context, base: VehicleSnapshot): VehicleSnapshot
}

/** Carrega a implementação opcional (se estiver no projeto) por reflexão. */
object ExtraCarReaders {
    private const val IMPL = "br.com.eletricguardian.app.byd.OverdriveReader"

    fun load(): ExtraCarReader? = try {
        Class.forName(IMPL).getDeclaredConstructor().newInstance() as? ExtraCarReader
    } catch (t: Throwable) {
        null
    }

    /** Nome curto da implementação carregada, para o diagnóstico. */
    fun describe(reader: ExtraCarReader?): String =
        if (reader == null) "nenhuma" else reader.javaClass.simpleName
}
