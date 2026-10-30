// Telegram com a SUA conta. O login (telefone, código, senha) é feito pelo painel do add-on.
const fs = require('fs');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { ARQ_SESSAO_TG, log } = require('./util');

// etapa: sem_credenciais | precisa_login | telefone | codigo | senha | verificando | conectado | erro
const status = { etapa: 'precisa_login', erro: null, nome: null };
let client = null;
let pendente = null;

function aguardarEntrada(etapa) {
  status.etapa = etapa;
  return new Promise((resolve) => { pendente = { etapa, resolve }; });
}

function fornecerEntrada(etapa, valor) {
  if (pendente?.etapa !== etapa) return false;
  const { resolve } = pendente;
  pendente = null;
  status.etapa = 'verificando';
  status.erro = null;
  resolve(String(valor).trim());
  return true;
}

const ERROS = {
  PHONE_CODE_INVALID: 'Código incorreto. Tente de novo.',
  PHONE_CODE_EXPIRED: 'O código expirou. Clique em "Refazer login".',
  PASSWORD_HASH_INVALID: 'Senha incorreta. Tente de novo.',
  PHONE_NUMBER_INVALID: 'Número de telefone inválido. Use o formato +5511999999999.',
  API_ID_INVALID: 'api_id ou api_hash inválidos. Confira na aba Configuração.',
  FLOOD: 'Muitas tentativas. Espere alguns minutos e tente de novo.',
};
const traduzir = (msg = '') => Object.entries(ERROS).find(([k]) => msg.includes(k))?.[1] || msg;

async function iniciar(opcoes, telefone) {
  if (!opcoes.apiId || !opcoes.apiHash) {
    status.etapa = 'sem_credenciais';
    return null;
  }
  const sessao = fs.existsSync(ARQ_SESSAO_TG) ? fs.readFileSync(ARQ_SESSAO_TG, 'utf8').trim() : '';
  if (!sessao && !telefone) {
    status.etapa = 'precisa_login';
    return null;
  }
  status.etapa = 'verificando';
  status.erro = null;
  client = new TelegramClient(new StringSession(sessao), opcoes.apiId, opcoes.apiHash, {
    connectionRetries: 10,
    autoReconnect: true,
  });
  client.setLogLevel('error');
  try {
    await client.start({
      phoneNumber: async () => telefone || aguardarEntrada('telefone'),
      phoneCode: async () => aguardarEntrada('codigo'),
      password: async () => aguardarEntrada('senha'),
      onError: async (err) => {
        status.erro = traduzir(err.message);
        log('Telegram:', status.erro);
        return /API_ID_INVALID|PHONE_NUMBER_INVALID|FLOOD/.test(err.message); // true = desiste
      },
    });
  } catch (err) {
    status.etapa = 'erro';
    status.erro = traduzir(err.message);
    log('Login do Telegram falhou:', status.erro);
    return null;
  }
  fs.writeFileSync(ARQ_SESSAO_TG, client.session.save());
  const eu = await client.getMe().catch(() => null);
  status.nome = eu ? [eu.firstName, eu.lastName].filter(Boolean).join(' ') : null;
  status.etapa = 'conectado';
  status.erro = null;
  log(`Telegram conectado${status.nome ? ` como ${status.nome}` : ''}.`);
  return client;
}

async function sair() {
  try { await client?.disconnect(); } catch { /* ignora */ }
  client = null;
  pendente = null;
  try { fs.unlinkSync(ARQ_SESSAO_TG); } catch { /* ignora */ }
  Object.assign(status, { etapa: 'precisa_login', erro: null, nome: null });
}

async function listarChats() {
  const dialogos = await client.getDialogs({ limit: 60 });
  return dialogos.filter((d) => d.title).map((d) => ({ id: String(d.id), nome: d.title, usuario: d.entity?.username || '' }));
}

async function resolverChat(chat) {
  const texto = String(chat).trim().replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '');
  await client.getDialogs({ limit: 200 }); // carrega o cache para IDs numéricos
  const entidade = await client.getEntity(/^-?\d+$/.test(texto) ? Number(texto) : texto);
  const peerId = String(await client.getPeerId(entidade));
  return { entidade, peerId };
}

function ehAudio(msg) {
  if (!msg || !msg.media) return false;
  if (msg.voice || msg.audio) return true;
  return (msg.file?.mimeType || '').startsWith('audio/');
}

async function baixarAudio(msg) {
  const buffer = await client.downloadMedia(msg);
  const mime = msg.file?.mimeType || (msg.voice ? 'audio/ogg' : 'audio/mpeg');
  const ext = msg.file?.ext || (mime.includes('ogg') ? '.ogg' : '.mp3');
  return { buffer, mime, ext };
}

async function buscarUltimoAudio(entidade, limite = 30) {
  const msgs = await client.getMessages(entidade, { limit: limite });
  return msgs.find(ehAudio) || null;
}

// Todos os áudios recentes do chat, do mais novo para o mais antigo.
async function buscarAudios(entidade, limite = 40) {
  const msgs = await client.getMessages(entidade, { limit: limite });
  return msgs.filter(ehAudio);
}

// Um único ouvinte; quem decide se a mensagem é do chat certo é obterPeerId() (o chat pode mudar pelo painel).
function aoChegarAudio(obterPeerId, callback) {
  client.addEventHandler(async (evento) => {
    try {
      const msg = evento.message;
      const alvo = obterPeerId();
      if (alvo && String(msg.chatId) === alvo && ehAudio(msg)) await callback(msg);
    } catch (err) {
      log('Erro ao processar mensagem nova:', err.message);
    }
  }, new NewMessage({}));
}

module.exports = {
  status, iniciar, sair, fornecerEntrada, listarChats, resolverChat,
  ehAudio, baixarAudio, buscarUltimoAudio, buscarAudios, aoChegarAudio,
  conectado: () => status.etapa === 'conectado' && client !== null,
};
