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
let notaAtual = null; // forma de onda e duração da nota de voz sendo enviada

// O iPhone só toca nota de voz que tenha forma de onda. A Baileys apaga a forma de onda
// quando não consegue gerá-la sozinha, então ela é recolocada aqui, logo antes do envio.
function completarNotaDeVoz(msg) {
  const a = msg?.audioMessage || msg?.ephemeralMessage?.message?.audioMessage;
  if (a && a.ptt && notaAtual) {
    if (!a.waveform?.length && notaAtual.waveform) a.waveform = notaAtual.waveform;
    if (!a.seconds && notaAtual.seconds) a.seconds = notaAtual.seconds;
  }
  return msg;
}

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
    patchMessageBeforeSending: (msg) => completarNotaDeVoz(msg),
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

// Limite prático do WhatsApp para áudio: ~16 MB. Usamos 15 MB com folga.
const LIMITE_BYTES = 15 * 1024 * 1024;

function converterOpus(entrada, saida, kbps) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', entrada, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', `${kbps}k`, '-application', 'voip', '-avoid_negative_ts', 'make_zero', saida], { timeout: 300000 });
  return r.status === 0 && fs.existsSync(saida) ? fs.readFileSync(saida) : null;
}

// Duração em segundos (o iPhone precisa dela na nota de voz).
function duracaoSegundos(arquivo) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', arquivo], { encoding: 'utf8', timeout: 60000 });
  const s = Math.ceil(Number(String(r.stdout || '').trim()));
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

// Forma de onda com 64 barras de 0 a 100, igual à que o próprio WhatsApp gera.
function formaDeOnda(arquivo) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', arquivo, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
  if (r.status !== 0 || !r.stdout?.length) return undefined;
  const amostras = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2));
  const barras = 64;
  const porBarra = Math.max(1, Math.floor(amostras.length / barras));
  const medias = [];
  for (let b = 0; b < barras; b++) {
    let soma = 0;
    const ini = b * porBarra;
    const fim = Math.min(amostras.length, ini + porBarra);
    for (let i = ini; i < fim; i++) soma += Math.abs(amostras[i]);
    medias.push(fim > ini ? soma / (fim - ini) : 0);
  }
  const max = Math.max(...medias) || 1;
  return new Uint8Array(medias.map((m) => Math.round((m / max) * 100)));
}

function extrasNotaDeVoz(buffer) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-'));
  const arq = path.join(pasta, 'nota.ogg');
  try {
    fs.writeFileSync(arq, buffer);
    return { seconds: duracaoSegundos(arq), waveform: formaDeOnda(arq) };
  } catch {
    return {};
  } finally {
    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* ignora */ }
  }
}

// Converte qualquer áudio (m4a, mp3...) para nota de voz do WhatsApp (ogg/opus).
// Se o resultado passar do limite de tamanho do WhatsApp, reduz a qualidade e tenta de novo.
// Se a conversão falhar, envia o arquivo original como áudio comum.
function prepararNotaDeVoz(audio) {
  if (audio.mime.includes('ogg') && audio.buffer.length <= LIMITE_BYTES) {
    return { buffer: audio.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, reduzido: false };
  }
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'oracao-'));
  const entrada = path.join(pasta, `entrada${audio.ext || '.m4a'}`);
  const saida = path.join(pasta, 'saida.ogg');
  try {
    fs.writeFileSync(entrada, audio.buffer);
    let kbps = 48;
    let buffer = converterOpus(entrada, saida, kbps);
    let reduzido = false;
    for (let tentativa = 0; buffer && buffer.length > LIMITE_BYTES && tentativa < 3; tentativa++) {
      // Calcula uma qualidade menor proporcional ao excesso (mínimo 12 kbps, ainda claro para voz).
      kbps = Math.max(12, Math.floor((kbps * LIMITE_BYTES * 0.9) / buffer.length));
      log(`Áudio grande demais para o WhatsApp (${(buffer.length / 1048576).toFixed(1)} MB). Reduzindo a qualidade para ${kbps} kbps...`);
      buffer = converterOpus(entrada, saida, kbps);
      reduzido = true;
    }
    if (buffer) {
      log(`Convertido para nota de voz: ${(buffer.length / 1024).toFixed(0)} KB (${kbps} kbps).`);
      if (buffer.length > LIMITE_BYTES) throw new Error('mesmo com a qualidade mínima, o áudio passou do limite de tamanho do WhatsApp');
      return { buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, reduzido, kbps };
    }
    log('Não consegui converter para nota de voz; enviando como áudio comum.');
  } finally {
    try { fs.rmSync(pasta, { recursive: true, force: true }); } catch { /* ignora */ }
  }
  if (audio.buffer.length > LIMITE_BYTES) throw new Error('o áudio passou do limite de tamanho do WhatsApp e não pôde ser convertido');
  const mimetype = /m4a|mp4|aac/.test(audio.mime) ? 'audio/mp4' : audio.mime;
  return { buffer: audio.buffer, mimetype, ptt: false, reduzido: false };
}

// Envia para cada destino, um por vez, com pausa aleatória entre eles:
// primeiro a mensagem do dia (se houver), depois o áudio, depois a legenda (se houver).
async function enviarAudio(audio, destinos, { intervalo = { min: 20, max: 60 }, mensagem = '', legenda = '' } = {}) {
  const nota = prepararNotaDeVoz(audio);
  notaAtual = nota.ptt ? extrasNotaDeVoz(nota.buffer) : null;
  if (notaAtual) log(`Nota de voz: ${notaAtual.seconds ?? '?'} s, forma de onda ${notaAtual.waveform ? 'ok' : 'indisponível'}.`);
  const resultado = { ok: [], falhas: [], erros: {}, reduzido: nota.reduzido ? nota.kbps : null };

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
      await s.sendMessage(jid, {
        audio: nota.buffer,
        mimetype: nota.mimetype,
        ptt: nota.ptt,
        ...(notaAtual?.seconds ? { seconds: notaAtual.seconds } : {}),
      });
      await s.sendPresenceUpdate('paused', jid).catch(() => {});
      if (legenda) await s.sendMessage(jid, { text: legenda });
      log(`  ✔ ${d.nome}`);
      resultado.ok.push(d.nome);
    } catch (err) {
      log(`  ✘ ${d.nome}: ${err.message}`);
      resultado.falhas.push(d.nome);
      resultado.erros[d.nome] = err.message;
    }
    if (i < destinos.length - 1) await esperar(aleatorio(intervalo.min, intervalo.max) * 1000);
  }
  return resultado;
}

// Mensagem de texto simples (usada para avisar você quando o áudio não chegou).
async function enviarTexto(id, texto) {
  const s = await aguardarConexao(30);
  const jid = await resolverJid(s, id);
  await s.sendMessage(jid, { text: texto });
}

function encerrar() {
  geracao++;
  try { sock?.end(undefined); } catch { /* ignora */ }
}

module.exports = { status, iniciar, sair, listarGrupos, enviarAudio, enviarTexto, encerrar };
