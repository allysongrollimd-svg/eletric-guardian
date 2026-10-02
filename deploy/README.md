# Implantação do Electric Guardian Cloud (VPS)

Serviço único (Node) + Caddy (HTTPS automático). Faz: contas de clientes, vínculo do carro ao chassi (VIN),
painel em tempo real, controle remoto, broker MQTT embutido e túnel reverso para câmeras/gravações/sentinela.

```
Carro (app) ──wss://app.exemplo.com/mqtt──▶ broker embutido ──▶ painel (tempo real + controles)
Carro (app) ──wss://app.exemplo.com/tunnel─▶ túnel ──▶ https://view.exemplo.com  (ao vivo / gravações / sentinela)
Cliente (navegador) ──https──▶ app.exemplo.com  (login, carros, painel)
```

## 1. Requisitos
- VPS Linux com Docker + Docker Compose (1 vCPU / 1 GB RAM atende dezenas de carros; **banda de saída** é o que escala com o vídeo).
- Dois nomes DNS apontando para a VPS: `app.exemplo.com` e `view.exemplo.com` (**mesmo domínio-pai**: o cookie das câmeras é `SameSite=Strict`).
- Portas 80 e 443 abertas.

## 2. Subir
```bash
cd deploy
cp .env.example .env        # edite APP_HOST, VIEW_HOST, ACME_EMAIL
docker compose up -d --build
docker compose logs -f eg   # "accounts mode — app: … cameras: … signup: closed"
```

## 3. Criar o primeiro cliente (cadastro fechado por padrão)
```bash
docker compose exec eg node scripts/admin.mjs create-user cliente@exemplo.com 'senha-longa-aqui' 'Nome do Cliente'
docker compose exec eg node scripts/admin.mjs list
docker compose exec eg node scripts/admin.mjs release-vin LGXC16DG2R0123456   # liberar um chassi (carro vendido, suporte)
docker compose exec eg node scripts/admin.mjs disable-user cliente@exemplo.com
```
Para cadastro aberto: `ALLOW_SIGNUP=1` no `.env`.

## 4. Vincular um carro (o que o cliente faz)
1. No carro: app **Electric Guardian → menu Integrações → Nuvem**; informar `https://app.exemplo.com`, ativar, salvar. Aparece um **código de 8 caracteres**.
2. No painel (`https://app.exemplo.com`): entrar → **Carros → Vincular um carro** → apelido, **chassi (VIN)** e o código.
3. O servidor confere que o chassi informado bate com o que o carro reporta (quando o SDK da BYD o fornece) e que **nenhuma outra conta** já tem esse chassi.
4. O app configura sozinho o MQTT (telemetria) e abre o túnel das câmeras. Para controle remoto, ligar **Permitir controle remoto** na mesma tela do carro.

## 5. Segurança — leia antes de vender
- O túnel entrega tráfego ao servidor do carro **como se fosse local** (sem o login do app). Toda a autenticação está no servidor da nuvem:
  proteja a VPS (atualizações, firewall, SSH por chave), faça backup do volume `eg-data` e trate a chave de sessão como segredo.
- Quem acessa as câmeras tem **o mesmo poder do app no carro** (inclui ações do veículo). Cada requisição é revalidada (dono, conta ativa, chave de sessão).
- Rotas que reconfiguram a própria nuvem (`/api/cloud/*`, `/cloud.html`) são bloqueadas no proxy: só funcionam dentro do carro.
- Controle remoto: desligado por padrão no app **e** no servidor (`CONTROL_ENABLED`); destravar exige a **senha da conta** (10 min); log de auditoria por usuário.
- Senhas com scrypt; sessões assinadas e revogáveis (`logout-all`, troca de senha); limites de tentativa em login, vínculo e PIN.
- Dados: o estado mais recente de cada carro fica em `/data/state.json`; contas, carros e auditoria em `/data/eg.sqlite`. Gravações **não** ficam na VPS (ficam no cartão do carro; a VPS só repassa).

## 6. Banda e custos
- Ao vivo H.264 ≈ 1–3 Mbps por espectador por câmera; download de gravação usa o máximo que o 4G do carro der.
- O tráfego passa pela VPS **e** pelo plano de dados do carro: preveja franquia e limite de espectadores por carro (hoje: 64 streams simultâneos).

## 7. Atualizar
`git pull && docker compose up -d --build` (os dados ficam no volume).

## Instalação em um comando (VPS Debian/Ubuntu)

```bash
git clone <este repositório> && cd <repo>
sudo APP_HOST=guardian.allysongrolli.com.br VIEW_HOST=cam.guardian.allysongrolli.com.br \
     ACME_EMAIL=voce@email.com ADMIN_EMAIL=voce@email.com bash deploy/install.sh
```

DNS: crie registros A para `guardian…` e `cam.guardian…` apontando para o IP da VPS (portas 80/443 abertas).
No carro: Nuvem → endereço `https://guardian.allysongrolli.com.br` → aparece um **QR code**; o cliente o lê,
entra na conta e toca em *Vincular*. O chassi é enviado pelo próprio app do carro.

## Cobrança (InfinitePay) e painel de administração

- **Administração:** `https://SEU_APP_HOST/admin` (somente contas com perfil admin). Clientes, carros, faturas, planos, configurações e auditoria.
  Para promover uma conta existente: `docker compose -f deploy/docker-compose.nginx.yml exec -T eg node scripts/admin.mjs make-admin voce@email.com`
- **Checkout:** em *Config.* informe a **InfiniteTag** da sua conta InfinitePay. O link de pagamento (Pix ou cartão) e o webhook são criados
  automaticamente a cada fatura; a baixa é automática. O servidor **não confia no corpo do webhook**: confirma cada pagamento na API da InfinitePay
  (`payment_check`) e confere o valor antes de liberar. A URL do webhook leva uma chave por fatura.
- **Regras:** o teste grátis começa no primeiro vínculo do chassi e não reinicia ao desvincular/vincular. Depois de vencer há uma tolerância; passada
  a tolerância, câmeras e controles remotos ficam bloqueados (o painel segue mostrando os dados). Pagar durante o teste não perde os dias restantes.
- **Renovação:** o checkout da InfinitePay é pagamento avulso (não cobra o cartão sozinho todo mês). Cada período é uma nova fatura que o cliente paga em *Assinatura*.

## Backup e restauração

O serviço guarda sozinho uma cópia consistente do banco por dia (14 mantidas) dentro do volume Docker. Isso protege contra erro, **não** contra perder a VPS.
Para levar as cópias para fora do contêiner e agendar:

```bash
bash deploy/backup.sh                                    # copia para /var/backups/electric-guardian (30 dias)
(crontab -l 2>/dev/null; echo "30 3 * * * bash $PWD/deploy/backup.sh >> /var/log/eg-backup.log 2>&1") | crontab -
```

Copie essa pasta também para outro lugar (outro servidor, nuvem, seu computador). O arquivo `session.secret` vai junto: ele assina as sessões e as chaves dos webhooks.

**Restaurar** (serviço parado): copie o `eg-AAAAMMDD-HHMMSSZ.sqlite` escolhido para `eg.sqlite` no volume e o `session.secret` para o mesmo lugar, depois suba de novo:

```bash
docker compose -f deploy/docker-compose.nginx.yml stop eg
docker run --rm -v deploy_eg-data:/data -v /var/backups/electric-guardian:/b alpine sh -c 'cp /b/eg-XXXX.sqlite /data/eg.sqlite && cp /b/session.secret /data/session.secret && rm -f /data/eg.sqlite-wal /data/eg.sqlite-shm && chown -R 1000:1000 /data'
docker compose -f deploy/docker-compose.nginx.yml start eg
```
