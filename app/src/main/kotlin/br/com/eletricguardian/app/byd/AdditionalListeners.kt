package br.com.eletricguardian.app.byd

import android.content.Context
import android.util.Log

/**
 * Listeners adicionais para capturar todos os campos que o Overdrive consegue ler.
 * Implementa os listeners tipados que ainda faltam no Electric Guardian:
 * - CollectData: telemetria dos motores (tensão, corrente, temperatura, RPM, torque)
 * - Tyre: pressão e temperatura dos pneus
 * - Engine: motor ICE (para PHEVs)
 * - Energy: modos de energia e operação
 */
object AdditionalListeners {
    private const val TAG = "EG-AdditionalListeners"

    /**
     * Registra listener de telemetria dos motores (front/rear).
     * Captura: tensão, corrente, temperatura, velocidade (RPM) e torque.
     */
    fun registerCollectDataListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return try {
            val listener = object : android.hardware.bydauto.collectdata.AbsBYDAutoCollectDataListener() {
                override fun onMotorMCUGeneratrixVolt(front: Int, rear: Int) {
                    callback("onMotorMCUGeneratrixVolt", arrayOf(front, rear))
                }

                override fun onMotorMCUGeneratrixCurrent(front: Int, rear: Int) {
                    callback("onMotorMCUGeneratrixCurrent", arrayOf(front, rear))
                }

                override fun onDriverMotorTemperature(front: Int, rear: Int) {
                    callback("onDriverMotorTemperature", arrayOf(front, rear))
                }

                override fun onDriverMotorSpeed(front: Int, rear: Int) {
                    callback("onDriverMotorSpeed", arrayOf(front, rear))
                }

                override fun onDriverMotorTorque(front: Int, rear: Int) {
                    callback("onDriverMotorTorque", arrayOf(front, rear))
                }
            }
            val method = device.javaClass.getMethod(
                "registerListener",
                android.hardware.bydauto.collectdata.AbsBYDAutoCollectDataListener::class.java
            )
            method.invoke(device, listener)
            Log.i(TAG, "CollectData listener registrado com sucesso")
            true
        } catch (e: NoClassDefFoundError) {
            Log.d(TAG, "CollectData listener não disponível neste firmware")
            false
        } catch (e: Exception) {
            Log.d(TAG, "Falha ao registrar CollectData listener: ${e.message}")
            false
        }
    }

    /**
     * Registra listener de pneus (pressão, temperatura, bateria TPMS).
     */
    fun registerTyreListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return try {
            val listener = object : android.hardware.bydauto.tyre.AbsBYDAutoTyreListener() {
                override fun onTyrePressureValueChanged(wheel: Int, value: Int) {
                    callback("onTyrePressureValueChanged", arrayOf(wheel, value))
                }

                override fun onTyrePressureValueByTypeChanged(wheel: Int, value: Float) {
                    callback("onTyrePressureValueByTypeChanged", arrayOf(wheel, value))
                }

                override fun onTyrePressureStateChanged(wheel: Int, state: Int) {
                    callback("onTyrePressureStateChanged", arrayOf(wheel, state))
                }

                override fun onTyreBatteryValueChanged(wheel: Int, value: Float) {
                    callback("onTyreBatteryValueChanged", arrayOf(wheel, value))
                }

                override fun onTyreBatteryValueChanged(wheel: Int, value: Double) {
                    callback("onTyreBatteryValueChanged", arrayOf(wheel, value))
                }

                override fun onTyreBatteryStateChanged(state: Int) {
                    callback("onTyreBatteryStateChanged", arrayOf(state))
                }

                override fun onTyreTemperatureStateChanged(state: Int) {
                    callback("onTyreTemperatureStateChanged", arrayOf(state))
                }

                override fun onTyreTemperatureValueChanged(wheel: Int, value: Int) {
                    callback("onTyreTemperatureValueChanged", arrayOf(wheel, value))
                }

                override fun onTyreAirLeakStateChanged(wheel: Int, state: Int) {
                    callback("onTyreAirLeakStateChanged", arrayOf(wheel, state))
                }

                override fun onTyreSignalStateChanged(wheel: Int, state: Int) {
                    callback("onTyreSignalStateChanged", arrayOf(wheel, state))
                }

                override fun onTyreSystemStateChanged(state: Int) {
                    callback("onTyreSystemStateChanged", arrayOf(state))
                }

                override fun onIndirectTyreSystemStateChanged(state: Int) {
                    callback("onIndirectTyreSystemStateChanged", arrayOf(state))
                }
            }
            val method = device.javaClass.getMethod(
                "registerListener",
                android.hardware.bydauto.tyre.AbsBYDAutoTyreListener::class.java
            )
            method.invoke(device, listener)
            Log.i(TAG, "Tyre listener registrado com sucesso")
            true
        } catch (e: NoClassDefFoundError) {
            Log.d(TAG, "Tyre listener não disponível neste firmware")
            false
        } catch (e: Exception) {
            Log.d(TAG, "Falha ao registrar Tyre listener: ${e.message}")
            false
        }
    }

    /**
     * Registra listener do motor ICE (para PHEVs).
     * Captura: RPM, nível de óleo, nível de líquido de arrefecimento.
     */
    fun registerEngineListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return try {
            val listener = object : android.hardware.bydauto.engine.AbsBYDAutoEngineListener() {
                override fun onEngineSpeedChanged(value: Int) {
                    callback("onEngineSpeedChanged", arrayOf(value))
                }

                override fun onEngineCoolantLevelChanged(state: Int) {
                    callback("onEngineCoolantLevelChanged", arrayOf(state))
                }

                override fun onOilLevelChanged(value: Int) {
                    callback("onOilLevelChanged", arrayOf(value))
                }
            }
            val method = device.javaClass.getMethod(
                "registerListener",
                android.hardware.bydauto.engine.AbsBYDAutoEngineListener::class.java
            )
            method.invoke(device, listener)
            Log.i(TAG, "Engine listener registrado com sucesso")
            true
        } catch (e: NoClassDefFoundError) {
            Log.d(TAG, "Engine listener não disponível neste firmware")
            false
        } catch (e: Exception) {
            Log.d(TAG, "Falha ao registrar Engine listener: ${e.message}")
            false
        }
    }

    /**
     * Registra listener de energia (modos de operação e energia).
     */
    fun registerEnergyListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return try {
            val listener = object : android.hardware.bydauto.energy.AbsBYDAutoEnergyListener() {
                override fun onEnergyModeChanged(mode: Int) {
                    callback("onEnergyModeChanged", arrayOf(mode))
                }

                override fun onOperationModeChanged(mode: Int) {
                    callback("onOperationModeChanged", arrayOf(mode))
                }

                override fun onRoadSurfaceChanged(mode: Int) {
                    callback("onRoadSurfaceChanged", arrayOf(mode))
                }

                override fun oniTACModeChanged(mode: Int) {
                    callback("oniTACModeChanged", arrayOf(mode))
                }
            }
            val method = device.javaClass.getMethod(
                "registerListener",
                android.hardware.bydauto.energy.AbsBYDAutoEnergyListener::class.java
            )
            method.invoke(device, listener)
            Log.i(TAG, "Energy listener registrado com sucesso")
            true
        } catch (e: NoClassDefFoundError) {
            Log.d(TAG, "Energy listener não disponível neste firmware")
            false
        } catch (e: Exception) {
            Log.d(TAG, "Falha ao registrar Energy listener: ${e.message}")
            false
        }
    }

    /**
     * Registra listeners adicionais do Instrument (potência de carga, temperatura externa).
     */
    fun registerInstrumentListener(device: Any?, callback: (String, Array<out Any?>) -> Unit): Boolean {
        if (device == null) return false
        return try {
            val listener = object : android.hardware.bydauto.instrument.AbsBYDAutoInstrumentListener() {
                override fun onExternalChargingPowerChanged(power: Float) {
                    callback("onExternalChargingPowerChanged", arrayOf(power))
                }

                override fun onExternalChargingPowerChanged(power: Double) {
                    callback("onExternalChargingPowerChanged", arrayOf(power))
                }

                override fun onOutCarTemperatureChanged(tempC: Int) {
                    callback("onOutCarTemperatureChanged", arrayOf(tempC))
                }

                override fun onSportModeStateChanged(state: Int) {
                    callback("onSportModeStateChanged", arrayOf(state))
                }
            }
            val method = device.javaClass.getMethod(
                "registerListener",
                android.hardware.bydauto.instrument.AbsBYDAutoInstrumentListener::class.java
            )
            method.invoke(device, listener)
            Log.i(TAG, "Instrument listener adicional registrado com sucesso")
            true
        } catch (e: NoClassDefFoundError) {
            Log.d(TAG, "Instrument listener adicional não disponível")
            false
        } catch (e: Exception) {
            Log.d(TAG, "Falha ao registrar Instrument listener adicional: ${e.message}")
            false
        }
    }
}
