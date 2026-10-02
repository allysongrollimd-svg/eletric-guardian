// Generates public/fields.json from the Android app's TelemetryFieldCatalog so the
// dashboard always knows every telemetry key (label, unit, kind) the app can publish.
// Usage: node scripts/gen-fields.mjs [path/to/TelemetryFieldCatalog.java]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ||
  resolve(here, '../../app/src/main/java/com/overdrive/app/mqtt/TelemetryFieldCatalog.java');
const java = readFileSync(src, 'utf8');

const lit = (s) => (s === 'null' ? null : s.replace(/^"|"$/g, ''));
const re = /^\s*add\(\s*("[^"]*")\s*,\s*("[^"]*")\s*,\s*(SENSOR|BINARY|NONE)\s*,\s*(null|"[^"]*")\s*,\s*(\w+)\s*,\s*(null|"[^"]*")\s*,\s*(null|"[^"]*")\s*,\s*(true|false)\s*,\s*([\d.]+)\s*\);/gm;
const fields = {};
for (const m of java.matchAll(re)) {
  const [, key, name, comp, dc, , unit, , diag] = m;
  fields[lit(key)] = {
    name: lit(name),
    kind: comp === 'BINARY' ? 'binary' : (lit(dc) === 'enum' || (!lit(unit) && comp === 'SENSOR') ? 'text' : 'number'),
    unit: lit(unit),
    deviceClass: lit(dc),
    diagnostic: diag === 'true',
    hidden: comp === 'NONE',
  };
}
const out = resolve(here, '../public/fields.json');
writeFileSync(out, JSON.stringify(fields, null, 1) + '\n');
console.log(`${Object.keys(fields).length} fields -> ${out}`);
