#!/usr/bin/env bash
# Electric Guardian — one-shot VPS bootstrap (Debian/Ubuntu). Run as root from a clone of the repo:
#   sudo APP_HOST=guardian.allysongrolli.com.br VIEW_HOST=cam.guardian.allysongrolli.com.br \
#        ACME_EMAIL=voce@email.com ADMIN_EMAIL=voce@email.com bash deploy/install.sh
# DNS (A records) for BOTH hosts must already point to this server; ports 80/443 must be open.
set -euo pipefail
cd "$(dirname "$0")"
: "${APP_HOST:?defina APP_HOST}" "${VIEW_HOST:?defina VIEW_HOST}" "${ACME_EMAIL:?defina ACME_EMAIL}"

if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
docker compose version >/dev/null

if [ ! -f .env ]; then
  cat > .env <<EOF
APP_HOST=$APP_HOST
VIEW_HOST=$VIEW_HOST
ACME_EMAIL=$ACME_EMAIL
ALLOW_SIGNUP=${ALLOW_SIGNUP:-1}
CONTROL_ENABLED=${CONTROL_ENABLED:-1}
SESSION_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n=/+')
EOF
  chmod 600 .env
  echo ">> .env criado"
else
  echo ">> .env já existe — mantido"
fi

docker compose up -d --build
echo ">> aguardando o serviço…"
for i in $(seq 1 40); do docker compose exec -T eg node -e "fetch('http://127.0.0.1:8787/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 2; done

if [ -n "${ADMIN_EMAIL:-}" ]; then
  ADMIN_PASS="${ADMIN_PASSWORD:-$(head -c 18 /dev/urandom | base64 | tr -d '\n=/+')}"
  docker compose exec -T eg node scripts/admin.mjs create-user "$ADMIN_EMAIL" "$ADMIN_PASS" "Admin" admin && \
    echo ">> usuário: $ADMIN_EMAIL  senha: $ADMIN_PASS   (troque no painel)"
fi
echo ">> pronto: https://$APP_HOST   | no carro, em Nuvem, use o endereço https://$APP_HOST"
