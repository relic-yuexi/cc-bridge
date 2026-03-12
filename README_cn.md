# cc-bridge

<div align="center">

**Claude Code 的开源远程桥接方案**

[English](README.md) | [简体中文](README_cn.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)

*继 OpenClaw 开源浪潮后，又一个让 Claude 更自由的开源项目*

</div>

---

## 📖 项目简介

**cc-bridge** 是一个轻量级、开源的 Claude Code 远程桥接管理系统。通过自托管架构，让你完全掌控 Claude 的远程访问方式，支持多环境管理、团队协作和自定义部署。

### 为什么选择 cc-bridge？

虽然 Claude Code 提供了官方 Remote Control 功能，但 cc-bridge 提供：

- ✅ **自主部署** - 无需依赖 claude.ai 账号系统
- ✅ **自定义界面** - 完全掌控用户体验
- ✅ **多环境管理** - 同时管理多个 Claude 实例
- ✅ **团队协作** - 搭建团队内部的 Claude 服务
- ✅ **完全开源** - 代码可审计，可二次开发

---

## ✨ 核心特性

### 🌐 Web 端访问
- 内置简洁的 Web 聊天界面
- 无需依赖 claude.ai，完全独立部署
- 支持任何设备的浏览器访问

### 🔗 多桥接架构
```
Web 客户端 ←→ 中央服务器 ←→ 多个桥接器 ←→ 多个 Claude 实例
```
- 一个服务器管理多个 Bridge
- 每个 Bridge 可运行在不同机器上
- 轻松切换不同工作环境

### ⚡ 双模式支持
- **stdin/stdout 模式**：稳定可靠，兼容性强
- **SDK URL 模式**：性能更强，WebSocket 直连

### 🔐 灵活的权限控制
- **Web 端审批**：实时接收权限请求，一键批准/拒绝
- **自动批准模式**：信任环境下可配置自动通过
- **批量操作**：支持批量审批，提高效率
- **审计追溯**：完整的审批记录，便于合规审计

### 💾 会话持久化
- 会话状态自动保存到文件系统
- 支持会话恢复，断线重连不丢失上下文
- 完整的日志记录，方便调试和审计

### 🔄 稳定保活机制
- **心跳监控**：自动检测 Bridge 在线状态
- **断线重连**：网络波动时自动恢复连接
- **进程守护**：Bridge 可配置为系统服务，开机自启
- **会话恢复**：断线后会话状态不丢失，重连即可继续

### 🎛️ 灵活配置
- 支持自定义环境变量（Bridge 级别和会话级别）
- 可配置工作目录、Claude 命令等
- 支持多种环境变量配置方式

---

## 🚀 快速开始

### 环境要求
- Node.js >= 16.0.0
- 已安装 Claude Code CLI
- Anthropic API 密钥

### 安装步骤

1. **克隆仓库**
```bash
git clone https://github.com/relic-yuexi/cc-bridge.git
cd cc-bridge
npm install
```

2. **配置环境（可选）**
```bash
# 复制示例配置文件
cp .env.example .env

# 编辑 .env 文件进行自定义配置
# 详见下方配置说明部分
```

3. **启动中央服务器**
```bash
node server.js
```

4. **启动桥接器**
```bash
# 默认配置
node bridge.js

# 通过环境变量自定义配置
SIGNALING_URL=ws://localhost:8080 \
BRIDGE_NAME=MyProject \
WORK_DIR=/path/to/project \
node bridge.js
```

5. **打开 Web 界面**

在浏览器中访问 `http://localhost:8080`

---

## 📋 使用场景

### 场景一：多服务器统一管理
**痛点**：你有 3 台服务器（开发/测试/生产），每次需要在不同服务器上运行 Claude Code 时，都要 SSH 登录、切换目录、启动命令...

**解决方案**：
- 在每台服务器上运行一个 Bridge（开发环境、测试环境、生产环境）
- 在浏览器中一键切换不同环境，无需 SSH
- 所有操作在 Web 端完成，包括权限审批

**效果**：从"打开 3 个终端窗口"变成"浏览器选择环境"

### 场景二：移动办公
**痛点**：在咖啡厅用 iPad 想改代码，但 Claude Code 只能在本地电脑运行

**解决方案**：
- 家里电脑运行 Bridge 连接到云服务器
- iPad 浏览器访问 Web 界面
- 实时编辑代码、审批文件操作权限

**效果**：任何设备都能使用完整的 Claude Code 功能

### 场景三：团队协作
**痛点**：团队成员需要访问共享的开发环境，但每个人都要配置 Claude Code

**解决方案**：
- 部署一个中央服务器
- 为每个项目/成员配置独立的 Bridge
- 统一的 Web 入口，权限集中管理

**效果**：团队成员通过浏览器即可访问，无需本地安装配置

---

## 🔒 安全性保障

### Token 安全
✅ **API Key 只存储在 Bridge 本地**
- Token 通过环境变量配置在 Bridge 服务器上
- 中央服务器**不存储、不记录**任何 API Key
- 消息转发过程中 Token 不会传输

✅ **通信加密**
- 支持 HTTPS/WSS 加密传输
- 建议生产环境启用 SSL 证书
- 内网部署可降低网络攻击风险

✅ **访问控制**
- 可配置 IP 白名单
- 支持添加身份认证层（Nginx/反向代理）
- Bridge 连接需要正确的服务器地址

### 数据安全
✅ **代码不离开本地**
- 所有文件操作在 Bridge 服务器本地执行
- 只有对话内容发送到 Anthropic API（和直接用 Claude Code 一样）

✅ **内网部署方案**
- 中央服务器可部署在内网
- 代码和敏感数据完全不出内网
- 符合企业安全合规要求

### 最佳实践
🔐 使用环境变量管理 Token，不要硬编码
🔐 生产环境启用 HTTPS/WSS
🔐 定期轮换 API Key
🔐 内网部署 + 外网代理访问 Anthropic API

---

## 🆚 功能对比

| 特性 | cc-bridge | 官方 Remote Control |
|------|-----------|-------------------|
| **部署方式** | 完全自主部署 | 依赖 claude.ai |
| **账号系统** | 无需 claude.ai 账号 | 需要 Pro/Max/Team/Enterprise |
| **Web 界面** | 自定义 UI，完全可控 | 固定使用 claude.ai/code |
| **多实例管理** | ✅ 支持多 Bridge 管理 | ❌ 每次一个会话 |
| **团队部署** | ✅ 可搭建内部服务 | ⚠️ 需要企业订阅 |
| **开源** | ✅ 完全开源 | ❌ 闭源 |
| **扩展性** | ✅ 可二次开发 | ❌ 无法定制 |
| **网络要求** | 内网可用 | 需要连接 Anthropic API |

---

## 🗺️ 未来规划

### 即将支持
🚧 **QQ 机器人集成**
- 通过 QQ 直接与 Claude 对话
- 支持群聊和私聊模式
- 代码片段自动格式化

🚧 **企业微信智能助手**
- 接入企业微信应用
- 团队成员通过企微使用 Claude
- 支持审批流程集成

🚧 **更多平台**
- 钉钉机器人
- Slack Bot
- Discord Bot
- Telegram Bot

---

## 🛠️ 配置说明

### 环境变量

你可以使用 `.env` 文件或环境变量来配置 cc-bridge。将 `.env.example` 复制为 `.env` 并根据需要修改。

#### 服务器配置

```bash
# 服务器监听端口（默认：8080）
PORT=8080

# 服务器绑定地址（默认：0.0.0.0）
# 0.0.0.0 = 所有网络接口，127.0.0.1 = 仅本地访问
HOST=0.0.0.0

# 自定义服务器 .env 文件路径
SERVER_ENV_FILE=/path/to/server.env

# 服务器进程日志目录
SERVER_LOG_DIR=/path/to/server/logs

# 服务器会话状态目录（持久化会话快照和消息历史）
SERVER_SESSION_DIR=/path/to/server/sessions
```

#### 桥接器配置

```bash
# 自定义桥接器 .env 文件路径
BRIDGE_ENV_FILE=/path/to/bridge.env

# 唯一桥接器标识符（未设置时自动生成 UUID）
BRIDGE_ID=my-bridge-01

# 桥接器显示名称（在 Web 界面中显示）
BRIDGE_NAME=My-Bridge

# 服务器 WebSocket URL（桥接器连接到此地址）
SIGNALING_URL=ws://localhost:8080

# Claude 进程的默认工作目录
WORK_DIR=/path/to/project

# Claude CLI 命令或 claude 二进制文件的完整路径
CLAUDE_CMD=claude

# 此桥接器上的最大并发 Claude 会话数
MAX_SESSIONS=10

# 使用 --sdk-url 模式进行 Claude <-> 服务器直接通信
# 1 = sdk-url 模式（性能更好），0 = stdin/stdout 模式（更稳定）
USE_SDK_URL=1

# 全局跳过所有工具权限提示（谨慎使用！）
# 警告：这将允许 Claude 在没有用户确认的情况下运行任何工具
DANGEROUSLY_SKIP_PERMISSIONS=0

# 桥接器进程日志目录
BRIDGE_LOG_DIR=/path/to/bridge/logs

# 桥接器每个会话的日志目录
BRIDGE_SESSION_DIR=/path/to/bridge/logs/sessions
```

#### Claude 环境变量

这些变量将被注入到桥接器启动的每个 Claude 子进程中。

**方法 1：直接变量**（自动检测常见的 Anthropic 变量）
```bash
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=sk-ant-xxx
ANTHROPIC_AUTH_TOKEN=sk-xxx
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001
```

**方法 2：CLAUDE_ENV_ 前缀**（用于任何自定义变量）
```bash
# CLAUDE_ENV_ 前缀在传递给 Claude 之前会被去除
CLAUDE_ENV_MY_CUSTOM_VAR=value
CLAUDE_ENV_DATABASE_URL=postgres://localhost/mydb
```

**方法 3：JSON 格式**（一次设置多个变量）
```bash
BRIDGE_ENV='{"ANTHROPIC_BASE_URL":"https://api.minimax.chat/anthropic","ANTHROPIC_MODEL":"MiniMax-M2.5"}'
```

#### 替代 API 提供商

cc-bridge 支持任何兼容 Anthropic 的 API。MiniMax 示例：

```bash
ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic
ANTHROPIC_AUTH_TOKEN=sk-xxx
ANTHROPIC_MODEL=MiniMax-M2.5
ANTHROPIC_SMALL_FAST_MODEL=MiniMax-M2.5
ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M2.5
ANTHROPIC_DEFAULT_OPUS_MODEL=MiniMax-M2.5
ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M2.5
```

---

## 📚 技术架构

### 组件说明
- **server.js**：中央服务器，负责 Bridge 注册、会话管理、消息路由
- **bridge.js**：桥接器，负责启动和管理 Claude 子进程
- **index.html**：Web 聊天界面，提供友好的用户体验

### 消息协议
支持完整的双向通信协议：
- Bridge 注册和心跳
- 会话创建和恢复
- 用户消息和 Agent 事件
- 权限请求和响应
- 会话中断和停止

---

## 🤝 参与贡献

欢迎贡献代码！请随时提交 Pull Request。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 开源协议

本项目采用 MIT 协议 - 查看 [LICENSE](LICENSE) 文件了解详情。

---

## 🙏 致谢

- [Claude Code](https://code.claude.com/) - 官方 Claude Code CLI
- [OpenClaw](https://github.com/openclaw) - 来自开源社区的灵感

---

## 📞 支持与反馈

- **问题反馈**：[GitHub Issues](https://github.com/relic-yuexi/cc-bridge/issues)
- **官方文档**：[Claude Code Remote Control](https://code.claude.com/docs/en/remote-control#new-session)

---

<div align="center">

**⭐ 如果觉得有用，欢迎 Star 支持！**

</div>
