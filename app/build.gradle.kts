plugins {
    id("com.android.application")
    kotlin("android")
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
        versionCode = 1
        versionName = "0.1.0"
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
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
