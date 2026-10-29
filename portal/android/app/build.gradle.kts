plugins {
    id("com.android.application")
}

// The portal this build opens. It is the deployed origin, never committed: the
// repository is public. Debug builds without one open a placeholder.
val portalOrigin: String = providers.gradleProperty("vybatron.portalOrigin")
    .orElse(providers.environmentVariable("VYBATRON_PORTAL_ORIGIN"))
    .getOrElse("")
val originPattern = Regex("^https://[a-z0-9.-]+(:[0-9]{1,5})?$")
require(portalOrigin.isEmpty() || originPattern.matches(portalOrigin)) {
    "The portal origin must look like https://host or https://host:port, without a path."
}

android {
    namespace = "app.vybatron"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "app.vybatron"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.3.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["portalOrigin"] = portalOrigin
    }

    buildTypes {
        debug {
            buildConfigField("String", "PORTAL_ORIGIN", "\"${portalOrigin.ifEmpty { "https://portal.invalid" }}\"")
        }
        release {
            buildConfigField("String", "PORTAL_ORIGIN", "\"$portalOrigin\"")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
    }
}

kotlin {
    jvmToolchain(21)
}

// A release that opened nothing would ship as a blank app.
tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
    val origin = portalOrigin
    doFirst {
        require(origin.isNotEmpty()) { "Set vybatron.portalOrigin (or VYBATRON_PORTAL_ORIGIN) for a release build." }
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-session:1.11.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")

    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver3:5.5.1")
}
