// plugins/qqbot/index.js
// QQ Bot Channel Plugin for cc-bridge
//
// Config (env vars or .env):
//   QQBOT_APP_ID       - QQ Bot App ID
//   QQBOT_CLIENT_SECRET - QQ Bot Client Secret
//
// Each C2C user gets their own Claude session.
// Each group gets one shared Claude session.

import WebSocket from 'ws';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Per-session working directories live here; CLAUDE.md in __dirname is picked
// up automatically by Claude Code when it scans parent directories.
const SESSIONS_DIR = join(__dirname, 'sessions');

const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

// Intent bits
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;  // 频道公域消息
const INTENT_DIRECT_MESSAGE        = 1 << 12;  // 频道私信
const INTENT_GROUP_AND_C2C         = 1 << 25;  // 群聊 + C2C

// ============ Token Management ============

const tokenCache = new Map(); // appId -> { token, expiresAt }

async function getToken(appId, clientSecret) {
  const cached = tokenCache.get(appId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const res = await fetch(QQ_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  tokenCache.set(appId, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

// ============ QQ API Calls ============

// msg_seq counter: QQ requires an incrementing seq number for each message
// sent in reply to the same msg_id, otherwise messages get deduplicated.
const msgSeqMap = new Map(); // msgId -> last seq used

function nextMsgSeq(msgId) {
  const seq = (msgSeqMap.get(msgId) || 0) + 1;
  msgSeqMap.set(msgId, seq);
  return seq;
}

async function sendC2CText(appId, clientSecret, openid, text, msgId) {
  const token = await getToken(appId, clientSecret);
  const body = { content: text, msg_type: 0 };
  if (msgId) { body.msg_id = msgId; body.msg_seq = nextMsgSeq(msgId); }

  const res = await fetch(`${QQ_API_BASE}/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error(`[qqbot] sendC2C failed: ${JSON.stringify(data)}`);
  return data;
}

async function sendGroupText(appId, clientSecret, groupOpenid, text, msgId) {
  const token = await getToken(appId, clientSecret);
  const body = { content: text, msg_type: 0 };
  if (msgId) { body.msg_id = msgId; body.msg_seq = nextMsgSeq(msgId); }

  const res = await fetch(`${QQ_API_BASE}/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error(`[qqbot] sendGroup failed: ${JSON.stringify(data)}`);
  return data;
}

// ============ Image Support ============

// file_type: 1=image, 2=video, 3=audio, 4=file
const FILE_TYPE_IMAGE = 1;

async function uploadMedia(appId, clientSecret, target, fileBase64) {
  const token = await getToken(appId, clientSecret);
  const body = { file_type: FILE_TYPE_IMAGE, file_data: fileBase64, srv_send_msg: false };
  const url = target.type === 'c2c'
    ? `${QQ_API_BASE}/v2/users/${target.openid}/files`
    : `${QQ_API_BASE}/v2/groups/${target.groupOpenid}/files`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`uploadMedia failed: ${JSON.stringify(data)}`);
  return data.file_info;
}

async function sendMediaMessage(appId, clientSecret, target, fileInfo, msgId) {
  const token = await getToken(appId, clientSecret);
  const body = { msg_type: 7, media: { file_info: fileInfo } };
  if (msgId) { body.msg_id = msgId; body.msg_seq = nextMsgSeq(msgId); }

  const url = target.type === 'c2c'
    ? `${QQ_API_BASE}/v2/users/${target.openid}/messages`
    : `${QQ_API_BASE}/v2/groups/${target.groupOpenid}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) console.error(`[qqbot] sendMedia failed: ${JSON.stringify(data)}`);
  return data;
}

// Resolve an image src to base64. Handles:
//   - server-relative upload URLs (/bridge-uploads/... /session-uploads/...)
//   - absolute local file paths
//   - http/https URLs
async function resolveImageToBase64(src, api) {
  // Server-relative upload URL → local disk path
  const localPath = api.resolveUploadUrl(src);
  if (localPath) {
    if (!existsSync(localPath)) throw new Error(`File not found: ${localPath}`);
    return readFileSync(localPath).toString('base64');
  }

  // Absolute local path (Windows or Unix)
  if (src.match(/^[A-Za-z]:[\\/]/) || src.startsWith('/')) {
    if (!existsSync(src)) throw new Error(`File not found: ${src}`);
    return readFileSync(src).toString('base64');
  }

  // HTTP/HTTPS URL → fetch
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${src}`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  }

  throw new Error(`Cannot resolve image src: ${src}`);
}

// Extract markdown images from text, return { text, images: [{alt, src}] }
function extractImages(text) {
  const images = [];
  const cleaned = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    images.push({ alt, src: src.trim() });
    return '';               // remove from text
  }).replace(/\n{3,}/g, '\n\n').trim(); // collapse extra blank lines
  return { text: cleaned, images };
}

// ============ Gateway WebSocket ============

function connectGateway(appId, clientSecret, onDispatch) {
  const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
  let reconnectAttempt = 0;
  let heartbeatTimer = null;

  async function connect() {
    let ws;
    try {
      // Get fresh gateway URL each reconnect (URL can change)
      const token = await getToken(appId, clientSecret);
      const gwRes = await fetch(`${QQ_API_BASE}/gateway/bot`, {
        headers: { Authorization: `QQBot ${token}` },
      });
      const { url } = await gwRes.json();

      ws = new WebSocket(url);
    } catch (e) {
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt++, RECONNECT_DELAYS.length - 1)];
      console.error(`[qqbot] Gateway connect failed: ${e.message}, retry in ${delay}ms`);
      setTimeout(connect, delay);
      return;
    }

    ws.on('open', () => {
      console.log('[qqbot] Gateway connected');
      reconnectAttempt = 0;
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const { op, t, d } = msg;

      if (op === 10) {
        // Hello → start heartbeat and identify
        const interval = d.heartbeat_interval;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: null }));
          }
        }, interval);

        getToken(appId, clientSecret).then(token => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: INTENT_PUBLIC_GUILD_MESSAGES | INTENT_DIRECT_MESSAGE | INTENT_GROUP_AND_C2C,
              shard: [0, 1],
              properties: { os: 'linux', browser: 'cc-bridge', device: 'cc-bridge' },
            },
          }));
        }).catch(e => console.error(`[qqbot] Identify failed: ${e.message}`));

      } else if (op === 0 && t) {
        // Dispatch event
        onDispatch(t, d);

      } else if (op === 9) {
        // Invalid session
        console.warn('[qqbot] Invalid session, reconnecting...');
        ws.close();
      }
    });

    ws.on('close', (code) => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt++, RECONNECT_DELAYS.length - 1)];
      console.log(`[qqbot] Gateway closed (${code}), reconnecting in ${delay}ms`);
      setTimeout(connect, delay);
    });

    ws.on('error', (e) => {
      console.error(`[qqbot] Gateway error: ${e.message}`);
      // close handler will trigger reconnect
    });
  }

  connect();
}

// ============ Plugin Entry Point ============

export async function start(api) {
  const appId = process.env.QQBOT_APP_ID;
  const clientSecret = process.env.QQBOT_CLIENT_SECRET;
  // QQBOT_AUTO_APPROVE_TOOLS=true  → always approve tool use without asking
  const autoApprove = process.env.QQBOT_AUTO_APPROVE_TOOLS === 'true';

  if (!appId || !clientSecret) {
    console.log('[qqbot] QQBOT_APP_ID / QQBOT_CLIENT_SECRET not set — plugin disabled');
    return;
  }

  // sessionId -> { accText, replyTo, channelUserId, verbose }
  const pendingReplies = new Map();

  // sessionId -> { requestId, toolName, input }  (awaiting user /allow or /deny)
  const pendingPermissions = new Map();

  // Sessions with verbose mode on
  const verboseSessions = new Set();

  // Sessions with per-session auto-approve enabled (runtime override of global autoApprove)
  const autoApproveSessions = new Set();

  // Sessions that already have a listener registered (avoid duplicates)
  const registeredSessions = new Set();

  // ---- helpers ----

  async function sendToQQ(replyTo, text) {
    if (!text) return;
    if (replyTo.type === 'c2c') {
      await sendC2CText(appId, clientSecret, replyTo.openid, text, replyTo.msgId);
    } else {
      await sendGroupText(appId, clientSecret, replyTo.groupOpenid, text, replyTo.msgId);
    }
  }

  async function sendReplyWithImages(replyTo, accText) {
    const { text: replyText, images } = extractImages(accText);
    if (replyText) await sendToQQ(replyTo, replyText);
    for (const img of images) {
      try {
        const base64 = await resolveImageToBase64(img.src, api);
        const fileInfo = await uploadMedia(appId, clientSecret, replyTo, base64);
        await sendMediaMessage(appId, clientSecret, replyTo, fileInfo, replyTo.msgId);
        console.log(`[qqbot] Sent image ${img.src}`);
      } catch (e) {
        console.error(`[qqbot] Image send failed (${img.src}): ${e.message}`);
      }
    }
    return replyText || images.length > 0;
  }

  // ---- session event listener ----

  function registerSessionListener(sessionId) {
    if (registeredSessions.has(sessionId)) return;
    registeredSessions.add(sessionId);

    api.onEvent(sessionId, async (claudeEvent) => {
      const state = pendingReplies.get(sessionId);
      const verbose = verboseSessions.has(sessionId);

      // ── assistant event ──────────────────────────────────────────────────
      if (claudeEvent.type === 'assistant' && claudeEvent.message?.content) {
        if (!state) return;
        for (const block of claudeEvent.message.content) {
          if (block.type === 'text' && block.text) {
            // Let Claude autonomously toggle verbose mode via its response text
            if (/开启.*(中间过程|详细|调试)/i.test(block.text) && !verboseSessions.has(sessionId)) {
              verboseSessions.add(sessionId);
              console.log(`[qqbot] Verbose ON (triggered by Claude) for ${sessionId}`);
            } else if (/关闭.*(中间过程|详细|调试)/i.test(block.text) && verboseSessions.has(sessionId)) {
              verboseSessions.delete(sessionId);
              console.log(`[qqbot] Verbose OFF (triggered by Claude) for ${sessionId}`);
            }

            // Let Claude autonomously toggle auto-approve via its response text
            if (/已为您开启自动权限/.test(block.text) && !autoApproveSessions.has(sessionId)) {
              autoApproveSessions.add(sessionId);
              console.log(`[qqbot] AutoApprove ON (triggered by Claude) for ${sessionId}`);
              // If there's a permission currently pending, approve it immediately
              const perm = pendingPermissions.get(sessionId);
              if (perm) {
                api.respondToPermission(sessionId, perm.requestId, 'allow');
                pendingPermissions.delete(sessionId);
                console.log(`[qqbot] Auto-approved pending permission: ${perm.toolName}`);
              }
            } else if (/已为您关闭自动权限/.test(block.text) && autoApproveSessions.has(sessionId)) {
              autoApproveSessions.delete(sessionId);
              console.log(`[qqbot] AutoApprove OFF (triggered by Claude) for ${sessionId}`);
            }

            if (verbose) {
              // In verbose mode: send text immediately as it arrives
              await sendToQQ(state.replyTo, block.text).catch(e =>
                console.error(`[qqbot] verbose text send failed: ${e.message}`)
              );
            } else {
              state.accText += block.text;
            }
          }
          if (block.type === 'tool_use' && verbose) {
            const inputStr = JSON.stringify(block.input || {}, null, 2);
            const msg = `🔧 调用工具: ${block.name}\n\`\`\`\n${inputStr.slice(0, 800)}\n\`\`\``;
            await sendToQQ(state.replyTo, msg).catch(() => {});
          }
        }
      }

      // ── tool result (comes back as user event) ───────────────────────────
      if (claudeEvent.type === 'user' && claudeEvent.message?.content && verbose) {
        if (!state) return;
        for (const block of claudeEvent.message.content) {
          if (block.type === 'tool_result') {
            const raw = Array.isArray(block.content)
              ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
              : (typeof block.content === 'string' ? block.content : '');
            if (raw) {
              const msg = `📋 工具结果:\n\`\`\`\n${raw.slice(0, 800)}\n\`\`\``;
              await sendToQQ(state.replyTo, msg).catch(() => {});
            }
          }
        }
      }

      // ── permission request ───────────────────────────────────────────────
      if (claudeEvent.type === 'control_request') {
        const req = claudeEvent.request || {};
        if (req.subtype !== 'can_use_tool') return;
        const requestId = claudeEvent.request_id;
        const toolName = req.tool_name || 'Unknown';
        const input = req.input || {};

        if (autoApprove || autoApproveSessions.has(sessionId)) {
          api.respondToPermission(sessionId, requestId, 'allow');
          console.log(`[qqbot] Auto-approved tool: ${toolName}`);
          return;
        }

        // Ask user via QQ
        pendingPermissions.set(sessionId, { requestId, toolName, input });
        const inputPreview = JSON.stringify(input).slice(0, 300);
        const prompt =
          `⚠️ Claude 想要使用工具:\n` +
          `📦 工具: ${toolName}\n` +
          `📝 参数: ${inputPreview}\n\n` +
          `回复 /allow 允许，/deny 拒绝`;
        const replyTo = state?.replyTo;
        if (replyTo) {
          await sendToQQ(replyTo, prompt).catch(e =>
            console.error(`[qqbot] Permission prompt failed: ${e.message}`)
          );
        }
      }

      // ── turn complete ────────────────────────────────────────────────────
      if (claudeEvent.type === 'result') {
        if (!state) return;
        const { accText, replyTo } = state;
        pendingReplies.delete(sessionId);

        if (verbose) {
          // Already sent everything inline; just send a brief summary
          const cost = claudeEvent.usage?.total_cost_usd?.toFixed(4) || '?';
          await sendToQQ(replyTo, `✅ 完成 | $${cost}`).catch(() => {});
        } else {
          if (accText.trim()) {
            await sendReplyWithImages(replyTo, accText).catch(e =>
              console.error(`[qqbot] Send reply failed: ${e.message}`)
            );
          }
        }
      }

      // ── session end ──────────────────────────────────────────────────────
      if (claudeEvent.type === 'session_end') {
        const channelUserId = state?.channelUserId;
        pendingReplies.delete(sessionId);
        pendingPermissions.delete(sessionId);
        verboseSessions.delete(sessionId);
        autoApproveSessions.delete(sessionId);
        registeredSessions.delete(sessionId);
        if (channelUserId) api.clearSession('qqbot', channelUserId);
      }
    });
  }

  // ---- incoming QQ message handler ----

  async function handleQQMessage(type, event) {
    let channelUserId, replyTarget, userText;

    if (type === 'C2C_MESSAGE_CREATE') {
      const openid = event.author?.user_openid;
      if (!openid) return;
      channelUserId = `c2c:${openid}`;
      userText = (event.content || '').trim();
      replyTarget = { type: 'c2c', openid, msgId: event.id };

    } else if (type === 'GROUP_AT_MESSAGE_CREATE') {
      const groupOpenid = event.group_openid;
      if (!groupOpenid) return;
      channelUserId = `group:${groupOpenid}`;
      userText = (event.content || '').replace(/<@!\d+>/g, '').trim();
      replyTarget = { type: 'group', groupOpenid, msgId: event.id };

    } else {
      return;
    }

    if (!userText) return;

    console.log(`[qqbot] ${type} ${channelUserId}: ${userText.slice(0, 80)}`);

    // ── 新对话 — kill process and start a truly fresh session ───────────
    if (/^\/new$|^新对话$|^开始新对话$|^重新开始$/.test(userText)) {
      const oldSessionId = api._channelSessions?.get(`qqbot:${channelUserId}`);
      api.stopSession('qqbot', channelUserId);
      if (oldSessionId) {
        verboseSessions.delete(oldSessionId);
        autoApproveSessions.delete(oldSessionId);
        pendingPermissions.delete(oldSessionId);
        pendingReplies.delete(oldSessionId);
        registeredSessions.delete(oldSessionId);
      }
      await sendToQQ(replyTarget, '🆕 已开启新对话，进程已重启，上下文已清空。').catch(() => {});
      return;
    }

    // ── /clear — same process, context cleared (like Claude's /clear) ───
    if (/^\/clear$|^清除上下文$|^清空上下文$/.test(userText)) {
      const oldSessionId = api._channelSessions?.get(`qqbot:${channelUserId}`);
      if (!oldSessionId) {
        await sendToQQ(replyTarget, '当前没有进行中的对话。').catch(() => {});
        return;
      }
      // Clear per-session state
      pendingReplies.delete(oldSessionId);
      pendingPermissions.delete(oldSessionId);
      // Send /clear to Claude — Claude Code handles it internally as a slash command
      api.sendUserMessage(oldSessionId, '/clear');
      await sendToQQ(replyTarget, '🧹 上下文已清空，进程保留，可以继续对话。').catch(() => {});
      return;
    }

    let sessionId;
    try {
      // workDir callback: create an isolated per-session subdirectory so each
      // QQ conversation has its own workspace. CLAUDE.md in the parent
      // (plugins/qqbot/) is picked up automatically via directory traversal.
      const getWorkDir = (sid) => {
        const dir = join(SESSIONS_DIR, sid);
        mkdirSync(dir, { recursive: true });
        return dir;
      };
      sessionId = await api.getOrCreateSession('qqbot', channelUserId, { getWorkDir });
    } catch (e) {
      console.error(`[qqbot] Session error for ${channelUserId}: ${e.message}`);
      return;
    }

    registerSessionListener(sessionId);

    // ── /aa — toggle auto-approve for this session ──────────────────────
    if (userText === '/aa') {
      if (autoApproveSessions.has(sessionId)) {
        autoApproveSessions.delete(sessionId);
        await sendToQQ(replyTarget, '🔒 已关闭自动权限').catch(() => {});
      } else {
        autoApproveSessions.add(sessionId);
        // Also approve any currently pending permission
        const perm = pendingPermissions.get(sessionId);
        if (perm) {
          api.respondToPermission(sessionId, perm.requestId, 'allow');
          pendingPermissions.delete(sessionId);
        }
        await sendToQQ(replyTarget, '🔓 已开启自动权限，后续工具调用无需确认').catch(() => {});
      }
      return;
    }

    // ── /allow /deny — permission response ──────────────────────────────
    if (userText === '/allow' || userText === '/deny') {
      const perm = pendingPermissions.get(sessionId);
      if (perm) {
        const decision = userText === '/allow' ? 'allow' : 'deny';
        api.respondToPermission(sessionId, perm.requestId, decision);
        pendingPermissions.delete(sessionId);
        await sendToQQ(replyTarget,
          decision === 'allow' ? '✅ 已允许，继续执行...' : '❌ 已拒绝'
        ).catch(() => {});
      } else {
        await sendToQQ(replyTarget, '当前没有待处理的权限请求').catch(() => {});
      }
      return;
    }

    // ── verbose toggle ───────────────────────────────────────────────────
    const verboseOn  = /开启.*(中间过程|详细|调试|verbose)/i.test(userText) || userText === '/verbose on';
    const verboseOff = /关闭.*(中间过程|详细|调试|verbose)/i.test(userText) || userText === '/verbose off';

    if (verboseOn && !verboseSessions.has(sessionId)) {
      verboseSessions.add(sessionId);
      console.log(`[qqbot] Verbose ON for ${sessionId}`);
      // Fall through — let Claude also handle the message naturally
    } else if (verboseOff && verboseSessions.has(sessionId)) {
      verboseSessions.delete(sessionId);
      console.log(`[qqbot] Verbose OFF for ${sessionId}`);
      // Fall through — let Claude also handle the message naturally
    }

    // ── normal message → Claude ──────────────────────────────────────────
    pendingReplies.set(sessionId, { accText: '', replyTo: replyTarget, channelUserId });
    api.sendUserMessage(sessionId, userText);
  }

  connectGateway(appId, clientSecret, handleQQMessage);
  console.log(`[qqbot] Plugin started (appId=${appId}, autoApprove=${autoApprove})`);
}
