package br.com.eletricguardian.app.byd

import android.content.Context
import android.util.Log
import br.com.eletricguardian.core.BatteryState
import br.com.eletricguardian.core.BydEventCodes
import br.com.eletricguardian.core.ClimateState
import br.com.eletricguardian.core.EnergyModeState
import br.com.eletricguardian.core.TyreState
import br.com.eletricguardian.core.VehicleDataSource
import br.com.eletricguardian.core.VehicleIdentity
import br.com.eletricguardian.core.VehicleSnapshot
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.ConcurrentHashMap

/**
 * Lê o carro pelo SDK da central BYD (android.hardware.bydauto.*), presente só
 * na central multimídia. Usa reflexão para compilar sem o SDK e para que cada
 * método ausente num modelo vire apenas um campo nulo.
 *
 * Os getters do SDK exigem as permissões BYDAUTO_* (de assinatura da BYD): no
 * Dolphin GS (DiLink 3.0) todos deram SecurityException, por isso não são
 * chamados. Os dados chegam pelos eventos que o serviço empurra para quem
 * registra listener ([BydEventBus]). Os devices são carregados só para
 * registrar os listeners. Criar no thread principal, pois os devices podem
 * criar Handlers no construtor.
 *
 * Toda falha é registrada uma vez no logcat com a tag EG-BYD.
 */
class BydVehicleDataSource(context: Context) : VehicleDataSource {
    override val name = "byd-sdk"

    private val appContext = context.applicationContext
    private val failures = ConcurrentHashMap<String, String>()
    private val events = BydEventBus(context)

    // Leitura extra opcional (plugada por fora): preenche os campos protegidos
    // parado quando a classe OverdriveReader existe no projeto. Ver ExtraCarReader.
    private val extra = ExtraCarReaders.load()

    // Leitura pelo provider com.byd.car.server (ICarPropertyService), como o
    // Overdrive: pega velocidade, marcha, odômetro, 12V e temperatura externa
    // que os getters do SDK barram por permissão de assinatura.
    private val provider = ProviderReader(context)

    @Volatile
    private var providerSwept = false

    init {
        HiddenApi.exemptAll()
    }

    private val statistic = device(context, "statistic.BYDAutoStatisticDevice")
    private val speed = device(context, "speed.BYDAutoSpeedDevice")
    private val charging = device(context, "charging.BYDAutoChargingDevice")
    private val ac = device(context, "ac.BYDAutoAcDevice")
    private val body = device(context, "bodywork.BYDAutoBodyworkDevice")
    private val gearbox = device(context, "gearbox.BYDAutoGearboxDevice")
    private val instrument = device(context, "instrument.BYDAutoInstrumentDevice")

    // Dispositivos adicionais para capturar todos os dados que o Overdrive lê.
    // BYDAutoCollectDataDevice não existe no DiLink 3.0 (ClassNotFound), ficou de fora.
    private val tyre = device(context, "tyre.BYDAutoTyreDevice")
    private val engine = device(context, "engine.BYDAutoEngineDevice")
    private val energy = device(context, "energy.BYDAutoEnergyDevice")

    // Armazenamento dos dados capturados pelos listeners adicionais
    private val tyreData = ConcurrentHashMap<String, Number>()
    private val energyModeData = ConcurrentHashMap<String, Int>()

    init {
        events.register(
            mapOf(
                "charging" to charging, "statistic" to statistic, "bodywork" to body, "gearbox" to gearbox,
                "instrument" to instrument, "speed" to speed, "ac" to ac,
            ),
        )
        events.startLogReader()

        // Registra listeners adicionais para capturar todos os dados que o Overdrive lê
        registerAdditionalListeners()

        // Varredura de descoberta do provider, uma vez, em segundo plano: não
        // pode rodar no thread principal (IPC) nem segurar o construtor.
        Thread({
            runCatching { provider.sweep(BydProperties.ALL) }
                .onFailure { Log.w(TAG, "varredura do provider falhou", it) }
            providerSwept = true
        }, "EG-ProviderSweep").apply { isDaemon = true; start() }
    }

    private fun registerAdditionalListeners() {
        // Tyre: pressão e temperatura dos pneus (wheel: 0=FL, 1=FR, 2=RL, 3=RR)
        AdditionalListeners.registerTyreListener(tyre) { name, args ->
            Log.d(TAG, "Tyre: $name ${args.contentToString()}")
            val wheel = args.getOrNull(0) as? Int ?: return@registerTyreListener
            val wheelKey = when (wheel) {
                0 -> "FL"
                1 -> "FR"
                2 -> "RL"
                3 -> "RR"
                else -> return@registerTyreListener
            }
            when (name) {
                "onTyrePressureValueByTypeChanged" -> {
                    val pressure = args.getOrNull(1) as? Number ?: return@registerTyreListener
                    tyreData["pressure$wheelKey"] = pressure
                }
                "onTyreTemperatureValueChanged" -> {
                    val temp = args.getOrNull(1) as? Int ?: return@registerTyreListener
                    tyreData["temp$wheelKey"] = temp
                }
            }
        }

        // Engine: motor ICE (para PHEVs)
        AdditionalListeners.registerEngineListener(engine) { name, args ->
            Log.d(TAG, "Engine: $name ${args.contentToString()}")
        }

        // Energy: modos de energia e operação
        AdditionalListeners.registerEnergyListener(energy) { name, args ->
            Log.d(TAG, "Energy: $name ${args.contentToString()}")
            val value = args.getOrNull(0) as? Int ?: return@registerEnergyListener
            when (name) {
                "onEnergyModeChanged" -> energyModeData["energyMode"] = value
                "onOperationModeChanged" -> energyModeData["operationMode"] = value
                "onRoadSurfaceChanged" -> energyModeData["roadSurface"] = value
                "oniTACModeChanged" -> energyModeData["iTacMode"] = value
            }
        }

        // Instrument: potência de carga externa, temperatura externa, modo sport
        AdditionalListeners.registerInstrumentListener(instrument) { name, args ->
            Log.d(TAG, "Instrument adicional: $name ${args.contentToString()}")
            when (name) {
                "onSportModeStateChanged" -> {
                    val state = args.getOrNull(0) as? Int ?: return@registerInstrumentListener
                    energyModeData["sportMode"] = state
                }
                "onOutCarTemperatureChanged" -> {
                    val tempC = args.getOrNull(0) as? Int ?: return@registerInstrumentListener
                    tyreData["outsideTempC"] = tempC
                }
            }
        }
    }

    override fun isAvailable() =
        listOf(statistic, speed, charging, body, gearbox, instrument, tyre, engine, energy)
            .any { it != null } || provider.isAvailable()

    override fun close() = events.stop()

    /** Resumo do que carregou e do que falhou, para a tela de diagnóstico. */
    fun diagnostics(): String {
        val loaded = listOf(
            "statistic" to statistic, "speed" to speed, "charging" to charging, "ac" to ac, "body" to body,
            "tyre" to tyre, "engine" to engine, "energy" to energy,
        ).joinToString(" ") { (n, d) -> if (d != null) "$n✓" else "$n✗" }
        val codes = events.latest.values.sortedBy { it.code }
        val raw = if (codes.isEmpty()) {
            "nenhum evento recebido ainda"
        } else {
            codes.joinToString("  ") { "${it.code}=${fmt(it.value)}" }
        }
        val prov = if (!providerSwept) {
            "provider: varrendo…"
        } else {
            "provider ${if (provider.isAvailable()) "✓" else "✗"} rota=${provider.route} (${provider.resolved.size}): ${provider.diagnostics()}"
        }
        return "$loaded\nlisteners: ${events.registeredSummary().ifEmpty { "nenhum" }}\n" +
            "eventos (${codes.size}): $raw\n$prov\n" +
            "leitura extra: ${ExtraCarReaders.describe(extra)}"
    }

    private fun fmt(v: Double) = if (v == Math.floor(v) && Math.abs(v) < 1e9) v.toLong().toString() else "%.3f".format(v)

    /** Valor mais recente de um código de evento "deviceType|eventType". */
    private fun ev(code: String): Double? = events.latest[code]?.value

    override fun read(nowMs: Long): VehicleSnapshot {
        val base = readBase(nowMs)
        // Se a leitura extra estiver plugada, deixa ela preencher os campos
        // protegidos; qualquer falha dela não derruba a leitura comum.
        return extra?.let { runCatching { it.fill(appContext, base) }.getOrDefault(base) } ?: base
    }

    private fun readBase(nowMs: Long): VehicleSnapshot = VehicleSnapshot(
        timestampMs = nowMs,
        // Fallback pelo provider (não depende de andar para ter o valor atual).
        odometerKm = BydEventCodes.odometerKm(::ev) ?: provider.readD("Statistic.STATISTIC_TOTAL_MILEAGE"),
        powerKw = BydEventCodes.packPowerKw(::ev),
        gear = BydEventCodes.gear(::ev),
        battery = BatteryState(
            socPct = BydEventCodes.socPct(::ev),
            sohPct = BydEventCodes.sohPct(::ev),
            rangeKm = BydEventCodes.rangeKm(::ev),
            packVoltageV = BydEventCodes.packVoltageV(::ev),
            cellVoltageMinV = BydEventCodes.cellVoltageMinV(::ev),
            cellVoltageMaxV = BydEventCodes.cellVoltageMaxV(::ev),
            cellTempMaxC = BydEventCodes.batteryTempC(::ev),
        ),
        charging = BydEventCodes.charging(::ev),
        climate = (BydEventCodes.outsideTempC(::ev) ?: tyreData["outsideTempC"]?.toDouble())
            ?.let { ClimateState(outsideTempC = it) },
        tyres = readTyres(),
        energyMode = readEnergyMode(),
        vehicle = VehicleIdentity(brand = "BYD"),
    )

    private fun readTyres(): TyreState? {
        if (tyreData.isEmpty()) return null
        return TyreState(
            pressureFrontLeft = tyreData["pressureFL"]?.toDouble(),
            pressureFrontRight = tyreData["pressureFR"]?.toDouble(),
            pressureRearLeft = tyreData["pressureRL"]?.toDouble(),
            pressureRearRight = tyreData["pressureRR"]?.toDouble(),
            tempFrontLeft = tyreData["tempFL"]?.toInt(),
            tempFrontRight = tyreData["tempFR"]?.toInt(),
            tempRearLeft = tyreData["tempRL"]?.toInt(),
            tempRearRight = tyreData["tempRR"]?.toInt(),
        )
    }

    private fun readEnergyMode(): EnergyModeState? {
        if (energyModeData.isEmpty()) return null
        return EnergyModeState(
            energyMode = energyModeData["energyMode"],
            operationMode = energyModeData["operationMode"],
            roadSurface = energyModeData["roadSurface"],
            iTacMode = energyModeData["iTacMode"],
            sportMode = energyModeData["sportMode"],
        )
    }

    private fun device(context: Context, cls: String): Any? = try {
        val d = Class.forName("android.hardware.bydauto.$cls")
            .getMethod("getInstance", Context::class.java)
            .invoke(null, context)
        Log.i(TAG, "$cls carregado: ${d?.javaClass?.name}")
        d
    } catch (t: Throwable) {
        fail(cls, t)
        null
    }

    private fun fail(key: String, t: Throwable) {
        val cause = (t as? InvocationTargetException)?.targetException ?: t
        val msg = "${cause.javaClass.simpleName}: ${cause.message}"
        if (failures.putIfAbsent(key, msg) == null) Log.e(TAG, "falha em $key", cause)
    }

    private companion object {
        const val TAG = "EG-BYD"
    }
}
