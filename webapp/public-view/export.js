// "Exportar" for Deslocamentos / Recargas: pulls the history from the car's own API (same origin, through the tunnel)
// and hands the customer a spreadsheet-friendly CSV (Excel in Portuguese opens it directly).
(function () {
  var btn = document.getElementById('exportBtn'); if (!btn) return;
  var KIND = btn.getAttribute('data-kind');
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var fdate = function (ms) { if (!ms) return ''; var d = new Date(+ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  var num = function (v, dec) { return v == null || v === '' || isNaN(+v) ? '' : (+v).toFixed(dec).replace('.', ','); };
  var yes = function (v) { return v ? 'sim' : 'não'; };
  var DEF = {
    trips: {
      url: function (days, limit, off) { return '/api/trips?days=' + days + '&limit=' + limit + '&offset=' + off; }, key: 'trips', page: 50, file: 'deslocamentos',
      cols: [
        ['Início', function (r) { return fdate(r.startTime); }], ['Fim', function (r) { return fdate(r.endTime); }],
        ['Distância (km)', function (r) { return num(r.distanceKm, 1); }], ['Duração (min)', function (r) { return num((r.durationSeconds || 0) / 60, 0); }],
        ['Velocidade média (km/h)', function (r) { return num(r.avgSpeedKmh, 0); }], ['Velocidade máxima (km/h)', function (r) { return num(r.maxSpeedKmh, 0); }],
        ['Bateria no início (%)', function (r) { return num(r.socStart, 0); }], ['Bateria no fim (%)', function (r) { return num(r.socEnd, 0); }],
        ['Energia usada (kWh)', function (r) { return num(r.energyUsedKwh, 2); }], ['Consumo (kWh/100 km)', function (r) { return num((r.energyPerKm || 0) * 100, 1); }],
        ['Custo', function (r) { return num(r.tripCost, 2); }], ['Moeda', function (r) { return r.currency || ''; }],
        ['Odômetro início (km)', function (r) { return num(r.odometerStartKm, 0); }], ['Odômetro fim (km)', function (r) { return num(r.odometerEndKm, 0); }],
        ['Latitude início', function (r) { return num(r.startLat, 5); }], ['Longitude início', function (r) { return num(r.startLng, 5); }],
        ['Latitude fim', function (r) { return num(r.endLat, 5); }], ['Longitude fim', function (r) { return num(r.endLng, 5); }],
      ],
    },
    charging: {
      url: function (days, limit, off) { return '/api/charging?days=' + (days >= 36500 ? 0 : days) + '&limit=' + limit + '&offset=' + off; }, key: 'sessions', page: 200, file: 'recargas',
      cols: [
        ['Início', function (r) { return fdate(r.startTime); }], ['Fim', function (r) { return fdate(r.endTime); }],
        ['Duração (min)', function (r) { return num(r.durationMinutes, 0); }], ['Bateria no início (%)', function (r) { return num(r.startSoc, 0); }], ['Bateria no fim (%)', function (r) { return num(r.endSoc, 0); }],
        ['Energia adicionada (kWh)', function (r) { return num(r.energyAdded, 2); }], ['Potência máxima (kW)', function (r) { return num(r.peakPower, 1); }], ['Potência média (kW)', function (r) { return num(r.avgPower, 1); }],
        ['Tipo', function (r) { return r.isDc ? 'Rápido (CC)' : 'Normal (CA)'; }], ['Autonomia ganha (km)', function (r) { return num(r.rangeGained, 0); }],
        ['Tarifa (por kWh)', function (r) { return num(r.electricityRate, 2); }], ['Custo', function (r) { return num(r.cost, 2); }], ['Moeda', function (r) { return r.currency || ''; }],
        ['Local', function (r) { return r.placeLabel || ''; }], ['Tarifa usada', function (r) { return r.tariffLabel || ''; }], ['Em andamento', function (r) { return yes(r.inProgress); }],
        ['Temperatura média (°C)', function (r) { return num(r.tempAvg, 0); }], ['Latitude', function (r) { return num(r.lat, 5); }], ['Longitude', function (r) { return num(r.lng, 5); }],
      ],
    },
  }[KIND];
  if (!DEF) return;

  var sheet = document.createElement('div');
  sheet.className = 'xsheet'; sheet.hidden = true;
  sheet.innerHTML = '<div class="xbox" role="dialog" aria-label="Exportar dados"><h2>Exportar dados</h2><p>Escolha o período. O arquivo abre direto no Excel ou no Planilhas.</p>' +
    '<div class="xopts" id="xopts"><button data-d="30" class="on">30 dias</button><button data-d="90">90 dias</button><button data-d="365">12 meses</button><button data-d="36500">Tudo</button></div>' +
    '<p id="xmsg" class="xmsg" role="status"></p><div class="xact"><button id="xcancel" class="xghost" type="button">Cancelar</button><button id="xgo" type="button">Exportar</button></div></div>';
  document.body.appendChild(sheet);
  var days = 30, busy = false, $ = function (id) { return document.getElementById(id); };
  btn.addEventListener('click', function () { $('xmsg').textContent = ''; sheet.hidden = false; });
  $('xcancel').addEventListener('click', function () { if (!busy) sheet.hidden = true; });
  $('xopts').addEventListener('click', function (e) { var b = e.target.closest('button[data-d]'); if (!b || busy) return; days = +b.getAttribute('data-d'); [].forEach.call($('xopts').children, function (x) { x.classList.toggle('on', x === b); }); });

  function esc(v) { v = String(v == null ? '' : v); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  async function fetchAll() {
    var rows = [], off = 0;
    for (var i = 0; i < 400; i++) {
      var r = await fetch(DEF.url(days, DEF.page, off), { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json(), list = (j && j[DEF.key]) || [];
      rows = rows.concat(list); off += list.length;
      $('xmsg').textContent = 'Buscando no carro… ' + rows.length + ' registros';
      if (list.length < DEF.page) break;
    }
    return rows;
  }
  function toCsv(rows) {
    var out = [DEF.cols.map(function (c) { return esc(c[0]); }).join(';')];
    rows.forEach(function (r) { out.push(DEF.cols.map(function (c) { try { return esc(c[1](r)); } catch (e) { return ''; } }).join(';')); });
    return '﻿' + out.join('\r\n') + '\r\n';
  }
  async function save(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    try {
      var file = new File([blob], name, { type: 'text/csv' });
      if ('ontouchstart' in window && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  $('xgo').addEventListener('click', async function () {
    if (busy) return; busy = true; $('xgo').disabled = true; $('xmsg').textContent = 'Buscando no carro…';
    try {
      var rows = await fetchAll();
      if (!rows.length) { $('xmsg').textContent = 'Não há registros neste período.'; return; }
      var d = new Date(); await save('eletric-guardian-' + DEF.file + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.csv', toCsv(rows));
      $('xmsg').textContent = rows.length + ' registros exportados.'; setTimeout(function () { sheet.hidden = true; }, 1200);
    } catch (e) { $('xmsg').textContent = 'Não foi possível exportar agora. Confira se o carro está online e tente de novo.'; }
    finally { busy = false; $('xgo').disabled = false; }
  });
})();
