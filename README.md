# cc-bridge

<div align="center">

**Open-source remote bridge for Claude Code**

[English](README.md) | [简体中文](README_cn.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)

*Inspired by the open-source movement following OpenClaw*

</div>

---

## 📖 Overview

**cc-bridge** is a lightweight, open-source remote bridge management system for Claude Code. It enables complete control over Claude's remote access through a self-hosted architecture, supporting multiple environments, team collaboration, and custom deployments.

### Why cc-bridge?

While Claude Code offers official Remote Control functionality, cc-bridge provides:

- ✅ **Self-hosted deployment** - No dependency on claude.ai account system
- ✅ **Custom web interface** - Full control over user experience
- ✅ **Multi-environment management** - Manage multiple Claude instances simultaneously
- ✅ **Team collaboration** - Build internal Claude services for your team
- ✅ **Fully open-source** - Audit code and extend functionality

---

## ✨ Features

### 🌐 Web-based Access
- Built-in clean web chat interface
- Independent deployment without claude.ai dependency
- Access from any device with a browser

### 🔗 Multi-bridge Architecture
```
Web Client ←→ Central Server ←→ Multiple Bridges ←→ Multiple Claude Instances
```
- One server manages multiple bridges
- Each bridge runs on different machines
- Easy switching between work environments

### ⚡ Dual Mode Support
- **stdin/stdout mode**: Stable and reliable, high compatibility
- **SDK URL mode**: Better performance, WebSocket direct connection

### 🔐 Flexible Permission Control
- **Web approval**: Real-time permission requests with one-click approve/reject
- **Auto-approve mode**: Configure automatic approval for trusted environments
- **Batch operations**: Approve multiple requests efficiently
- **Audit trail**: Complete approval records for compliance

### 💾 Session Persistence
- Automatic session state saving to filesystem
- Session recovery support, no context loss on reconnection
- Complete logging for debugging and auditing

### 🔄 Stable Keep-alive Mechanism
- **Heartbeat monitoring**: Automatic bridge online status detection
- **Auto-reconnect**: Automatic recovery on network fluctuations
- **Process daemon**: Configure bridge as system service with auto-start
- **Session recovery**: No state loss after disconnection

### 🎛️ Flexible Configuration
- Custom environment variables (bridge-level and session-level)
- Configurable working directory and Claude commands
- Multiple environment variable configuration methods

---

## 🚀 Quick Start

### Prerequisites
- Node.js >= 16.0.0
- Claude Code CLI installed
- Anthropic API key

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/relic-yuexi/cc-bridge.git
cd cc-bridge
npm install
```

2. **Configure environment (optional)**
```bash
# Copy the example configuration file
cp .env.example .env

# Edit .env with your preferred settings
# See Configuration section below for details
```

3. **Start the central server**
```bash
node server.js
```

4. **Start a bridge**
```bash
# Default configuration
node bridge.js

# Custom configuration via environment variables
SIGNALING_URL=ws://localhost:8080 \
BRIDGE_NAME=MyProject \
WORK_DIR=/path/to/project \
node bridge.js
```

5. **Open web interface**

Visit `http://localhost:8080` in your browser

---

## 📋 Use Cases

### Scenario 1: Multi-server Management
**Problem**: Managing 3 servers (dev/test/prod) requires SSH login, directory switching, and command execution each time.

**Solution**:
- Run one bridge on each server
- Switch environments in browser without SSH
- All operations including permission approval in web UI

**Result**: From "opening 3 terminal windows" to "selecting environment in browser"

### Scenario 2: Mobile Development
**Problem**: Want to code on iPad at a coffee shop, but Claude Code only runs locally.

**Solution**:
- Home computer runs bridge connected to cloud server
- iPad browser accesses web interface
- Real-time code editing and permission approval

**Result**: Full Claude Code functionality on any device

### Scenario 3: Team Collaboration
**Problem**: Team members need shared dev environment access, but everyone must configure Claude Code.

**Solution**:
- Deploy one central server
- Configure independent bridges for each project/member
- Unified web entry with centralized permission management

**Result**: Team members access via browser without local installation

---

## 🔒 Security

### Token Security
✅ **API keys stored locally on bridge only**
- Tokens configured via environment variables on bridge servers
- Central server **does not store or log** any API keys
- Tokens never transmitted during message forwarding

✅ **Encrypted communication**
- HTTPS/WSS encryption support
- SSL certificates recommended for production
- Internal network deployment reduces attack surface

✅ **Access control**
- IP whitelist configuration
- Authentication layer support (Nginx/reverse proxy)
- Bridge connection requires correct server address

### Data Security
✅ **Code stays local**
- All file operations execute locally on bridge server
- Only conversation content sent to Anthropic API (same as direct Claude Code usage)

✅ **Internal network deployment**
- Central server deployable on internal network
- Code and sensitive data never leave internal network
- Meets enterprise security compliance requirements

### Best Practices
🔐 Use environment variables for tokens, never hardcode
🔐 Enable HTTPS/WSS in production
🔐 Rotate API keys regularly
🔐 Internal deployment + external proxy for Anthropic API access

---

## 🆚 Comparison

| Feature | cc-bridge | Official Remote Control |
|---------|-----------|------------------------|
| **Deployment** | Self-hosted | Depends on claude.ai |
| **Account** | No claude.ai account needed | Requires Pro/Max/Team/Enterprise |
| **Web UI** | Custom UI, full control | Fixed claude.ai/code interface |
| **Multi-instance** | ✅ Multiple bridge management | ❌ One session at a time |
| **Team deployment** | ✅ Internal service setup | ⚠️ Requires enterprise subscription |
| **Open source** | ✅ Fully open-source | ❌ Closed source |
| **Extensibility** | ✅ Customizable | ❌ No customization |
| **Network** | Works on internal network | Requires Anthropic API connection |

---

## 🗺️ Roadmap

### Coming Soon
🚧 **QQ Bot Integration**
- Chat with Claude directly via QQ
- Group and private chat support
- Auto-formatted code snippets

🚧 **WeChat Work Assistant**
- WeChat Work application integration
- Team access to Claude via WeChat Work
- Approval workflow integration

🚧 **More Platforms**
- DingTalk Bot
- Slack Bot
- Discord Bot
- Telegram Bot

---

## 🛠️ Configuration

### Environment Variables

You can configure cc-bridge using a `.env` file or environment variables. Copy `.env.example` to `.env` and modify as needed.

#### Server Configuration

```bash
# Server listening port (default: 8080)
PORT=8080

# Server bind address (default: 0.0.0.0)
# 0.0.0.0 = all interfaces, 127.0.0.1 = localhost only
HOST=0.0.0.0

# Custom .env file path for server
SERVER_ENV_FILE=/path/to/server.env

# Server process log directory
SERVER_LOG_DIR=/path/to/server/logs

# Server session state directory (persists session snapshots and message history)
SERVER_SESSION_DIR=/path/to/server/sessions
```

#### Bridge Configuration

```bash
# Custom .env file path for bridge
BRIDGE_ENV_FILE=/path/to/bridge.env

# Unique bridge identifier (auto-generated UUID if not set)
BRIDGE_ID=my-bridge-01

# Display name for this bridge (shown in the web UI)
BRIDGE_NAME=My-Bridge

# Server WebSocket URL (bridge connects to this)
SIGNALING_URL=ws://localhost:8080

# Default working directory for Claude processes
WORK_DIR=/path/to/project

# Claude CLI command or full path to the claude binary
CLAUDE_CMD=claude

# Maximum number of concurrent Claude sessions on this bridge
MAX_SESSIONS=10

# Use --sdk-url mode for direct Claude <-> server communication
# 1 = sdk-url mode (better performance), 0 = stdin/stdout mode (more stable)
USE_SDK_URL=1

# Skip all tool permission prompts globally (use with caution!)
# WARNING: This allows Claude to run any tool without user confirmation
DANGEROUSLY_SKIP_PERMISSIONS=0

# Bridge process log directory
BRIDGE_LOG_DIR=/path/to/bridge/logs

# Bridge per-session log directory
BRIDGE_SESSION_DIR=/path/to/bridge/logs/sessions
```

#### Claude Environment Variables

These variables are injected into every Claude child process spawned by the bridge.

**Method 1: Direct variables** (auto-detected common Anthropic vars)
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

**Method 2: CLAUDE_ENV_ prefix** (for any custom variable)
```bash
# The CLAUDE_ENV_ prefix is stripped before passing to Claude
CLAUDE_ENV_MY_CUSTOM_VAR=value
CLAUDE_ENV_DATABASE_URL=postgres://localhost/mydb
```

**Method 3: JSON format** (set multiple vars at once)
```bash
BRIDGE_ENV='{"ANTHROPIC_BASE_URL":"https://api.minimax.chat/anthropic","ANTHROPIC_MODEL":"MiniMax-M2.5"}'
```

#### Alternative API Providers

cc-bridge supports any Anthropic-compatible API. Example for MiniMax:

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

## 📚 Architecture

### Components
- **server.js**: Central server for bridge registration, session management, message routing
- **bridge.js**: Bridge for starting and managing Claude subprocesses
- **index.html**: Web chat interface for user experience

### Message Protocol
Complete bidirectional communication protocol:
- Bridge registration and heartbeat
- Session creation and recovery
- User messages and agent events
- Permission requests and responses
- Session interruption and termination

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [Claude Code](https://code.claude.com/) - Official Claude Code CLI
- [OpenClaw](https://github.com/openclaw) - Inspiration from the open-source community

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/relic-yuexi/cc-bridge/issues)
- **Documentation**: [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control#new-session)

---

<div align="center">

**⭐ Star this repo if you find it useful!**

</div>
