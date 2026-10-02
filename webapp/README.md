# Electric Guardian — painel em tempo real

Servidor Node.js (única dependência: `mqtt`) que recebe a telemetria do carro e a empurra ao navegador por
**Server‑Sent Events**. Dashboard PWA em português: bateria, velocidade, potência/regeneração, carga, viagem,
temperaturas, odômetro, gráficos dos últimos 30 min, mapa e tabela com **todos** os campos publicados
(`public/fields.json` é gerado do `TelemetryFieldCatalog.java` do app: `npm run gen:fields`).

## Rodar local

```bash
npm install
npm run dev          # carro simulado, token "dev", http://localhost:8787
npm test             # 23 testes (parser, auth, SSE, WebSocket, store, controle, PIN…)
```

## Configurar o app do carro (obrigatório para os controles)

No app (tela do carro ou `http://<ip-do-carro>:8080`): **Configurações → MQTT → nova conexão**.

| Campo | Valor |
|---|---|
| Broker / porta | o seu broker na nuvem (use TLS: `ssl://…:8883`) + usuário/senha |
| Tópico | `electric-guardian/car/telemetry` (um tópico diferente por carro: `electric-guardian/<carro>/telemetry`) |
| **Home Assistant** | **ligado** (o app passa a publicar um tópico retido por campo; é o único modo que aceita comandos) |
| **Permitir controle** | ligado (aparece quando "Home Assistant" está ligado; **desligado por padrão no app**) |
| Intervalo | mínimo 5 s; "só quando mudar" ligado economiza dados |

O painel entende os dois modos de telemetria: JSON agregado (sem controles) e campos retidos (com controles).

## Controle remoto

Aba **Controles**: ar-condicionado, bancos, vidros, porta-malas, teto, luzes, limite de carga, modos de condução e ADAS —
os 59 controles que o app aceita (`public/controls.json` é gerado de `VehicleControlCatalog.java`: `npm run gen:controls`).

Camadas de segurança (o painel dá acesso físico ao carro):
1. **Desligado por padrão** no servidor (`CONTROL_ENABLED=1`) *e* no app ("Permitir controle").
2. Login do painel + **PIN de controle** separado, que desbloqueia por 10 min (5 tentativas / 5 min por IP).
3. **Confirmação** para vidros, porta-malas, teto, condução e ADAS.
4. Cada valor é validado contra o catálogo do app antes de ir ao broker; limite de comandos por minuto e por controle; **log de auditoria**.
5. O app mantém as proteções dele: bloqueio em movimento, comandos *retidos* ignorados, só SDK local.
6. O carro **não confirma** o comando: o painel mostra o estado vindo da telemetria. Não há "desfazer".

Alguns controles (ex.: modo híbrido, retenção de bateria) só existem em modelos PHEV; em outros o app recusa o comando.

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

## Tempo real: WebSocket (com SSE de reserva) e de onde vem o atraso

O navegador abre um **WebSocket** (`/api/ws`) que recebe os dados e também envia comandos/PIN pela mesma conexão
(sem novo pedido HTTP a cada clique). Se um proxy bloquear WebSocket, cai sozinho para SSE em 4 s. O selo no topo mostra
`WS · 38 ms` (ida e volta até o servidor) ou `SSE`. `?sse=1` na URL força o SSE.

Medição (broker + navegador reais, mesma máquina, 40 amostras): do *publish* no MQTT até aparecer na tela,
**mediana 3 ms, p95 4–5 ms, tanto em WebSocket quanto em SSE**. Ou seja, o trecho broker → servidor → tela já é
instantâneo, e trocar o protocolo não muda isso. O atraso que você vai perceber vem de fora do painel:

| Trecho | Atraso típico | O que fazer |
|---|---|---|
| App publica a cada N s | 1–5 s | *Configurações → MQTT → intervalo mínimo = 1 s* (novo padrão), "só quando mudar" ligado |
| 4G do carro → broker | 50–300 ms | broker perto (mesma região), QoS 0 |
| Broker → servidor → navegador | ~3 ms | já otimizado (envio imediato + fusão de rajadas de 60 ms) |
| Carro recebe o comando | 50–300 ms + execução do app | — |

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
