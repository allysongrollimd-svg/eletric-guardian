# Eletric Guardian

App para a central multimídia de carros elétricos (multimarca): monitora o carro,
grava as câmeras e avisa o dono no celular.

## Estado atual

- **Núcleo (`core/`)**: modelo de dados do veículo, interface de fonte de dados por
  marca, simulador e detecção de viagens com consumo. Kotlin puro, com testes.
- **App (`app/`)**: serviço em primeiro plano que sobe com a central, lê o carro a
  cada segundo, junta o GPS e mostra um painel. Fonte BYD pelo SDK da central
  (`android.hardware.bydauto`); fora do carro, a versão de teste usa dados simulados.

## Roteiro

1. Monitor de dados e localização (em andamento)
2. Agente privilegiado via ADB local, para acessar câmeras e dados restritos
3. Dashcam: gravação em segmentos, limite de disco, DVR de fábrica
4. Sentinela com IA: detecção de movimento, pessoa/veículo, clipe antes/depois, alerta
5. Webapp companion: dados ao vivo, mapa, histórico e configurações das câmeras
6. Waze no cluster (aguardando carro de teste compatível)

## Build

```
./gradlew :core:test          # testes do núcleo
./gradlew :app:assembleDebug  # APK em app/build/outputs/apk/debug/
```

O GitHub Actions roda os dois a cada atualização e publica o APK, sem zip, em
https://github.com/allysongrollimd-svg/eletric-guardian/releases/download/teste/eletric-guardian.apk
