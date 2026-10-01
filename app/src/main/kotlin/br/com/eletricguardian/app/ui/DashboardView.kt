package br.com.eletricguardian.app.ui

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import br.com.eletricguardian.app.BuildConfig
import br.com.eletricguardian.app.Telemetry
import br.com.eletricguardian.core.ChargingMode
import br.com.eletricguardian.core.PowerState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Painel de dados do carro. Montado em código para não depender de bibliotecas
 * de UI; as telas definitivas vêm depois, com base nos prints do webapp.
 */
class DashboardView(context: Context) : ScrollView(context) {

    private val header = text(16f, Color.parseColor("#9AA4B2"))
    private val grid = GridLayout(context).apply { columnCount = 3 }
    private val trip = text(16f, Color.WHITE)
    private val diagnostics = text(13f, Color.parseColor("#6B7480"))
    private val tiles = LinkedHashMap<String, TextView>()

    init {
        setBackgroundColor(Color.parseColor("#0E1116"))
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        column.addView(text(28f, Color.WHITE).apply {
            text = "Eletric Guardian"
            setTypeface(typeface, Typeface.BOLD)
        })
        column.addView(text(14f, Color.parseColor("#6B7480")).apply {
            text = "Versão ${BuildConfig.VERSION_NAME} (${BuildConfig.COMMIT})"
        })
        column.addView(header)
        column.addView(grid)
        column.addView(trip)
        column.addView(diagnostics)
        addView(column)

        for (label in LABELS) tiles[label] = addTile(label)
    }

    fun render(state: Telemetry.State) {
        val s = state.snapshot
        header.text = when (state.sourceName) {
            null -> "Procurando fonte de dados…"
            "simulado" -> "Fonte: dados simulados (fora do carro)"
            else -> "Fonte: ${state.sourceName}" + (s?.vehicle?.model?.let { " · $it" } ?: "")
        }

        set("Bateria", s?.battery?.socPct?.let { "%.0f %%".format(it) })
        set("Autonomia", s?.battery?.rangeKm?.let { "$it km" })
        set("Saúde (SoH)", s?.battery?.sohPct?.let { "%.0f %%".format(it) })
        set("Velocidade", s?.speedKmh?.let { "%.0f km/h".format(it) })
        set("Potência", s?.powerKw?.let { "%.1f kW".format(it) })
        set("Odômetro", s?.odometerKm?.let { "%.0f km".format(it) })
        set("Consumo médio", s?.energy?.averageConsumptionKwhPer100Km?.let { "%.1f kWh/100km".format(it) })
        set("Carga", s?.charging?.let { c ->
            when {
                c.charging -> "Carregando" +
                    (if (c.mode != ChargingMode.UNKNOWN) " ${c.mode}" else "") +
                    (c.powerKw?.let { " · %.1f kW".format(it) } ?: "") +
                    (c.energyAddedKwh?.let { " · +%.1f kWh".format(it) } ?: "")
                c.plugConnected == true -> "Plugado"
                else -> "Desconectado"
            }
        })
        set("Ignição", s?.powerState?.let {
            when (it) {
                PowerState.ON -> "Ligado"
                PowerState.ACC -> "Acessórios"
                PowerState.OFF -> "Desligado"
                PowerState.UNKNOWN -> "?"
            }
        })
        set("Travas", s?.body?.locked?.let { if (it) "Travado" else "Destravado" })
        set("Temp. externa", s?.climate?.outsideTempC?.let { "%.0f °C".format(it) })
        set("Tensão do pack", s?.battery?.packVoltageV?.let { "%.0f V".format(it) })
        set("Células (mín/máx)", s?.battery?.let { b ->
            if (b.cellVoltageMinV == null && b.cellVoltageMaxV == null) null
            else "%.3f / %.3f V".format(b.cellVoltageMinV ?: Double.NaN, b.cellVoltageMaxV ?: Double.NaN)
        })
        set("Localização", s?.location?.let { "%.5f, %.5f".format(it.latitude, it.longitude) })

        diagnostics.text = state.diagnostics?.let { "Diagnóstico: $it" } ?: ""

        val last = state.lastTrip
        trip.text = buildString {
            append(if (state.tripInProgress) "Viagem em andamento" else "Sem viagem em andamento")
            if (last != null) {
                append("\nÚltima viagem: ")
                append(TIME.format(Date(last.startMs)))
                append(" · %.1f km".format(last.distanceKm))
                last.consumptionKwhPer100Km?.let { append(" · %.1f kWh/100km".format(it)) }
            }
        }
    }

    private fun set(label: String, value: String?) {
        tiles[label]?.text = "$label\n${value ?: "—"}"
    }

    private fun addTile(label: String): TextView {
        val tile = text(20f, Color.WHITE).apply {
            text = "$label\n—"
            gravity = Gravity.START
            setBackgroundColor(Color.parseColor("#1A1F27"))
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        val params = GridLayout.LayoutParams(
            GridLayout.spec(GridLayout.UNDEFINED, 1f),
            GridLayout.spec(GridLayout.UNDEFINED, 1f),
        ).apply {
            width = 0
            setMargins(dp(6), dp(6), dp(6), dp(6))
        }
        grid.addView(tile, params)
        return tile
    }

    private fun text(sp: Float, color: Int) = TextView(context).apply {
        textSize = sp
        setTextColor(color)
        setPadding(0, dp(8), 0, dp(8))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private companion object {
        val LABELS = listOf(
            "Bateria", "Autonomia", "Saúde (SoH)",
            "Velocidade", "Potência", "Odômetro",
            "Consumo médio", "Carga", "Ignição",
            "Travas", "Temp. externa", "Tensão do pack",
            "Células (mín/máx)", "Localização",
        )
        val TIME = SimpleDateFormat("dd/MM HH:mm", Locale("pt", "BR"))
    }
}
