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
