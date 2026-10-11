/**
 * Token de sistema del informe diario.
 *
 * El job llama a `POST /api/informes/diario/enviar` con `x-internal-secret` y el
 * informe vuelve a llamar al propio API (`/api/cajas/top`, `/api/agora/invoices/exceptions`)
 * con un JWT de sistema de vida corta. Se firma uno por llamada: con uno solo
 * por envío, los destinatarios que se procesan pasada su caducidad daban 401.
 */

import test, { after, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-del-informe';
process.env.INTERNAL_SYNC_SECRET = 'secreto-interno-del-informe-largo';
process.env.SMTP_USER = 'smtp@grupo.test';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { establecerTransporteEmail } = await import('../lib/email.js');
const { requireAuth } = await import('../middleware/auth.js');
const { default: informesRouter } = await import('../routes/informes.js');

const ONCE_MIN = 11 * 60 * 1000;
const llamadas = [];
const enviados = [];
let alAtenderTop = () => {};

const app = express();
app.use(express.json());
app.use('/api', requireAuth);
app.get('/api/cajas/top', (req, res) => {
  llamadas.push({ ruta: 'top', auth: req.headers.authorization, sub: req.user?.sub });
  alAtenderTop();
  res.json({ objetivos: [{ nombre: 'Bar', workplaceId: '1', real: 100, comparativa: 90 }], topUsuarios: [] });
});
app.get('/api/agora/invoices/exceptions', (req, res) => {
  llamadas.push({ ruta: 'exceptions', auth: req.headers.authorization, sub: req.user?.sub });
  res.json({ rows: [] });
});
app.use('/api', informesRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
process.env.PORT = String(servidor.address().port);
const base = `http://127.0.0.1:${process.env.PORT}`;

establecerTransporteEmail({ sendMail: async (m) => { enviados.push(m); return {}; } });

after(() => {
  mock.timers.reset();
  establecerTransporteEmail(null);
  servidor.closeAllConnections?.();
  servidor.close();
});

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.instalar(docClient);
  db.sembrar(tables.locales, { id_Locales: '000001', nombre: 'Bar', agoraCode: '1' });
  for (const [id, email] of [['000001', 'uno@grupo.test'], ['000002', 'dos@grupo.test'], ['000003', 'tres@grupo.test']]) {
    db.sembrar(tables.usuarios, { id_usuario: id, Email: email, Nombre: email, Rol: 'Administrador', Local: ['Bar'] });
  }
  return db;
}

async function enviarInforme() {
  const res = await fetch(`${base}/api/informes/diario/enviar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SYNC_SECRET },
    body: JSON.stringify({ businessDay: '2026-10-10' }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('envío con varios destinatarios que dura más que la vida del token de sistema: ninguno da 401', async () => {
  montar();
  llamadas.length = 0;
  enviados.length = 0;
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // Cada destinatario «tarda» 11 min: más que los 10 min del token de sistema.
  alAtenderTop = () => mock.timers.tick(ONCE_MIN);
  try {
    const r = await enviarInforme();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.errores, []);
    assert.equal(r.body.enviados, 3);
    assert.equal(enviados.length, 3);
    const tops = llamadas.filter((l) => l.ruta === 'top');
    assert.equal(tops.length, 3);
    assert.ok(tops.every((l) => l.sub === 'sistema-informes'));
    assert.equal(new Set(tops.map((l) => l.auth)).size, 3, 'un token por destinatario');
  } finally {
    alAtenderTop = () => {};
    mock.timers.reset();
  }
});
