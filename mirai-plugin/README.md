# Prayer Bridge（mirai 插件）

把 QQ 群消息转发到远程 Prayer 客服中台，并把答复发回群里。支持两种连接方向：

- **client 模式（默认）**：B 机无需公网，由本插件主动连接 A 机的 Prayer。
- **server 模式**：本插件监听端口，等 Prayer 主动连入。适用于 Prayer 侧不便监听、或由 mirai 侧持有可达地址的场景。

## 环境

- **JDK 11~17**（实测 JDK 14 可用）。**不要用 JDK 21**：Gradle 7.3.3 不支持它。
- **Gradle 7.3.3**（仓库内已带 wrapper，无需自装）。不要升到 8.x：mirai-console-gradle 2.16.0 仍引用 Gradle 7 已移除的 `MavenPlugin`，用 8.5 会报 `org/gradle/api/plugins/MavenPlugin`。
- Kotlin 1.9.22 / JVM target 11（已在 build.gradle.kts 固定）

## 构建

```bash
cd mirai-plugin
JAVA_HOME=/path/to/jdk-14 ./gradlew buildPlugin
# Windows Git Bash：JAVA_HOME="C:/Program Files/Java/jdk-14" ./gradlew.bat --offline buildPlugin
```

产物 `build/mirai/prayer-bridge-0.1.0.mirai2.jar`（约 350KB，已内嵌 Java-WebSocket）。
把它放进 mirai-console 的 `plugins/` 目录后重启。

本机已验证：编译与打包均通过，JAR 内含 100 个 `org/java_websocket/*` 类，
说明 `shadowLink` 生效，B 机离线也能加载。

## 自测（不依赖 mirai / 不需网络）

```bash
cd mirai-plugin
JAVA_HOME=/path/to/jdk-14 ./gradlew loopbackTest
```

在本地回环上拉起 server 传输并用 client 传输连入，覆盖：正确 token 建连、
错误 token 与重复连接被拒（单活动会话）、hello/ping/pong 帧往返、
以及 server/client 的 `stop()` 有界且幂等。全部通过打印 `ALL PASS`。
还会校验握手期间停止、断线取消异步请求，以及生成 `build/protocol-frames.json`，
供 Prayer 的协议测试直接校验 Kotlin 编码结果。

## 配置

首次启动会生成 `config/org.prayer.prayer-bridge/config.yml`：

```yaml
wsMode: "client"          # client=主动连 Prayer（默认）；server=监听等 Prayer 连入
# --- client 模式 ---
wsUrl: "wss://a-server.example.com/mirai"   # 跨公网必须 wss
token: "与 Prayer 后台该 clientId 的 token 一致"
clientId: "mirai-1"
backoffMs: 1000
maxBackoffMs: 60000
# --- server 模式（wsMode: server 时用）---
serverHost: "127.0.0.1"   # 默认仅回环；跨机才改 0.0.0.0，且务必配强 token + 外层 TLS
serverPort: 3003          # 避开 3000(Next.js)/3001(NapCat)/3002(client 默认)
# --- 通用 ---
allowedGroups: []         # 留空 = 全部群；填群号则只转发这些群
forwardImages: true
maxImagesPerMessage: 3
```

`token` 是凭据，该目录不要提交进 Git。两种模式都用它鉴权：client 模式作
`Authorization: Bearer` 头上报；server 模式在 WS 升级前校验连入方的同名头，不匹配直接拒握手。
server 模式下 `token` 为空会拒绝启动（否则等于开一个谁都能连的端口）。

无论哪种模式，插件在会话建立后**始终先发 hello 声明身份与所辖会话**；只有 hello
成功送达后才开始转发群消息。尚无已登录 Bot 时不会上报 `botId=0`，而是有界等待，
超时则关闭会话等待重连。

## A 机（Prayer）侧对应配置

在 `/admin/config` →「渠道接入」→「mirai 通道」选择 **Prayer 连接模式**：

- **WS 服务端**：设置监听端口（默认 3002），添加 `clientId + token`。Mirai 插件用 `wsMode: client`，`wsUrl` 指向 Prayer 的监听地址。
- **WS 客户端**：填写 Mirai WS 地址（同机示例 `ws://127.0.0.1:3003`）、插件 `clientId` 和 `token`。Mirai 插件用 `wsMode: server`，跨机时将 `serverHost` 改为 Prayer 能访问的地址。

两端模式必须相反。开启通道后点击「保存并生效」；切换时保留另一模式的配置。
此地址是 Prayer Bridge v1，不是 mirai-api-http。
然后在 `/admin/groups` 将目标群设为生效会话并配置知识库分区 `kbNamespace`。

## 端口说明

Prayer 的 WS 服务端默认 3002（client 模式插件连它）。server 模式插件默认监听 3003。
3000 是 Next.js，3001 是 NapCat OneBot 的既定地址，同机部署时占用会导致启动失败。

## 行为要点

只有 @ 机器人的消息才会触发答复（插件判定消息链是否含 `At(bot)` 后上报）。群内其余消息仍会转发，用于会话上下文、反思沉淀与问题归类。

引用回复依赖本地 `MessageSource` 缓存（500 条 / 10 分钟）。超时后 Prayer 的答复会退化为不引用的纯文本，不影响送达。

client 模式断线自动重连，退避从 1s 指数增长至 60s。若日志出现 `鉴权失败`，说明 token 与对端不一致，重连不会成功，需改配置后重启插件。server 模式由 Prayer 主动重连，插件侧仅维持单个活动会话，重复连接会被拒。

Prayer 侧的回查应答（listChats / listMembers）会绑定回收到请求的那一路会话；断线换新会话后，旧请求的迟到应答不会串到新会话。

## 已知限制

mirai 2.16.0 之后官方长期未发稳定版，实际登录 QQ 需自行配合签名服务。这是 mirai 生态的既有问题，与本插件无关。
