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

## Serviço na nuvem (contas, câmeras e controle)

`webapp/` roda em dois modos: **dono único** (um token, seus próprios carros, MQTT externo) e **contas** (`AUTH_MODE=accounts`,
o serviço vendável): clientes com login, **carro vinculado ao chassi (VIN)** por código de pareamento exibido na tela do carro,
broker MQTT embutido com isolamento por carro, painel em tempo real, controle remoto e **câmeras ao vivo / gravações /
sentinela por túnel reverso** (o carro abre uma conexão de saída até a sua VPS; nada precisa ser aberto no 4G).
Implantação: [`deploy/README.md`](deploy/README.md). Demo local sem carro: `cd webapp && npm install && npm run dev:cloud`.

## Antes de vender (licenças e riscos — não é aconselhamento jurídico)

- O código do OverDrive é **MIT** (pode vender; mantenha o aviso de copyright, já em [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- **Modelos YOLO (`yolo11n`, `yolo26n`, Ultralytics) são AGPL-3.0**: distribuir/oferecer como serviço implica obrigações de código aberto
  ou licença comercial da Ultralytics. Troque por um detector de licença permissiva ou compre a licença.
- **`sing-box` é GPL-3.0** (binário embutido): quem recebe o APK precisa poder pedir o código-fonte.
- A integração com a **nuvem da BYD** vem de engenharia reversa de terceiros (sem licença clara) e pode violar termos da BYD.
- **LGPD**: gravações de sentinela captam imagem de terceiros; defina política de retenção e base legal antes de armazenar na VPS.
- O túnel dá a quem acessa as câmeras o mesmo poder do app no carro: veja a seção de segurança em `deploy/README.md`.

## Estado e limitações conhecidas

- O app Android é compilado pelo GitHub Actions (CI) e já foi instalado e testado num BYD Dolphin GS (ao vivo, gravações e
  estacionamento funcionam). O **cliente de nuvem** (pareamento, túnel e MQTT automático) é novo e **ainda não foi testado num carro**.
- O `applicationId`/pacote Kotlin continua **`com.overdrive.app`** de propósito: há ~140 referências ao pacote
  em comandos de shell/daemons (`am start -n com.overdrive.app/...`, `/data/app/com.overdrive.app*/`) que
  precisam ser migradas e testadas num carro. Consequência: não instala lado a lado com o OverDrive original.
- Os links "Discord/WhatsApp" da interface agora levam às *Discussions* deste repositório até existirem canais próprios.
- O atualizador in-app consulta as *Releases* deste repositório; sem releases, ele simplesmente não encontra updates.

## Licença

MIT — ver [LICENSE](LICENSE) (mantém o aviso de copyright original, exigido pela licença). Componentes de terceiros
seguem suas próprias licenças ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
