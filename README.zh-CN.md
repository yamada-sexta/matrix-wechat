# Matrix–WeChat

[English](README.md) | [简体中文](README.zh-CN.md)

使用微信 Linux 客户端的 Matrix–微信桥接。将当前登录的微信账号的会话桥接到私有 Matrix 房间，供一个指定的 Matrix 用户使用。

## 文档

- [部署指南](docs/setup.zh-CN.md) — 使用 Docker Compose 安装并向 homeserver 注册。
- [使用指南](docs/usage.zh-CN.md) — 登录、管理会话和使用桥接命令。
- [功能与限制](docs/features.zh-CN.md) — 支持的消息类型和桥接行为。
- [开发指南](docs/development.zh-CN.md) — 构建、测试和开发桥接。

部署需要 amd64 Linux 主机，以及在 Matrix homeserver 上注册应用服务的权限。不支持加密的 Matrix 房间。

## 许可证

[AGPL-3.0](LICENSE)。
