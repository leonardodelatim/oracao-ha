// WhatsApp como "aparelho conectado". O QR Code aparece no painel do add-on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pino = require('pino');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const { PASTA_SESSAO_WA, log, esperar, aleatorio } = require('./util');

const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const status = { conectado: false, qrSvg: null, numero: null, erro: null };
let sock = null;
let geracao = 0; // invalida sockets antigos quando reiniciamos
let aoConectar = () => {};
let aoDesconectar = () => {};

async function iniciar(callbacks = {}) {
  if (callbacks.aoConectar) aoConectar = callbacks.aoConectar;
  if (callbacks.aoDesconectar) aoDesconectar = callbacks.aoDesconectar;
  const minha = ++geracao;

  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO_WA);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa a padrão */ }
  if (minha !== geracao) return;

  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['Home Assistant', 'Chrome', '120.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  const meu = sock;
  meu.ev.on('creds.update', saveCreds);

  meu.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (minha !== geracao) return;
    if (qr) {
      status.qrSvg = await QRCode.toString(qr, { type: 'svg', margin: 1 });
      status.conectado = false;
    }
    if (connection === 'open') {
      Object.assign(status, { conectado: true, qrSvg: null, erro: null, numero: meu.user?.id?.split(':')[0] || null });
      log('WhatsApp conectado.');
      aoConectar();
    }
    if (connection === 'close') {
      status.conectado = false;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        log('WhatsApp: aparelho removido no celular. Gerando novo QR Code.');
        status.erro = 'O WhatsApp foi desconectado pelo celular. Leia o QR Code de novo.';
        aoDesconectar(status.erro);
        limparSessao();
        setTimeout(() => iniciar(), 2000);
      } else {
        log(`WhatsApp: conexão caiu (código ${codigo ?? '?'}). Reconectando...`);
        setTimeout(() => { if (minha === geracao) iniciar(); }, 3000);
      }
    }
  });
}

function limparSessao() {
  try { fs.rmSync(PASTA_SESSAO_WA, { recursive: true, force: true }); } catch { /* ignora */ }
}

async function sair() {
  geracao++;
  try { await sock?.logout(); } catch { /* ignora */ }
  try { sock?.end(undefined); } catch { /* ignora */ }
  limparSessao();
  Object.assign(status, { conectado: false, qrSvg: null, numero: null, erro: null });
  setTimeout(() => iniciar(), 1000);
}

async function aguardarConexao(maxSegundos = 120) {
  for (let i = 0; i < maxSegundos && !status.conectado; i++) await esperar(1000);
  if (!status.conectado) throw new Error('WhatsApp não está conectado.');
  return sock;
}

async function listarGrupos() {
  const s = await aguardarConexao(5);
  const grupos = await s.groupFetchAllParticipating();
  return Object.values(grupos)
    .map((g) => ({ nome: g.subject || '(sem nome)', id: g.id }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// Descobre o endereço real do número no WhatsApp. Números brasileiros antigos
// às vezes estão registrados SEM o 9 depois do DDD, e o WhatsApp aceita a mensagem
// para o endereço errado sem dar erro (ela só não chega). Por isso perguntamos antes.
const cacheJid = new Map();
async function resolverJid(s, id) {
  if (!id || !id.endsWith('@s.whatsapp.net')) return id; // grupos ficam como estão
  if (cacheJid.has(id)) return cacheJid.get(id);
  const d = id.split('@')[0];
  const candidatos = [d];
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') candidatos.push(d.slice(0, 4) + d.slice(5)); // sem o 9
  if (d.startsWith('55') && d.length === 12) candidatos.push(`${d.slice(0, 4)}9${d.slice(4)}`); // com o 9
  for (const c of candidatos) {
    try {
      const [r] = await s.onWhatsApp(c);
      if (r?.exists && r.jid) {
        cacheJid.set(id, r.jid);
        if (r.jid !== id) log(`  (número ${d} está registrado no WhatsApp como ${r.jid.split('@')[0]})`);
        return r.jid;
      }
    } catch { /* tenta o próximo */ }
  }
  throw new Error(`o número ${d} não foi encontrado no WhatsApp`);
}

// Converte qualquer áudio (m4a, mp3...) para nota de voz do WhatsApp (ogg/opus).
// Se a conversão falhar, envia o arquivo original como áudio comum.
function prepararNotaDeVoz(audio) {
  if (audio.mime.includes('ogg')) return { buffer: audio.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true };
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'oracao-'));
  const entrada = path.join(pasta, `entrada${audio.ext || '.m4a'}`);
  const saida = path.join(pasta, 'saida.ogg');
  try {
    fs.writeFileSync(entrada, audio.buffer);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', entrada, '-vn', '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', saida], { timeout: 180000 });
    if (r.status === 0 && fs.existsSync(saida)) {
      const buffer = fs.readFileSync(saida);
      log(`Convertido para nota de voz: ${(buffer.length / 1024).toFixed(0)} KB.`);
      return { buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    }
    log('Não consegui converter para nota de voz; enviando como áudio comum.', String(r.stderr || r.error || '').slice(0, 200));
  } catch (err) {
    log('Falha na conversão do áudio:', err.message);
  } finally {
    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* ignora */ }
  }
  const mimetype = /m4a|mp4|aac/.test(audio.mime) ? 'audio/mp4' : audio.mime;
  return { buffer: audio.buffer, mimetype, ptt: false };
}

// Envia para cada destino, um por vez, com pausa aleatória entre eles:
// primeiro a mensagem do dia (se houver), depois o áudio, depois a legenda (se houver).
async function enviarAudio(audio, destinos, { intervalo = { min: 20, max: 60 }, mensagem = '', legenda = '' } = {}) {
  const nota = prepararNotaDeVoz(audio);
  const resultado = { ok: [], falhas: [] };

  for (let i = 0; i < destinos.length; i++) {
    const d = destinos[i];
    try {
      const s = await aguardarConexao();
      const jid = await resolverJid(s, d.id);
      if (mensagem) {
        await s.sendPresenceUpdate('composing', jid).catch(() => {});
        await esperar(aleatorio(1500, 3500));
        await s.sendMessage(jid, { text: mensagem });
        await esperar(aleatorio(1000, 2500));
      }
      await s.sendPresenceUpdate('recording', jid).catch(() => {});
      await esperar(aleatorio(2000, 5000));
      await s.sendMessage(jid, { audio: nota.buffer, mimetype: nota.mimetype, ptt: nota.ptt });
      await s.sendPresenceUpdate('paused', jid).catch(() => {});
      if (legenda) await s.sendMessage(jid, { text: legenda });
      log(`  ✔ ${d.nome}`);
      resultado.ok.push(d.nome);
    } catch (err) {
      log(`  ✘ ${d.nome}: ${err.message}`);
      resultado.falhas.push(d.nome);
    }
    if (i < destinos.length - 1) await esperar(aleatorio(intervalo.min, intervalo.max) * 1000);
  }
  return resultado;
}

function encerrar() {
  geracao++;
  try { sock?.end(undefined); } catch { /* ignora */ }
}

module.exports = { status, iniciar, sair, listarGrupos, enviarAudio, encerrar };
