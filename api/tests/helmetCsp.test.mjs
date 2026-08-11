/**
 * [SEC S-11] Helmet debe emitir CSP en modo report-only (no enforcing).
 * Importar server.js arrancaría validateEnv + listen + jobs; se monta un
 * mini-app con la misma config compartida (`lib/helmetOptions.js`).
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import { helmetOptions } from '../lib/helmetOptions.js';

let servidor = null;
let base = '';

async function ensureServer() {
  if (servidor) return;
  const app = express();
  app.use(helmet(helmetOptions));
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}`;
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

test('Helmet emite Content-Security-Policy-Report-Only (no enforcing)', async () => {
  await ensureServer();
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);

  const reportOnly = res.headers.get('content-security-policy-report-only');
  const enforcing = res.headers.get('content-security-policy');

  assert.ok(reportOnly, 'debe existir Content-Security-Policy-Report-Only');
  assert.equal(enforcing, null, 'no debe existir Content-Security-Policy enforcing');
  assert.match(reportOnly, /default-src\s+'none'/);
  assert.match(reportOnly, /frame-ancestors\s+'none'/);
});
