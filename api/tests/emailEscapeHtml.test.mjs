/**
 * S-17: los datos de BD o del usuario que acaban en el HTML de un correo salen
 * escapados. Un proveedor llamado '<a href="http://x">pulsa</a>' ya no mete un
 * enlace en el correo que el ERP envía con nuestro remitente.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import { createRequire } from 'node:module';

const Tesseract = createRequire(import.meta.url)('tesseract.js');
Tesseract.createWorker = async () => ({
  recognize: async () => ({ data: { text: '' } }),
  terminate: async () => {},
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-escape-html';
process.env.INTERNAL_SYNC_SECRET = 'secreto-interno-de-las-pruebas-de-escape';

const { montarEscenario, tables, local, EMPRESA_NORTE } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { establecerTransporteEmail, escapeHtml } = await import('../lib/email.js');
const { requireAuth } = await import('../middleware/auth.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');
const { default: authRouter } = await import('../routes/auth.js');
const { default: informesRouter } = await import('../routes/informes.js');

const MALICIOSO = '<a href="http://x">pulsa</a>';
const ESCAPADO = '&lt;a href=&quot;http://x&quot;&gt;pulsa&lt;/a&gt;';
const ROL = 'Administracion';
const USUARIO = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };

const entornoPrevio = { SMTP_USER: process.env.SMTP_USER, APP_PUBLIC_URL: process.env.APP_PUBLIC_URL, PORT: process.env.PORT };
let enviados = [];
let db;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.log = { warn() {}, error() {}, info() {} };
  next();
});
app.use('/api', authRouter);
// El informe diario se llama a sí mismo con el token de sistema.
app.get('/api/cajas/top', requireAuth, (_req, res) => res.json({ objetivos: [], topUsuarios: [] }));
app.get('/api/agora/invoices/exceptions', requireAuth, (_req, res) => res.json({ rows: [] }));
app.use('/api/informes', requireAuth);
app.use('/api', informesRouter);
app.use('/api', (req, _res, next) => {
  req.user = USUARIO;
  next();
}, facturacionRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
process.env.PORT = String(servidor.address().port);
const base = `http://127.0.0.1:${process.env.PORT}`;

async function api(metodo, ruta, cuerpo, cabeceras = {}) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...cabeceras },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeEach(() => {
  enviados = [];
  establecerTransporteEmail({ sendMail: async (m) => { enviados.push(m); return {}; } });
  process.env.SMTP_USER = 'smtp@grupo.test';
  process.env.APP_PUBLIC_URL = 'https://erp.grupo.test';
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.sembrar(tables.locales, { ...local('000010', 'Local Norte', EMPRESA_NORTE), agoraCode: '1' });
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: USUARIO.email, Local: ['Local Norte'], Rol: ROL });
  db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: 'PERMISO#facturacion.editar' });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  establecerTransporteEmail(null);
  for (const [k, v] of Object.entries(entornoPrevio)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  servidor.closeAllConnections?.();
  servidor.close();
});

test('escapeHtml escapa los cinco caracteres con significado en HTML', () => {
  assert.equal(escapeHtml(MALICIOSO), ESCAPADO);
  assert.equal(escapeHtml(`O'Brien & <b>`), 'O&#39;Brien &amp; &lt;b&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(12.5), '12.5');
});

test('enviar factura por email: el nombre del proveedor sale escapado', async () => {
  db.sembrar(tables.facturas, {
    id_factura: 'F-1', tipo: 'OUT', emisor_id: EMPRESA_NORTE, estado: 'emitida',
    empresa_nombre: MALICIOSO, numero_factura: '<i>F-1</i>', total_factura: 10,
  });
  const r = await api('POST', '/api/facturacion/facturas/F-1/enviar-email', { destinatario: 'cliente@x.test' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(enviados.length, 1);
  assert.ok(enviados[0].html.includes(ESCAPADO));
  assert.ok(enviados[0].html.includes('&lt;i&gt;F-1&lt;/i&gt;'));
  assert.doesNotMatch(enviados[0].html, /<a href/);
});

test('enviar factura con mensaje propio: el texto del usuario se escapa y conserva los saltos de línea', async () => {
  db.sembrar(tables.facturas, { id_factura: 'F-1', tipo: 'OUT', emisor_id: EMPRESA_NORTE, estado: 'emitida', total_factura: 10 });
  const r = await api('POST', '/api/facturacion/facturas/F-1/enviar-email', {
    destinatario: 'cliente@x.test',
    cuerpo: `Hola,\n${MALICIOSO}`,
  });
  assert.equal(r.status, 200);
  assert.equal(enviados[0].html, `Hola,<br/>${ESCAPADO}`);
});

test('recordatorios de cobro: el nombre del cliente sale escapado', async () => {
  db.sembrar(tables.facturas, {
    id_factura: 'F-V', id_entrada: 'F-V', tipo: 'OUT', emisor_id: EMPRESA_NORTE, estado: 'vencida',
    empresa_nombre: MALICIOSO, empresa_email: 'cliente@x.test', saldo_pendiente: 50,
  });
  const r = await api('POST', '/api/facturacion/enviar-recordatorios');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.enviados, 1);
  assert.ok(enviados[0].html.includes(ESCAPADO));
  assert.doesNotMatch(enviados[0].html, /<a href/);
});

test('recuperar contraseña: el Nombre del usuario sale escapado y el enlace sigue funcionando', async () => {
  db.sembrar(tables.usuarios, { id_usuario: '000002', Email: 'ana@grupo.test', Nombre: MALICIOSO });
  const r = await api('POST', '/api/forgot-password', { email: 'ana@grupo.test' });
  assert.equal(r.status, 200);
  for (let i = 0; i < 20 && enviados.length === 0; i += 1) await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(enviados.length, 1);
  assert.ok(enviados[0].html.startsWith(`<p>${ESCAPADO},</p>`));
  assert.match(enviados[0].html, /<a href="https:\/\/erp\.grupo\.test\/reset-password\?token=[0-9a-f]+&amp;email=/);
});

test('informe diario: el nombre del destinatario y de sus locales salen escapados', async () => {
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.locales, { id_Locales: '000011', nombre: MALICIOSO, agoraCode: '2' });
  db.sembrar(tables.usuarios, { id_usuario: '000003', Email: 'jefe@grupo.test', Nombre: MALICIOSO, Rol: 'Administrador', Local: [MALICIOSO] });
  const r = await api('POST', '/api/informes/diario/enviar', { businessDay: '2026-10-10' }, {
    'x-internal-secret': process.env.INTERNAL_SYNC_SECRET,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const correo = enviados.find((m) => m.to === 'jefe@grupo.test');
  assert.ok(correo, JSON.stringify(r.body));
  assert.ok(correo.html.startsWith(`<p>Hola ${ESCAPADO},</p>`));
  assert.doesNotMatch(correo.html, /<a href/);
});
