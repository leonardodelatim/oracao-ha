// WhatsApp como "aparelho conectado". O QR Code aparece no painel do add-on.
const fs = require('fs');
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

// Envia para cada destino, um por vez, com pausa aleatória entre eles.
async function enviarAudio(audio, destinos, { intervalo = { min: 20, max: 60 }, legenda = '' } = {}) {
  const ptt = audio.mime.includes('ogg'); // nota de voz exige ogg/opus
  const mimetype = ptt ? 'audio/ogg; codecs=opus' : audio.mime;
  const resultado = { ok: [], falhas: [] };

  for (let i = 0; i < destinos.length; i++) {
    const d = destinos[i];
    try {
      const s = await aguardarConexao();
      await s.sendPresenceUpdate('recording', d.id).catch(() => {});
      await esperar(aleatorio(2000, 5000));
      await s.sendMessage(d.id, { audio: audio.buffer, mimetype, ptt });
      await s.sendPresenceUpdate('paused', d.id).catch(() => {});
      if (legenda) await s.sendMessage(d.id, { text: legenda });
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
