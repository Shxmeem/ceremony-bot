import pino from 'pino';
import http from 'http';
import fs from 'fs';
import path from 'path';
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState,
  initAuthCreds
} from 'baileys';

const FORWARD_URL = 'https://bots.qxel.app/tg/notify/bot';
const FORWARD_PATH = '/';
const OTP_TOKEN = process.env.OTP_TOKEN || '';
const RECONNECT_DELAY = 5000;
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth';

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

// Seed auth folder from CREDS env var ONCE (if folder is empty)
function seedAuthFromEnv() {
  if (!process.env.CREDS) return;
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const credsFile = path.join(AUTH_DIR, 'creds.json');
  if (fs.existsSync(credsFile)) {
    logger.info('Auth folder already exists — skipping CREDS seed');
    return;
  }

  try {
    const raw = fixBuffer(JSON.parse(process.env.CREDS));

    // Baileys >= 6 stores creds as JSON with buffers serialized as
    // { type: 'Buffer', data: [...] }. JSON.stringify already handles this.
    // Also strip the pairing keypair if the device is already registered.
    if (raw.registered && raw.pairingEphemeralKeyPair) {
      delete raw.pairingEphemeralKeyPair;
      delete raw.pairingCode;
    }

    fs.writeFileSync(credsFile, JSON.stringify(raw, null, 2));
    logger.info('Seeded creds.json from CREDS env var');
  } catch (e) {
    logger.error({ err: e }, 'Failed to seed creds from CREDS');
  }
}

// ====================================================
//   CONNECT
// ====================================================
async function connectSession() {
  seedAuthFromEnv();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: state.keys
    },
    logger: pino({ level: 'silent' }),
    browser: ['Izumie Console', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
    getMessage: async () => ''
  });

  // IMPORTANT: persist every creds/key mutation to disk
  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      logger.info('✅ WhatsApp connected');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ code }, '⚠ Connection closed');
      sock = null;

      if (isShuttingDown) return;

      if (code === DisconnectReason.loggedOut) {
        logger.error('❌ Logged out — delete ./auth and provide new CREDS.');
        process.exit(1);
      }

      logger.info(`🔁 Reconnecting in ${RECONNECT_DELAY}ms...`);
      setTimeout(boot, RECONNECT_DELAY);
    }
  });

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

async function boot() {
  try {
    sock = await connectSession();
  } catch (err) {
    logger.error({ err }, '❌ Boot failed — retrying');
    setTimeout(boot, RECONNECT_DELAY);
  }
}

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

logger.info('🚀 Starting WhatsApp forwarder...');
boot();
