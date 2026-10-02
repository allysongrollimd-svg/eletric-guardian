# Electric Guardian — painel em tempo real

Servidor Node.js (única dependência: `mqtt`) que recebe a telemetria do carro e a empurra ao navegador por
**Server‑Sent Events**. Dashboard PWA em português: bateria, velocidade, potência/regeneração, carga, viagem,
temperaturas, odômetro, gráficos dos últimos 30 min, mapa e tabela com **todos** os campos publicados
(`public/fields.json` é gerado do `TelemetryFieldCatalog.java` do app: `npm run gen:fields`).

## Rodar local

```bash
npm install
npm run dev          # carro simulado, token "dev", http://localhost:8787
npm test             # 9 testes (parser, auth, SSE, store…)
```

## Como os dados chegam

1. **MQTT (recomendado).** No app: *Configurações → MQTT*, broker + credenciais, tópico
   `electric-guardian/<carro>/telemetry`. O app também publica `…/telemetry/availability`
   (`online`/`offline`), usado para o status Online/Offline. O painel assina `MQTT_TOPIC`
   (padrão `electric-guardian/+/telemetry`); o `<carro>` vira o seletor de veículo.
2. **HTTP.** `POST /api/ingest/<carro>` com `Authorization: Bearer $INGEST_TOKEN` e um JSON plano
   (`{"soc": 71.2, "speed": 0, ...}`). Teste: `INGEST_TOKEN=x npm run simulate`.

## Produção (Docker Compose)

```bash
cp .env.example .env                      # edite DASHBOARD_TOKEN, MQTT_PASSWORD…
mkdir -p mosquitto
docker run --rm -v "$PWD/mosquitto:/mosquitto/config" eclipse-mosquitto \
  mosquitto_passwd -b -c /mosquitto/config/passwd guardian 'SUA-SENHA'
docker compose up -d
```

Coloque o painel atrás de **HTTPS** (Caddy, Traefik, Cloudflare Tunnel). O cookie de sessão ganha `Secure`
quando o proxy envia `X-Forwarded-Proto: https`. Prefira TLS também no broker (`mqtts://`) — a telemetria
contém posição GPS.

## Segurança

- Sem `DASHBOARD_TOKEN` o servidor **não sobe** (exceto `ALLOW_INSECURE=1`, só para testes locais).
- Token comparado em tempo constante; login limitado a 10 tentativas/min por IP; cookie `HttpOnly; SameSite=Strict`.
- Ingest HTTP exige token próprio (`INGEST_TOKEN`); payloads limitados a 256 KB e normalizados (sem objetos aninhados).
- CSP restritiva; a interface só usa `textContent` (sem `innerHTML`).
- Dados ficam **em memória** (histórico limitado); reiniciar o servidor zera o histórico.

## Variáveis

Veja `.env.example`. Principais: `DASHBOARD_TOKEN`, `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TOPIC`,
`INGEST_TOKEN`, `OFFLINE_AFTER_SECONDS` (padrão 90), `HISTORY_MAX_POINTS`, `DEMO`.

## Limitações

- Mapa via iframe do OpenStreetMap (precisa de internet no navegador).
- Sem banco de dados: sem histórico além da memória/sessão. Próximo passo natural: SQLite/Timescale + viagens.
- Dockerfile/compose escritos mas não testados neste ambiente (sem Docker); servidor, MQTT e UI foram testados.
