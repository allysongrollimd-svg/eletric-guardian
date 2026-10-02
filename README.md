<p align="center">
  <img src="branding/logo.svg" width="110" alt="Electric Guardian">
</p>

<h1 align="center">Electric Guardian</h1>
<p align="center">Monitoramento, dashcam e modo sentinela para veículos BYD — com painel web em tempo real.</p>

---

## O que é

**Electric Guardian** é um rebrand do [OverDrive](https://github.com/yash-srivastava/Overdrive-release)
(Yash Srivastava, licença MIT) com identidade visual própria e um **webapp na nuvem** para acompanhar os
dados do carro ao vivo. O restante — gravação/sentinela, telemetria, automações, túneis de acesso remoto,
Telegram, Home Assistant — é herdado do projeto original. Veja [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
para créditos e licenças de componentes de terceiros (incluindo GPL/AGPL).

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `app/` | App Android (Kotlin/Java/C++) que roda na central multimídia BYD DiLink |
| `webapp/` | **Novo.** Painel em tempo real (Node.js): MQTT/HTTP → Server‑Sent Events → dashboard PWA |
| `branding/` | Logo (SVG) |
| `tools/`, `stubs-bydauto/` | Ferramentas de build herdadas |

## Painel em tempo real (`webapp/`)

```
Carro (app) ──MQTT──▶ Broker ──▶ webapp (Node) ──SSE──▶ navegador/celular (PWA)
              └─────── ou HTTP POST /api/ingest/<carro> ───────┘
```

Teste em 30 segundos, sem carro (dados simulados):

```bash
cd webapp && npm install && npm run dev      # http://localhost:8787  — token: dev
```

Em produção: `webapp/README.md` (broker MQTT na nuvem, Docker Compose/Render, HTTPS, variáveis).
Para ver os dados e **controlar o carro pelo painel**, configure a conexão MQTT no app como descrito em `webapp/README.md`
(tópico `electric-guardian/<carro>/telemetry`, modo *Home Assistant* e *Permitir controle* ligados).

## O que mudou em relação ao OverDrive

- Nome, textos (todos os idiomas), paleta (verde‑lima/grafite), ícones e logo novos.
- **Privacidade:** removidas as chamadas ao backend do autor original. Telemetria de uso (analytics), backend
  "community" e RoadSense agora vêm **desativados** (URL vazia); links de suporte/issues/atualização apontam
  para este repositório. Baixar os modelos de IA ainda usa os assets `models-v1` do repositório original.
- Novo tópico MQTT padrão e o webapp acima.

## Estado e limitações conhecidas

- O app Android **não foi compilado nem testado em veículo** nesta etapa (ambiente sem Android SDK). As
  mudanças no app são de texto, recursos (cores/ícones) e URLs; compile e valide antes de distribuir.
- O `applicationId`/pacote Kotlin continua **`com.overdrive.app`** de propósito: há ~140 referências ao pacote
  em comandos de shell/daemons (`am start -n com.overdrive.app/...`, `/data/app/com.overdrive.app*/`) que
  precisam ser migradas e testadas num carro. Consequência: não instala lado a lado com o OverDrive original.
- Os links "Discord/WhatsApp" da interface agora levam às *Discussions* deste repositório até existirem canais próprios.
- O atualizador in-app consulta as *Releases* deste repositório; sem releases, ele simplesmente não encontra updates.

## Licença

MIT — ver [LICENSE](LICENSE) (mantém o aviso de copyright original, exigido pela licença). Componentes de terceiros
seguem suas próprias licenças ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
