package br.com.eletricguardian.app

import br.com.eletricguardian.core.TripSummary
import br.com.eletricguardian.core.VehicleSnapshot
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Estado compartilhado entre o serviço de monitoramento e as telas. */
object Telemetry {
    data class State(
        val sourceName: String? = null,
        val snapshot: VehicleSnapshot? = null,
        val tripInProgress: Boolean = false,
        val lastTrip: TripSummary? = null,
        /** O que a fonte conseguiu carregar e o que falhou. */
        val diagnostics: String? = null,
        /** Endereço do webapp (painel) servido pelo próprio app. */
        val webUrl: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state

    internal fun update(transform: (State) -> State) {
        _state.value = transform(_state.value)
    }
}
