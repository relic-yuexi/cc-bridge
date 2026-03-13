// bridge.js - Multi-Session Bridge
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { applyEnvFile, ensureDir, createTimestampLabel, safePathSegment, formatLogArgs, initProcessLogger, makeAppendEventFn } from './shared/utils.js';
import { uploadFileBase64 } from './shared/http-upload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file from bridge directory (won't override existing process.env)
applyEnvFile('BRIDGE_ENV_FILE', join(__dirname, '.env'));

// ============ Configuration ============
const SIGNALING_URL = process.env.SIGNALING_URL || 'ws://localhost:8080';
const BRIDGE_ID = process.env.BRIDGE_ID || randomUUID();
const BRIDGE_NAME = process.env.BRIDGE_NAME || `Bridge-${BRIDGE_ID.slice(0, 8)}`;
const WORK_DIR = process.env.WORK_DIR || process.cwd();
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '10');
const USE_SDK_URL = process.env.USE_SDK_URL !== '0';
const BRIDGE_LOG_DIR = process.env.BRIDGE_LOG_DIR || join(__dirname, 'logs');
const BRIDGE_SESSION_DIR = process.env.BRIDGE_SESSION_DIR || join(BRIDGE_LOG_DIR, 'sessions');
const BRIDGE_LOG_FILE = join(BRIDGE_LOG_DIR, `bridge-${createTimestampLabel()}.log`);

initProcessLogger(BRIDGE_LOG_FILE, 'bridge');
console.log(`📝 Bridge log: ${BRIDGE_LOG_FILE}`);
console.log(`🗂 Bridge session dir: ${BRIDGE_SESSION_DIR}`);

function getBridgeSessionDir(sessionId) {
  return join(BRIDGE_SESSION_DIR, safePathSegment(sessionId));
}

function getBridgeSessionStateFile(sessionId) {
  return join(getBridgeSessionDir(sessionId), 'session.json');
}

function getBridgeSessionEventFile(sessionId) {
  return join(getBridgeSessionDir(sessionId), 'events.log');
}

// Bridge-level custom environment variables for Claude child processes
// Method 1: JSON format via BRIDGE_ENV env var
//   Example: BRIDGE_ENV='{"ANTHROPIC_BASE_URL":"https://api.minimax.chat/anthropic"}'
// Method 2: .env file with CLAUDE_ENV_ prefix
//   Example in .env:
//     CLAUDE_ENV_ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic
//     CLAUDE_ENV_ANTHROPIC_MODEL=MiniMax-M2.5
// Method 3: Direct env vars matching known patterns
//   ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, etc.

let BRIDGE_ENV = {};

// Load from BRIDGE_ENV JSON
if (process.env.BRIDGE_ENV) {
  try {
    BRIDGE_ENV = JSON.parse(process.env.BRIDGE_ENV);
  } catch (e) {
    console.error('❌ Failed to parse BRIDGE_ENV (must be valid JSON):', e.message);
  }
}

// Load CLAUDE_ENV_* prefixed vars (strip prefix, inject as env vars for Claude)
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('CLAUDE_ENV_')) {
    const realKey = key.slice('CLAUDE_ENV_'.length);
    if (realKey) {
      BRIDGE_ENV[realKey] = value;
    }
  }
}

// Auto-detect common Anthropic/Claude env vars to pass through
const PASSTHROUGH_VARS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];
for (const varName of PASSTHROUGH_VARS) {
  if (process.env[varName] && !(varName in BRIDGE_ENV)) {
    BRIDGE_ENV[varName] = process.env[varName];
  }
}

console.log(`🔗 Bridge starting...`);
console.log(`   Bridge ID: ${BRIDGE_ID}`);
console.log(`   Bridge Name: ${BRIDGE_NAME}`);
console.log(`   Work Dir: ${WORK_DIR}`);
console.log(`   Signaling: ${SIGNALING_URL}`);
console.log(`   Max Sessions: ${MAX_SESSIONS}`);
console.log(`   Mode: ${USE_SDK_URL ? '--sdk-url (direct)' : 'stdin/stdout'}`);
if (Object.keys(BRIDGE_ENV).length > 0) {
  console.log(`   Claude Env Vars: ${Object.keys(BRIDGE_ENV).join(', ')}`);
}

// ============ Bridge Controller ============
class BridgeController {
  constructor() {
    this.bridgeId = BRIDGE_ID;
    this.claudeSessions = new Map(); // sessionId -> ClaudeProcess
    this.pendingControlRequests = new Map(); // requestId -> control_request (for permission_suggestions)
    this.controlWs = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  connect() {
    console.log(`🔌 Connecting to server...`);
    this.controlWs = new WebSocket(`${SIGNALING_URL}/bridge?bridgeId=${this.bridgeId}`);

    this.controlWs.on('open', () => {
      console.log('✅ Connected to server');
      this.register();
      this.startHeartbeat();
      this.recoverSessions();
    });

    this.controlWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this.handleControlMessage(msg);
      } catch (e) {
        console.error('❌ Parse error:', e.message);
      }
    });

    this.controlWs.on('error', (err) => {
      console.error('❌ Control WS error:', err.message);
    });

    this.controlWs.on('close', () => {
      console.log('⚠️  Control WS closed, reconnecting in 5s...');
      this.stopHeartbeat();
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
  }

  register() {
    const metadata = {
      name: BRIDGE_NAME,
      workDir: WORK_DIR,
      claudeCmd: CLAUDE_CMD,
      useSdkUrl: USE_SDK_URL,
      maxSessions: MAX_SESSIONS,
      currentSessions: this.claudeSessions.size,
      envVarKeys: Object.keys(BRIDGE_ENV), // report which env vars are configured (keys only, no secrets)
    };

    this.send({
      type: 'bridge_register',
      bridgeId: this.bridgeId,
      metadata,
    });

    console.log(`✅ Bridge registered`);
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: 'bridge_heartbeat',
        bridgeId: this.bridgeId,
        currentSessions: this.claudeSessions.size,
        timestamp: Date.now(),
      });
    }, 15_000); // Every 15 seconds
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  recoverSessions() {
    // After reconnect, notify server about active sessions
    for (const [sessionId, claudeProc] of this.claudeSessions) {
      if (claudeProc.status === 'running' && claudeProc.claudeSessionId) {
        this.send({
          type: 'session_recovery',
          sessionId,
          claudeSessionId: claudeProc.claudeSessionId,
        });
      }
    }
  }

  handleControlMessage(msg) {
    switch (msg.type) {
      case 'register_ack':
        console.log(`✅ Registration acknowledged`);
        break;

      case 'start_session':
        this.startSession(
          msg.sessionId,
          msg.resume,
          msg.claudeSessionId,
          msg.env || {},
          msg.dangerouslySkipPermissions,
          msg.workDir,
          msg.model
        );
        break;

      case 'user_message':
        this.forwardToSession(msg.sessionId, {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: msg.content }] }
        });
        break;

      case 'upload_file':
        // Upload a file from bridge's file system to server
        this.uploadFileToServer(msg.sessionId, msg.filePath, msg.filename);
        break;

      case 'permission_response':
        // Permission responses delivered over the bridge control channel are written to stdin.
        // This path is for stdin/stdout mode sessions.
        // Must include permission_suggestions from the original control_request, or validation fails.
        {
          const originalRequest = this.pendingControlRequests.get(msg.requestId);
          // Use suggestions explicitly checked by the user in the Web UI.
          // Falls back to all suggestions only when the UI sends no selection info (legacy / non-UI path).
          const permissionSuggestions = Array.isArray(msg.permissions)
            ? msg.permissions
            : (originalRequest?.request?.permission_suggestions || []);

          // Claude Code internally does: D = parsed.response.response; schema.parse(D)
          // where schema is z.union([
          //   z.object({ behavior: "allow", updatedInput: z.record(z.unknown()) }),
          //   z.object({ behavior: "deny", message: z.string() })
          // ])
          // So response.response MUST be present with the correct shape.
          // IMPORTANT: updatedInput must be the ORIGINAL tool input from the control_request,
          // NOT an empty object. Claude Code uses updatedInput to replace the tool's input
          // before execution. An empty {} causes "undefined is not an object" errors
          // because fields like 'command' become undefined.
          const originalInput = originalRequest?.request?.input || {};

          const controlResponse = {
            type: 'control_response',
            session_id: msg.sessionId,
            response: {
              subtype: msg.decision === 'allow' ? 'permission_granted' : 'permission_denied',
              request_id: msg.requestId,
              permissions: permissionSuggestions,
              response: msg.decision === 'allow'
                ? { behavior: 'allow', updatedInput: originalInput }
                : { behavior: 'deny', message: 'User denied permission' },
            },
            request_id: msg.requestId,
          };

          this.forwardToSession(msg.sessionId, controlResponse);
          this.appendSessionEvent(msg.sessionId, 'permission_response', {
            decision: msg.decision,
            requestId: msg.requestId,
            permissions: permissionSuggestions,
          });
          console.log(`[${msg.sessionId}] Permission control_response forwarded to stdin: decision=${msg.decision} requestId=${msg.requestId} permissions=${JSON.stringify(permissionSuggestions)}`);

          // Clean up cached request
          this.pendingControlRequests.delete(msg.requestId);
        }
        break;

      case 'interrupt':
        this.interruptSession(msg.sessionId);
        break;

      case 'set_model':
        // Forward set_model control_request to Claude stdin (for stdin mode)
        this.forwardToSession(msg.sessionId, {
          type: 'control_request',
          request_id: msg.requestId || `set_model-${Date.now()}`,
          request: {
            subtype: 'set_model',
            model: msg.model,
          },
        });
        console.log(`[${msg.sessionId}] Forwarded set_model to Claude stdin: ${msg.model}`);
        break;

      case 'stop_session':
        this.stopSession(msg.sessionId);
        break;
    }
  }

  startSession(sessionId, resume = false, claudeSessionId = null, sessionEnv = {}, dangerouslySkipPermissions = false, sessionWorkDir = null, model = null) {
    if (this.claudeSessions.has(sessionId)) {
      console.log(`⚠️  Session ${sessionId} already exists`);
      return;
    }

    if (this.claudeSessions.size >= MAX_SESSIONS) {
      console.log(`❌ Max sessions reached (${MAX_SESSIONS})`);
      this.send({
        type: 'error',
        sessionId,
        message: 'Max sessions reached',
      });
      return;
    }

    console.log(`🚀 Starting session: ${sessionId} (resume: ${resume})`);

    const sessionDir = getBridgeSessionDir(sessionId);
    ensureDir(sessionDir);
    const runLabel = createTimestampLabel();
    const debugFile = join(sessionDir, `claude-debug-${runLabel}.log`);
    const bridgeLogFile = join(sessionDir, `bridge-raw-${runLabel}.log`);
    const workDir = typeof sessionWorkDir === 'string' && sessionWorkDir.trim()
      ? sessionWorkDir.trim()
      : WORK_DIR;
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--replay-user-messages',
      '--debug', '--debug-file', debugFile,
    ];
    console.log(`📝 Debug log: ${debugFile}`);
    console.log(`📝 Bridge raw log: ${bridgeLogFile}`);
    if (workDir !== WORK_DIR) {
      console.log(`🗂 [${sessionId}] Work Dir: ${workDir}`);
    }

    if (USE_SDK_URL) {
      args.push('--sdk-url', `${SIGNALING_URL}/session/${sessionId}`);
      args.push('--session-id', sessionId);
      args.push('--input-format', 'stream-json');
    } else {
      args.push('--input-format', 'stream-json');
    }

    if (resume && claudeSessionId) {
      args.push('--resume', claudeSessionId);
      console.log(`🔄 Resuming Claude session: ${claudeSessionId}`);
    }

    // --dangerously-skip-permissions: from session param or global env
    const skipPerms = dangerouslySkipPermissions || process.env.DANGEROUSLY_SKIP_PERMISSIONS === '1';
    if (skipPerms) {
      args.push('--dangerously-skip-permissions');
      console.log(`⚠️  [${sessionId}] Running with --dangerously-skip-permissions`);
    }

    // Add model if specified
    if (model) {
      args.push('--model', model);
      console.log(`🤖 [${sessionId}] Using model: ${model}`);
    }

    const uploadBaseUrl = SIGNALING_URL.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const env = {
      ...process.env,
      ...BRIDGE_ENV,           // Bridge-level custom env vars
      ...sessionEnv,           // Session-level custom env vars (override bridge-level)
      CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
      BRIDGE_UPLOAD_URL: `${uploadBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/upload`,
      BRIDGE_UPLOAD_SCRIPT: join(__dirname, 'upload-helper.js'),
      ...(USE_SDK_URL && {
        CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'local-token',
        CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1',
      }),
    };

    // Remove CLAUDECODE to allow nested sessions
    delete env.CLAUDECODE;

    if (Object.keys(sessionEnv).length > 0) {
      console.log(`[${sessionId}] Session env vars: ${Object.keys(sessionEnv).join(', ')}`);
    }

    const child = spawn(CLAUDE_CMD, args, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    const claudeProc = {
      sessionId,
      process: child,
      status: 'starting',
      claudeSessionId: claudeSessionId || null,
      workDir,
      sessionDir,
      debugFile,
      bridgeLogFile,
      runLabel,
      createdAt: Date.now(),
    };

    this.claudeSessions.set(sessionId, claudeProc);
    this.persistSessionState(sessionId);
    this.appendSessionEvent(sessionId, 'session_started', {
      resume,
      claudeSessionId,
      debugFile,
      bridgeLogFile,
      pid: child.pid,
    });

    if (!USE_SDK_URL) {
      // stdin/stdout mode: bridge forwards events
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        this.appendSessionLog(sessionId, 'STDOUT', text);
        const lines = text.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            this.logEvent(sessionId, event);
            if (event.session_id) {
              claudeProc.claudeSessionId = event.session_id;
              this.persistSessionState(sessionId);
            }

            this.send({
              type: 'agent_event',
              sessionId,
              payload: event
            });
          } catch {
            console.log(`[${sessionId}] Raw stdout:`, line.slice(0, 300));
          }
        }
      });
    } else {
      // --sdk-url mode: Claude sends events directly to HTTP endpoint, no need to forward via WebSocket
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        this.appendSessionLog(sessionId, 'STDOUT', text);
        const lines = text.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);

            // Extract and cache session_id if present
            if (parsed.session_id) {
              claudeProc.claudeSessionId = parsed.session_id;
              this.persistSessionState(sessionId);
            }

            // Cache control_requests so we can include permission_suggestions in responses
            if (parsed.type === 'control_request' && parsed.request_id) {
              this.pendingControlRequests.set(parsed.request_id, parsed);
              this.appendSessionEvent(sessionId, 'control_request_cached', {
                requestId: parsed.request_id,
                subtype: parsed.request?.subtype,
              });
              console.log(`[${sessionId}] Cached control_request: requestId=${parsed.request_id} subtype=${parsed.request?.subtype}`);
              this.respondToLocalControlRequest(sessionId, parsed);
            }

            // Log interesting event types in detail
            if (parsed.type === 'control_request' || parsed.type === 'control_response') {
              console.log(`[${sessionId}] Claude stdout [${parsed.type}]:`, JSON.stringify(parsed).slice(0, 1000));
            } else {
              console.log(`[${sessionId}] Claude stdout [${parsed.type || 'unknown'}]:`, line.slice(0, 1000));
            }
          } catch {
            console.log(`[${sessionId}] Claude stdout (raw):`, line.slice(0, 1000));
          }
        }
      });
    }

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.appendSessionLog(sessionId, 'STDERR', text);
      const trimmed = text.trim();
      if (trimmed) console.log(`[${sessionId}] [STDERR]`, trimmed.slice(0, 500));
    });

    child.on('close', (code, signal) => {
      console.log(`[${sessionId}] Claude exited with code=${code} signal=${signal}`);
      claudeProc.status = 'ended';
      this.persistSessionState(sessionId, {
        endedAt: Date.now(),
        exitCode: code,
        exitSignal: signal,
      });
      this.appendSessionEvent(sessionId, 'process_closed', { code, signal });


      if (!USE_SDK_URL) {
        this.send({
          type: 'session_end',
          sessionId,
          code
        });
      }

      this.claudeSessions.delete(sessionId);
    });

    child.on('error', (err) => {
      console.error(`[${sessionId}] Failed to start Claude:`, err.message);
      this.persistSessionState(sessionId, {
        failedAt: Date.now(),
        error: err.message,
      });
      this.appendSessionEvent(sessionId, 'process_error', err.message);
      this.send({
        type: 'error',
        sessionId,
        message: `Failed to start Claude: ${err.message}`
      });
      this.claudeSessions.delete(sessionId);
    });

    // Notify server that session started
    claudeProc.status = 'running';
    this.persistSessionState(sessionId);
    this.send({
      type: 'session_started',
      sessionId,
      status: 'running',
    });
  }

  forwardToSession(sessionId, message) {
    const claudeProc = this.claudeSessions.get(sessionId);
    if (!claudeProc || claudeProc.status !== 'running') {
      console.log(`⚠️  Session ${sessionId} not running`);
      return;
    }

    try {
      claudeProc.process.stdin.write(JSON.stringify(message) + '\n');
      this.appendSessionEvent(sessionId, 'stdin_forwarded', message.type || 'unknown');
      console.log(`[${sessionId}] Forwarded to Claude stdin`);
    } catch (e) {
      console.error(`[${sessionId}] Failed to write to stdin:`, e.message);
    }
  }

  respondToLocalControlRequest(sessionId, request) {
    const claudeProc = this.claudeSessions.get(sessionId);
    if (!claudeProc || claudeProc.status !== 'running') {
      return false;
    }

    const subtype = request?.request?.subtype;
    if (!subtype || !request.request_id) {
      return false;
    }

    let controlResponse = null;
    switch (subtype) {
      case 'initialize':
        controlResponse = {
          type: 'control_response',
          session_id: sessionId,
          response: {
            subtype: 'success',
            request_id: request.request_id,
            response: {
              commands: [],
              output_style: 'normal',
              available_output_styles: ['normal'],
              models: [],
              account: {},
              pid: claudeProc.process?.pid || null,
            },
          },
          request_id: request.request_id,
        };
        break;

      case 'set_max_thinking_tokens':
        controlResponse = {
          type: 'control_response',
          session_id: sessionId,
          response: {
            subtype: 'success',
            request_id: request.request_id,
          },
          request_id: request.request_id,
        };
        break;

      default:
        return false;
    }

    this.forwardToSession(sessionId, controlResponse);
    this.appendSessionEvent(sessionId, 'local_control_response', {
      requestId: request.request_id,
      subtype,
    });
    console.log(`[${sessionId}] Replied to local control_request via stdin: requestId=${request.request_id} subtype=${subtype}`);
    return true;
  }

  interruptSession(sessionId) {
    const claudeProc = this.claudeSessions.get(sessionId);
    if (!claudeProc) {
      console.log(`⚠️  Session ${sessionId} not found`);
      return;
    }

    console.log(`[${sessionId}] Interrupting session`);
    this.appendSessionEvent(sessionId, 'interrupt_requested');
    claudeProc.process.kill('SIGTERM');
    this.claudeSessions.delete(sessionId);
  }

  stopSession(sessionId) {
    const claudeProc = this.claudeSessions.get(sessionId);
    if (!claudeProc) {
      console.log(`⚠️  Session ${sessionId} not found for stop`);
      return;
    }

    console.log(`[${sessionId}] Stopping session (user requested)`);
    this.appendSessionEvent(sessionId, 'session_stopped_by_user');

    if (claudeProc.process && !claudeProc.process.killed) {
      claudeProc.process.kill('SIGTERM');
    }
  }

  appendSessionLog(sessionId, streamName, text) {
    if (!text) return;

    const claudeProc = this.claudeSessions.get(sessionId);
    if (!claudeProc?.bridgeLogFile) return;

    try {
      const suffix = text.endsWith('\n') ? '' : '\n';
      appendFileSync(
        claudeProc.bridgeLogFile,
        `[${new Date().toISOString()}] [${streamName}]\n${text}${suffix}`
      );
    } catch (e) {
      console.error(`[${sessionId}] Failed to append ${streamName} log:`, e.message);
    }
  }

  appendSessionEvent = makeAppendEventFn(getBridgeSessionDir, getBridgeSessionEventFile);

  persistSessionState(sessionId, extra = {}) {
    const claudeProc = this.claudeSessions.get(sessionId);
    if (!claudeProc) return;

    try {
      ensureDir(claudeProc.sessionDir);
      writeFileSync(
        getBridgeSessionStateFile(sessionId),
        JSON.stringify({
          sessionId,
          bridgeId: this.bridgeId,
          bridgeName: BRIDGE_NAME,
          status: claudeProc.status,
          claudeSessionId: claudeProc.claudeSessionId,
          createdAt: claudeProc.createdAt,
          runLabel: claudeProc.runLabel,
          pid: claudeProc.process?.pid || null,
          workDir: claudeProc.workDir || WORK_DIR,
          useSdkUrl: USE_SDK_URL,
          debugFile: claudeProc.debugFile,
          bridgeLogFile: claudeProc.bridgeLogFile,
          ...extra,
        }, null, 2)
      );
    } catch (e) {
      console.error(`[${sessionId}] Failed to persist session state:`, e.message);
    }
  }

  logEvent(sessionId, event) {
    switch (event.type) {
      case 'assistant':
        console.log(`[${sessionId}] 🤖 Claude:`, JSON.stringify(event.message?.content).slice(0, 100));
        break;
      case 'result':
        console.log(`[${sessionId}] ✅ Result:`, event.subtype, '| cost:', event.usage?.total_cost?.toFixed(4));
        break;
      default:
        console.log(`[${sessionId}] 📤 Event:`, event.type);
    }
  }

  send(message) {
    if (this.controlWs?.readyState === WebSocket.OPEN) {
      this.controlWs.send(JSON.stringify(message));
    }
  }

  shutdown() {
    console.log('\n👋 Shutting down...');
    this.stopHeartbeat();

    for (const [sessionId, claudeProc] of this.claudeSessions) {
      if (claudeProc.process && !claudeProc.process.killed) {
        console.log(`[${sessionId}] Killing Claude process`);
        claudeProc.process.kill();
      }
    }

    if (this.controlWs?.readyState === WebSocket.OPEN) {
      this.controlWs.close();
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    process.exit(0);
  }

  uploadFileToServer(sessionId, filePath, filename) {
    console.log(`[${sessionId}] Uploading file to server: ${filePath}`);

    if (!existsSync(filePath)) {
      console.error(`[${sessionId}] File not found: ${filePath}`);
      this.send({
        type: 'upload_error',
        sessionId,
        error: 'File not found',
        filePath,
      });
      return;
    }

    try {
      const fileContent = readFileSync(filePath);
      const base64Content = fileContent.toString('base64');
      const finalFilename = filename || filePath.split(/[/\\]/).pop();

      const uploadBaseUrl = SIGNALING_URL.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      const targetUrl = `${uploadBaseUrl}/api/sessions/${encodeURIComponent(sessionId)}/upload`;

      uploadFileBase64({
        url: targetUrl,
        filename: finalFilename,
        content: base64Content,
        onSuccess: (result) => {
          console.log(`[${sessionId}] \u2705 File uploaded successfully: ${finalFilename}`);
          this.send({
            type: 'upload_success',
            sessionId,
            filename: finalFilename,
            url: result.url,
          });
        },
        onError: (errMsg) => {
          console.error(`[${sessionId}] \u274C Upload failed: ${errMsg}`);
          this.send({
            type: 'upload_error',
            sessionId,
            error: errMsg,
          });
        },
      });

      this.appendSessionEvent(sessionId, 'file_upload_initiated', {
        filePath,
        filename: finalFilename,
        size: fileContent.length,
      });
    } catch (e) {
      console.error(`[${sessionId}] \u274C Failed to read or upload file:`, e.message);
      this.send({
        type: 'upload_error',
        sessionId,
        error: e.message,
      });
    }
  }
}

// ============ Start Bridge ============
const bridge = new BridgeController();
bridge.connect();

// ============ Graceful Shutdown ============
process.on('SIGINT', () => bridge.shutdown());
process.on('SIGTERM', () => bridge.shutdown());
