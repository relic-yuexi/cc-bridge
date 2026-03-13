// shared/utils.js - Common utilities shared between server.js and bridge.js
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { inspect } from 'util';

export function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const vars = {};
  try {
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
  } catch (e) {
    console.error(`Failed to load env file ${filePath}: ${e.message}`);
  }
  return vars;
}

export function applyEnvFile(envVarName, defaultPath) {
  const envFilePath = process.env[envVarName] || defaultPath;
  const dotEnvVars = loadEnvFile(envFilePath);
  if (Object.keys(dotEnvVars).length > 0) {
    console.log(`\u{1F4C4} Loaded ${Object.keys(dotEnvVars).length} vars from ${envFilePath}`);
    for (const [key, value] of Object.entries(dotEnvVars)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

export function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

export function createTimestampLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function safePathSegment(value) {
  if (!value) return 'unknown';
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
}

export function formatLogArgs(args) {
  return args.map((arg) => (
    typeof arg === 'string'
      ? arg
      : inspect(arg, { depth: 6, breakLength: 120, maxArrayLength: 100 })
  )).join(' ');
}

export function initProcessLogger(logFile, label) {
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

export function makeAppendEventFn(getSessionDirFn, getSessionEventFileFn) {
  return function appendSessionEvent(sessionId, eventType, details) {
    try {
      const sessionDir = getSessionDirFn(sessionId);
      ensureDir(sessionDir);
      const suffix = details === undefined ? '' : ` ${formatLogArgs([details])}`;
      appendFileSync(
        getSessionEventFileFn(sessionId),
        `[${new Date().toISOString()}] [${eventType}]${suffix}\n`
      );
    } catch (e) {
      console.error(`[${sessionId}] Failed to append session event:`, e.message);
    }
  };
}
