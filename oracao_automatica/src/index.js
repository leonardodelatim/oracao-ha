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
    const dia = util.diaDoAudio(opcoes, msg.date);
    processar(msg, { destinos, registrar: modo !== 'teste', dia });
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

async function tratarAudio(msg, { destinos, registrar = true, dia } = {}) {
  const cfg = util.carregarConfig();
  destinos = destinos || cfg.whatsapp.destinos;
  const estado = util.carregarEstado();
  const hoje = dia || util.diaDoAudio(opcoes, msg.date);
  if (!destinos.length) {
    log('Áudio disponível, mas não há destinos cadastrados.');
    return;
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

    const mensagem = util.mensagemDoDia(opcoes, hoje);
    log(`Enviando para ${destinos.length} destino(s)${mensagem ? ` com a mensagem: "${mensagem}"` : ''}...`);
    const r = await wa.enviarAudio(audio, destinos, { intervalo: opcoes.intervalo, mensagem, legenda: opcoes.legenda });
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
    log(`Agenda: envio às ${opcoes.horarioEnvio}, aviso às ${opcoes.horarioAlerta} se o áudio não chegar, limite às ${opcoes.horarioLimite}. `
      + `Áudios postados a partir das ${opcoes.vesperaAPartirDe} valem para o dia seguinte.`);
    buscarJa = true;
    await ciclo();
  } catch (err) {
    log('Não consegui abrir o chat escolhido:', err.message);
  }
}

// ---------- Ciclo diário ----------
// A cada minuto: na janela de envio (horarioEnvio → horarioLimite), procura o áudio do dia
// e envia; se até horarioAlerta ele não apareceu, avisa você no WhatsApp; se o limite passar
// sem áudio, avisa de novo e encerra o dia.
let ultimaBusca = 0;
let buscarJa = true;
let cicloRodando = false;

async function audioDoDia(dia) {
  const agora = Date.now();
  if (!buscarJa && agora - ultimaBusca < CONFERIR_A_CADA_MIN * 60 * 1000) return null;
  buscarJa = false;
  ultimaBusca = agora;
  const audios = await tg.buscarAudios(chatAtual.entidade);
  return audios.find((m) => util.diaDoAudio(opcoes, m.date) === dia) || null;
}

async function avisarVoce(titulo, texto) {
  log(texto);
  ha.notificar(opcoes.servicoNotificacao, titulo, texto);
  const meu = util.numeroParaJid(util.carregarConfig().whatsapp.meuNumero);
  if (!meu) return;
  try {
    await wa.enviarTexto(meu, texto);
  } catch (err) {
    log('Não consegui enviar o aviso no WhatsApp:', err.message);
  }
}

async function ciclo() {
  atualizarSensor();
  if (cicloRodando || enviando || !tg.conectado() || !chatAtual || !wa.status.conectado) return;
  cicloRodando = true;
  try {
    const dia = util.hoje();
    const hora = util.hora();
    const e = util.carregarEstado();
    if (e.ultimoEnvioData === dia || e.semAudioData === dia) return;
    const fase = util.faseDoDia(opcoes);
    const quando = `${util.nomeDoDia(dia)}, ${util.dataBR(dia)}`;

    if (fase === 'depois') {
      // Só avisa se o dia estava sendo acompanhado (o aviso das 06:00 saiu). Ligar o add-on
      // depois do limite não gera aviso falso.
      e.semAudioData = dia;
      util.salvarEstado(e);
      if (e.alertaData !== dia) return;
      await avisarVoce('Oração não enviada',
        `⚠️ A oração de hoje (${quando}) não foi disponibilizada no Telegram até as ${opcoes.horarioLimite}. Nada foi enviado hoje.`);
      return;
    }
    if (fase !== 'janela') return;

    const msg = await audioDoDia(dia);
    if (msg) {
      const atrasada = e.alertaData === dia;
      await processar(msg, { registrar: true, dia });
      if (atrasada) {
        await avisarVoce('Oração enviada com atraso',
          `✅ A oração de hoje (${quando}) chegou às ${hora} e já foi enviada para os destinos.`);
      }
      return;
    }
    if (hora >= opcoes.horarioAlerta && e.alertaData !== dia) {
      e.alertaData = dia;
      util.salvarEstado(e);
      await avisarVoce('Oração ainda não disponível',
        `⚠️ A oração de hoje (${quando}) ainda não foi disponibilizada no Telegram até as ${opcoes.horarioAlerta}. `
        + `Vou continuar conferindo até as ${opcoes.horarioLimite} e envio automaticamente se ela chegar.`);
    }
  } catch (err) {
    log('Falha no ciclo diário:', err.message);
  } finally {
    cicloRodando = false;
    atualizarSensor();
  }
}

async function iniciarTelegram(telefone) {
  const client = await tg.iniciar(opcoes, telefone);
  atualizarSensor();
  if (!client) return;
  tg.aoChegarAudio(() => chatAtual?.peerId, (msg) => {
    log(`Áudio novo no chat (mensagem ${msg.id}), referente a ${util.dataBR(util.diaDoAudio(opcoes, msg.date))}.`);
    buscarJa = true;
    return ciclo();
  });
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
    else if (e.semAudioData === util.hoje()) estado = 'sem_audio';
    else if (util.faseDoDia(opcoes) === 'janela') estado = 'aguardando_audio';
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
    aoConectar: () => { atualizarSensor(); ciclo(); },
    aoDesconectar: (motivo) => {
      atualizarSensor();
      ha.notificar(opcoes.servicoNotificacao, 'Oração Automática', `${motivo} Abra o painel "Oração" no Home Assistant.`);
    },
  });
  const cfg = util.carregarConfig();
  iniciarTelegram(cfg.telegram.telefone).catch((err) => log('Telegram:', err.message));
  setInterval(ciclo, 60 * 1000);
}

const desligar = () => { wa.encerrar(); process.exit(0); };
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);
process.on('unhandledRejection', (err) => log('Erro não tratado:', err?.message || err));

if (require.main === module) principal();
module.exports = { app, principal };
