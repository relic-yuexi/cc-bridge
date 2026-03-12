// plugin-api.js - cc-bridge Plugin API
// Exposes a stable interface for channel plugins to interact with cc-bridge

import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';

export class PluginAPI {
  constructor({ sessionManager, bridgeManager, deliverClaudeIngressMessage, buildUserMessageEvent, resolveUploadUrl, respondToPermission }) {
    this._sessionManager = sessionManager;
    this._bridgeManager = bridgeManager;
    this._deliverClaudeIngressMessage = deliverClaudeIngressMessage;
    this._buildUserMessageEvent = buildUserMessageEvent;
    this._resolveUploadUrl = resolveUploadUrl;
    this._respondToPermission = respondToPermission;

    // channelKey (e.g. "qqbot:c2c:openid123") -> sessionId
    this._channelSessions = new Map();

    // sessionId -> Set<callback(event)>
    this._eventListeners = new Map();
  }

  /**
   * Get all currently online bridges.
   * @returns {{ id: string, name: string }[]}
   */
  getBridges() {
    return this._bridgeManager.getAllBridges()
      .filter(b => b.status === 'online')
      .map(b => ({ id: b.bridgeId, name: b.metadata?.name || b.bridgeId }));
  }

  /**
   * Get or create a Claude session for a given channel + user.
   * Reuses an existing live session if available.
   *
   * @param {string} channelId - e.g. 'qqbot'
   * @param {string} userId    - unique user/group identifier within the channel
   * @param {object} opts
   * @param {string} [opts.bridgeId]   - preferred bridge (defaults to first available)
   * @param {string} [opts.workDir]    - working directory for Claude
   * @param {boolean} [opts.dangerouslySkipPermissions]
   * @returns {Promise<string>} sessionId
   */
  async getOrCreateSession(channelId, userId, opts = {}) {
    const channelKey = `${channelId}:${userId}`;

    // Reuse existing live session
    const existingId = this._channelSessions.get(channelKey);
    if (existingId) {
      const session = this._sessionManager.getSession(existingId);
      if (session) return existingId;
      // Session was removed, fall through to create a new one
      this._channelSessions.delete(channelKey);
    }

    // Pick a bridge
    const bridges = this.getBridges();
    const bridgeId = opts.bridgeId || bridges[0]?.id;
    if (!bridgeId) throw new Error('No bridge available');

    const bridge = this._bridgeManager.getBridge(bridgeId);
    if (!bridge || bridge.ws?.readyState !== WebSocket.OPEN) {
      throw new Error(`Bridge ${bridgeId} not connected`);
    }

    // Create session
    const sessionId = `plugin-${channelId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    // Allow caller to derive workDir from the final sessionId (e.g. per-session subdirs)
    const workDir = opts.getWorkDir ? opts.getWorkDir(sessionId) : (opts.workDir || '');
    this._sessionManager.createSession(sessionId, bridgeId, workDir);
    this._bridgeManager.addSession(bridgeId, sessionId);

    bridge.ws.send(JSON.stringify({
      type: 'start_session',
      sessionId,
      resume: false,
      workDir: workDir || undefined,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions || false,
    }));

    this._channelSessions.set(channelKey, sessionId);
    console.log(`[Plugin] Created session ${sessionId} for ${channelKey} on bridge ${bridgeId}`);
    return sessionId;
  }

  /**
   * Remove the channel->session mapping (e.g. when a session ends).
   * Call this from onEvent when you receive a 'session_end' event.
   *
   * @param {string} channelId
   * @param {string} userId
   */
  clearSession(channelId, userId) {
    const channelKey = `${channelId}:${userId}`;
    const sessionId = this._channelSessions.get(channelKey);
    if (sessionId) {
      this._channelSessions.delete(channelKey);
      this._eventListeners.delete(sessionId);
    }
  }

  /**
   * Stop a session and remove it from the channel mapping.
   * The bridge will kill the Claude process; the plugin should then start fresh.
   *
   * @param {string} channelId
   * @param {string} userId
   */
  stopSession(channelId, userId) {
    const channelKey = `${channelId}:${userId}`;
    const sessionId = this._channelSessions.get(channelKey);
    if (!sessionId) return;

    const session = this._sessionManager.getSession(sessionId);
    if (session) {
      const bridge = this._bridgeManager.getBridge(session.bridgeId);
      if (bridge?.ws?.readyState === WebSocket.OPEN) {
        bridge.ws.send(JSON.stringify({ type: 'stop_session', sessionId }));
      }
      this._sessionManager.removeSession(sessionId);
    }

    this._channelSessions.delete(channelKey);
    this._eventListeners.delete(sessionId);
    console.log(`[Plugin] Stopped session ${sessionId} for ${channelKey}`);
  }

  /**
   * Resolve a server-relative upload URL (e.g. /bridge-uploads/sessionId/file.png)
   * to an absolute local file path on disk. Returns null if not a local upload URL.
   *
   * @param {string} url
   * @returns {string|null} absolute file path, or null
   */
  resolveUploadUrl(url) {
    return this._resolveUploadUrl ? this._resolveUploadUrl(url) : null;
  }

  /**
   * Send a user text message to Claude in the given session.
   *
   * @param {string} sessionId
   * @param {string} text
   */
  sendUserMessage(sessionId, text) {
    const event = this._buildUserMessageEvent(sessionId, text);
    this._deliverClaudeIngressMessage(sessionId, event, 'Plugin message');
  }

  /**
   * Subscribe to all Claude events for a given session.
   * Returns an unsubscribe function.
   *
   * Common event types:
   *   - content_block_delta  (delta.type === 'text_delta', delta.text)
   *   - result               (signals end of turn)
   *   - session_end          (session was terminated)
   *
   * @param {string} sessionId
   * @param {function(event: object): void} callback
   * @returns {function} unsubscribe
   */
  onEvent(sessionId, callback) {
    if (!this._eventListeners.has(sessionId)) {
      this._eventListeners.set(sessionId, new Set());
    }
    this._eventListeners.get(sessionId).add(callback);
    return () => {
      this._eventListeners.get(sessionId)?.delete(callback);
    };
  }

  /**
   * Respond to a Claude permission request.
   * @param {string} sessionId
   * @param {string} requestId
   * @param {'allow'|'deny'} decision
   */
  respondToPermission(sessionId, requestId, decision) {
    if (this._respondToPermission) {
      this._respondToPermission(sessionId, requestId, decision);
    }
  }

  /**
   * Internal: called by server.js forwardToChat to fan out events to plugin listeners.
   * Not intended for plugin use.
   *
   * @param {string} sessionId
   * @param {object} event
   */
  _dispatch(sessionId, event) {
    const listeners = this._eventListeners.get(sessionId);
    if (!listeners?.size) return;
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (e) {
        console.error(`[Plugin] Event listener error: ${e.message}`);
      }
    }
  }
}
