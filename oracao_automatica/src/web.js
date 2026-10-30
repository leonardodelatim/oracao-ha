// Painel do add-on (aparece no menu lateral do Home Assistant via Ingress) + API para automações.
const http = require('http');
const util = require('./util');

const PORTA = Number(process.env.PORTA || 8099);
let app = null;
let gruposCache = [];

// ---------- utilidades HTTP ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function redeInterna(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || /^172\.30\.3[23]\./.test(ip);
}

function lerCorpo(req) {
  return new Promise((resolve) => {
    let dados = '';
    req.on('data', (c) => { dados += c; if (dados.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(dados)));
  });
}

const base = (req) => (req.headers['x-ingress-path'] || '').replace(/\/$/, '');
function voltar(req, res, msg, pagina = '') {
  const q = msg ? `?msg=${encodeURIComponent(msg)}` : '';
  res.writeHead(303, { Location: `${base(req)}/${pagina}${q}` });
  res.end();
}
function enviar(res, codigo, tipo, corpo) {
  res.writeHead(codigo, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(corpo);
}
const json = (res, obj, codigo = 200) => enviar(res, codigo, 'application/json; charset=utf-8', JSON.stringify(obj));

// ---------- layout ----------
const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--txt:#1c1f24;--sub:#5f6672;--borda:#e1e4e8;--pri:#2b6cb0;--ok:#2f855a;--aviso:#b7791f;--erro:#c53030}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1c2026;--txt:#e7e9ec;--sub:#9aa3ad;--borda:#2c323a;--pri:#63a4e8;--ok:#5cc28c;--aviso:#e0b252;--erro:#f07373}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0 16px}h2{font-size:16px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--borda);border-radius:12px;padding:16px;margin-bottom:14px}
.linha{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid var(--borda)}.linha:last-child{border:0}
.sub{color:var(--sub);font-size:13px}.ok{color:var(--ok)}.aviso{color:var(--aviso)}.erro{color:var(--erro)}
.selo{font-size:13px;font-weight:600}
input[type=text],input[type=tel],input[type=password]{width:100%;padding:10px;border:1px solid var(--borda);border-radius:8px;background:var(--bg);color:var(--txt);font-size:15px;margin:4px 0 10px}
button,.btn{display:inline-block;border:0;border-radius:8px;padding:10px 14px;font-size:14px;font-weight:600;cursor:pointer;background:var(--pri);color:#fff;text-decoration:none}
.sec{background:transparent;color:var(--pri);border:1px solid var(--borda)}.perigo{background:transparent;color:var(--erro);border:1px solid var(--borda)}
.acoes{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}form.inline{display:inline}
.msg{background:var(--card);border-left:4px solid var(--pri);padding:10px 14px;border-radius:8px;margin-bottom:14px}
.qr{background:#fff;padding:12px;border-radius:12px;width:260px;max-width:100%;margin:8px auto;display:block}
label.item{display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--borda)}label.item:last-child{border:0}
ol{padding-left:20px;margin:6px 0}table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 4px;border-bottom:1px solid var(--borda)}
`;

function pagina(req, titulo, corpo, { atualizar = false } = {}) {
  const msg = new URL(req.url, 'http://x').searchParams.get('msg');
  const script = atualizar ? `<script>
let assinatura=null;
setInterval(async()=>{try{
  const r=await fetch('api/status');const s=await r.json();
  const a=[s.telegram.etapa,s.whatsapp.conectado,s.chat_pronto,s.enviando].join('|');
  if(assinatura===null)assinatura=a;
  else if(a!==assinatura&&!document.querySelector('input:focus'))location.reload();
  const q=document.getElementById('qr');if(q)q.src='qr.svg?t='+Date.now();
}catch(e){}},4000);
</script>` : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<base href="${esc(base(req))}/"><title>${esc(titulo)}</title><style>${CSS}</style></head>
<body><main>${msg ? `<div class="msg">${esc(msg)}</div>` : ''}${corpo}</main>${script}</body></html>`;
}

const selo = (ok, txtOk, txtNao, classeNao = 'aviso') => `<span class="selo ${ok ? 'ok' : classeNao}">${ok ? '● ' + txtOk : '● ' + txtNao}</span>`;

// ---------- seções do painel ----------
function secaoTelegram() {
  const s = app.tg.status;
  const erro = s.erro ? `<p class="erro">${esc(s.erro)}</p>` : '';
  const cfg = app.config();
  switch (s.etapa) {
    case 'sem_credenciais':
      return `<div class="card"><h2>1. Telegram ${selo(false, '', 'falta configurar')}</h2>
<p>Abra a aba <b>Configuração</b> deste add-on e preencha o <b>api_id</b> e o <b>api_hash</b> (pegue em <b>my.telegram.org ▸ API development tools</b>). Depois clique em <b>Reiniciar</b>.</p></div>`;
    case 'precisa_login':
    case 'telefone':
    case 'erro':
      return `<div class="card"><h2>1. Telegram ${selo(false, '', 'entrar na conta')}</h2>${erro}
<form method="post" action="telegram/telefone"><label>Seu número do Telegram, com +55 e DDD</label>
<input type="tel" name="telefone" placeholder="+5511999999999" value="${esc(cfg.telegram.telefone)}" required>
<button>Enviar código</button></form></div>`;
    case 'codigo':
      return `<div class="card"><h2>1. Telegram ${selo(false, '', 'aguardando código')}</h2>${erro}
<form method="post" action="telegram/codigo"><label>Código que chegou no seu app do Telegram</label>
<input type="text" name="codigo" inputmode="numeric" autocomplete="one-time-code" required autofocus>
<button>Confirmar</button></form><form method="post" action="telegram/sair" style="margin-top:10px"><button class="sec">Refazer login</button></form></div>`;
    case 'senha':
      return `<div class="card"><h2>1. Telegram ${selo(false, '', 'verificação em duas etapas')}</h2>${erro}
<form method="post" action="telegram/senha"><label>Senha da verificação em duas etapas do Telegram</label>
<input type="password" name="senha" required autofocus><button>Confirmar</button></form><form method="post" action="telegram/sair" style="margin-top:10px"><button class="sec">Refazer login</button></form></div>`;
    case 'verificando':
      return `<div class="card"><h2>1. Telegram ${selo(false, '', 'conectando...')}</h2>${erro}<p class="sub">Aguarde alguns segundos.</p></div>`;
    default: {
      const chat = cfg.telegram.chatNome
        ? `<div class="linha"><span>Chat da oração</span><span>${esc(cfg.telegram.chatNome)} · <a href="chats">trocar</a></span></div>`
        : `<p class="aviso">Falta escolher o chat onde a oração chega.</p><a class="btn" href="chats">Escolher chat</a>`;
      return `<div class="card"><h2>1. Telegram ${selo(true, 'conectado', '')}</h2>
<div class="linha"><span>Conta</span><span>${esc(s.nome || '—')}</span></div>${chat}</div>`;
    }
  }
}

function secaoWhatsApp() {
  const s = app.wa.status;
  if (s.conectado) {
    return `<div class="card"><h2>2. WhatsApp ${selo(true, 'conectado', '')}</h2>
<div class="linha"><span>Número</span><span>${esc(s.numero ? '+' + s.numero : '—')}</span></div></div>`;
  }
  const qr = s.qrSvg
    ? `<img id="qr" class="qr" src="qr.svg" alt="QR Code do WhatsApp">
<ol><li>No celular, abra o <b>WhatsApp</b>.</li><li>Toque em <b>⋮ ▸ Aparelhos conectados ▸ Conectar um aparelho</b>.</li><li>Aponte a câmera para este QR Code.</li></ol>`
    : '<p class="sub">Gerando QR Code...</p>';
  return `<div class="card"><h2>2. WhatsApp ${selo(false, '', 'conectar')}</h2>${s.erro ? `<p class="erro">${esc(s.erro)}</p>` : ''}${qr}</div>`;
}

function secaoDestinos() {
  const cfg = app.config();
  const d = cfg.whatsapp.destinos;
  const grupos = d.filter((x) => x.id.endsWith('@g.us')).length;
  return `<div class="card"><h2>3. Destinos ${selo(d.length > 0, `${d.length} cadastrado(s)`, 'nenhum ainda')}</h2>
<div class="linha"><span>Grupos</span><span>${grupos}</span></div>
<div class="linha"><span>Pessoas</span><span>${d.length - grupos}</span></div>
<div class="linha"><span>Seu número (teste)</span><span>${esc(cfg.whatsapp.meuNumero || '—')}</span></div>
<div class="acoes"><a class="btn" href="destinos">Gerenciar destinos</a></div></div>`;
}

function secaoStatus() {
  const e = app.estado();
  const pronto = app.tg.conectado() && app.wa.status.conectado && app.chatPronto && app.config().whatsapp.destinos.length;
  const hoje = e.ultimoEnvioData === util.hoje();
  const op = app.opcoes;
  const fase = util.faseDoDia(op);
  const situacao = app.enviando
    ? '<span class="selo aviso">● enviando agora...</span>'
    : !pronto ? '<span class="selo aviso">● termine a configuração acima</span>'
      : hoje ? '<span class="selo ok">● oração de hoje enviada</span>'
        : e.semAudioData === util.hoje() && e.alertaData === util.hoje() ? `<span class="selo erro">● a oração de hoje não chegou até as ${esc(op.horarioLimite)}</span>`
          : e.semAudioData === util.hoje() ? `<span class="selo ok">● próximo envio amanhã às ${esc(op.horarioEnvio)}</span>`
          : fase === 'janela'
            ? `<span class="selo aviso">● aguardando o áudio de hoje no Telegram${e.alertaData === util.hoje() ? ' (aviso já enviado)' : ` (aviso às ${esc(op.horarioAlerta)})`}</span>`
            : `<span class="selo ok">● próximo envio às ${esc(op.horarioEnvio)}</span>`;
  const hist = (e.historico || []).slice(-7).reverse()
    .map((h) => `<tr><td>${esc(util.dataBR(h.data))} ${esc(h.hora)}</td><td class="ok">${h.ok.length} ok</td><td class="${h.falhas.length ? 'erro' : 'sub'}">${h.falhas.length ? esc(h.falhas.join(', ')) : '—'}</td></tr>`)
    .join('');
  const desab = pronto && !app.enviando ? '' : 'disabled';
  // O teste só precisa do Telegram, do WhatsApp, do chat e do seu número (não depende dos destinos).
  const prontoTeste = app.tg.conectado() && app.wa.status.conectado && app.chatPronto && app.config().whatsapp.meuNumero;
  const desabTeste = prontoTeste && !app.enviando ? '' : 'disabled';
  return `<div class="card"><h2>Situação</h2><p>${situacao}</p>
<p class="sub">Envio diário às ${esc(op.horarioEnvio)} · aviso às ${esc(op.horarioAlerta)} se o áudio não chegar · limite ${esc(op.horarioLimite)} · áudios postados a partir das ${esc(op.vesperaAPartirDe)} valem para o dia seguinte.</p>
<div class="acoes">
<form class="inline" method="post" action="acao/teste"><button ${desabTeste}>Testar (só para mim)</button></form>
<form class="inline" method="post" action="acao/reenviar" onsubmit="return confirm('Enviar o último áudio para TODOS os destinos agora?')"><button class="sec" ${desab}>Enviar para todos agora</button></form>
${(e.historico || []).slice(-1)[0]?.falhas?.length ? `<form class="inline" method="post" action="acao/reenviar-falhas" onsubmit="return confirm('Reenviar o último áudio só para quem não recebeu?')"><button class="sec" ${desab}>Reenviar para quem falhou (${(e.historico || []).slice(-1)[0].falhas.length})</button></form>` : ''}
${!hoje && pronto ? `<form class="inline" method="post" action="acao/marcar-hoje"><button class="sec">Já enviei hoje à mão</button></form>` : ''}
</div>
${hist ? `<h2 style="margin-top:16px">Últimos envios</h2><table>${hist}</table>` : ''}</div>`;
}

function painel(req) {
  const desconectar = `<div class="card"><h2>Contas</h2><div class="acoes">
${app.tg.conectado() ? `<form class="inline" method="post" action="telegram/sair" onsubmit="return confirm('Sair do Telegram neste add-on?')"><button class="perigo">Sair do Telegram</button></form>` : ''}
${app.wa.status.conectado ? `<form class="inline" method="post" action="whatsapp/sair" onsubmit="return confirm('Desconectar o WhatsApp deste add-on?')"><button class="perigo">Desconectar WhatsApp</button></form>` : ''}
</div><p class="sub">Áudios ficam salvos em <b>Mídia ▸ oracao</b>.</p></div>`;
  return pagina(req, 'Oração Automática', `<h1>🙏 Oração Automática</h1>${secaoStatus()}${secaoTelegram()}${secaoWhatsApp()}${secaoDestinos()}${desconectar}`, { atualizar: true });
}

async function paginaChats(req) {
  if (!app.tg.conectado()) return pagina(req, 'Chats', '<p>Entre no Telegram primeiro.</p><a class="btn sec" href="./">Voltar</a>');
  const chats = await app.tg.listarChats();
  const atual = app.config().telegram.chat;
  const itens = chats.map((c) => `<label class="item"><input type="radio" name="chat" value="${esc(c.usuario || c.id)}|${esc(c.nome)}" ${[c.usuario, c.id].includes(atual) ? 'checked' : ''} required>
<span>${esc(c.nome)}${c.usuario ? ` <span class="sub">@${esc(c.usuario)}</span>` : ''}</span></label>`).join('');
  return pagina(req, 'Escolher chat', `<h1>Em qual chat a oração chega?</h1>
<form method="post" action="chats"><div class="card">${itens || '<p>Nenhum chat encontrado.</p>'}</div>
<div class="acoes"><button>Salvar</button><a class="btn sec" href="./">Cancelar</a></div></form>`);
}

async function paginaDestinos(req) {
  const cfg = app.config();
  const escolhidos = new Set(cfg.whatsapp.destinos.map((d) => d.id));
  let blocoGrupos;
  if (app.wa.status.conectado) {
    try {
      gruposCache = await app.wa.listarGrupos();
      blocoGrupos = gruposCache.map((g) => `<label class="item"><input type="checkbox" name="grupo" value="${esc(g.id)}" ${escolhidos.has(g.id) ? 'checked' : ''}><span>${esc(g.nome)}</span></label>`).join('') || '<p class="sub">Você não está em nenhum grupo.</p>';
    } catch (err) {
      blocoGrupos = `<p class="erro">Não consegui listar os grupos: ${esc(err.message)}</p>`;
    }
  } else {
    blocoGrupos = '<p class="aviso">Conecte o WhatsApp para ver seus grupos.</p>';
  }
  const pessoas = cfg.whatsapp.destinos.filter((d) => d.id.endsWith('@s.whatsapp.net'));
  const listaPessoas = pessoas.map((p) => `<div class="linha"><span>${esc(p.nome)} <span class="sub">+${esc(p.id.split('@')[0])}</span></span>
<form class="inline" method="post" action="destinos/remover"><input type="hidden" name="id" value="${esc(p.id)}"><button class="perigo">Remover</button></form></div>`).join('') || '<p class="sub">Nenhuma pessoa ainda.</p>';

  return pagina(req, 'Destinos', `<h1>Destinos</h1>
<form method="post" action="destinos">
<div class="card"><h2>Seu número</h2><p class="sub">Recebe o envio de teste. Não entra no envio diário.</p>
<input type="tel" name="meu_numero" placeholder="11 98765-4321" value="${esc(cfg.whatsapp.meuNumero)}"></div>
<div class="card"><h2>Grupos que recebem a oração</h2>${blocoGrupos}</div>
<div class="acoes" style="margin-bottom:14px"><button>Salvar grupos e número</button><a class="btn sec" href="./">Voltar</a></div>
</form>
<div class="card"><h2>Pessoas que recebem a oração</h2>${listaPessoas}
<form method="post" action="destinos/pessoa" style="margin-top:12px">
<label>Nome</label><input type="text" name="nome" required>
<label>Número com DDD</label><input type="tel" name="numero" placeholder="11 98765-4321" required>
<button>Adicionar pessoa</button></form></div>`);
}

// ---------- rotas ----------
async function rotear(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  const rota = `${req.method} ${pathname.replace(/\/+$/, '') || '/'}`;
  const corpo = req.method === 'POST' ? await lerCorpo(req) : null;

  switch (rota) {
    case 'GET /':
      return enviar(res, 200, 'text/html; charset=utf-8', painel(req));
    case 'GET /qr.svg':
      return app.wa.status.qrSvg ? enviar(res, 200, 'image/svg+xml', app.wa.status.qrSvg) : enviar(res, 404, 'text/plain', '');
    case 'GET /chats':
      return enviar(res, 200, 'text/html; charset=utf-8', await paginaChats(req));
    case 'GET /destinos':
      return enviar(res, 200, 'text/html; charset=utf-8', await paginaDestinos(req));

    case 'POST /telegram/telefone': {
      const tel = corpo.get('telefone') || '';
      if (!app.tg.fornecerEntrada('telefone', tel)) await app.loginTelegram(tel);
      await util.esperar(1500);
      return voltar(req, res);
    }
    case 'POST /telegram/codigo':
      app.tg.fornecerEntrada('codigo', corpo.get('codigo') || '');
      await util.esperar(2000);
      return voltar(req, res);
    case 'POST /telegram/senha':
      app.tg.fornecerEntrada('senha', corpo.get('senha') || '');
      await util.esperar(2000);
      return voltar(req, res);
    case 'POST /telegram/sair':
      await app.sairTelegram();
      return voltar(req, res, 'Você saiu do Telegram neste add-on.');
    case 'POST /whatsapp/sair':
      await app.wa.sair();
      return voltar(req, res, 'WhatsApp desconectado. Um novo QR Code vai aparecer.');

    case 'POST /chats': {
      const [id, ...nome] = (corpo.get('chat') || '').split('|');
      if (!id) return voltar(req, res, 'Escolha um chat.', 'chats');
      await app.escolherChat(id, nome.join('|'));
      return voltar(req, res, `Chat salvo: ${nome.join('|')}`);
    }
    case 'POST /destinos': {
      const cfg = app.config();
      const marcados = new Set(corpo.getAll('grupo'));
      const grupos = gruposCache.filter((g) => marcados.has(g.id));
      const pessoas = cfg.whatsapp.destinos.filter((d) => d.id.endsWith('@s.whatsapp.net'));
      app.salvarDestinos((corpo.get('meu_numero') || '').trim(), [...grupos, ...pessoas]);
      return voltar(req, res, `Salvo: ${grupos.length} grupo(s) e ${pessoas.length} pessoa(s).`, 'destinos');
    }
    case 'POST /destinos/pessoa': {
      const jid = util.numeroParaJid(corpo.get('numero') || '');
      const nome = (corpo.get('nome') || '').trim();
      if (!jid || !nome) return voltar(req, res, 'Preencha nome e número.', 'destinos');
      const cfg = app.config();
      const destinos = cfg.whatsapp.destinos.filter((d) => d.id !== jid);
      destinos.push({ nome, id: jid });
      app.salvarDestinos(cfg.whatsapp.meuNumero, destinos);
      return voltar(req, res, `${nome} adicionado(a).`, 'destinos');
    }
    case 'POST /destinos/remover': {
      const cfg = app.config();
      app.salvarDestinos(cfg.whatsapp.meuNumero, cfg.whatsapp.destinos.filter((d) => d.id !== corpo.get('id')));
      return voltar(req, res, 'Removido.', 'destinos');
    }

    case 'POST /acao/teste':
    case 'POST /api/teste':
    case 'POST /acao/reenviar':
    case 'POST /api/reenviar':
    case 'POST /acao/reenviar-falhas':
    case 'POST /api/reenviar-falhas': {
      const modo = rota.endsWith('teste') ? 'teste' : rota.endsWith('falhas') ? 'falhas' : 'todos';
      try {
        await app.enviarUltimo(modo);
        const m = modo === 'teste' ? 'Teste iniciado: o áudio vai chegar no seu número em instantes.' : modo === 'falhas' ? 'Reenvio iniciado para quem não recebeu.' : 'Envio para todos iniciado.';
        return rota.includes('/api/') ? json(res, { ok: true, mensagem: m }) : voltar(req, res, m);
      } catch (err) {
        return rota.includes('/api/') ? json(res, { ok: false, erro: err.message }, 400) : voltar(req, res, err.message);
      }
    }
    case 'POST /acao/marcar-hoje':
      await app.marcarHojeComoEnviado();
      return voltar(req, res, 'Certo, hoje não será enviado de novo.');

    case 'GET /api/status': {
      const e = app.estado();
      return json(res, {
        telegram: { etapa: app.tg.status.etapa, nome: app.tg.status.nome },
        whatsapp: { conectado: app.wa.status.conectado, numero: app.wa.status.numero },
        chat_pronto: app.chatPronto,
        enviando: app.enviando,
        destinos: app.config().whatsapp.destinos.length,
        ultimo_envio: e.ultimoEnvioData,
      });
    }
    default:
      return enviar(res, 404, 'text/plain; charset=utf-8', 'Página não encontrada');
  }
}

function iniciar(aplicacao) {
  app = aplicacao;
  http.createServer(async (req, res) => {
    if (!redeInterna(req)) return enviar(res, 403, 'text/plain', 'Acesso negado');
    try {
      await rotear(req, res);
    } catch (err) {
      util.log('Erro no painel:', err.message);
      if (!res.headersSent) enviar(res, 500, 'text/plain; charset=utf-8', `Erro: ${err.message}`);
    }
  }).listen(PORTA, '0.0.0.0', () => util.log(`Painel pronto na porta ${PORTA}.`));
}

module.exports = { iniciar };
