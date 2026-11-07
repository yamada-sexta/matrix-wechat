# 部署指南

[English](setup.md) | [简体中文](setup.zh-CN.md)

本指南面向使用 Docker Compose 自行部署桥接的管理员。从源码构建和运行检查请参阅[开发指南](development.zh-CN.md)。

## 前置条件

- 安装了 Docker 和 Docker Compose 插件的 amd64 Linux 主机。运行时包含固定版本的 x86-64 微信 Linux 客户端。
- 支持应用服务（appservice）的 Matrix homeserver，以及注册应用服务的权限。
- 一个已有的 Matrix 账号，作为桥接所有者；手机上已登录的微信账号，用于确认桌面端登录。
- 下述命令需要 Git 和 OpenSSL。

每个桥接实例仅服务一个 Matrix 所有者，并跟随运行时中当前登录的微信账号。桥接内置 SQLite，无需另行部署数据库服务器。

## 1. 准备配置

```sh
git clone https://github.com/yamada-sexta/matrix-wechat.git
cd matrix-wechat
mkdir -p data/bridge data/wechat
cp example-config.yaml data/bridge/config.yaml
```

后续命令均在此仓库目录中执行。如果已有配置，请编辑原文件，不要覆盖。

生成桥接与运行时共用的 API 密钥：

```sh
openssl rand -hex 32
```

在仓库根目录创建 `.env`，填入生成的值：

```dotenv
WECHAT_API_TOKEN=replace_with_the_generated_secret
```

如果 `.env` 已存在，将此设置添加到原文件。两个容器使用该密钥验证桥接到运行时的请求；它与稍后生成的 Matrix 注册令牌不同。

```sh
chmod 600 .env
```

编辑 `data/bridge/config.yaml`：

| 配置项 | 应填写的值 |
| --- | --- |
| `homeserver.address` | **从桥接容器访问**的 homeserver URL，例如共享 Docker 网络中的 `http://synapse:8008`，或 `https://matrix.example.com`。 |
| `homeserver.domain` | Matrix 服务器名称，例如用户 ID 为 `@you:example.com` 时填写 `example.com`。它可能与上述 URL 中的主机名不同。 |
| `appservice.address` | **从 homeserver 访问**的桥接 URL，例如共享 Docker 网络中的 `http://bridge:17778`。 |
| `bridge.owner` | 完整的 Matrix 用户 ID，例如 `'@you:example.com'`。只有此用户可以控制桥接。 |

使用仓库提供的 Compose 文件时，保留示例中的 `wechat.address: http://wechat-runtime:18743`、`appservice.hostname: 0.0.0.0` 和 `/data/...` 路径。桥接容器中的 `/data` 对应主机上的 `data/bridge`。

### 配置 homeserver 网络

Homeserver 必须能访问桥接，桥接也必须能访问 homeserver。容器中的 `localhost` 指向该容器自身。

如果 homeserver 运行在另一个 Compose 项目中，将桥接加入它已有的 Docker 网络。在 `compose.yaml` 旁创建 `compose.override.yaml`：

```yaml
services:
  bridge:
    networks:
      - default
      - homeserver

networks:
  homeserver:
    external: true
    name: synapse_default
```

将 `synapse_default` 替换为 homeserver 的实际网络名称，可用 `docker network ls` 查看。桥接同时保留默认网络，以访问微信运行时。Compose 会自动加载此覆盖文件。

如果 homeserver 的网络别名为 `synapse`，可使用 `homeserver.address: http://synapse:8008` 和 `appservice.address: http://bridge:17778`。

如果 homeserver 直接运行在同一主机上，可通过 Compose 发布的 `http://127.0.0.1:17778` 访问桥接。`homeserver.address` 则须填写 Docker 容器内可访问的 URL。如果 homeserver 位于另一台机器，需要提供它可访问的桥接地址；默认仅绑定 localhost 的端口无法满足这一要求。

### 数据目录权限

两个镜像均以 UID/GID `1000:1000` 运行。桥接需要读取配置并写入 `data/bridge`，运行时需要写入 `data/wechat`。如果主机用户的 UID 不同，请先将这两个目录交给容器用户：

```sh
sudo chown -R 1000:1000 data/bridge data/wechat
```

## 2. 获取镜像并生成注册文件

Compose 文件使用已发布的 `:master` 镜像：

```sh
docker compose pull
docker compose run --rm --no-deps bridge --check-config
docker compose run --rm --no-deps bridge -g
```

如需在本地构建，将 `docker compose pull` 换成 `docker compose build`。

最后一条命令会创建 `data/bridge/registration.yaml`。生成过程拒绝覆盖已有注册文件；重启或更新时请保留它。配置检查只验证配置项，不测试网络连通性。

## 3. 注册应用服务

桥接和 homeserver 必须使用同一份生成的注册信息。保留桥接端的 `data/bridge/registration.yaml`。

对于 Synapse，将该文件复制或挂载到 Synapse 可读取的位置，再在 `homeserver.yaml` 中添加路径：

```yaml
app_service_config_files:
  - /data/wechat-registration.yaml
```

如果已有列表，请追加。Synapse 运行在容器中时，这里填写的是**容器内的路径**。例如，可为 Synapse 服务添加以下只读挂载，并替换主机路径：

```yaml
volumes:
  - /absolute/path/to/matrix-wechat/data/bridge/registration.yaml:/data/wechat-registration.yaml:ro
```

确认 Synapse 能读取文件后重启它；如果新增了挂载，需要重新创建容器。其他 homeserver 的操作方式不同，可参阅[应用服务注册指南](https://docs.mau.fi/bridges/general/registering-appservices.html)。

## 4. 启动并登录

```sh
docker compose up -d
docker compose logs --tail=100 bridge wechat-runtime
```

在 Matrix 中接受桥接管理房间的邀请，然后发送 `login qr`。使用手机微信扫描图片并完成确认。对于桌面端记住的账号，也可发送 `login prompt` 请求手机确认。

也可在运行时的网页界面 <http://127.0.0.1:18742/> 发起登录。如果部署在远程主机，可将端口转发到自己的电脑：

```sh
ssh -L 18742:127.0.0.1:18742 user@bridge-host
```

登录后，桥接会为可见的微信会话创建私有房间，并导入本地缓存的历史消息。接受房间邀请，在管理房间发送 `status` 检查连接。更多命令请参阅[使用指南](usage.zh-CN.md)。

Compose 默认只在 localhost 发布网页界面（`18742`）和 Matrix 应用服务（`17778`）。需要身份验证的运行时 API（`18743`）仅在容器网络中开放。

## 可选设置

### 禁用网页界面

在 `.env` 中添加 `WECHAT_WEB_UI=false`，然后重新创建运行时容器：

```sh
docker compose up -d --force-recreate wechat-runtime
```

需要身份验证的 API 和 Matrix 登录命令仍可使用。主机端 ADB 登录监听器需要网页界面监听端口保持启用。

### 双向身份映射（Double puppeting）

启用后，从你自己的微信账号发出的新消息会以你的真实 Matrix 用户身份显示，桥接也会替你接受其房间邀请。未启用时，消息使用桥接虚拟账号（ghost），你需要手动接受邀请。

1. 按照[注册说明](https://docs.mau.fi/bridges/general/double-puppeting.html#automatically)，在 homeserver 上安装独立的双向身份映射应用服务注册。其非独占用户命名空间必须包含 `bridge.owner`。可复用符合条件的已有注册；不要修改桥接自身的 ghost 注册。
2. 将该注册文件中 **`as_token` 的原始值**添加到 `.env`：

   ```dotenv
   MATRIX_OWNER_AS_TOKEN=replace_with_the_double_puppeting_as_token
   ```

3. 重新创建桥接容器：

   ```sh
   docker compose up -d --force-recreate bridge
   ```

`MATRIX_OWNER_AS_TOKEN` 是本桥接专用的配置。不要添加 mautrix 示例中的 `as_token:` 前缀。Compose 仅将其传给桥接容器。桥接启动时会验证所有者身份；已导入消息的作者和主动离开房间的状态会保留。

## 更新与备份

保留 `.env`、`data/bridge` 和 `data/wechat`。它们包含凭据、房间映射、历史同步游标，以及微信账号和会话文件。备份前先停止服务。不要让两个运行时同时使用同一个账号目录。

更新已发布的镜像：

```sh
docker compose pull
docker compose up -d
```

使用 `docker compose stop` 停止两个服务并保留数据，或用 `docker compose restart bridge` 仅重启 Matrix 桥接。镜像更新需要执行 `up -d` 重新创建容器。不提供旧版 Go 配置和数据库的迁移。

## 故障排查

- **缺少 `WECHAT_API_TOKEN`：** 确认 `.env` 位于仓库根目录，且值非空。
- **权限不足：** 检查数据目录所有权，并确认 homeserver 能读取其注册文件副本。
- **没有管理房间邀请，或 Matrix 消息无法发送到微信：** 检查双向网络连通性、注册文件中的 URL，以及 homeserver 是否已加载注册。查看桥接和 homeserver 日志。
- **微信已退出或断开：** 发送 `status`，再发送 `login prompt` 或 `login qr`。如果客户端无法启动，查看运行时日志。
- **注册文件已存在：** 继续使用它。如果修改了影响注册的配置，需同步更新两端副本，并重启 homeserver 和桥接。不要仅为重启服务而删除注册文件。
