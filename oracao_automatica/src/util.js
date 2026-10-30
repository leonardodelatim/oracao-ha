// Apoio: caminhos, opções do add-on, configuração salva pelo painel, estado, horários e log.
const fs = require('fs');
const path = require('path');

const DADOS = process.env.DADOS_DIR || '/data';
const AUDIOS = process.env.AUDIOS_DIR || '/media/oracao';
const FUSO = process.env.TZ || 'America/Sao_Paulo';

const ARQ_OPCOES = path.join(DADOS, 'options.json'); // escrito pelo Home Assistant
const ARQ_CONFIG = path.join(DADOS, 'config.json'); // escrito pelo painel (chat e destinos)
const ARQ_ESTADO = path.join(DADOS, 'estado.json');
const ARQ_SESSAO_TG = path.join(DADOS, 'sessao-telegram.txt');
const PASTA_SESSAO_WA = path.join(DADOS, 'sessao-whatsapp');

for (const p of [DADOS, AUDIOS]) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* ignora */ }
}

function partes(data = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(data).map((x) => [x.type, x.value]));
}
const hoje = (d) => { const p = partes(d); return `${p.year}-${p.month}-${p.day}`; };
const hora = (d) => { const p = partes(d); return `${p.hour}:${p.minute}`; };
// 0 = domingo ... 6 = sábado, no fuso do Brasil
const diaDaSemana = (d = new Date()) => (
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: FUSO, weekday: 'short' }).format(d),
  )
);
const mensagemDoDia = (op, d = new Date()) => (op.mensagens || [])[diaDaSemana(d)] || '';
const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

function log(...args) {
  const p = partes();
  console.log(`[${p.day}/${p.month} ${p.hour}:${p.minute}:${p.second}]`, ...args);
}

function lerJson(arq, padrao) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}
function gravarJson(arq, obj) {
  fs.writeFileSync(arq, JSON.stringify(obj, null, 2));
}

const MENSAGENS_PADRAO = {
  segunda: 'Bom dia, uma segunda-feira e uma semana abençoada para todos nós! 🙏',
  terca: 'Bom dia, uma terça-feira abençoada para todos nós! 🙏',
  quarta: 'Bom dia, uma quarta-feira abençoada para todos nós! 🙏',
  quinta: 'Bom dia, uma quinta-feira abençoada para todos nós! 🙏',
  sexta: 'Bom dia, uma sexta-feira abençoada e um ótimo fim de semana para todos nós! 🙏',
  sabado: 'Bom dia, um sábado abençoado para todos nós! 🙏',
  domingo: 'Bom dia, um domingo abençoado para todos nós! 🙏',
};

function carregarOpcoes() {
  const o = lerJson(ARQ_OPCOES, {});
  const min = Number(o.intervalo_min_segundos ?? 20);
  const max = Math.max(min, Number(o.intervalo_max_segundos ?? 60));
  return {
    apiId: Number(o.api_id || 0),
    apiHash: o.api_hash || '',
    horarioInicio: o.horario_inicio || '00:00',
    horarioFim: o.horario_fim || '23:59',
    apenasUmPorDia: o.apenas_um_por_dia !== false,
    intervalo: { min, max },
    legenda: (o.legenda || '').trim(),
    // Mensagem enviada ANTES do áudio, uma por dia da semana (0 = domingo).
    // Se a opção ainda não existe (instalação anterior à 1.1.0), usa o texto padrão;
    // se você apagar o texto, nada é enviado antes do áudio naquele dia.
    mensagens: ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']
      .map((dia) => (o[`mensagem_${dia}`] ?? MENSAGENS_PADRAO[dia] ?? '').trim()),
    servicoNotificacao: (o.servico_notificacao || '').trim().replace(/^notify\./, ''),
  };
}

function carregarConfig() {
  const c = lerJson(ARQ_CONFIG, {});
  return {
    telegram: { telefone: '', chat: '', chatNome: '', ...(c.telegram || {}) },
    whatsapp: { meuNumero: '', destinos: [], ...(c.whatsapp || {}) },
  };
}
const salvarConfig = (c) => gravarJson(ARQ_CONFIG, c);

function carregarEstado() {
  return { ultimaMensagemId: null, ultimoEnvioData: null, historico: [], ...lerJson(ARQ_ESTADO, {}) };
}
function salvarEstado(e) {
  e.historico = (e.historico || []).slice(-60);
  gravarJson(ARQ_ESTADO, e);
}

function dentroDoHorario(op, d = new Date()) {
  const h = hora(d);
  return op.horarioInicio <= op.horarioFim
    ? h >= op.horarioInicio && h <= op.horarioFim
    : h >= op.horarioInicio || h <= op.horarioFim; // janela que passa da meia-noite
}

// "11 98765-4321" → "5511987654321@s.whatsapp.net"
function numeroParaJid(numero) {
  let d = String(numero).replace(/\D/g, '');
  if (!d) return null;
  if (!d.startsWith('55') || d.length <= 11) d = `55${d}`;
  return `${d}@s.whatsapp.net`;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const aleatorio = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

module.exports = {
  DADOS, AUDIOS, ARQ_SESSAO_TG, PASTA_SESSAO_WA,
  log, hoje, hora, dataBR, carregarOpcoes, carregarConfig, salvarConfig,
  carregarEstado, salvarEstado, dentroDoHorario, numeroParaJid, esperar, aleatorio,
  diaDaSemana, mensagemDoDia,
};
