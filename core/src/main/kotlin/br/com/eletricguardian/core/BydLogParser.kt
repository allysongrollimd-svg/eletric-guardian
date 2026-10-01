package br.com.eletricguardian.core

/**
 * Extrai eventos do SDK da BYD das linhas de log ("postEvent ... device_type=…
 * event_type=… value=…"). O código é "deviceType|eventType", com event_type em
 * hexadecimal minúsculo sem "0x", no mesmo formato usado pelo Connect Pulse.
 */
object BydLogParser {
    data class Event(val code: String, val value: Double)

    private val DEVICE_TYPE = Regex("device_type[=:\\s]+(-?\\d+)")
    private val EVENT_TYPE = Regex("event_type[=:\\s]+=?\\s*(?:0[xX])?([0-9a-fA-F]+)")
    private val VALUE = Regex("value[=:\\s]+=?\\s*(-?[0-9]+(?:\\.[0-9]+)?)")

    fun parse(line: String): Event? {
        if (!line.contains("event_type")) return null
        val dt = DEVICE_TYPE.find(line)?.groupValues?.get(1) ?: return null
        val et = EVENT_TYPE.find(line)?.groupValues?.get(1)?.lowercase() ?: return null
        val v = VALUE.find(line)?.groupValues?.get(1)?.toDoubleOrNull() ?: return null
        return Event("$dt|$et", v)
    }
}
