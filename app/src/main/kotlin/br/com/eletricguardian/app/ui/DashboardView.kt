package br.com.eletricguardian.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import br.com.eletricguardian.app.BuildConfig
import br.com.eletricguardian.app.Telemetry
import br.com.eletricguardian.core.ChargingMode
import br.com.eletricguardian.core.Gear
import br.com.eletricguardian.core.VehicleSnapshot

/**
 * Painel de dados no estilo do Electro: mapa no topo e cards agrupados
 * (bateria em destaque, velocidade, carga, autonomia), montado em código para
 * não depender de bibliotecas de UI. Campo sem dado aparece como "—".
 */
@SuppressLint("SetJavaScriptEnabled")
class DashboardView(context: Context) : ScrollView(context) {

    private val title = text(24f, Color.WHITE, Typeface.BOLD)
    private val model = text(14f, MUTED)
    private val version = text(12f, FAINT)
    private val webUrl = text(14f, 0xFF2ED29A.toInt())
    private val source = text(12f, FAINT)

    private val map = WebView(context)
    private var mapReady = false
    private var lastLat = Double.NaN
    private var lastLon = Double.NaN

    // Bateria (card de destaque)
    private val soc = big()
    private val socUnit = unit("%")
    private val bTemp = sub("TEMP")
    private val bCell = sub("CÉLULAS")
    private val bHealth = sub("SAÚDE")
    private val b12v = sub("12V")

    // Velocidade
    private val speed = big()
    private val speedUnit = unit("km/h")
    private val sGear = sub("MODO")
    private val sOdo = sub("ODÔMETRO")
    private val sAlt = sub("ALTITUDE")

    // Carga
    private val chargeCard: LinearLayout
    private val chargePower = big()
    private val chargePowerUnit = unit("kW")
    private val cRemaining = sub("FALTAM")
    private val cMode = sub("MODO")
    private val cAdded = sub("ADICIONADO")

    // Autonomia e potência
    private val range = big()
    private val rangeUnit = unit("km")
    private val power = big()
    private val powerUnit = unit("kW")

    private val diagnostics = text(10f, FAINT)

    init {
        setBackgroundColor(BG)
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }

        // Header: nome do veículo + versão
        column.addView(LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(title, lp(weight = 1f))
            addView(model.apply { gravity = Gravity.END or Gravity.CENTER_VERTICAL })
        })
        title.text = "Eletric Guardian"
        column.addView(version)
        version.text = "Versão ${BuildConfig.VERSION_NAME} (${BuildConfig.COMMIT})"
        column.addView(webUrl)
        column.addView(source)

        // Mapa no topo
        map.apply {
            settings.javaScriptEnabled = true
            setBackgroundColor(CARD)
            // Não intercepta o toque: deixa o ScrollView rolar.
            setOnTouchListener { _, _ -> true }
            webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) { mapReady = true }
            }
            loadDataWithBaseURL("https://tile.openstreetmap.org/", MAP_HTML, "text/html", "utf-8", null)
        }
        column.addView(map, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(200)).apply {
            topMargin = dp(8)
            bottomMargin = dp(12)
        })

        // Cards
        column.addView(batteryCard())
        column.addView(speedCard())
        chargeCard = chargingCard()
        column.addView(chargeCard)
        column.addView(LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(smallCard("AUTONOMIA", range, rangeUnit), lp(weight = 1f).apply { rightMargin = dp(6) })
            addView(smallCard("POTÊNCIA", power, powerUnit), lp(weight = 1f).apply { leftMargin = dp(6) })
        })

        column.addView(diagnostics.apply { setPadding(0, dp(12), 0, 0) })
        addView(column)
    }

    fun render(state: Telemetry.State) {
        val s = state.snapshot
        webUrl.text = state.webUrl?.let { "Painel no celular: $it" } ?: ""
        model.text = s?.vehicle?.model ?: s?.vehicle?.brand ?: ""
        source.text = when (state.sourceName) {
            null -> "Procurando fonte de dados…"
            "simulado" -> "Dados simulados (fora do carro)"
            else -> ""
        }

        // Mapa
        s?.location?.let {
            if (mapReady && (dist(it.latitude, it.longitude) > 0.00003 || lastLat.isNaN())) {
                lastLat = it.latitude
                lastLon = it.longitude
                map.evaluateJavascript("setPos(${it.latitude},${it.longitude})", null)
            }
        }

        // Bateria
        soc.text = s?.battery?.socPct?.let { "%.0f".format(it) } ?: "—"
        bTemp.set(s?.battery?.cellTempMaxC?.let { "%.0f °C".format(it) })
        bCell.set(cells(s))
        bHealth.set(s?.battery?.sohPct?.let { "%.0f %%".format(it) })
        b12v.set(s?.battery?.voltage12V?.let { "%.1f V".format(it) })

        // Velocidade
        speed.text = s?.speedKmh?.let { "%.0f".format(it) } ?: "—"
        sGear.set(gear(s?.gear))
        sOdo.set(s?.odometerKm?.let { "%,.0f km".format(it) })
        sAlt.set(s?.location?.altitudeM?.let { "%.0f m".format(it) })

        // Carga
        val c = s?.charging
        val plugged = c != null && (c.charging || c.plugConnected == true)
        chargeCard.visibility = if (plugged) View.VISIBLE else View.GONE
        if (plugged && c != null) {
            chargePower.text = c.powerKw?.let { "%.1f".format(it) } ?: "—"
            cRemaining.set(c.remainingMinutes?.let { "$it min" })
            cMode.set(if (c.mode != ChargingMode.UNKNOWN) c.mode.name else if (c.charging) "carregando" else "plugado")
            cAdded.set(c.energyAddedKwh?.let { "+%.1f kWh".format(it) })
        }

        // Autonomia e potência
        range.text = s?.battery?.rangeKm?.toString() ?: "—"
        power.text = s?.powerKw?.let { "%.1f".format(it) } ?: "—"

        diagnostics.text = state.diagnostics?.let { "diag: $it" } ?: ""
    }

    // --- construção de cards ---

    private fun batteryCard(): View = cardBox("BATERIA").apply {
        addView(valueRow(soc, socUnit))
        addView(subRow(bTemp, bCell, bHealth, b12v))
    }

    private fun speedCard(): View = cardBox("VELOCIDADE").apply {
        addView(valueRow(speed, speedUnit))
        addView(subRow(sGear, sOdo, sAlt))
    }

    private fun chargingCard(): LinearLayout = cardBox("CARREGANDO").apply {
        addView(valueRow(chargePower, chargePowerUnit))
        addView(subRow(cRemaining, cMode, cAdded))
        visibility = View.GONE
    }

    private fun smallCard(label: String, value: TextView, u: TextView): View =
        cardBox(label).apply { addView(valueRow(value, u)) }

    private fun cardBox(label: String): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(CARD)
        setPadding(dp(16), dp(14), dp(16), dp(14))
        (layoutParams as? ViewGroup.MarginLayoutParams)
        addView(text(11f, MUTED).apply {
            text = label
            letterSpacing = 0.08f
        })
    }.also { box ->
        // margem entre cards empilhados
        box.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { bottomMargin = dp(12) }
    }

    private fun valueRow(value: TextView, u: TextView) = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.BOTTOM
        setPadding(0, dp(4), 0, dp(2))
        addView(value)
        addView(u.apply { setPadding(dp(6), 0, 0, dp(8)) })
    }

    private fun subRow(vararg subs: Sub) = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, dp(10), 0, 0)
        for (s in subs) addView(s.view, lp(weight = 1f))
    }

    // --- helpers ---

    private fun cells(s: VehicleSnapshot?): String? {
        val b = s?.battery ?: return null
        if (b.cellVoltageMinV == null && b.cellVoltageMaxV == null) return null
        return "%.3f/%.3f V".format(b.cellVoltageMinV ?: Double.NaN, b.cellVoltageMaxV ?: Double.NaN)
    }

    private fun gear(g: Gear?): String? = when (g) {
        null, Gear.UNKNOWN -> null
        else -> g.name
    }

    private fun dist(la: Double, lo: Double): Double =
        if (lastLat.isNaN()) Double.MAX_VALUE else Math.abs(la - lastLat) + Math.abs(lo - lastLon)

    private fun big() = text(40f, Color.WHITE, Typeface.BOLD).apply { text = "—" }

    private fun unit(u: String) = text(16f, MUTED).apply { text = u }

    private fun sub(label: String) = Sub(context, label)

    private fun text(sp: Float, color: Int, style: Int = Typeface.NORMAL) = TextView(context).apply {
        textSize = sp
        setTextColor(color)
        if (style != Typeface.NORMAL) setTypeface(typeface, style)
    }

    private fun rounded(color: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(14).toFloat()
    }

    private fun lp(weight: Float = 0f) = LinearLayout.LayoutParams(
        if (weight > 0) 0 else ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        weight,
    )

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    /** Métrica secundária dentro de um card: rótulo pequeno + valor. */
    class Sub(context: Context, label: String) {
        private val labelView = TextView(context).apply {
            text = label
            textSize = 10f
            setTextColor(FAINT)
            letterSpacing = 0.06f
        }
        private val valueView = TextView(context).apply {
            text = "—"
            textSize = 15f
            setTextColor(Color.WHITE)
        }
        val view: LinearLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(labelView)
            addView(valueView)
        }

        fun set(value: String?) { valueView.text = value ?: "—" }
    }

    private companion object {
        const val BG = 0xFF0E1116.toInt()
        const val CARD = 0xFF161B22.toInt()
        const val MUTED = 0xFF9AA4B2.toInt()
        const val FAINT = 0xFF6B7480.toInt()

        val MAP_HTML = """
            <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
            <style>html,body,#m{height:100%;margin:0;background:#161B22}</style></head>
            <body><div id="m"></div>
            <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
            <script>
              var map=L.map('m',{zoomControl:false,attributionControl:false}).setView([-15.6,-56.1],15);
              L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
              var mk=null;
              function setPos(la,lo){map.setView([la,lo],16);if(mk){mk.setLatLng([la,lo]);}else{mk=L.marker([la,lo]).addTo(map);}}
            </script></body></html>
        """.trimIndent()
    }
}
