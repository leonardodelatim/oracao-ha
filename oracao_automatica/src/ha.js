// Conversa com o Home Assistant pela API do Supervisor: sensor de status e notificações.
const { log } = require('./util');

const TOKEN = process.env.SUPERVISOR_TOKEN;
const BASE = process.env.HA_API_URL || 'http://supervisor/core/api';
const SENSOR = 'sensor.oracao_automatica';

async function chamar(metodo, caminho, corpo) {
  if (!TOKEN) return null;
  try {
    const r = await fetch(BASE + caminho, {
      method: metodo,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!r.ok) log(`Home Assistant respondeu ${r.status} em ${caminho}`);
    return r.ok;
  } catch (err) {
    log('Falha ao falar com o Home Assistant:', err.message);
    return null;
  }
}

function atualizarSensor(estado, atributos = {}) {
  return chamar('POST', `/states/${SENSOR}`, {
    state: estado,
    attributes: { friendly_name: 'Oração Automática', icon: 'mdi:hands-pray', ...atributos },
  });
}

function notificar(servico, titulo, mensagem) {
  if (!servico) return null;
  return chamar('POST', `/services/notify/${servico}`, { title: titulo, message: mensagem });
}

module.exports = { atualizarSensor, notificar };
