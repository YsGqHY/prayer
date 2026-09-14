plugins {
    val kotlinVersion = "1.9.22"
    kotlin("jvm") version kotlinVersion
    kotlin("plugin.serialization") version kotlinVersion
    id("net.mamoe.mirai-console") version "2.16.0"
}

group = "org.prayer"
version = "0.1.0"

repositories {
    mavenCentral()
    // 国内拉 mirai / kotlin 依赖走镜像，避免 Maven Central 直连超时
    maven("https://maven.aliyun.com/repository/public")
    maven("https://maven.aliyun.com/nexus/content/groups/public/")
}

mirai {
    // JVM 11：与本机 JDK 21 兼容，也对齐参考项目 XAiGeek
    jvmTarget = JavaVersion.VERSION_11
    noTestCore = true
}

dependencies {
    implementation(kotlin("stdlib-jdk8"))
    // WS 客户端选 Java-WebSocket 而非 ktor：mirai 自带的 ktor 版本受其内部约束，
    // 插件再引易与 console 的 classloader 隔离机制冲突；本库无传递依赖，最稳。
    implementation("org.java-websocket:Java-WebSocket:1.5.6")
    // buildPlugin 自 2.11 起默认不内嵌外部依赖（改为运行时从 Maven 拉），
    // shadowLink 强制打进 JAR，避免 B 机离线时插件加载失败。不带版本号。
    "shadowLink"("org.java-websocket:Java-WebSocket")

    implementation(platform("net.mamoe:mirai-bom:2.16.0"))
    compileOnly("net.mamoe:mirai-console-compiler-common")
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    kotlinOptions {
        jvmTarget = "11"
    }
}

// 无依赖 loopback 自测入口：验证 server/client 认证、单活动会话、传输往返与 stop。
// 用 compileClasspath（含 mirai 传递来的 coroutines/serialization + Java-WebSocket）+ main 产物，
// 测试本身不加载任何 mirai 类，可离线运行。
tasks.register<JavaExec>("loopbackTest") {
    group = "verification"
    description = "运行 BridgeLoopbackTest（不依赖 mirai 运行时）"
    dependsOn("compileKotlin")
    val main = sourceSets.getByName("main")
    classpath = main.compileClasspath + main.output
    mainClass.set("org.prayer.bridge.BridgeLoopbackTestKt")
}
