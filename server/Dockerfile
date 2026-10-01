# Construído a partir da raiz do repo, para levar o mesmo painel do app.
FROM node:22-alpine
WORKDIR /srv
COPY server/server.js ./server.js
COPY app/src/main/assets/dashboard.html ./dashboard.html
ENV DASHBOARD_HTML=/srv/dashboard.html DATA_DIR=/srv/data PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
