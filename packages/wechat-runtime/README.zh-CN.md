# 微信运行时

[English](README.md) | [简体中文](README.zh-CN.md)

仅在容器中运行的微信 Linux 4.1.13 注入工具、Bun + TypeScript API 和 React 聊天界面。原生可执行文件通过 SHA-256 固定。

```sh
packages/wechat-runtime/scripts/container.sh build
packages/wechat-runtime/scripts/container.sh start
```

打开 <http://127.0.0.1:18742/>。通过界面或桥接命令明确发起登录。设置 `WECHAT_AUTO_LOGIN=true` 可启用自动请求手机确认。微信可能要求手机确认；没有已记住的账号时，页面显示客户端二维码。

Dockerfile 从仓库的[固定客户端发布版本](https://github.com/yamada-sexta/matrix-wechat/releases/tag/wechat-client-4.1.13-4526180b)下载原始厂商 AppImage，遇到临时故障最多重试三次，按原生 ABI 配置中的 SHA-256 校验，并在构建时解包、验证可执行文件。可通过 `WECHAT_APPIMAGE_URL` 更换下载镜像，但仍须符合相同哈希。预期 AppImage 哈希为 `4526180bca980128791599af122ff4795002a5715a510f6a65480e2be6874244`。下载内容发生变化会导致构建失败。启动前会再次检查 AppImage 和可执行文件的哈希。客户端安装目录对运行时用户只读，镜像不含账号数据。

Dockerfile 位于此包中，但构建上下文是仓库根目录，以便包含 `packages/wechat-rpc`。构建过程运行 lint、类型检查和测试，再使用根工作区锁文件构建原生 hook 和 React 界面。CI 构建相同的 amd64 Dockerfile，并在不启动微信的情况下检查内置客户端。可写账号状态从仓库的 `data/wechat` 挂载到容器的 `/home/wechat`。启动脚本仅发布 `127.0.0.1:18742`，使用独立的 PID 和显示环境命名空间，为 Frida 授予 `SYS_PTRACE`，为内置浏览器沙箱授予 `SYS_CHROOT`。不挂载主机 home、显示服务或 IPC。服务启动时会拒绝在主机环境直接执行。

```sh
packages/wechat-runtime/scripts/container.sh stop
packages/wechat-runtime/scripts/container.sh start
packages/wechat-runtime/scripts/container.sh logs --tail 30
```

停止和启动会保留状态。源码修改后重新构建并停止、启动容器，无需手动复制文件到运行中的容器。

开发检查不会启动微信：

```sh
bun install --frozen-lockfile
bun run --cwd packages/wechat-runtime check
bun run --cwd packages/wechat-runtime lint
bun run --cwd packages/wechat-runtime test
bun run --cwd packages/wechat-runtime build
```

## 服务 API 与可选网页界面

Matrix 桥接在独立容器中运行，通过共享的 `wechat-rpc` 客户端连接。设置 `WECHAT_API_TOKEN` 后，启用端口 `18743` 上需要身份验证的 API；每次请求均须带上 `Authorization: Bearer <token>`。没有令牌时，该监听端口禁用。Compose 为两个服务提供相同令牌，并将此端口保留在内部网络。

`/trpc` 上的类型化 tRPC API 提供状态、联系人、群、会话、可恢复的历史分页、近期消息、撤回、登录和退出、文本发送，以及 multipart 图片和文件上传。读取仅限当前账号，包括其保留的数据库分片，不包含先前账号的数据库。需要身份验证的 `/assets/avatar`、`/assets/media`、`/assets/thumbnail` 和 `/assets/qr` 直接返回二进制数据，不做 base64 编码。历史记录包含用于回显关联的公开媒体校验和，原生原始记录留在此服务内部。

当缓存的原生成员列表和账号联系人信息可用时，群响应包含 `joined`。系统 XML 会标准化为可读消息文本和 `system.type`（如 `payment_reminder`）；公开响应不包含原生 XML 或支付操作 URL。

`WECHAT_WEB_UI` 默认为 `true`。设置为 `false` 可禁用 `18742` 上独立的网页界面和 HTTP 监听端口，需要身份验证的 API 仍可使用。独立启动脚本会读取仓库 `.env` 中的 `WECHAT_*` 和 `TZ` 设置，并接受已导出的 `WECHAT_API_TOKEN` 和 `WECHAT_WEB_UI` 覆盖值。Matrix 凭据不会传入运行时容器。该脚本仅发布网页界面端口。桥接和运行时共用网络的部署请使用根目录的 [Compose 配置](../../compose.yaml)。

网页界面还提供本地 HTTP API：

使用 `rpc.login.mutate({ mode: "qr" })` 或 `{ mode: "prompt" }` 发起登录，使用 `rpc.logout.mutate()` 结束当前原生会话。本地界面通过 `POST /api/login` 发送相同的登录载荷，通过 `POST /api/logout` 发送 `{}`。退出过程中状态为 `logging_out`；成功表示原生认证已结束，而非仅已排入操作队列。退出失败时返回错误，并从原生客户端刷新状态。退出遵循原生客户端的聊天记录设置；在明确请求登录前禁止自动登录。微信之后可能要求重新用摄像头扫码。

HTTP API：`GET /api/status`、`/api/contacts`、`/api/groups`、`/api/conversations`、`/api/history?chat_id=...&limit=50&cursor=...`、`/api/capabilities`；`GET /api/events` 提供 Server-Sent Events；`POST /api/send` 接收 `{ "chat_id": "...", "kind": "text", "text": "..." }`。原生 ID 始终为十进制字符串。浏览器响应不包含原生原始记录、密钥材料或路径。错误格式为 `{ "error": { "code": "...", "message": "..." } }`。

文本和引用回复使用原生发送处理器，图片和文件上传使用原生上传处理器。发送确认仅报告原生处理器结果，是否送达须通过包含服务器 ID 的源历史记录验证。支持接收缓存图片、MP4 视频、文件、头像、表情包/GIF 和解码后的语音。视频读取会验证消息大小和校验和，上限为 64 MiB。MP4 上传请使用 File 按钮或 `POST /api/send-file`：微信可能将其识别为原生视频消息，已通过 H.264 示例验证。未缓存视频的下载和其他视频格式尚未验证；其他发送类型也尚未验证。接收更新使用原生数据库写入 hook，再与已提交状态核对；直接的全局消息回调尚未验证。API、模式和调查笔记位于完全被 Git 忽略的 `wechat_api/` 中。

原生 ABI 元数据位于 `wechat-native` 工作区的 `src/*_profile.toml`。Bun 的 TOML 读取器加载运行时配置，Zod 在注入前验证哈希、地址和指令字节。Zod 也会在 HTTP 和私有 socket 共用的运行时边界验证登录与文本发送参数。厂商载荷和 API 传输协议仍使用 XML/JSON。存储测试数据通过 Bun 的 SQLite 连接器运行；加密账号数据库通过客户端原生 WCDB 连接读取。

仓库根目录的 `bun run check` 会检查全部工作区。`wechat-runtime` 检查 Bun/React 应用；`wechat-native` 使用 Frida 类型检查注入代码，不含 Bun 或浏览器全局变量。运行时 TypeScript 项目没有排除原生代码文件。

C++ 图片适配器在运行时 Dockerfile 的构建阶段编译并测试。自动原图请求默认禁用。私有 socket 的 `download.validate` 操作接收原图缺失图片的 `{chat_id,message_id}`，执行原生协程冒烟回调，请求原图变体 3，并用消息 MD5 校验下载后的缓存图片。只有验证成功才会为该账号启用重试，并写入与适配器、客户端和协程库哈希绑定的私有验证记录。`download.status` 报告启用状态，不暴露账号标识。桥接会继续显示缩略图并保留重试标记，直到经验证的原图替换原有 Matrix 事件中的内容。

Git 忽略账号数据、本地笔记、依赖、构建输出、二维码图片、日志、数据库和抓取文件。个人数据不应进入源码、测试数据或 Docker 构建上下文。

如需通过 ADB 连接的手机批准桌面登录请求，在容器运行且网页界面监听端口启用时，在主机执行：

```sh
bun packages/wechat-runtime/scripts/adb-login.ts --watch
```

监听器检查本地 API 中待处理的手机确认，通过 Android 界面自动化匹配微信桌面登录提示并点击登录按钮。微信隐藏无障碍控件时，会检查准确的桌面登录 Activity，并在内存截图中定位绿色大按钮。手机锁定时会等待。连接多台 ADB 设备时设置 `ANDROID_SERIAL`。去掉 `--watch` 仅检查一次，按 Ctrl+C 停止。界面转储是手机上的临时文件，每次检查后删除；不会记录账号或会话文本。

模式信息按数据库身份及 SQLite 模式版本缓存。提交后的写入提示合并受影响的表；无法确定写入范围或存在触发器时扩大扫描范围。至少每分钟执行一次完整快照，失败的扫描保留之前的快照。媒体文件监听仅作为提示，必须通过对应消息的校验和验证后才报告可用。桥接与运行时应使用相同版本部署。
