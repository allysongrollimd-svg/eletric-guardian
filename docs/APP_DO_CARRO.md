# App do carro (APK) — inventário completo

Levantamento feito lendo o código do app (831 arquivos, ~470 mil linhas, 171 permissões, 27 páginas web, ~340 rotas de API local).
Objetivo: saber **o que já temos no serviço**, **o que o app faz e ainda não aproveitamos** e **o que falta para instalar com segurança**.
Tudo aqui vem do código; o que depende de ver o carro funcionando está marcado como **(a confirmar)**.

Legenda: ✅ já está no webapp · 🟡 existe no app, só parcialmente no webapp · ⬜ existe no app, ainda não está no webapp · 🔒 avançado/risco (admin ou só no carro)

---

## 1. Como o app funciona por dentro (resumo)

1. **O APK** (`com.overdrive.app`, mira Android 7/targetSdk 25 de propósito: assim as permissões comuns vêm concedidas na instalação) é só a "casca" que o cliente abre.
2. **O privilégio de verdade vem do ADB**: o app conecta em `localhost:5555` (ADB sem fio **ligado no carro**), usa uma chave RSA própria (`adbkey`, o carro mostra "Permitir depuração" uma vez) e, por esse canal, **inicia daemons como usuário `shell` (UID 2000)** e roda `pm grant` em todas as permissões (`PermissionGranter`).
3. **Os daemons** (processos independentes do app, reiniciados por vigilância a cada 30 s e quando o ADB reconecta):
   - `CameraDaemon` — câmeras 360, gravação, servidor HTTP/WebSocket local (porta do app), IPC.
   - `AccSentryDaemon` / `SentryDaemon` — detecta ignição (ACC) e arma a Sentinela com o carro desligado.
   - `TelegramBotDaemon`, `GlobalProxyDaemon` (proxy/4G), mais serviços Android (listados no item 3).
4. **Sensores e comandos do carro** vêm das bibliotecas da BYD (`BYDAUTO_*`) — 135 permissões BYD cobrindo ar-condicionado, portas, vidros, bancos, bateria (BMS), motor, ADAS, radar, pneus, luzes, carga, painel etc.
5. **Nuvem Electric Guardian** (`cloud/CloudClient`): registro por QR, **túnel reverso** (câmeras e páginas do carro), **MQTT** (telemetria + comandos), vigilância do link.

---

## 2. Permissões e acessos exigidos

| Grupo | Para quê | Como é obtido hoje |
|---|---|---|
| ADB sem fio `localhost:5555` + aceitar a chave | tudo que roda como `shell` | **manual no carro** (ver item 6) |
| ~135 permissões `BYD*` + `BYD_CAMERA`, `BYDACQUISITION_*` | ler/comandar o carro, câmeras | `pm grant` automático via ADB |
| Câmera, microfone (`RECORD_AUDIO`), local (inclui segundo plano) | gravação, áudio da cabine, GPS | `pm grant` |
| Armazenamento (`MANAGE_EXTERNAL_STORAGE`, leitura/escrita) | salvar gravações no carro/SD/USB | `pm grant`; pode exigir tela do sistema (a confirmar) |
| Sobrepor outros apps (`SYSTEM_ALERT_WINDOW`) | avisos na tela, Dissuasão | `pm grant` / tela do sistema (a confirmar) |
| Serviço de acessibilidade (`KeepAliveAccessibilityService`) | manter o app vivo e captar teclas | **manual** (a confirmar se o ADB consegue ativar sozinho) |
| `WRITE_SECURE_SETTINGS`, `WRITE_SETTINGS`, `READ_LOGS`, `FORCE_STOP_PACKAGES`, `DEVICE_ACC`, `DEVICE_POWER` | energia, ACC, sessão | `pm grant` |
| Otimização de bateria / manter acordado com ACC desligado | Sentinela 24h | automático (`Di5ParkedPowerHold`, `WifiLock`, keep-alive) |
| `INTERNET`, Wi‑Fi/rede, Bluetooth | nuvem, hotspot, gatilhos | instalação |

**Risco principal da instalação:** tudo depende do ADB sem fio permanecer ativo. O app tem rotinas de persistência (Wireless 5555 + USB) e de "auto-cura", mas se o carro desativar a depuração (atualização OTA da BYD, por exemplo), os daemons param. Precisamos de um **diagnóstico que avise** (item 7).

---

## 3. Inventário por área

### 3.1 Telemetria (o que o carro envia para a nuvem)
134 campos catalogados (`TelemetryFieldCatalog`); 33 aparecem no Painel, 101 são "diagnóstico" (escondidos do cliente).
- ✅ Bateria (SoC, meta, SoH, capacidade), potência do motor (kW, consumo/regeneração), velocidade, marcha, odômetro, autonomia, combustível (PHEV), temperaturas (bateria, cabine, externa), 12 V, pressão dos 4 pneus, PM2.5 (dentro/fora), viagem atual (km, horas, kWh, consumo), estado e potência de carga, ETA de carga, V2L, DC rápido.
- ✅ Novo: velocidade, pedais, potência, rpm e torque a 4×/s (fluxo ao vivo, 250 ms).
- 🟡 Campos de diagnóstico (101): tensão do pack, células (máx/mín/delta), rpm dos motores, torque dianteiro, acelerador/freio, estado das chaves, portas, cintos, etc. — só no Painel de admin/diagnóstico, nada para o cliente.
- ⬜ Não explorado: histórico de SoC (`SocHistoryDatabase`), estimativa de SoH (`SohEstimator`), uso de dados móveis (`DataUsageMonitor`), qualidade de sessões de carga, química da bateria.

### 3.2 Controle remoto
59 controles (`VehicleControlCatalog`), por MQTT, com confirmação nos sensíveis. ✅ no webapp (aba Controles), em 7 grupos:
- Clima (6): ar-condicionado, bancos aquecido/ventilado (2+2), volante aquecido.
- Acesso (8): vidros, ventilar, porta-malas, teto solar, cortina, trava infantil, retrovisores.
- Luzes (6): DRL, faróis, pisca-alerta, luz ambiente (cor/brilho).
- Carga (8): limite, carga inteligente, iniciar carga, carregador por indução (esq./dir.), meta de bateria.
- Condução (9): ESP, iTAC, modo de condução, modo do motor, HEV, reter bateria, regeneração, direção, freio.
- ADAS (16): limites de velocidade, assistente de faixa, ponto cego, placas, alertas de tráfego/colisão, frenagem, AEB.
- Outros (6): partida remota do clima (+ agendamento), memória do banco, agendamento de carga, rotação da tela, câmera 360.
- ⬜ Existe no app mas fora do catálogo/webapp: `QuickControls`, `VehicleActuatorService`, `EnergyModeActuator`, posições dos bancos (`seat-positions`), mapeamento de teclas (`key-mapping`).

### 3.3 Câmeras, gravação e Sentinela
- ✅ Ao vivo (4 câmeras), lista de gravações Sentinela e Dashcam por dia com miniaturas, player com zoom por câmera, download, filtros por objeto (pessoa/veículo/bicicleta/animal).
- ✅ Configurações enxutas para o cliente (Sentinela e Dashcam; Dashcam OEM removida; Modo de Direção; "Ativar vigilância" primeiro; Locais Seguros).
- 🟡 Detecção por IA (YOLO) com zonas, vadiagem, sensibilidade, filtro de sombra — escondido do cliente (decisão sua).
- ⬜ Não explorado: gravação **4K HEVC** (perfil `ULTRA_4K`, 12 Mbps) — hoje o padrão é 1080p; **Proximity Guard** (grava por radar de proximidade); **clipe manual** (`ManualClipService`); **Parking Intelligence** (reconhece placa de sinalização/vaga com OCR e guarda local de estacionamento); **Eventos** (linha do tempo de eventos com vídeo); gravação nas telas de SD/USB; limpeza automática de armazenamento.
- 🔒 Dissuasão na tela (`DeterrentActivity`/`BlockerActivity`) — escondida.

### 3.4 Deslocamentos e Recargas
- ✅ Páginas do carro no webapp (viagens com nota de condução/"DNA", resumo por período, estatísticas, sessões de carga, custo por tarifa).
- ⬜ Dados já calculados no app, ainda sem tela própria: **pontuação de direção** (`TripScoreEngine`, `MicroMoments`), **estimativa de autonomia** (`RangeEstimator`), **elevação**, **consumo por faixa** (`ConsumptionBucket`), **resumos semanais/mensais**, **tarifas** (`TariffManager`: horário/dia), **calibração do contador de energia** (`CounterScaleCalibrator`).

### 3.5 Navegação e mapa
- ⬜ `navmap`: navegação própria (rotas Valhalla, busca, locais salvos, POIs via Overpass, voz, projeção no painel de instrumentos), **RoadSense** (detecta buracos/lombadas por IMU e avisa; mapa de perigos). RoadSense vem desativado no rebrand (backend vazio).
- ⬜ `geo`: geocodificação reversa (Nominatim) e cache — base para "onde estacionei".

### 3.6 Automações e integrações
- ⬜ **Automações** (74 arquivos): gatilhos (porta, marcha, cinto, pisca, clima, Bluetooth, hora/pôr do sol, rede, modo de condução, ponto cego, regeneração, MQTT, variáveis) + ações (comando do carro, notificação, shell, esperar, condicional, grupos). Muito poderoso, hoje só pelo carro.
- ⬜ **Telegram** (bot: alertas de sentinela, vídeo, túnel), **ABRP** (telemetria para planejador de rotas), **MQTT/Home Assistant** (já usamos), **Nuvem BYD** (engenharia reversa, risco legal), **notificações push Web (VAPID)** (infra pronta no app!), **GenAI** (assistente, insights, rotinas aprendidas), **Hotspot/rede** (4G, sing-box/Tailscale/Zrok/Cloudflared).
- ⬜ **Voz remota / comunicação**: falar com a cabine pelo celular, áudio da cabine ao vivo (`CabinAudio*`) — exige política de privacidade.
- ⬜ **Remote Dev View** (espelhar a tela do carro), **Projeção** na tela do painel, **Backup/restauração de configuração**, **Atualizador** (`AppUpdater`, aponta para os Releases deste repositório).

### 3.7 Energia e estado do carro
- ✅ Carga, bateria, SoC.
- ⬜ `power`: **corte por bateria baixa** (`SocCutoffMonitor`), **manter acordado estacionado** (DiLink 5), proteção de 12 V — importante para a Sentinela não descarregar o carro; hoje escondido.
- ⬜ Notificações de **porta aberta** e **carga** (`DoorEventNotifier`, `ChargingEventNotifier`) já existem e podem virar alertas no webapp.

---

## 4. Lacuna principal: "modo cliente" do APK

O app já tem uma **barra lateral personalizável** (`NavigationRailCatalog`, 16 destinos: Assistente, Ao vivo, Gravações, Estacionamento, Veículo, Posições do banco, Projeção, Deslocamentos, Carga, Automações, Teclas, Integrações, RoadSense, Mapa, Rede, Diagnóstico). Plano:
1. Flag "modo cliente" (ligado por padrão no build de venda; admin/instalador desbloqueia com PIN).
2. No modo cliente, a barra mostra só: **Nuvem (QR/estado)**, **Ao vivo**, **Gravações** e **Status**. Todo o resto some (a página web local também recusa as rotas).
3. Uma **tela inicial única** com o QR para vincular, o estado de cada requisito (item 7) e o botão "Ajuda".
4. Traduções para português só dessas telas.
Isso é o item "esconder o avançado no APK" que você deixou para depois do webapp.

---

## 5. O que falta explorar (ideias por valor para o cliente)
1. **Alertas no celular** (push/e-mail): sentinela detectou pessoa, porta aberta, carga terminou, assinatura vencendo. O app já tem a infraestrutura de push (VAPID); falta o lado da nuvem.
2. **Onde estacionei** (Parking Intelligence + geocodificação) e **Locais Seguros** por GPS.
3. **Nota de direção e economia** (pontuação, consumo, comparação semanal) no Painel.
4. **Saúde da bateria** (SoH, tensão de células) — diferencial, mas precisa validar a precisão.
5. **Clima antes de entrar** com agendamento (já há comandos).
6. **Automações prontas** ("fechar vidros ao estacionar") expostas como ligar/desligar simples.
7. **Gravação 4K** como opção paga.

---

## 6. Quem instala e como (decisão do dono)
**Quem instala é o técnico que faz o desbloqueio do carro** (serviço principal do dono). O carro já chega com o acesso liberado (ADB sem fio ligado e acessível), então **o cliente nunca mexe em ADB, opções de desenvolvedor ou "controle de dados"** (este último já não é problema).

Roteiro do técnico:
1. Carro desbloqueado e ADB acessível (já é o serviço dele).
2. Instalar o APK.
3. Abrir o app, aceitar a chave ADB (uma vez) e esperar a checklist ficar toda verde.
4. O início automático **do nosso app já vem ligado**.
5. Ler o QR com o celular do cliente, criar a conta e vincular; conferir no `/admin` que o carro aparece com "Ao vivo" ✔.
6. Reiniciar a central uma vez e confirmar que o app volta sozinho.

## 7. Checklist de instalação no carro (a construir)
Tela única para o técnico (e o mesmo relatório enviado ao `/admin`):
1. ADB conectado e chave autorizada.
2. Processos ativos (câmera, sentinela, ACC) — com "reiniciar".
3. Permissões concedidas (quantas OK / faltando).
4. Acessibilidade, sobreposição, armazenamento, localização em segundo plano.
5. Câmeras entregando imagem (4 quadros recentes).
6. Telemetria lendo o carro (SoC, velocidade, GPS — com o carro ligado).
7. Nuvem: registrado, **VIN recebido**, MQTT conectado, túnel ativo.
8. Armazenamento com espaço e destino de gravação.
9. Início automático do nosso app: ligado.

## 8. Tela do carro para o cliente (modo cliente)
Referência de estrutura (apenas inspiração, sem copiar marca ou textos): uma tela simples com QR, configurações e dono vinculado.
- **Principal:** endereço do webapp, **Gerar QR Code**, **Configurações**, lista do dono vinculado com **Remover** (desvincula o carro), e uma faixa de status.
- **Configurações:** início automático e a checklist da seção 7.
- Todo o resto escondido; o **PIN do técnico** abre o app completo.

## 9. Em aberto
- Provedor de alertas (push/e-mail) — recomendado: Web Push do webapp.
