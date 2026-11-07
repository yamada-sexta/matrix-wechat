# 开发指南

[English](development.md) | [简体中文](development.zh-CN.md)

部署配置、homeserver 注册和首次登录请参阅[部署指南](setup.zh-CN.md)。

## 仓库结构

| 包 | 职责 |
| --- | --- |
| `packages/matrix-bridge` | Matrix 应用服务、房间映射、历史游标和发送跟踪。 |
| `packages/wechat-runtime` | 微信客户端、账号文件、需要身份验证的 API，以及可选的 React 网页界面。 |
| `packages/wechat-rpc` | 共享的 tRPC 契约、类型和客户端。 |
| `packages/wechat-native` | Frida 注入代码、固定的原生配置和随运行时打包的 C++ 下载适配器。 |

桥接和运行时位于独立容器，通过 `wechat-rpc` 进行 HTTP 通信。桥接不启动微信、不访问微信账号文件，也不导入原生运行时代码。桥接状态通过 `bun:sqlite` 存储于 `data/bridge`，微信状态保存在 `data/wechat`。重启桥接不会停止客户端或网页界面。

客户端版本固定、注入机制及独立运行方式请参阅[运行时](../packages/wechat-runtime/README.zh-CN.md)和[原生集成](../packages/wechat-native/README.zh-CN.md)文档。

## 本地检查与镜像

使用 `package.json` 和 Dockerfile 中固定的 Bun 1.3.14。在仓库根目录安装依赖，四个包共用同一个 Bun 锁文件。

```sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run test
bun run build
podman build -f packages/matrix-bridge/Dockerfile -t localhost/matrix-wechat:dev .
podman build -f packages/wechat-runtime/Dockerfile -t localhost/wechatlinux-demo:dev .
```

这些检查不会启动微信。`bun run build` 构建运行时应用和 React 界面；桥接直接运行 TypeScript 入口。两个 Dockerfile 都使用仓库根目录作为构建上下文。可将 Podman 换成 Docker，或使用 `docker compose build` 构建部署镜像。

仅运行时镜像包含固定版本的 amd64 微信客户端、Frida 和图形界面依赖。桥接不需要原生客户端所需的容器能力，也不挂载微信数据卷。

## 桥接命令行

入口为 `packages/matrix-bridge/src/main.ts`，在仓库根目录可执行 `bun run start`。

| 选项 | 用途 |
| --- | --- |
| `-c <config>` | 指定配置文件，默认为 `config.yaml`。 |
| `-r <registration>` | 覆盖配置中的注册文件路径。 |
| `-g` | 生成应用服务注册文件。 |
| `-e` | 写入示例配置。 |
| `--check-config` | 验证配置，不启动桥接。 |
| `--version` | 输出桥接和 Bun 的版本。 |

生成过程拒绝覆盖已有文件。容器入口已提供 `-c /data/config.yaml`。

## CI

CI 分别构建并发布 amd64 镜像 `ghcr.io/yamada-sexta/matrix-wechat` 和 `ghcr.io/yamada-sexta/matrix-wechat-runtime`。

每个 amd64 镜像分别通过 GitHub Actions 缓存 Docker 层。运行时在复制应用代码前准备并验证只读客户端，因此修改源码时可以复用体积较大的客户端层。依赖层取决于工作区清单和锁文件。缓存导出超时为五分钟，尽力执行，失败不影响已成功的构建；构建和验证本身失败仍会导致 CI 失败。客户端或缓存变化后的首次构建可能较慢。

推送和拉取请求仅构建受影响的镜像。桥接或运行时变更分别触发对应镜像；共享 RPC 代码、工作区清单、锁文件、Docker 上下文排除规则和 CI 变更触发两个镜像。仅文档或部署配置变更不构建镜像。发布标签和手动运行会构建两个镜像。

查看 CI 日志时，在 Actions 中选择运行记录，再选择 `matrix-bridge` 或 `wechat-runtime` 任务。如果 GitHub 任务页面不显示步骤，可尝试 `gh run view RUN_ID --log` 获取原始日志；存在步骤元数据时，可用 `--log-failed` 筛选失败步骤。Lint、类型检查、测试和打包输出位于 **Build and cache verification image** 步骤中。复用的 Docker 层显示为 `CACHED`，不会重复输出之前的日志。

## 真实环境端到端测试

[E2E 测试程序](../packages/matrix-bridge/scripts/e2e.ts)需要 Podman、Bun、供登录监听器使用的 ADB 连接手机，以及 `data/wechat` 中真实的微信账号数据。可选择以下测试：

```sh
bun run test:matrix all --build   # 重新构建两个镜像并运行全部测试
bun run test:matrix quote        # 仅测试文本引用和引用回复
bun run test:matrix image file video
bun run test:matrix history      # 历史、富文本卡片和接收媒体的精确校验
bun run test:matrix restart outage
bun run test:matrix permissions encryption
```

不带 `--build` 时复用本地已有镜像，缺失的镜像会自动构建。每次运行都会启动独立的运行时、Synapse 和桥接容器，注册测试 Matrix 所有者和应用服务，并启动 ADB 登录监听器。如果微信无法请求手机确认，请手动扫码。所有发送测试**仅发往文件传输助手**。测试不会发送或领取转账、红包；历史测试只检查收到的支付卡片。图片、文件和 MP4 测试复用账号缓存的真实数据，因此账号中须已有相应示例。

如果独立的 `wechatlinux-demo` 容器正在运行，测试会暂时停止它以避免同时访问账号，并在结束后恢复。运行测试前，请停止其他使用 `data/wechat` 的运行时，包括 Compose 运行时。可通过 `BRIDGE_IMAGE` 和 `WECHAT_RUNTIME_IMAGE` 覆盖镜像，通过 `WECHATLINUX_CONTAINER` 指定已有容器。私有日志和验证摘要保存在被 Git 忽略的 `data/matrix-acceptance/` 中。
