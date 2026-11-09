import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

/**
 * Release signing, from OUTSIDE the repository (never commit a keystore, never print it). Either
 *   AUTION_SIGNING_PROPERTIES=/path/to/release.properties   (storeFile, storePassword, keyAlias, keyPassword)
 * or the four values directly:
 *   AUTION_KEYSTORE_FILE, AUTION_KEYSTORE_PASSWORD, AUTION_KEY_ALIAS, AUTION_KEY_PASSWORD   (what CI uses)
 * With neither, the release APK is built unsigned.
 */
val releaseSigning: Map<String, String>? = run {
    val path = System.getenv("AUTION_SIGNING_PROPERTIES")
    if (!path.isNullOrBlank()) {
        val props = Properties().apply { file(path).inputStream().use { load(it) } }
        return@run listOf("storeFile", "storePassword", "keyAlias", "keyPassword").associateWith { props.getProperty(it) ?: error("$it missing in AUTION_SIGNING_PROPERTIES") }
    }
    val storeFile = System.getenv("AUTION_KEYSTORE_FILE")
    if (storeFile.isNullOrBlank()) return@run null
    mapOf(
        "storeFile" to storeFile,
        "storePassword" to (System.getenv("AUTION_KEYSTORE_PASSWORD") ?: error("AUTION_KEYSTORE_PASSWORD is not set")),
        "keyAlias" to (System.getenv("AUTION_KEY_ALIAS") ?: "aution"),
        "keyPassword" to (System.getenv("AUTION_KEY_PASSWORD") ?: System.getenv("AUTION_KEYSTORE_PASSWORD")!!),
    )
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "com.remeinium.aution"
    defaultConfig {
        applicationId = "com.remeinium.aution"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (releaseSigning != null) {
            create("release") {
                storeFile = file(releaseSigning.getValue("storeFile"))
                storePassword = releaseSigning.getValue("storePassword")
                keyAlias = releaseSigning.getValue("keyAlias")
                keyPassword = releaseSigning.getValue("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (releaseSigning != null) signingConfig = signingConfigs.getByName("release")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
