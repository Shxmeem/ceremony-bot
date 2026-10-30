import pino from 'pino';
import http from 'http';
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  isJidBroadcast,
  isJidNewsletter
} from 'baileys';
import NodeCache from '@cacheable/node-cache';

const FORWARD_URL = 'https://bots.qxel.app/tg/notify/bot';
const FORWARD_PATH = '/';
const OTP_TOKEN = process.env.OTP_TOKEN || '';
const RECONNECT_DELAY = 5000;
const PORT = process.env.PORT || 3000;

const logger = pino({ level: 'info' });

let sock = null;
let isShuttingDown = false;

// Survive socket restarts
const msgRetryCounterCache = new NodeCache();

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
    throw new Error('CREDS environment variable not found');
  }
  const raw = JSON.parse(process.env.CREDS);
  fixBuffer(raw);
  return raw;
}

// ====================================================
//   READ-ONLY KEYSTORE (same as Vercel version)
// ====================================================
function makeKeyStore(creds) {
  return {
    get: (type, ids) => {
      return creds[type] && creds[type][ids] ? creds[type][ids] : null;
    },
    set: () => {},   // ignore writes
    clear: () => {}
  };
}

// ====================================================
//   CONNECT
// ====================================================
async function connectSession() {
  const creds = loadCredsFromEnv();
  const keyStore = makeKeyStore(creds);

  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: {
      creds,
      keys: {
        get: (...args) => keyStore.get(...args),
        set: () => {}
      }
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),

    // ==== HANDSHAKE / 408 FIXES ====
    markOnlineOnConnect: false,        // don't force foreground → avoids extra handshake
    syncFullHistory: false,            // prevent 408 during initial history sync
    shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidNewsletter(jid),

    msgRetryCounterCache,              // prevents retry-loop stalls
    maxMsgRetryCount: 5,

    // reliability callbacks Baileys needs during handshake
    getMessage: async (key) => {
      // No persistent store; return undefined so Baileys just asks the peer to resend
      return undefined;
    },

    // keep ws alive
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 2000
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
//   EXTRACT TEXT
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
//   FORWARD
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

process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));

logger.info('🚀 Starting WhatsApp forwarder...');
boot();
