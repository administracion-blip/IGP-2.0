/**
 * Todo POST que lanza el planificador (`lib/jobs/scheduledTasks.js`) con
 * `internalSyncFetchHeaders()` debe estar en INTERNAL_SYNC_POST_PATHS; si no,
 * requireAuth le devuelve 401 y la sincronización falla en silencio.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-sync';

const { INTERNAL_SYNC_POST_PATHS } = await import('../lib/internalSync.js');
const { requireAuth } = await import('../middleware/auth.js');

function pasaComoInterno(path, secreto) {
  const req = {
    method: 'POST',
    originalUrl: path,
    headers: { 'x-internal-secret': secreto },
  };
  let paso = false;
  let estado = null;
  const res = {
    status(s) {
      estado = s;
      return { json: () => {} };
    },
  };
  requireAuth(req, res, () => {
    paso = true;
  });
  return { paso, estado, isInternal: req.isInternal === true };
}

test('users/sync y payment-methods/sync entran como internos con el secreto', () => {
  const anterior = process.env.INTERNAL_SYNC_SECRET;
  process.env.INTERNAL_SYNC_SECRET = 'secreto-interno-de-prueba';
  try {
    for (const path of ['/api/agora/users/sync', '/api/agora/payment-methods/sync']) {
      const r = pasaComoInterno(path, 'secreto-interno-de-prueba');
      assert.equal(r.paso, true, `${path} debe pasar`);
      assert.equal(r.isInternal, true);
      const malo = pasaComoInterno(path, 'otro');
      assert.equal(malo.paso, false);
      assert.equal(malo.estado, 401);
    }
  } finally {
    if (anterior === undefined) delete process.env.INTERNAL_SYNC_SECRET;
    else process.env.INTERNAL_SYNC_SECRET = anterior;
  }
});

test('todas las rutas del planificador están en INTERNAL_SYNC_POST_PATHS', async () => {
  const fuente = await readFile(new URL('../lib/jobs/scheduledTasks.js', import.meta.url), 'utf8');
  const todas = [...new Set([...fuente.matchAll(/(\/api\/[a-z0-9/_-]+)/gi)].map((m) => m[1]))];
  assert.ok(todas.includes('/api/agora/closeouts/full-sync'));
  for (const ruta of todas) {
    assert.ok(INTERNAL_SYNC_POST_PATHS.has(ruta), `${ruta} falta en INTERNAL_SYNC_POST_PATHS`);
  }
});
