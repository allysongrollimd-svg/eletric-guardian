# Servidor na nuvem

O app no carro envia o estado a cada 3 s (pela rede 4G quando existe) e este
servidor mostra o mesmo painel do app no navegador, de qualquer lugar.

## Colocar no ar (Render, grátis)

1. Em render.com, **New → Blueprint** e escolha este repositório (usa o `render.yaml`).
2. Copie o endereço que o Render der (ex.: `https://eletric-guardian.onrender.com`).
3. No GitHub: **Settings → Secrets and variables → Actions → Variables**, crie
   `EG_CLOUD_URL` com esse endereço.
4. O próximo build gera um APK que já envia para lá. Na tela do app aparece
   "Painel na nuvem: …": esse é o link do seu carro.

No plano grátis o servidor dorme sem uso e esquece o último estado ao reiniciar;
o carro manda de novo em seguida.

## Rodar e testar local

```
node server/server.js     # porta 8080
node server/test.js       # teste rápido
```
