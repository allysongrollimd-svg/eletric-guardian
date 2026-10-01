package br.com.eletricguardian.app.web

import br.com.eletricguardian.app.Telemetry
import br.com.eletricguardian.core.ChargingMode
import br.com.eletricguardian.core.Gear
import org.json.JSONObject

/** Converte o estado atual do carro no JSON que o webapp lê. */
object SnapshotJson {

    fun of(state: Telemetry.State): String {
        val root = JSONObject()
        root.put("ts", System.currentTimeMillis())
        root.put("source", state.sourceName ?: JSONObject.NULL)

        val s = state.snapshot
        if (s == null) return root.toString()

        root.put("ts", s.timestampMs)
        root.put("speed_kmh", num(s.speedKmh))
        root.put("gear", s.gear?.takeIf { it != Gear.UNKNOWN }?.name ?: JSONObject.NULL)
        root.put("odometer_km", num(s.odometerKm))
        root.put("power_kw", num(s.powerKw))
        root.put("outside_temp_c", num(s.climate?.outsideTempC))

        s.vehicle?.let {
            root.put("vehicle", JSONObject().apply {
                put("brand", it.brand ?: JSONObject.NULL)
                put("model", it.model ?: JSONObject.NULL)
            })
        }

        root.put("battery", JSONObject().apply {
            put("soc", num(s.battery.socPct))
            put("soh", num(s.battery.sohPct))
            put("range_km", s.battery.rangeKm ?: JSONObject.NULL)
            put("temp_c", num(s.battery.cellTempMaxC))
            put("pack_v", num(s.battery.packVoltageV))
            put("cell_min_v", num(s.battery.cellVoltageMinV))
            put("cell_max_v", num(s.battery.cellVoltageMaxV))
            put("v12", num(s.battery.voltage12V))
        })

        s.charging?.let { c ->
            root.put("charging", JSONObject().apply {
                put("active", c.charging)
                put("plugged", c.plugConnected ?: JSONObject.NULL)
                put("power_kw", num(c.powerKw))
                put("remaining_min", c.remainingMinutes ?: JSONObject.NULL)
                put("mode", if (c.mode != ChargingMode.UNKNOWN) c.mode.name else JSONObject.NULL)
                put("added_kwh", num(c.energyAddedKwh))
            })
        }

        s.location?.let {
            root.put("location", JSONObject().apply {
                put("lat", it.latitude)
                put("lon", it.longitude)
                put("alt_m", num(it.altitudeM))
            })
        }
        return root.toString()
    }

    private fun num(v: Double?): Any = if (v == null || v.isNaN()) JSONObject.NULL else v
}
