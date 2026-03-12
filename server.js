// server.js - Multi-Bridge Management Server
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync } from 'fs';
import { extname, basename } from 'path';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { inspect } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ .env File Loader ============
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const vars = {};
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    let key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// Load .env file (won't override existing process.env)
const envFilePath = process.env.SERVER_ENV_FILE || join(__dirname, '.env');
const dotEnvVars = loadEnvFile(envFilePath);
if (Object.keys(dotEnvVars).length > 0) {
  console.log(`📄 Loaded ${Object.keys(dotEnvVars).length} vars from ${envFilePath}`);
  for (const [key, value] of Object.entries(dotEnvVars)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function createTimestampLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function safePathSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatLogArgs(args) {
  return args.map((arg) => (
    typeof arg === 'string'
      ? arg
      : inspect(arg, { depth: 6, breakLength: 120, maxArrayLength: 100 })
  )).join(' ');
}

function initProcessLogger(logFile, label) {
  ensureDir(dirname(logFile));

  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function write(level, args) {
    try {
      appendFileSync(
        logFile,
        `[${new Date().toISOString()}] [${level}] ${formatLogArgs(args)}\n`
      );
    } catch (e) {
      originalConsole.error(`[${label}] Failed to append log file ${logFile}: ${e.message}`);
    }
  }

  console.log = (...args) => {
    write('INFO', args);
    originalConsole.log(...args);
  };
  console.info = (...args) => {
    write('INFO', args);
    originalConsole.info(...args);
  };
  console.warn = (...args) => {
    write('WARN', args);
    originalConsole.warn(...args);
  };
  console.error = (...args) => {
    write('ERROR', args);
    originalConsole.error(...args);
  };
}

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_LOG_DIR = process.env.SERVER_LOG_DIR || join(__dirname, 'logs');
const SERVER_SESSION_DIR = process.env.SERVER_SESSION_DIR || join(__dirname, 'sessions');
const SERVER_LOG_FILE = join(SERVER_LOG_DIR, `server-${createTimestampLabel()}.log`);

initProcessLogger(SERVER_LOG_FILE, 'server');
console.log(`📝 Server log: ${SERVER_LOG_FILE}`);
console.log(`🗂 Server session dir: ${SERVER_SESSION_DIR}`);

function getServerSessionDir(sessionId) {
  return join(SERVER_SESSION_DIR, safePathSegment(sessionId));
}

function getServerSessionStateFile(sessionId) {
  return join(getServerSessionDir(sessionId), 'session.json');
}

function getServerSessionEventFile(sessionId) {
  return join(getServerSessionDir(sessionId), 'events.log');
}

function appendServerSessionEvent(sessionId, eventType, details) {
  try {
    const sessionDir = getServerSessionDir(sessionId);
    ensureDir(sessionDir);
    const suffix = details === undefined ? '' : ` ${formatLogArgs([details])}`;
    appendFileSync(
      getServerSessionEventFile(sessionId),
      `[${new Date().toISOString()}] [${eventType}]${suffix}\n`
    );
  } catch (e) {
    console.error(`[Session] Failed to append event for ${sessionId}:`, e.message);
  }
}

function persistSessionSnapshot(session, extra = {}) {
  if (!session) return;

  try {
    const sessionDir = getServerSessionDir(session.sessionId);
    ensureDir(sessionDir);
    writeFileSync(
      getServerSessionStateFile(session.sessionId),
      JSON.stringify({
        sessionId: session.sessionId,
        bridgeId: session.bridgeId,
        status: session.status,
        claudeSessionId: session.claudeSessionId,
        workDir: session.workDir || null,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        chatConnected: session.chatWsSet ? session.chatWsSet.size > 0 : false,
        ...extra,
      }, null, 2)
    );
  } catch (e) {
    console.error(`[Session] Failed to persist snapshot for ${session.sessionId}:`, e.message);
  }
}

// ============ Bridge Manager ============
class BridgeManager {
  constructor() {
    this.bridges = new Map(); // bridgeId -> BridgeInfo
    this.startHeartbeatMonitor();
  }

  register(bridgeId, ws, metadata) {
    const bridgeInfo = {
      bridgeId,
      ws,
      status: 'online',
      lastHeartbeat: Date.now(),
      metadata: {
        name: metadata.name || bridgeId,
        workDir: metadata.workDir || '',
        claudeCmd: metadata.claudeCmd || 'claude',
        useSdkUrl: Boolean(metadata.useSdkUrl),
        maxSessions: metadata.maxSessions || 10,
        currentSessions: 0,
      },
      sessions: new Set(),
      createdAt: Date.now(),
    };
    this.bridges.set(bridgeId, bridgeInfo);
    console.log(`[Bridge] Registered: ${bridgeId} (${bridgeInfo.metadata.name})`);
    return bridgeInfo;
  }

  updateHeartbeat(bridgeId, currentSessions) {
    const bridge = this.bridges.get(bridgeId);
    if (bridge) {
      bridge.lastHeartbeat = Date.now();
      bridge.metadata.currentSessions = currentSessions;
      bridge.status = 'online';
    }
  }

  getBridge(bridgeId) {
    return this.bridges.get(bridgeId);
  }

  getAllBridges() {
    return Array.from(this.bridges.values()).map(b => ({
      bridgeId: b.bridgeId,
      name: b.metadata.name,
      status: b.status,
      metadata: b.metadata,
      currentSessions: b.metadata.currentSessions,
      maxSessions: b.metadata.maxSessions,
      lastHeartbeat: b.lastHeartbeat,
    }));
  }

  addSession(bridgeId, sessionId) {
    const bridge = this.bridges.get(bridgeId);
    if (bridge) {
      bridge.sessions.add(sessionId);
      bridge.metadata.currentSessions = bridge.sessions.size;
    }
  }

  removeSession(bridgeId, sessionId) {
    const bridge = this.bridges.get(bridgeId);
    if (bridge) {
      bridge.sessions.delete(sessionId);
      bridge.metadata.currentSessions = bridge.sessions.size;
    }
  }

  startHeartbeatMonitor() {
    setInterval(() => {
      const now = Date.now();
      const TIMEOUT = 45_000; // 45 seconds

      for (const [bridgeId, bridge] of this.bridges) {
        if (now - bridge.lastHeartbeat > TIMEOUT && bridge.status === 'online') {
          bridge.status = 'offline';
          console.log(`[Bridge] Timeout: ${bridgeId} (${bridge.metadata.name})`);

          // Notify all sessions on this bridge
          for (const sessionId of bridge.sessions) {
            const session = sessionManager.getSession(sessionId);
            if (session?.chatWsSet) {
              for (const chatWs of session.chatWsSet) {
                if (chatWs.readyState === WebSocket.OPEN) {
                  chatWs.send(JSON.stringify({
                    type: 'bridge_offline',
                    bridgeId,
                    sessionId,
                  }));
                }
              }
            }
          }
        }
      }
    }, 30_000); // Check every 30 seconds
  }
}

// ============ Session Manager ============
class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> SessionInfo
  }

  createSession(sessionId, bridgeId, workDir = null) {
    const sessionInfo = {
      sessionId,
      bridgeId,
      workDir: workDir || null,
      chatWsSet: new Set(),
      status: 'pending',
      claudeSessionId: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      tokenStats: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 0,
        turnCount: 0,
      },
    };
    this.sessions.set(sessionId, sessionInfo);
    persistSessionSnapshot(sessionInfo);
    appendServerSessionEvent(sessionId, 'session_created', { bridgeId, status: sessionInfo.status });
    console.log(`[Session] Created: ${sessionId} on bridge ${bridgeId}`);
    return sessionInfo;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  getSessionsByBridge(bridgeId) {
    return Array.from(this.sessions.values()).filter(s => s.bridgeId === bridgeId);
  }

  updateStatus(sessionId, status) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastActivity = Date.now();
      persistSessionSnapshot(session);
      appendServerSessionEvent(sessionId, 'status_changed', status);
    }
  }

  addChatWs(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.chatWsSet.add(ws);
      session.lastActivity = Date.now();
      persistSessionSnapshot(session);
      appendServerSessionEvent(sessionId, 'chat_connected', { clients: session.chatWsSet.size });
    }
  }

  removeChatWs(sessionId, ws) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.chatWsSet.delete(ws);
      session.lastActivity = Date.now();
      persistSessionSnapshot(session);
      appendServerSessionEvent(sessionId, 'chat_disconnected', { clients: session.chatWsSet.size });
    }
  }

  setClaudeSessionId(sessionId, claudeSessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.claudeSessionId = claudeSessionId;
      session.lastActivity = Date.now();
      persistSessionSnapshot(session);
      appendServerSessionEvent(sessionId, 'claude_session_id', claudeSessionId);
    }
  }

  removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      clearPendingClaudeIngressForSession(sessionId);
      deleteControlRequestsForSession(sessionId);
      persistSessionSnapshot(session, {
        removed: true,
        removedAt: Date.now(),
      });
      appendServerSessionEvent(sessionId, 'session_removed', { bridgeId: session.bridgeId });
      bridgeManager.removeSession(session.bridgeId, sessionId);
      this.sessions.delete(sessionId);
      console.log(`[Session] Removed: ${sessionId}`);
    }
  }
}

const bridgeManager = new BridgeManager();
const sessionManager = new SessionManager();

// ============ Claude WS Connections (--sdk-url mode) ============
// When Claude is spawned with --sdk-url ws://server/session/{id},
// it opens a WebSocket to receive user input and sends events via HTTP POST.
const claudeWsConnections = new Map(); // sessionId -> WebSocket
const pendingClaudeIngressMessages = new Map(); // sessionId -> message[]
const pendingControlRequests = new Map(); // requestId -> { sessionId, event }

function buildPermissionControlResponse(sessionId, decision, requestId, controlRequest) {
  const permissionSuggestions = controlRequest?.request?.permission_suggestions || [];
  const originalInput = controlRequest?.request?.input || {};

  return {
    type: 'control_response',
    session_id: sessionId,
    response: {
      subtype: decision === 'allow' ? 'permission_granted' : 'permission_denied',
      request_id: requestId,
      permissions: permissionSuggestions,
      response: decision === 'allow'
        ? { behavior: 'allow', updatedInput: originalInput }
        : { behavior: 'deny', message: 'User denied permission' },
    },
    request_id: requestId,
  };
}

function buildUserMessageEvent(sessionId, content) {
  return {
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  };
}

function queueClaudeIngressMessage(sessionId, message) {
  const queue = pendingClaudeIngressMessages.get(sessionId) || [];
  queue.push(message);
  pendingClaudeIngressMessages.set(sessionId, queue);
}

function sendClaudeIngressMessage(sessionId, message) {
  const claudeWs = claudeWsConnections.get(sessionId);
  if (claudeWs?.readyState !== WebSocket.OPEN) {
    return false;
  }

  claudeWs.send(JSON.stringify(message) + '\n');
  return true;
}

function flushPendingClaudeIngressMessages(sessionId) {
  const queue = pendingClaudeIngressMessages.get(sessionId);
  if (!queue?.length) return;

  let sentCount = 0;
  for (const message of queue) {
    if (!sendClaudeIngressMessage(sessionId, message)) {
      break;
    }
    sentCount += 1;
  }

  if (sentCount === 0) {
    return;
  }

  if (sentCount < queue.length) {
    pendingClaudeIngressMessages.set(sessionId, queue.slice(sentCount));
    console.warn(`[Claude WS] Partially flushed ingress queue for session=${sessionId}: sent=${sentCount} remaining=${queue.length - sentCount}`);
    return;
  }

  console.log(`[Claude WS] Flushed ${queue.length} queued ingress message(s) for session=${sessionId}`);
  pendingClaudeIngressMessages.delete(sessionId);
}

function deliverClaudeIngressMessage(sessionId, message, label) {
  if (sendClaudeIngressMessage(sessionId, message)) {
    console.log(`[${label} -> Claude WS] session=${sessionId}`);
    return true;
  }

  queueClaudeIngressMessage(sessionId, message);
  console.log(`[${label} -> Claude WS queued] session=${sessionId} reason=ws unavailable`);
  return false;
}

function cacheControlRequest(sessionId, event) {
  if (event.type !== 'control_request' || !event.request_id) return;

  pendingControlRequests.set(event.request_id, { sessionId, event });
  appendServerSessionEvent(sessionId, 'control_request_cached', {
    requestId: event.request_id,
    subtype: event.request?.subtype,
  });
}

function deleteControlRequestsForSession(sessionId) {
  for (const [requestId, request] of pendingControlRequests.entries()) {
    if (request.sessionId === sessionId) {
      pendingControlRequests.delete(requestId);
    }
  }
}

function clearPendingClaudeIngressForSession(sessionId) {
  pendingClaudeIngressMessages.delete(sessionId);
}

// ============ Session Persistence ============
function saveClaudeSessionId(sessionId, claudeSessionId) {
  const session = sessionManager.getSession(sessionId);
  const snapshot = session || {
    sessionId,
    bridgeId: null,
    workDir: null,
    status: 'unknown',
    claudeSessionId,
    createdAt: null,
    lastActivity: Date.now(),
    chatWsSet: new Set(),
  };

  persistSessionSnapshot(snapshot, {
    claudeSessionId,
  });
  appendServerSessionEvent(sessionId, 'claude_session_saved', claudeSessionId);
}

function loadClaudeSessionId(sessionId) {
  const file = getServerSessionStateFile(sessionId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function forwardToChat(sessionId, event) {
  const session = sessionManager.getSession(sessionId);
  if (!session) return;

  cacheControlRequest(sessionId, event);

  if (event.session_id) {
    saveClaudeSessionId(sessionId, event.session_id);
    sessionManager.setClaudeSessionId(sessionId, event.session_id);
  }

  // Accumulate token stats from result events
  if (event.type === 'result' && event.usage) {
    const stats = session.tokenStats;
    if (stats) {
      stats.inputTokens += event.usage.input_tokens || 0;
      stats.outputTokens += event.usage.output_tokens || 0;
      stats.cacheReadInputTokens += event.usage.cache_read_input_tokens || 0;
      stats.cacheCreationInputTokens += event.usage.cache_creation_input_tokens || 0;
      stats.totalCostUsd += event.usage.total_cost_usd || event.usage.total_cost || 0;
      stats.turnCount += 1;
    }
  }

  session.lastActivity = Date.now();
  persistSessionSnapshot(session);
  appendServerSessionEvent(sessionId, 'agent_event', event.type);

  // Broadcast to all connected chat clients
  if (session.chatWsSet) {
    const msg = JSON.stringify({
      type: 'agent_event',
      sessionId,
      payload: event,
      tokenStats: session.tokenStats,
    });
    for (const chatWs of session.chatWsSet) {
      if (chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(msg);
      }
    }
  }

  // Persist message record for assistant/user/result events
  appendMessageRecord(sessionId, event);
}

function getServerSessionMessagesFile(sessionId) {
  return join(getServerSessionDir(sessionId), 'messages.jsonl');
}

function getSessionUploadDir(sessionId) {
  return join(getServerSessionDir(sessionId), 'uploads');
}

function appendMessageRecord(sessionId, event) {
  if (!['assistant', 'user', 'result'].includes(event.type)) return;
  try {
    const session = sessionManager.getSession(sessionId);
    const record = {
      sessionId,
      claudeSessionId: session?.claudeSessionId || event.session_id || null,
      timestamp: new Date().toISOString(),
      type: event.type,
      message: event.message || event,
    };
    const sessionDir = getServerSessionDir(sessionId);
    ensureDir(sessionDir);
    appendFileSync(getServerSessionMessagesFile(sessionId), JSON.stringify(record) + '\n');
  } catch (e) {
    console.error(`[Session] Failed to append message record for ${sessionId}:`, e.message);
  }
}

// ============ HTTP Server ============
const server = createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve index.html
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(404);
      res.end('index.html not found');
    }
    return;
  }

  // GET /api/bridges - Get all bridges
  if (req.method === 'GET' && req.url === '/api/bridges') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ bridges: bridgeManager.getAllBridges() }));
    return;
  }

  // POST /api/sessions - Create new session
  if (req.method === 'POST' && req.url === '/api/sessions') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { bridgeId, sessionId, dangerouslySkipPermissions, workDir } = JSON.parse(body);
        const bridge = bridgeManager.getBridge(bridgeId);

        if (!bridge) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bridge not found' }));
          return;
        }

        if (bridge.status !== 'online') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bridge offline' }));
          return;
        }

        const newSessionId = sessionId || crypto.randomUUID();
        const workDirValue = typeof workDir === 'string' ? workDir.trim() : '';
        const session = sessionManager.createSession(newSessionId, bridgeId, workDirValue);
        bridgeManager.addSession(bridgeId, newSessionId);

        // Tell bridge to start session
        if (bridge.ws?.readyState === WebSocket.OPEN) {
          bridge.ws.send(JSON.stringify({
            type: 'start_session',
            sessionId: newSessionId,
            resume: false,
            workDir: workDirValue || undefined,
            dangerouslySkipPermissions: !!dangerouslySkipPermissions,
          }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessionId: newSessionId,
          bridgeId,
          status: 'pending',
          workDir: workDirValue || null,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // GET /api/sessions - Get all active sessions
  if (req.method === 'GET' && req.url === '/api/sessions') {
    const sessions = sessionManager.getAllSessions().map(s => ({
      sessionId: s.sessionId,
      bridgeId: s.bridgeId,
      status: s.status,
      claudeSessionId: s.claudeSessionId,
      workDir: s.workDir || null,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      chatConnected: s.chatWsSet ? s.chatWsSet.size > 0 : false,
      tokenStats: s.tokenStats || null,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // POST /api/sessions/:id/stop - Stop a session
  const stopSessionMatch = req.url?.match(/^\/api\/sessions\/([^/?#]+)\/stop/);
  if (req.method === 'POST' && stopSessionMatch) {
    const sessionId = decodeURIComponent(stopSessionMatch[1]);
    const session = sessionManager.getSession(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // Notify bridge to kill the session
    const bridge = bridgeManager.getBridge(session.bridgeId);
    if (bridge?.ws?.readyState === WebSocket.OPEN) {
      bridge.ws.send(JSON.stringify({
        type: 'stop_session',
        sessionId,
      }));
    }

    // Notify all chat clients
    if (session.chatWsSet) {
      for (const chatWs of session.chatWsSet) {
        if (chatWs.readyState === WebSocket.OPEN) {
          chatWs.send(JSON.stringify({
            type: 'session_end',
            sessionId,
            reason: 'user_stopped',
          }));
        }
      }
    }

    sessionManager.removeSession(sessionId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'stopped', sessionId }));
    return;
  }

  // GET /api/sessions/:id/messages - Get persisted messages for a session
  const sessionMessagesMatch = req.url?.match(/^\/api\/sessions\/([^/?#]+)\/messages/);
  if (req.method === 'GET' && sessionMessagesMatch) {
    const sessionId = decodeURIComponent(sessionMessagesMatch[1]);
    const messagesFile = getServerSessionMessagesFile(sessionId);
    if (!existsSync(messagesFile)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [] }));
      return;
    }
    try {
      const lines = readFileSync(messagesFile, 'utf8').split('\n').filter(Boolean);
      const messages = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read messages' }));
    }
    return;
  }

  // POST /api/sessions/:id/upload - Upload a file for a session
  const uploadMatch = req.url?.match(/^\/api\/sessions\/([^/?#]+)\/upload/);
  if (req.method === 'POST' && uploadMatch) {
    const sessionId = decodeURIComponent(uploadMatch[1]);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, mimeType, data } = JSON.parse(body);
        if (!name || !data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing name or data' }));
          return;
        }
        const ext = extname(name);
        const safeName = safePathSegment(basename(name, ext)) + ext;
        const uploadDir = getSessionUploadDir(sessionId);
        ensureDir(uploadDir);
        const filePath = join(uploadDir, safeName);
        writeFileSync(filePath, Buffer.from(data, 'base64'));
        const url = `/session-uploads/${encodeURIComponent(safePathSegment(sessionId))}/${encodeURIComponent(safeName)}`;
        console.log(`[Upload] session=${sessionId} file=${safeName}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: safeName, path: filePath, url }));
      } catch (e) {
        console.error('[Upload] Error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload failed' }));
      }
    });
    return;
  }

  // GET /session-uploads/:sessionId/:filename - Serve uploaded files
  const serveUploadMatch = req.url?.match(/^\/session-uploads\/([^/?#]+)\/([^/?#]+)/);
  if (req.method === 'GET' && serveUploadMatch) {
    const sessionId = decodeURIComponent(serveUploadMatch[1]);
    const filename = decodeURIComponent(serveUploadMatch[2]);
    const safeSid = safePathSegment(sessionId);
    const safeFn = safePathSegment(filename);
    const filePath = join(getSessionUploadDir(safeSid), safeFn);
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    try {
      const stat = statSync(filePath);
      const ext = extname(safeFn).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp',
        '.txt': 'text/plain', '.md': 'text/markdown',
        '.js': 'text/javascript', '.ts': 'text/typescript',
        '.py': 'text/x-python', '.json': 'application/json',
        '.yaml': 'text/yaml', '.yml': 'text/yaml', '.csv': 'text/csv',
      };
      const contentType = mimeMap[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
      createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end('Error');
    }
    return;
  }

  // GET /api/bridges/:bridgeId/sessions - Get bridge sessions
  const bridgeSessionsMatch = req.url?.match(/^\/api\/bridges\/([^/?#]+)\/sessions/);
  if (req.method === 'GET' && bridgeSessionsMatch) {
    const bridgeId = decodeURIComponent(bridgeSessionsMatch[1]);
    const sessions = sessionManager.getSessionsByBridge(bridgeId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // POST /session/:id/events - Claude events (from --sdk-url mode)
  const eventsMatch = req.url?.match(/^\/session\/([^/?#]+)\/events/);
  if (req.method === 'POST' && eventsMatch) {
    const sessionId = decodeURIComponent(eventsMatch[1]);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const events = Array.isArray(data.events) ? data.events : [data];
        for (const event of events) {
          console.log(`[POST /session/${sessionId}/events] type=${event.type}`);
          if (event.type === 'control_request') {
            console.log(`[POST /session/${sessionId}/events] control_request FULL:`, JSON.stringify(event));
          }
          forwardToChat(sessionId, event);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      } catch (e) {
        console.error('[POST] Parse error:', e.message);
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ============ WebSocket Server ============
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // /bridge - Bridge registration and control
  if (pathname === '/bridge') {
    const bridgeId = url.searchParams.get('bridgeId');
    if (!bridgeId) {
      ws.close();
      return;
    }

    console.log(`[WS] Bridge connected: ${bridgeId}`);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        handleBridgeMessage(bridgeId, ws, msg);
      } catch (e) {
        console.error('[WS] Bridge parse error:', e.message);
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Bridge disconnected: ${bridgeId}`);
      const bridge = bridgeManager.getBridge(bridgeId);
      if (bridge) {
        bridge.status = 'offline';
        bridge.ws = null;
      }
    });

    return;
  }

  // /session/:id - Claude process connection (--sdk-url mode)
  const sessionMatch = pathname.match(/^\/session\/([^/?#]+)$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    console.log(`[WS] Claude process connected for session: ${sessionId}`);

    claudeWsConnections.set(sessionId, ws);

    // Send initialize control_request immediately
    const initializeRequest = {
      type: 'control_request',
      request_id: `init-${sessionId}-${Date.now()}`,
      request: {
        subtype: 'initialize',
        sdkMcpServers: [],
        promptSuggestions: false,
        agentProgressSummaries: false,
      },
    };

    console.log(`[WS] Sending initialize to Claude for session: ${sessionId}`);
    ws.send(JSON.stringify(initializeRequest) + '\n');

    flushPendingClaudeIngressMessages(sessionId);

    let initializeSent = false;

    ws.on('message', (data) => {
      // Claude might send events over WS too (in addition to HTTP POST)
      try {
        const msg = JSON.parse(data);
        const events = Array.isArray(msg.events) ? msg.events : [msg];
        for (const event of events) {
          console.log(`[WS /session/${sessionId}] type=${event.type}`);

          // If this is a control_response for initialize, send system init message
          if (!initializeSent && event.type === 'control_response' &&
              event.response?.request_id?.startsWith('init-')) {
            console.log(`[WS] Received initialize response, sending system init message`);
            initializeSent = true;

            // Extract data from control_response
            const responseData = event.response.response || {};
            const session = sessionManager.getSession(sessionId);

            // Send system init message (like stdio mode)
            const systemInit = {
              type: 'system',
              subtype: 'init',
              cwd: session?.workDir || process.cwd(),
              session_id: sessionId,
              tools: ['Task', 'TaskOutput', 'Bash', 'Glob', 'Grep', 'ExitPlanMode', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'TaskStop', 'AskUserQuestion', 'Skill', 'EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList', 'LSP'],
              mcp_servers: [],
              model: responseData.models?.[0]?.value || 'default',
              permissionMode: 'default',
              slash_commands: (responseData.commands || []).map(c => c.name),
              apiKeySource: responseData.account?.tokenSource || 'none',
              claude_code_version: '2.1.72',
              output_style: responseData.output_style || 'default',
              agents: (responseData.agents || []).map(a => a.name),
              skills: (responseData.commands || []).map(c => c.name),
              plugins: [],
              uuid: require('crypto').randomUUID(),
              fast_mode_state: 'off',
            };

            console.log(`[WS] Sending system init message to Claude`);
            ws.send(JSON.stringify(systemInit) + '\n');
          }

          forwardToChat(sessionId, event);
        }
      } catch (e) {
        console.error(`[WS /session/${sessionId}] Parse error:`, e.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`[WS] Claude process disconnected for session: ${sessionId} code=${code} reason=${reason}`);
      claudeWsConnections.delete(sessionId);
      clearPendingClaudeIngressForSession(sessionId);
      deleteControlRequestsForSession(sessionId);

      // Notify all chat clients that session ended
      const session = sessionManager.getSession(sessionId);
      if (session?.chatWsSet) {
        for (const chatWs of session.chatWsSet) {
          if (chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({
              type: 'session_end',
              sessionId,
            }));
          }
        }
      }
    });

    return;
  }

  // /chat - Web client connection
  if (pathname === '/chat') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      ws.close();
      return;
    }

    console.log(`[WS] Chat connected: ${sessionId}`);

    let session = sessionManager.getSession(sessionId);

    // Try to resume session
    if (!session) {
      const savedData = loadClaudeSessionId(sessionId);
      if (savedData?.bridgeId) {
        const bridge = bridgeManager.getBridge(savedData.bridgeId);
        if (bridge && bridge.status === 'online') {
          session = sessionManager.createSession(sessionId, savedData.bridgeId, savedData.workDir);
          bridgeManager.addSession(savedData.bridgeId, sessionId);

          // Tell bridge to resume
          if (bridge.ws?.readyState === WebSocket.OPEN) {
            bridge.ws.send(JSON.stringify({
              type: 'start_session',
              sessionId,
              resume: true,
              claudeSessionId: savedData.claudeSessionId,
              workDir: savedData.workDir || undefined,
            }));
          }
        }
      }
    }

    if (!session) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Session not found or bridge offline',
      }));
      ws.close();
      return;
    }

    sessionManager.addChatWs(sessionId, ws);
    sessionManager.updateStatus(sessionId, 'active');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        handleChatMessage(sessionId, msg);
      } catch (e) {
        console.error('[WS] Chat parse error:', e.message);
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Chat disconnected: ${sessionId}`);
      sessionManager.removeChatWs(sessionId, ws);
    });

    return;
  }

  ws.close();
});

// ============ Message Handlers ============
function handleBridgeMessage(bridgeId, ws, msg) {
  switch (msg.type) {
    case 'bridge_register':
      bridgeManager.register(bridgeId, ws, msg.metadata || {});
      ws.send(JSON.stringify({ type: 'register_ack', bridgeId }));
      break;

    case 'bridge_heartbeat':
      bridgeManager.updateHeartbeat(bridgeId, msg.currentSessions || 0);
      break;

    case 'session_started':
      sessionManager.updateStatus(msg.sessionId, 'running');
      break;

    case 'agent_event':
      // Bridge forwarding events (stdin/stdout mode fallback)
      forwardToChat(msg.sessionId, msg.payload);
      break;

    case 'session_end':
      const sessionEnd = sessionManager.getSession(msg.sessionId);
      if (sessionEnd?.chatWsSet) {
        for (const chatWs of sessionEnd.chatWsSet) {
          if (chatWs.readyState === WebSocket.OPEN) {
            chatWs.send(JSON.stringify({
              type: 'session_end',
              sessionId: msg.sessionId,
            }));
          }
        }
      }
      clearPendingClaudeIngressForSession(msg.sessionId);
      deleteControlRequestsForSession(msg.sessionId);
      sessionManager.removeSession(msg.sessionId);
      break;
  }
}

function handleChatMessage(sessionId, msg) {
  const session = sessionManager.getSession(sessionId);
  if (!session) return;
  const bridge = bridgeManager.getBridge(session.bridgeId);
  const useSessionIngress = Boolean(bridge?.metadata?.useSdkUrl);

  // Permission responses go back through the bridge control channel so the
  // child can consume them on stdin together with other local control replies.
  if (msg.type === 'permission_response') {
    const decision = msg.decision; // 'allow' or 'deny'
    const requestId = msg.requestId;
    const permissions = msg.permissions || []; // checked permission_suggestions from UI

    if (bridge?.ws?.readyState === WebSocket.OPEN) {
      bridge.ws.send(JSON.stringify({
        type: 'permission_response',
        sessionId,
        requestId,
        decision,
        permissions,
      }));
      console.log(`[Permission -> Bridge stdin] session=${sessionId} requestId=${requestId} decision=${decision}`);
      return;
    }

    console.log(`[Permission] No delivery path available for session=${sessionId} requestId=${requestId}`);
    return;
  }

  if (msg.type === 'user_message' && useSessionIngress) {
    let event;
    if (msg.contentArray?.length > 0) {
      event = { type: 'user', session_id: sessionId, message: { role: 'user', content: msg.contentArray } };
    } else {
      const content = msg.content || msg.message || '';
      console.log(`[DEBUG] user_message: content="${content}" msg.content="${msg.content}" msg.message="${msg.message}"`);
      event = buildUserMessageEvent(sessionId, content);
    }
    deliverClaudeIngressMessage(sessionId, event, 'User message');
    return;
  }

  // Non-ingress messages or non-sdk sessions still route through bridge stdin.
  if (!bridge || bridge.ws?.readyState !== WebSocket.OPEN) {
    if (session.chatWsSet) {
      for (const chatWs of session.chatWsSet) {
        if (chatWs.readyState === WebSocket.OPEN) {
          chatWs.send(JSON.stringify({
            type: 'error',
            message: 'Bridge offline',
          }));
        }
      }
    }
    return;
  }

  // Forward message to bridge, which writes to Claude's stdin
  bridge.ws.send(JSON.stringify({
    ...msg,
    sessionId,
  }));
  console.log(`[Chat→Bridge] session=${sessionId} type=${msg.type}`);
}

// ============ Start Server ============
server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`🚀 Multi-Bridge Server running on http://${displayHost}:${PORT} (bind: ${HOST})`);
  console.log(`   Bridge:  ws://${displayHost}:${PORT}/bridge?bridgeId=xxx`);
  console.log(`   Chat:    ws://${displayHost}:${PORT}/chat?sessionId=xxx`);
  console.log(`   API:     http://${displayHost}:${PORT}/api/bridges`);
  console.log(`   SDK WS:  ws://${displayHost}:${PORT}/session/xxx (Claude --sdk-url)`);
  console.log(`   SDK POST: http://${displayHost}:${PORT}/session/xxx/events`);
});
