// Teste rápido: sobe o servidor, envia como o carro e lê como o painel.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dataDir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'eg-'));
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: 'inherit',
});
const base = `http://127.0.0.1:${PORT}`;
const id = '123e4567-e89b-12d3-a456-426614174000';
const key = 'a'.repeat(48);

(async () => {
  await new Promise((r) => setTimeout(r, 500));
  const post = (k, body) => fetch(`${base}/api/car/${id}`, {
    method: 'POST', headers: { 'X-Car-Key': k, 'Content-Type': 'application/json' }, body,
  });
  assert.strictEqual((await post(key, '{"battery":{"soc":80}}')).status, 204);
  assert.strictEqual((await post('b'.repeat(48), '{}')).status, 403);
  assert.strictEqual((await post(key, 'x')).status, 400);
  assert.strictEqual((await fetch(`${base}/api/car/${id}?k=errada`)).status, 403);
  const snap = await (await fetch(`${base}/api/car/${id}?k=${key}`)).json();
  assert.strictEqual(snap.battery.soc, 80);
  const page = await fetch(`${base}/car/${id}?k=${key}`);
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes('connectCloud'));

  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/car/${id}/stream?k=${key}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes('"soc":80'));
  await post(key, '{"battery":{"soc":81}}');
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.ok(next.includes('"soc":81'));
  ctrl.abort();
  console.log('ok');
  srv.kill();
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
