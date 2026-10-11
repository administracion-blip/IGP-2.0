/**
 * S-19: errores con un mensaje útil para el usuario que antes salían como 500
 * genérico (destinatario rechazado por el SMTP, configuración de remesas).
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-mensajes-s19';

const { montarEscenario, tables, local, EMPRESA_NORTE } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { establecerTransporteEmail, errorDestinatarioRechazado, MENSAJE_DESTINATARIO_RECHAZADO } = await import('../lib/email.js');
const { errorPublico } = await import('../lib/http/responderError.js');
const { generarFicheroRemesa } = await import('../lib/remesas/index.js');
const { default: facturacionRouter } = await import('../routes/facturacion.js');

const ROL = 'Administracion';
const USUARIO = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };
const smtpPrevio = process.env.SMTP_USER;
let fallo = null;

const app = express();
app.use(express.json());
app.use('/api', (req, _res, next) => {
  req.user = USUARIO;
  next();
}, facturacionRouter);
const servidor = http.createServer(app);
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const base = `http://127.0.0.1:${servidor.address().port}`;

async function enviar() {
  const res = await fetch(`${base}/api/facturacion/facturas/F-1/enviar-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinatario: 'nadie@x.test' }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeEach(() => {
  fallo = null;
  establecerTransporteEmail({ sendMail: async () => { if (fallo) throw fallo; return {}; } });
  process.env.SMTP_USER = 'smtp@grupo.test';
  const db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.sembrar(tables.locales, local('000010', 'Local Norte', EMPRESA_NORTE));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: USUARIO.email, Local: ['Local Norte'], Rol: ROL });
  db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: 'PERMISO#facturacion.editar' });
  db.sembrar(tables.facturas, { id_factura: 'F-1', tipo: 'OUT', emisor_id: EMPRESA_NORTE, estado: 'emitida', total_factura: 10 });
  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  establecerTransporteEmail(null);
  if (smtpPrevio === undefined) delete process.env.SMTP_USER;
  else process.env.SMTP_USER = smtpPrevio;
  servidor.closeAllConnections?.();
  servidor.close();
});

function errorSmtp(campos) {
  return Object.assign(new Error('Can\'t send mail - all recipients were rejected: 550 5.1.1 <nadie@x.test> User unknown'), campos);
}

test('enviar factura: rechazo SMTP del destinatario (550 en RCPT TO) → 400 sin el texto del SMTP', async () => {
  fallo = errorSmtp({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' });
  const r = await enviar();
  assert.equal(r.status, 400);
  assert.equal(r.body.error, MENSAJE_DESTINATARIO_RECHAZADO);
  assert.equal(r.body.code, undefined);
  assert.doesNotMatch(JSON.stringify(r.body), /User unknown|5\.1\.1/);
});

test('enviar factura: 553 o EENVELOPE sin comando también son rechazo de destinatario', async () => {
  fallo = errorSmtp({ responseCode: 553, command: 'RCPT TO' });
  assert.equal((await enviar()).status, 400);
  fallo = Object.assign(new Error('No recipients defined'), { code: 'EENVELOPE' });
  assert.equal((await enviar()).status, 400);
});

test('enviar factura: otros fallos SMTP siguen siendo 500 genérico', async () => {
  fallo = errorSmtp({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' });
  const auth = await enviar();
  assert.equal(auth.status, 500);
  assert.equal(auth.body.error, 'Error interno del servidor');

  fallo = errorSmtp({ code: 'EENVELOPE', responseCode: 550, command: 'MAIL FROM' });
  assert.equal((await enviar()).status, 500, 'el remitente rechazado no es culpa del destinatario');
});

test('errorDestinatarioRechazado: null para errores que no son de SMTP', () => {
  assert.equal(errorDestinatarioRechazado(new Error('x')), null);
  assert.equal(errorDestinatarioRechazado(null), null);
});

test('remesa con formato bancario no soportado → 422 con mensaje de configuración', async () => {
  await assert.rejects(generarFicheroRemesa({ banco: 'NO_EXISTE', lineas: [] }), (err) => {
    const pub = errorPublico(err);
    assert.equal(pub.status, 422);
    assert.match(pub.error, /formato bancario de la remesa no está soportado/);
    return true;
  });
});

test('plantilla BBVA FIT sin la hoja esperada → 422 con mensaje de configuración', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const original = ExcelJS.Workbook.prototype.getWorksheet;
  ExcelJS.Workbook.prototype.getWorksheet = () => undefined;
  try {
    await assert.rejects(generarFicheroRemesa({ banco: 'BBVA_FIT', lineas: [] }), (err) => {
      const pub = errorPublico(err);
      assert.equal(pub.status, 422);
      assert.match(pub.error, /plantilla BBVA FIT no tiene la hoja/);
      return true;
    });
  } finally {
    ExcelJS.Workbook.prototype.getWorksheet = original;
  }
});
