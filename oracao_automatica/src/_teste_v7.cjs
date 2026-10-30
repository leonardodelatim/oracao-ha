process.env.DADOS_DIR = '/tmp/b7/dados'; process.env.AUDIOS_DIR = '/tmp/b7/audios';
require('fs').rmSync('/tmp/b7/dados', { recursive: true, force: true });
const wa = require('./whatsapp');
wa.iniciar({}).then(() => console.log('iniciar ok')).catch((e) => console.log('ERRO iniciar', e.message));
let n = 0;
const t = setInterval(() => {
  n++;
  if (wa.status.qrSvg) { console.log('QR GERADO: conexao com WhatsApp funcionando na Baileys 7'); clearInterval(t); wa.encerrar(); setTimeout(() => process.exit(0), 500); }
  if (n > 40) { console.log('sem QR em 40s', JSON.stringify(wa.status)); process.exit(1); }
}, 1000);
