const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { LikeAPI } = require('ffapis');

const app = express();
app.use(cors()); // libera seu domínio do Lovable
app.use(express.json());

const like = new LikeAPI();
const DB_FILE = 'db.json';
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : { cooldowns: {}, locks: {} };

function save() { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }

// Hora atual no fuso de Brasília
function nowBR() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

// Próximo reset das 13:00 (BR)
function nextReset() {
  const d = nowBR();
  d.setHours(13, 0, 0, 0);
  if (d <= nowBR()) d.setDate(d.getDate() + 1);
  return d;
}

app.get('/api/status', (req, res) => {
  res.json({ ok: true, regras: 'cooldown 8h | trava UID ate 13:00 BR' });
});

app.post('/api/like', async (req, res) => {
  const { uid, region } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress;

  // validação
  if (!/^\d{9,12}$/.test(String(uid || ''))) {
    return res.status(400).json({ status: 'error', message: 'UID inválido. Digite só números.' });
  }
  const reg = (region || 'BR').toUpperCase();

  // TRAVA 1: UID bloqueado até o reset das 13:00
  if (db.locks[uid] && new Date(db.locks[uid]) > nowBR()) {
    return res.status(429).json({
      status: 'error',
      message: 'Este ID já recebeu likes hoje. Libera no reset das 13:00.'
    });
  }

  // TRAVA 2: cooldown de 8h por pessoa (IP)
  if (db.cooldowns[ip] && Date.now() - db.cooldowns[ip] < 8 * 3600 * 1000) {
    return res.status(429).json({
      status: 'error',
      message: 'Você já enviou likes. Aguarde 8 horas para enviar de novo.'
    });
  }

  try {
    const result = await like.sendLikes(uid, reg, 100);
    db.locks[uid] = nextReset().toISOString();   // trava o UID até 13:00
    db.cooldowns[ip] = Date.now();               // cooldown de 8h
    save();
    res.json({ status: 'success', message: 'Likes enviados com sucesso! 🎉', data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Erro ao enviar: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
