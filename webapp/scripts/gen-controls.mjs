// Generates public/controls.json from the Android app's VehicleControlCatalog.java so the
// webapp only offers controls (and payload domains) the app actually accepts.
// Usage: node scripts/gen-controls.mjs [path/to/VehicleControlCatalog.java]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || resolve(here, '../../app/src/main/java/com/overdrive/app/mqtt/VehicleControlCatalog.java');
const java = readFileSync(src, 'utf8');

// Portuguese label + UI group per key. Unknown keys fall back to the English name in "outros".
const PT = {
  climate: ['Ar-condicionado', 'clima'], seat_heat_driver: ['Banco aquecido (motorista)', 'clima'], seat_heat_passenger: ['Banco aquecido (passageiro)', 'clima'],
  seat_vent_driver: ['Banco ventilado (motorista)', 'clima'], seat_vent_passenger: ['Banco ventilado (passageiro)', 'clima'], steering_heat: ['Volante aquecido', 'clima'],
  windows_all: ['Vidros', 'acesso'], windows_vent: ['Ventilar vidros', 'acesso'], tailgate: ['Porta-malas', 'acesso'], sunroof: ['Teto solar', 'acesso'], sunshade: ['Cortina do teto', 'acesso'],
  child_lock: ['Trava infantil', 'acesso'], mirror_fold: ['Dobrar retrovisores', 'acesso'], mirror_auto_follow_up: ['Retrovisor acompanha ré', 'acesso'],
  drl: ['Luz diurna (DRL)', 'luzes'], headlight_mode: ['Faróis', 'luzes'], hazard: ['Pisca-alerta', 'luzes'], ambient_power: ['Luz ambiente', 'luzes'],
  ambient_colour: ['Cor da luz ambiente', 'luzes'], ambient_brightness: ['Brilho da luz ambiente', 'luzes'],
  charge_cap_enabled: ['Limite de carga', 'carga'], charge_cap_percent: ['Limite de carga (%)', 'carga'], smart_charging: ['Carga inteligente', 'carga'],
  start_charging_now: ['Iniciar carga agora', 'carga'], target_soc: ['Meta de bateria (%)', 'carga'], wireless_charging: ['Carregador por indução', 'carga'],
  wireless_charging_left: ['Indução esquerda', 'carga'], wireless_charging_right: ['Indução direita', 'carga'],
  drive_mode: ['Modo de condução', 'conducao'], powertrain_mode: ['Modo do motor', 'conducao'], regen_level: ['Regeneração', 'conducao'], steering_mode: ['Direção', 'conducao'],
  brake_feel: ['Pedal de freio', 'conducao'], hold_battery: ['Motor a combustão (modo HEV)', 'conducao'], battery_hold: ['Reter carga da bateria', 'conducao'],
  esp_control: ['Controle de estabilidade (ESP)', 'conducao'], itac: ['iTAC (torque)', 'conducao'],
  lane_assist: ['Assistente de faixa', 'adas'], adas_slw: ['Aviso de limite de velocidade', 'adas'], adas_cpd: ['Detecção de criança', 'adas'],
  adas_bsd: ['Ponto cego', 'adas'], adas_tsr: ['Leitura de placas', 'adas'], adas_rcta: ['Alerta tráfego traseiro', 'adas'], adas_fcta: ['Alerta tráfego frontal', 'adas'],
  adas_tla: ['Atenção ao semáforo', 'adas'], adas_dow: ['Aviso porta aberta', 'adas'], adas_rcw: ['Alerta colisão traseira', 'adas'], adas_islc: ['Limite inteligente de velocidade', 'adas'],
  adas_elka: ['Manutenção de faixa (emergência)', 'adas'], adas_rctb: ['Frenagem traseira', 'adas'], adas_fctb: ['Frenagem frontal', 'adas'], adas_aeb: ['Frenagem autônoma (AEB)', 'adas'],
  adas_fcw: ['Alerta colisão frontal', 'adas'],
  infotainment_rotation: ['Rotação da tela', 'outros'], native_camera_view: ['Câmera 360', 'outros'], seat_memory_driver: ['Memória do banco', 'outros'],
};
const GROUP_ORDER = ['clima', 'acesso', 'luzes', 'carga', 'conducao', 'adas', 'outros'];
// Anything that physically moves, or that weakens a safety system, needs an explicit confirmation.
const CONFIRM_GROUPS = new Set(['acesso', 'conducao', 'adas']);

// Constants referenced from other classes / local finals.
let consts = {};
try {
  const collector = readFileSync(resolve(dirname(src), '../byd/BydDataCollector.java'), 'utf8');
  for (const m of collector.matchAll(/public static final int (SOC_TARGET_MIN|SOC_TARGET_MAX)\s*=\s*(\d+)/g)) consts[`BydDataCollector.${m[1]}`] = Number(m[2]);
} catch { /* optional */ }
const lists = {};
for (const m of java.matchAll(/(?:static\s+)?final\s+List<String>\s+(\w+)\s*=\s*(?:java\.util\.)?(?:Arrays\.asList|List\.of)\(([^;]*?)\)\s*;/gs)) {
  lists[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

/** Split call args at depth 0 until the command lambda starts. */
function parseArgs(s, from) {
  const args = []; let depth = 0, cur = '', inStr = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === '\\') cur += s[++i]; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (depth === 0 && /^\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*->/.test(s.slice(i, i + 60))) break;
    if (c === '(') depth++;
    if (c === ')') { if (depth === 0) break; depth--; }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}
const str = (a) => (a == null || a === 'null' ? null : a.startsWith('"') ? JSON.parse(a) : null);
const num = (a) => { if (a in consts) return consts[a]; const n = parseFloat(a); return Number.isFinite(n) ? n : null; };
const opts = (a) => {
  if (!a) return null;
  if (lists[a]) return lists[a];
  const m = a.match(/"[^"]*"/g);
  return m ? m.map((x) => JSON.parse(x)) : null;
};

const out = [];
const re = /register\(\s*(sw|select|number|cover|text|climate|new ControlEntity)\(/g;
for (const m of java.matchAll(re)) {
  const f = m[1];
  const a = parseArgs(java, m.index + m[0].length);
  let e;
  if (f === 'sw') e = { platform: 'switch', key: str(a[0]), name: str(a[1]), icon: str(a[2]), category: str(a[3]), stateKey: str(a[4]), sensitive: false };
  else if (f === 'select') e = { platform: 'select', key: str(a[0]), name: str(a[1]), icon: str(a[2]), category: str(a[3]), stateKey: str(a[4]), options: opts(a[5]), sensitive: false };
  else if (f === 'number') e = { platform: 'number', key: str(a[0]), name: str(a[1]), icon: str(a[2]), category: str(a[3]), stateKey: str(a[4]), min: num(a[5]), max: num(a[6]), step: num(a[7]), unit: str(a[8]), sensitive: false };
  else if (f === 'cover') e = { platform: 'cover', key: str(a[0]), name: str(a[1]), icon: str(a[2]), category: null, stateKey: str(a[5]), sensitive: a[4] === 'true' };
  else if (f === 'text') e = { platform: 'text', key: str(a[0]), name: str(a[1]), icon: str(a[2]), category: str(a[3]), stateKey: null, sensitive: false };
  else if (f === 'climate') e = { platform: 'climate', key: 'climate', name: 'Climate', icon: 'mdi:air-conditioner', category: null, stateKey: null, sensitive: false, min: 17, max: 33, step: 1 };
  else e = { platform: str(a[1]), key: str(a[0]), name: str(a[2]), icon: str(a[3]), category: str(a[4]), sensitive: a[5] === 'true', stateKey: str(a[6]), min: num(a[7]), max: num(a[8]), step: num(a[9]), unit: str(a[10]), options: opts(a[11]) };
  if (!e.key || !e.platform) continue;
  const [label, group] = PT[e.key] || [e.name, 'outros'];
  out.push({ ...e, label, group, confirm: e.sensitive || CONFIRM_GROUPS.has(group) });
}
// "climate" is registered through a different helper shape: make sure it is present.
if (!out.some((c) => c.key === 'climate') && /register\(climate\(/.test(java)) {
  out.push({ platform: 'climate', key: 'climate', name: 'Climate', icon: 'mdi:air-conditioner', category: null, stateKey: null, sensitive: false, min: 17, max: 33, step: 1, label: 'Ar-condicionado', group: 'clima', confirm: false });
}
out.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group));
const dest = resolve(here, '../public/controls.json');
writeFileSync(dest, JSON.stringify({ groups: GROUP_ORDER, controls: out }, null, 1) + '\n');
const byPlatform = out.reduce((a, c) => ((a[c.platform] = (a[c.platform] || 0) + 1), a), {});
console.log(`${out.length} controls -> ${dest}`, byPlatform);
