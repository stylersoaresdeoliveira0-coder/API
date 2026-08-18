require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const FF_API_TIMEOUT_MS = parseInt(process.env.FF_API_TIMEOUT_MS || '20000', 10);
const NODE_ENV = process.env.NODE_ENV || 'production';

app.use(cors());
app.use(express.json());

const ffapis = {
  base: {
    url: 'https://ffapis.com/api/v1',
    key: 'ffapikey',
  },
  // mantenha outros endpoints aqui se necessário
};

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return {};
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('[DB] Erro ao carregar db.json:', err.message);
    return {};
  }
}

function saveDB(data) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[DB] Erro ao salvar db.json:', err.message);
  }
}

let db = loadDB();

function getUserKey(uid) {
  return `uid_${uid}`;
}

function getNowBR() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function isBlockedUntil1300() {
  const now = getNowBR();
  const hour = now.getHours();
  const minute = now.getMinutes();
  return hour < 13 || (hour === 13 && minute === 0);
}

function getNext1300BR() {
  const now = getNowBR();
  const next = new Date(now);
  next.setHours(13, 0, 0, 0);
  if (now >= next) next.setDate(next.getDate() + 1);
  return next.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function canSend(uid) {
  const key = getUserKey(uid);
  const last = db[key];
  if (!last) return { allowed: true };
  const lastTime = new Date(last).getTime();
  const now = Date.now();
  const eightHours = 8 * 60 * 60 * 1000;
  if (now - lastTime < eightHours) {
    const next = new Date(lastTime + eightHours);
    return {
      allowed: false,
      next: next.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    };
  }
  return { allowed: true };
}

function recordSend(uid) {
  db[getUserKey(uid)] = new Date().toISOString();
  saveDB(db);
}

// Circuit breaker para API externa
let circuitState = 'CLOSED';
let circuitFailures = 0;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_TIMEOUT_MS = 60000;

function circuitOpen() {
  return circuitState === 'OPEN' && (Date.now() - circuitLastFailure) < CIRCUIT_TIMEOUT_MS;
}

function circuitRecordSuccess() {
  circuitFailures = 0;
  circuitState = 'CLOSED';
}

function circuitRecordFailure() {
  circuitFailures += 1;
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitState = 'OPEN';
    circuitLastFailure = Date.now();
    console.error('[CIRCUIT] Aberto por 60s após', circuitFailures, 'falhas');
  }
}

async function callExternalAPI(uid) {
  if (circuitOpen()) {
    throw new Error('API externa temporariamente indisponível (circuit breaker)');
  }

  try {
    const response = await axios({
      method: 'post',
      url: `${ffapis.base.url}/send`,
      data: { uid, key: ffapis.base.key },
      timeout: FF_API_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FFLikesAPI/1.1',
      },
      validateStatus: () => true,
    });

    circuitRecordSuccess();
    return response.data;
  } catch (err) {
    circuitRecordFailure();
    throw err;
  }
}

// Rate limiter
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Muitas requisições. Aguarde um momento.',
    retryAfter: '60s',
  },
});

app.use('/api/', limiter);

// Health checks
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: NODE_ENV,
  });
});

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

// Status da API
app.get('/api/status', (_req, res) => {
  res.status(200).json({
    success: true,
    online: true,
    circuitBreaker: circuitState,
    timestamp: new Date().toISOString(),
  });
});

// Enviar likes
app.post('/api/send', async (req, res) => {
  try {
    const { uid } = req.body;

    if (!uid || typeof uid !== 'string' || !/^\d{9,12}$/.test(uid.trim())) {
      return res.status(400).json({
        success: false,
        message: 'UID inválido. Informe um UID numérico de 9 a 12 dígitos.',
      });
    }

    const cleanUid = uid.trim();

    if (isBlockedUntil1300()) {
      return res.status(403).json({
        success: false,
        message: `Envio de likes liberado a partir das 13:00 (horário de Brasília). Próximo horário: ${getNext1300BR()}`,
      });
    }

    const check = canSend(cleanUid);
    if (!check.allowed) {
      return res.status(429).json({
        success: false,
        message: `Você já enviou likes para este UID. Aguarde até ${check.next} para enviar novamente.`,
      });
    }

    const result = await callExternalAPI(cleanUid);

    if (result && (result.success === true || result.status === 'ok' || result.ok === true)) {
      recordSend(cleanUid);
    }

    return res.status(200).json({
      success: true,
      message: 'Likes enviados com sucesso.',
      data: result,
    });
  } catch (err) {
    console.error('[API] Erro em /api/send:', err.message);

    const isExternal = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.message.includes('circuit breaker') || err.message.includes('timeout');

    return res.status(isExternal ? 503 : 500).json({
      success: false,
      message: isExternal
        ? 'Serviço de likes externo está fora do ar ou lento. Tente novamente em alguns minutos.'
        : 'Erro interno ao processar o envio.',
      error: NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// Listar registro de um UID (opcional, mantém compatibilidade)
app.get('/api/check/:uid', (req, res) => {
  const uid = req.params.uid;
  const check = canSend(uid);
  res.status(200).json({
    success: true,
    uid,
    allowed: check.allowed,
    nextAvailable: check.next || null,
  });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Rota não encontrada.' });
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[SHUTDOWN] Recebido ${signal}, salvando db.json e encerrando...`);
  saveDB(db);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
  saveDB(db);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err);
});

// Persistência periódica a cada 5 min
cron.schedule('*/5 * * * *', () => {
  saveDB(db);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] API rodando em http://0.0.0.0:${PORT} | env=${NODE_ENV} | db=${DB_FILE}`);
});
