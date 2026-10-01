package br.com.eletricguardian.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TripTrackerTest {

    private fun snap(
        tSec: Long,
        speed: Double,
        odo: Double? = null,
        kwh: Double? = null,
        soc: Double? = null,
        power: PowerState = PowerState.ON,
        lat: Double? = null,
    ) = VehicleSnapshot(
        timestampMs = tSec * 1000,
        powerState = power,
        speedKmh = speed,
        odometerKm = odo,
        battery = BatteryState(socPct = soc),
        energy = EnergyCounters(totalConsumedKwh = kwh),
        location = lat?.let { GeoPoint(it, -46.6, timestampMs = tSec * 1000) },
    )

    @Test
    fun `nao abre viagem com carro parado`() {
        val t = TripTracker()
        assertNull(t.onSnapshot(snap(0, 0.0)))
        assertEquals(false, t.inProgress)
    }

    @Test
    fun `fecha ao desligar e calcula consumo pelo contador`() {
        val t = TripTracker()
        t.onSnapshot(snap(0, 30.0, odo = 1000.0, kwh = 500.0, soc = 80.0))
        t.onSnapshot(snap(600, 60.0, odo = 1010.0, kwh = 501.5, soc = 77.0))
        val trip = t.onSnapshot(snap(660, 0.0, power = PowerState.OFF))

        assertNotNull(trip)
        assertEquals(10.0, trip.distanceKm, 1e-9)
        assertEquals(1.5, trip.energyKwh!!, 1e-9)
        assertEquals(15.0, trip.consumptionKwhPer100Km!!, 1e-9)
        assertEquals(80.0, trip.socStartPct)
        assertEquals(77.0, trip.socEndPct)
        assertEquals(60.0, trip.maxSpeedKmh)
        assertEquals(false, t.inProgress)
    }

    @Test
    fun `fecha por inatividade e termina no ultimo movimento`() {
        val t = TripTracker(idleCloseMs = 300_000)
        t.onSnapshot(snap(0, 20.0, odo = 0.0))
        t.onSnapshot(snap(100, 20.0, odo = 1.0))
        assertNull(t.onSnapshot(snap(200, 0.0, odo = 1.0)))
        val trip = t.onSnapshot(snap(400, 0.0, odo = 1.0))

        assertNotNull(trip)
        assertEquals(100_000, trip.durationMs)
    }

    @Test
    fun `usa GPS quando nao ha odometro`() {
        val t = TripTracker()
        t.onSnapshot(snap(0, 40.0, lat = -23.50))
        t.onSnapshot(snap(60, 40.0, lat = -23.51))
        val trip = t.flush()

        assertNotNull(trip)
        // 0,01 grau de latitude ~ 1,11 km
        assertTrue(trip.distanceKm in 1.10..1.12, "distancia ${trip.distanceKm}")
        assertNull(trip.energyKwh)
        assertNull(trip.consumptionKwhPer100Km)
    }

    @Test
    fun `simulador gera viagem com consumo plausivel`() {
        val src = MockVehicleDataSource()
        val t = TripTracker()
        for (s in 0..600L) t.onSnapshot(src.read(s * 1000))
        val trip = t.flush()

        assertNotNull(trip)
        assertTrue(trip.distanceKm > 1.0)
        val c = trip.consumptionKwhPer100Km!!
        assertTrue(c in 5.0..40.0, "consumo $c")
    }
}
