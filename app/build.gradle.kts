plugins {
    id("com.android.application")
    kotlin("android")
}

// O APK sai como eletric-guardian-v0.1.N-debug.apk, inclusive dentro do zip do build.
base {
    archivesName.set("eletric-guardian-v0.1.${System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 0}")
}

android {
    namespace = "br.com.eletricguardian.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "br.com.eletricguardian"
        minSdk = 25
        // As centrais BYD/Geely rodam Android 9/10 e os apps de referência
        // (Electro, Connect Pulse, OverDrive) miram 25: evita as restrições de
        // serviço em segundo plano e a exigência de tipo de serviço das APIs novas.
        //noinspection ExpiredTargetSdkVersion
        targetSdk = 25
        // No GitHub Actions cada build ganha um número novo (GITHUB_RUN_NUMBER), que
        // aparece no painel e no nome do APK; localmente fica 0.
        val build = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 0
        val commit = System.getenv("GITHUB_SHA")?.take(7) ?: "local"
        versionCode = build + 1
        versionName = "0.1.$build"
        buildConfigField("String", "COMMIT", "\"$commit\"")
        // Endereço do servidor na nuvem (pasta server/). No GitHub vem da variável
        // EG_CLOUD_URL do repositório; vazio desliga o envio.
        val cloudUrl = System.getenv("EG_CLOUD_URL").orEmpty()
        buildConfigField("String", "CLOUD_URL", "\"$cloudUrl\"")
    }

    signingConfigs {
        // Chave de debug fixa no repositório: assim todo APK de teste (local ou do
        // GitHub) atualiza por cima do anterior, sem desinstalar e perder dados.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        // targetSdk baixo é proposital (ver defaultConfig).
        disable += setOf("ExpiredTargetSdkVersion", "OldTargetApi")
        abortOnError = false
    }
}

dependencies {
    implementation(project(":core"))
    compileOnly(project(":bydstub"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
