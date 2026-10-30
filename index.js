import pino from 'pino';
import http from 'http';
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  initAuthCreds
} from 'baileys';

const FORWARD_URL = 'https://bots.qxel.app/tg/notify/bot';
const FORWARD_PATH = '/';
const OTP_TOKEN = process.env.OTP_TOKEN || '';
const RECONNECT_DELAY = 5000;
const PORT = process.env.PORT || 3000;

const logger = pino({ level: 'info' });

let sock = null;
let isShuttingDown = false;

function fixBuffer(obj) {
  if (obj && typeof obj === 'object') {
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data);
    }
    for (const key in obj) obj[key] = fixBuffer(obj[key]);
  }
  return obj;
}

function loadCredsFromEnv() {
  if (!process.env.CREDS) {
    logger.warn('CREDS env var not found, using fresh initAuthCreds()');
    return initAuthCreds();
  }
  const raw = fixBuffer(JSON.parse(process.env.CREDS));
  return raw;
}

// ====================================================
//   PERSISTENT IN-MEMORY KEYSTORE
//   - created ONCE so it survives reconnects
//   - creds.update writes are kept in memory
// ====================================================
const creds = loadCredsFromEnv();
const keyStore = {};

function keysGet(type, ids) {
  if (Array.isArray(ids)) {
    const result = {};
    for (const id of ids) {
      if (keyStore[type] && keyStore[type][id]) result[id] = keyStore[type][id];
    }
    return result;
  }
  return keyStore[type] && keyStore[type][ids] ? keyStore[type][ids] : null;
}

function keysSet(data) {
  if (!data) return;
  for (const type in data) {
    if (!keyStore[type]) keyStore[type] = {};
    Object.assign(keyStore[type], data[type]);
  }
}

// ====================================================
//   CONNECT
// ====================================================
async function connectSession() {
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: {
      creds,
      keys: {
        get: keysGet,
        set: keysSet
      }
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Izumie Console', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
    // Baileys needs this to answer "retry receipt" requests from WhatsApp.
    // We don't store messages; returning empty string is fine.
    getMessage: async () => ''
  });

  // Persist updated creds (noise keys, registrationId, etc.) in memory.
  socket.ev.on('creds.update', (update) => {
    Object.assign(creds, update);
  });

  // ===== Connection lifecycle =====
  socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      logger.info('✅ WhatsApp connected');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ code }, '⚠ Connection closed');
      sock = null;

      if (isShuttingDown) return;

      if (code === DisconnectReason.loggedOut) {
        logger.error('❌ Logged out — CREDS need to be regenerated.');
        process.exit(1);
      }

      logger.info(`🔁 Reconnecting in ${RECONNECT_DELAY}ms...`);
      setTimeout(boot, RECONNECT_DELAY);
    }
  });

  // ===== Incoming messages =====
  socket.ev.on('messages.upsert', async (upsert) => {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const from = msg.key.remoteJid || '';
        if (!from.endsWith('@s.whatsapp.net')) continue;

        const text = extractText(msg.message);
        if (!text) continue;

        const number = from.split('@')[0];
        logger.info({ number, text }, '📩 Forwarding incoming message');

        await forwardMessage(number, text);
      } catch (err) {
        logger.error({ err }, '❌ Error handling message');
      }
    }
  });

  return socket;
}

// ====================================================
//   EXTRACT TEXT FROM ANY MESSAGE TYPE
// ====================================================
function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    message.buttonsMessage?.contentText ||
    message.listMessage?.description ||
    null
  );
}

// ====================================================
//   FORWARD TO YOUR ENDPOINT
// ====================================================
async function forwardMessage(number, message) {
  const url = FORWARD_URL.replace(/\/$/, '') + FORWARD_PATH;
  const body = { number, message };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(OTP_TOKEN ? { 'X-Qxel-Secret-Key': OTP_TOKEN } : {})
    },
    body: JSON.stringify(body)
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    logger.error({ status: res.status, body: text }, '❌ Forward failed');
  } else {
    logger.info({ status: res.status }, '✅ Forwarded successfully');
  }
}

// ====================================================
//   BOOT
// ====================================================
async function boot() {
  try {
    sock = await connectSession();
  } catch (err) {
    logger.error({ err }, '❌ Boot failed — retrying');
    setTimeout(boot, RECONNECT_DELAY);
  }
}

// ====================================================
//   HTTP WEB SERVICE
// ====================================================
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'whatsapp-forwarder',
      connected: !!sock,
      uptime: process.uptime()
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  logger.info(`🌐 Web service listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('SIGINT — shutting down');
  isShuttingDown = true;
  try { sock?.end(undefined); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down');
  isShuttingDown = true;
  try { sock?.end(undefined); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
});
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandledRejection');
});

// ============ START ============
logger.info('🚀 Starting WhatsApp forwarder...');
boot();
