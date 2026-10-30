import pino from 'pino';
import http from 'http';
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason
} from 'baileys';

const FORWARD_URL = 'https://bots.qxel.app/tg/notify/bot';
const FORWARD_PATH = '/';
const OTP_TOKEN = process.env.OTP_TOKEN || '';
const RECONNECT_DELAY = 5000;
const PORT = Number(process.env.PORT || 10000);

const logger = pino({ level: 'info' });

let sock = null;
let reconnectTimer = null;
let isShuttingDown = false;
let reconnecting = false;

function fixBuffer(value) {
  if (!value || typeof value !== 'object') return value;

  if (value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }

  if (Array.isArray(value)) {
    return value.map(fixBuffer);
  }

  for (const key of Object.keys(value)) {
    value[key] = fixBuffer(value[key]);
  }

  return value;
}

function loadAuthState() {
  const encoded = process.env.CREDS;

  if (!encoded) {
    throw new Error('CREDS environment variable is missing');
  }

  const raw = fixBuffer(JSON.parse(encoded));

  const authState = raw.auth || raw;

  if (!authState.creds) {
    throw new Error(
      'CREDS must contain a serialized Baileys auth state with { creds, keys }'
    );
  }

  return {
    creds: authState.creds,
    keys: authState.keys || {}
  };
}

function makeKeyStore(keyData) {
  const store = keyData || {};

  return {
    async get(type, ids) {
      const bucket = store[type] || {};
      const result = {};

      for (const id of ids) {
        if (bucket[id] !== undefined && bucket[id] !== null) {
          result[id] = bucket[id];
        }
      }

      return result;
    },

    async set(data) {
      for (const [type, values] of Object.entries(data)) {
        store[type] ||= {};

        for (const [id, value] of Object.entries(values || {})) {
          if (value === null || value === undefined) {
            delete store[type][id];
          } else {
            store[type][id] = value;
          }
        }
      }
    },

    async clear() {
      for (const type of Object.keys(store)) {
        delete store[type];
      }
    }
  };
}

async function connectSession() {
  const auth = loadAuthState();
  const keyStore = makeKeyStore(auth.keys);
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, 'Using WhatsApp Web version');

  const socket = makeWASocket({
    version,
    auth: {
      creds: auth.creds,
      keys: keyStore
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Izumie Console', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  socket.ev.on('creds.update', updates => {
    Object.assign(auth.creds, updates);
  });

  socket.ev.on('connection.update', update => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      reconnecting = false;
      logger.info('✅ WhatsApp connected');
      return;
    }

    if (connection !== 'close') return;

    const error = lastDisconnect?.error;
    const code =
      error?.output?.statusCode ||
      error?.data?.statusCode ||
      error?.statusCode;

    logger.warn(
      {
        code,
        error: error?.message || String(error || '')
      },
      '⚠ WhatsApp connection closed'
    );

    if (sock === socket) {
      sock = null;
    }

    if (isShuttingDown) return;

    if (code === DisconnectReason.loggedOut) {
      logger.error(
        '❌ WhatsApp logged out. Generate a fresh CREDS value and redeploy.'
      );
      process.exit(1);
    }

    scheduleReconnect();
  });

  socket.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid || '';

        if (
          from === 'status@broadcast' ||
          !from.endsWith('@s.whatsapp.net')
        ) {
          continue;
        }

        const text = extractText(msg.message);
        if (!text) continue;

        await forwardMessage(from.split('@')[0], text);
      } catch (error) {
        logger.error({ error }, '❌ Error handling WhatsApp message');
      }
    }
  });

  return socket;
}

function scheduleReconnect() {
  if (isShuttingDown || reconnectTimer || reconnecting) return;

  reconnecting = true;

  logger.info(
    { delay: RECONNECT_DELAY },
    '🔁 Reconnecting to WhatsApp'
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    boot();
  }, RECONNECT_DELAY);
}

function extractText(message) {
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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(OTP_TOKEN ? { 'X-Qxel-Secret-Key': OTP_TOKEN } : {})
    },
    body: JSON.stringify({ number, message })
  });

  const body = await response.text();

  if (!response.ok) {
    logger.error(
      { status: response.status, body },
      '❌ Forward failed'
    );
    return;
  }

  logger.info({ status: response.status }, '✅ Forwarded successfully');
}

async function boot() {
  if (isShuttingDown || sock) return;

  try {
    sock = await connectSession();
    reconnecting = false;
  } catch (error) {
    sock = null;
    reconnecting = false;

    logger.error({ error }, '❌ WhatsApp boot failed');
    scheduleReconnect();
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'whatsapp-forwarder',
        connected: Boolean(sock),
        uptime: process.uptime()
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, '🌐 Web service listening');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');

  isShuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    sock?.end(undefined);
  } catch (error) {
    logger.error({ error }, 'Error closing WhatsApp socket');
  }

  server.close(() => process.exit(0));
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', error => {
  logger.error({ error }, 'Uncaught exception');
});

process.on('unhandledRejection', error => {
  logger.error({ error }, 'Unhandled rejection');
});

logger.info('🚀 Starting WhatsApp forwarder...');
boot();
