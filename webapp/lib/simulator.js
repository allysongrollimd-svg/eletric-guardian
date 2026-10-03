// Fake vehicle so the dashboard can be explored without a car: a short drive loop + charging stop.
export function makeSample(tSec) {
  const phase = tSec % 240;
  const charging = phase >= 180;
  const driving = !charging;
  const speed = driving ? Math.max(0, 55 + 35 * Math.sin(tSec / 9) + 8 * Math.sin(tSec / 2.3)) : 0;
  const soc = charging ? 42 + ((phase - 180) / 60) * 40 : 80 - (phase / 180) * 38;
  const power = driving ? (speed - 45) * 0.9 + 6 * Math.sin(tSec / 3) : 0;
  const ang = tSec / 40;
  const r = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    soc: r(soc), speed: r(speed), power: r(power), gear: driving ? 'D' : 'P',
    is_charging: charging, is_parked: charging, charge_power: charging ? r(48 + 4 * Math.sin(tSec / 5)) : 0,
    charging_pct: charging ? r(soc, 0) : 0, charging_eta_minutes: charging ? Math.round((82 - soc) * 1.6) : 0,
    ev_range_km: Math.round(soc * 4.2), odometer: r(12345 + tSec * 0.012, 1),
    trip_km: r(driving ? phase * 0.0155 * 60 / 60 : 0, 1), trip_kwh: r(driving ? phase * 0.012 : 0, 1),
    consumption_50km: r(14 + 3 * Math.sin(tSec / 20)),
    ext_temp: r(24 + Math.sin(tSec / 60)), cabin_temp: r(22 + 0.5 * Math.sin(tSec / 30)), batt_temp: r(29 + 4 * (speed / 90) + (charging ? 5 : 0)),
    lat: r(-23.5505 + 0.01 * Math.sin(ang), 5), lon: r(-46.6333 + 0.015 * Math.cos(ang), 5), heading: Math.round(((ang * 180) / Math.PI + 90) % 360),
  };
}
export function startSimulator(store, device = 'demo', intervalMs = 1000) {
  const t0 = Date.now();
  const tick = () => store.update(device, makeSample((Date.now() - t0) / 1000));
  tick();
  const h = setInterval(tick, intervalMs);
  h.unref();
  return () => clearInterval(h);
}
