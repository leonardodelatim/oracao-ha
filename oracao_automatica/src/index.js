// Orquestra tudo: painel web, Telegram, WhatsApp, envio diário, sensor e notificações.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const tg = require('./telegram');
const wa = require('./whatsapp');
const ha = require('./ha');
const web = require('./web');

const { log } = util;
const CONFERIR_A_CADA_MIN = 5;

const opcoes = util.carregarOpcoes();
let chatAtual = null; // { entidade, peerId }
let fila = Promise.resolve();
let enviando = false;

const app = {
  opcoes,
  tg,
  wa,
  get enviando() { return enviando; },
  get chatPronto() { return Boolean(chatAtual); },
  config: () => util.carregarConfig(),
  estado: () => util.carregarEstado(),

  async loginTelegram(telefone) {
    const cfg = util.carregarConfig();
    cfg.telegram.telefone = telefone.trim();
    util.salvarConfig(cfg);
    iniciarTelegram(cfg.telegram.telefone);
  },
  async sairTelegram() {
    chatAtual = null;
    await tg.sair();
  },
  async escolherChat(id, nome) {
    const cfg = util.carregarConfig();
    cfg.telegram.chat = id;
    cfg.telegram.chatNome = nome;
    util.salvarConfig(cfg);
    await prepararChat();
  },
  salvarDestinos(meuNumero, destinos) {
    const cfg = util.carregarConfig();
    cfg.whatsapp.meuNumero = meuNumero;
    cfg.whatsapp.destinos = destinos;
    util.salvarConfig(cfg);
    atualizarSensor();
  },
  async marcarHojeComoEnviado() {
    const msg = chatAtual ? await tg.buscarUltimoAudio(chatAtual.entidade) : null;
    const e = util.carregarEstado();
    if (msg) e.ultimaMensagemId = Math.max(e.ultimaMensagemId || 0, msg.id);
    e.ultimoEnvioData = util.hoje();
    util.salvarEstado(e);
    atualizarSensor();
  },
  // modo: 'teste' (só o meu número) | 'todos' (reenviar para todos)
  async enviarUltimo(modo) {
    if (!tg.conectado() || !chatAtual) throw new Error('Telegram ou chat ainda não configurados.');
    if (!wa.status.conectado) throw new Error('WhatsApp não está conectado.');
    const cfg = util.carregarConfig();
    let destinos = cfg.whatsapp.destinos;
    if (modo === 'teste') {
      const jid = util.numeroParaJid(cfg.whatsapp.meuNumero);
      if (!jid) throw new Error('Cadastre o seu número em Destinos para usar o teste.');
      destinos = [{ nome: 'Meu número (teste)', id: jid }];
    }
    if (!destinos.length) throw new Error('Nenhum destino cadastrado.');
    const msg = await tg.buscarUltimoAudio(chatAtual.entidade);
    if (!msg) throw new Error('Não encontrei nenhum áudio recente no chat.');
    processar(msg, { forcar: true, destinos, registrar: modo !== 'teste' });
  },
};

function processar(msg, opts) {
  fila = fila.then(() => tratarAudio(msg, opts)).catch((e) => {
    log('Erro no envio:', e.message);
    ha.notificar(opcoes.servicoNotificacao, 'Oração Automática', `Erro ao enviar a oração: ${e.message}`);
    atualizarSensor('erro', { ultimo_erro: e.message });
  });
  return fila;
}

async function tratarAudio(msg, { forcar = false, destinos, registrar = true } = {}) {
  const cfg = util.carregarConfig();
  destinos = destinos || cfg.whatsapp.destinos;
  const estado = util.carregarEstado();
  const hoje = util.hoje();

  if (!forcar) {
    if (estado.ultimaMensagemId && msg.id <= estado.ultimaMensagemId) return;
    if (opcoes.apenasUmPorDia && estado.ultimoEnvioData === hoje) {
      log(`Áudio ${msg.id} ignorado: a oração de hoje já foi enviada.`);
      return;
    }
    if (!util.dentroDoHorario(opcoes)) {
      log(`Áudio ${msg.id} ignorado: fora do horário (${opcoes.horarioInicio}–${opcoes.horarioFim}).`);
      return;
    }
    if (!destinos.length) {
      log('Chegou áudio, mas não há destinos cadastrados.');
      return;
    }
  }

  enviando = true;
  atualizarSensor('enviando');
  try {
    log(`Oração encontrada (mensagem ${msg.id}). Baixando...`);
    const audio = await tg.baixarAudio(msg);
    log(`Baixado: ${(audio.buffer.length / 1024).toFixed(0)} KB (${audio.mime}).`);
    try {
      fs.writeFileSync(path.join(util.AUDIOS, `oracao-${hoje}-${msg.id}${audio.ext}`), audio.buffer);
    } catch (err) {
      log('Não consegui salvar cópia em /media:', err.message);
    }

    // Marca ANTES de enviar: se o add-on reiniciar no meio, ninguém recebe em dobro.
    if (registrar) {
      estado.ultimaMensagemId = Math.max(estado.ultimaMensagemId || 0, msg.id);
      estado.ultimoEnvioData = hoje;
      util.salvarEstado(estado);
    }

    log(`Enviando para ${destinos.length} destino(s)...`);
    const r = await wa.enviarAudio(audio, destinos, { intervalo: opcoes.intervalo, legenda: opcoes.legenda });
    log(`Concluído: ${r.ok.length} ok, ${r.falhas.length} falha(s).`);

    if (registrar) {
      const e = util.carregarEstado();
      e.historico = [...(e.historico || []), { data: hoje, hora: util.hora(), mensagem: msg.id, ...r }];
      util.salvarEstado(e);
    }
    const resumo = r.falhas.length
      ? `Enviada para ${r.ok.length} de ${destinos.length}. Falhou: ${r.falhas.join(', ')}.`
      : `Oração enviada para ${r.ok.length} destino(s). 🙏`;
    ha.notificar(opcoes.servicoNotificacao, registrar ? 'Oração enviada' : 'Teste da oração', resumo);
  } finally {
    enviando = false;
    atualizarSensor();
  }
}

async function prepararChat() {
  const cfg = util.carregarConfig();
  chatAtual = null;
  if (!tg.conectado() || !cfg.telegram.chat) return;
  try {
    chatAtual = await tg.resolverChat(cfg.telegram.chat);
    log(`Monitorando o chat: ${cfg.telegram.chatNome || cfg.telegram.chat}`);
    await conferir();
  } catch (err) {
    log('Não consegui abrir o chat escolhido:', err.message);
  }
}

// Rede de segurança: confere se a oração de hoje já foi enviada.
async function conferir() {
  atualizarSensor();
  if (!tg.conectado() || !chatAtual || !wa.status.conectado) return;
  try {
    const msg = await tg.buscarUltimoAudio(chatAtual.entidade);
    if (msg && util.hoje(new Date(msg.date * 1000)) === util.hoje()) await processar(msg);
  } catch (err) {
    log('Falha na conferência:', err.message);
  }
}

async function iniciarTelegram(telefone) {
  const client = await tg.iniciar(opcoes, telefone);
  atualizarSensor();
  if (!client) return;
  tg.aoChegarAudio(() => chatAtual?.peerId, (msg) => processar(msg));
  await prepararChat();
}

function atualizarSensor(estadoForcado, extra = {}) {
  const e = util.carregarEstado();
  const cfg = util.carregarConfig();
  const ultimo = e.historico?.[e.historico.length - 1];
  let estado = estadoForcado;
  if (!estado) {
    if (enviando) estado = 'enviando';
    else if (!tg.conectado() || !wa.status.conectado || !chatAtual) estado = 'configurar';
    else if (e.ultimoEnvioData === util.hoje()) estado = 'enviada_hoje';
    else estado = 'aguardando';
  }
  return ha.atualizarSensor(estado, {
    telegram: tg.status.etapa,
    whatsapp: wa.status.conectado ? 'conectado' : 'desconectado',
    chat: cfg.telegram.chatNome || null,
    destinos: cfg.whatsapp.destinos.length,
    ultimo_envio: e.ultimoEnvioData,
    ultimo_envio_hora: ultimo?.hora || null,
    ultimo_enviados: ultimo?.ok?.length ?? null,
    ultimo_falhas: ultimo?.falhas?.length ?? null,
    ...extra,
  });
}

async function principal() {
  log('Oração Automática iniciando...');
  web.iniciar(app);
  wa.iniciar({
    aoConectar: () => { atualizarSensor(); conferir(); },
    aoDesconectar: (motivo) => {
      atualizarSensor();
      ha.notificar(opcoes.servicoNotificacao, 'Oração Automática', `${motivo} Abra o painel "Oração" no Home Assistant.`);
    },
  });
  const cfg = util.carregarConfig();
  iniciarTelegram(cfg.telegram.telefone).catch((err) => log('Telegram:', err.message));
  setInterval(conferir, CONFERIR_A_CADA_MIN * 60 * 1000);
}

const desligar = () => { wa.encerrar(); process.exit(0); };
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);
process.on('unhandledRejection', (err) => log('Erro não tratado:', err?.message || err));

if (require.main === module) principal();
module.exports = { app, principal };
