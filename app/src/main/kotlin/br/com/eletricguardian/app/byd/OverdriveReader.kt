package br.com.eletricguardian.app.byd

import android.content.Context
import br.com.eletricguardian.core.VehicleSnapshot

class OverdriveReader : ExtraCarReader {
    override fun fill(context: Context, base: VehicleSnapshot): VehicleSnapshot {
        // MIOLO entra aqui depois: ler os campos e devolver base.copy(...)
        return base
    }
}
