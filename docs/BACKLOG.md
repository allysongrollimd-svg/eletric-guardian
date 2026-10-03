# Backlog e decisões

## Decisões (do dono do produto)
- **Esconder opções avançadas só dos clientes**, não do dono/admin. Vale para o que o cliente vê no webapp (páginas do carro servidas pelo túnel).
- **App do carro (APK):** esconder tudo o que for configuração avançada/experimental/de desenvolvedor — **depois** que o webapp estiver pronto.
- **Marca:** o kit de marca (logo, cores, fontes, tom de voz, ícone) vem de outro chat; só então aplicar. Os tokens ficam em `webapp/public/app.css` (`:root`) e `webapp/public-view/tokens.css`.
- Organizar o que já existe em vez de criar telas duplicadas (ver inventário abaixo).

## Inventário das páginas do carro (aba Câmeras)
- **Gravações** (`recording.html`): Captura (modo: Nenhum/Contínuo/Condução/Proteção de proximidade, layout, marcação de local), Dashcam OEM (Desligado/Contínuo/Inteligente), Qualidade, Armazenamento, Status.
- **Vigilância** (`surveillance.html`): Geral (modo, ativação, energia estacionado, locais seguros), Detecção, Controles por câmera, Programação, Dissuasão na tela/nuvem, Parking Intelligence, Desenvolvedor (mapa de calor, log de filtros).
- **Estacionamento**, **Eventos**, **Ao vivo**.

## A organizar (depois do webapp pronto)
1. Textos em inglês no meio do português (Parking Intelligence, Saved zones, Keep mobile data awake…): traduções faltando no APK.
2. Opções repetidas (Dashcam OEM em duas páginas; Parking Intelligence em duas).
3. Experimental/desenvolvedor visível para todos: esconder dos clientes no webapp; esconder tudo no APK.
4. Páginas muito longas (Vigilância ~1.700 linhas): dividir por assunto.

## Webapp: o que falta para ficar pronto
- Câmera ao vivo no celular
- Deslocamentos e Recargas (API do carro: `/api/trips`, `/api/charging`)
- Tela real de boas-vindas/cadastro (protótipo aprovado depende da marca)
- Aplicar o kit de marca
- Área da conta (trocar senha, dados, exclusão — LGPD)
- Avisos (vencimento da assinatura, alertas da sentinela) — precisa escolher o serviço de envio
- Revisão de licenças antes de vender (YOLO AGPL, sing-box GPL), termos de uso e política de privacidade

## Sentinela/Dashcam no estilo do app de referência (decisão)
- Referência (Electro): Sentinela = Gravações (lista + navegação por dia) e Configurações enxuta: Ativar, Armazenamento (tipo + limite + tempo estimado), Resolução (HD/Full HD/Original), Modo de operação, Layout.
- Hoje: Configurações = página do carro embutida; clientes não veem as abas Detecção/OEM/Estacionamento (Sentinela) nem Status (Dashcam).
- Falta cortar **dentro** das abas Geral/Gravação/Armazenamento (experimentais, energia estacionado, locais seguros, dissuasão…). O corte limpo é um "modo cliente" no APK (decisão: depois do webapp pronto).

## Sentinela: o que o cliente vê (decidido)
- **Geral:** modo de operação, ativar, modo de ativação, modo com carro desligado, USB energizado, dados móveis acordados, programação, marcação de local. (Dissuasão na tela: escondida; exigiria editor de texto.)
- **Detecção:** locais seguros, predefinição de ambiente, sensibilidade, objetos detectados.
- **Gravação:** qualidade, layout, telemetria nos vídeos (liga/desliga), correção de olho de peixe.
- **Armazenamento:** local, uso, limite, limpeza automática da dashcam BYD (liga/desliga).
- Escondido do cliente (admin vê tudo): experimental/DI5, economia de energia e corte por bateria, ajustes finos de detecção, desenvolvedor, áreas de detecção, Parking Intelligence, dissuasão em nuvem, mensagem/imagem personalizada, resolvedor online/URL, buffers, codec, FPS, duração do clipe, câmera do para-brisa, campos de telemetria, ajustes finos da limpeza, aba Dashcam OEM.
- Implementação: `webapp/lib/viewproxy.js` (`SURVEILLANCE_HIDE`), por chave de tradução (`data-i18n`).
- **Pendente:** repetir a conversa para a página de Gravações (Dashcam).

## Dashcam: o que o cliente vê (decidido)
- **Captura:** modo de gravação, layout da câmera, marcação de local.
- **Qualidade:** qualidade, codec, duração do clipe, correção de olho de peixe, telemetria no vídeo, áudio da cabine.
- **Armazenamento:** local, uso, limite, limpeza automática da dashcam BYD (se o carro tiver).
- Escondido do cliente: câmera do para-brisa, ajustes da guarda de proximidade (sensibilidade/buffers), resolvedor online/URL, FPS, ajustes finos da limpeza, aba Status.
- **Dashcam OEM removida para todos** (cliente e admin) no webapp: `EMBED_CSS` em `webapp/lib/viewproxy.js`. Continua existindo no carro. Para recolocar, tirar a regra de `EMBED_CSS`.
- Áudio da cabine: mantido visível (decisão do dono); privacidade/consentimento a revisar nos Termos.
