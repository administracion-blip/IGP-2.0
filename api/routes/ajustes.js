import { Router } from 'express';
import { ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { normalizarUrlExterna, sanitizarEnlacesPlanning } from '../lib/planningEnlaces.js';
import {
  ACCESO,
  accesoEscrituraAjuste,
  accesoLecturaAjuste,
  esAjusteCerrado,
  lecturaDependeSoloDelPk,
  puedeLeerPk,
} from '../lib/ajustes/politica.js';

const router = Router();
const tableAjustesName = tables.ajustes;

const ERROR_SIN_PERMISO = 'No tienes permiso para este ajuste';
const ERROR_NO_ENCONTRADO = 'Ajuste no encontrado';

function esAdministrador(user) {
  return user?.rol === 'Administrador';
}

/**
 * Corta la petición si la política no deja leer/escribir la clave. Devuelve true
 * si ya ha respondido. Las claves cerradas responden 404 para no revelar que
 * existen; las llamadas internas solo saltan los permisos, no el cierre.
 */
async function respondeSiNoPuede(req, res, pk, sk, evaluar) {
  if (req.isInternal) {
    if (!esAjusteCerrado(pk, sk)) return false;
    res.status(404).json({ error: ERROR_NO_ENCONTRADO });
    return true;
  }
  if (!req.user) {
    res.status(401).json({ error: 'No autenticado' });
    return true;
  }
  let acceso;
  try {
    acceso = await evaluar(pk, sk, req.user);
  } catch (err) {
    console.error('[ajustes permisos]', err.message || err);
    res.status(500).json({ error: 'Error verificando permisos' });
    return true;
  }
  if (acceso === ACCESO.PERMITIDO) return false;
  if (acceso === ACCESO.CERRADO) res.status(404).json({ error: ERROR_NO_ENCONTRADO });
  else res.status(403).json({ error: ERROR_SIN_PERMISO });
  return true;
}

const respondeSiNoPuedeLeer = (req, res, pk, sk) => respondeSiNoPuede(req, res, pk, sk, accesoLecturaAjuste);
const respondeSiNoPuedeEscribir = (req, res, pk, sk) => respondeSiNoPuede(req, res, pk, sk, accesoEscrituraAjuste);

/** Deja solo los ítems de la categoría que el usuario puede leer. */
async function filtrarLegibles(req, categoria, items) {
  const visibles = items.filter((it) => !esAjusteCerrado(it.PK, it.SK));
  if (req.isInternal || lecturaDependeSoloDelPk(categoria)) return visibles;
  const legibles = [];
  for (const it of visibles) {
    if ((await accesoLecturaAjuste(it.PK, it.SK, req.user)) === ACCESO.PERMITIDO) legibles.push(it);
  }
  return legibles;
}

router.get('/ajustes', async (req, res) => {
  try {
    const { categoria } = req.query;
    if (categoria !== undefined && typeof categoria !== 'string') {
      return res.status(400).json({ error: 'categoria debe ser un texto' });
    }
    if (!req.isInternal) {
      if (!req.user) return res.status(401).json({ error: 'No autenticado' });
      if (!categoria && !esAdministrador(req.user)) {
        return res.status(403).json({ error: ERROR_SIN_PERMISO });
      }
      if (categoria && lecturaDependeSoloDelPk(categoria) && !(await puedeLeerPk(categoria, req.user))) {
        return res.status(403).json({ error: ERROR_SIN_PERMISO });
      }
    }
    let items = [];
    let lastKey = null;
    if (categoria) {
      do {
        const r = await docClient.send(new QueryCommand({
          TableName: tableAjustesName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': categoria },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }));
        items.push(...(r.Items || []));
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
      items = await filtrarLegibles(req, categoria, items);
    } else {
      do {
        const r = await docClient.send(new ScanCommand({ TableName: tableAjustesName, ...(lastKey && { ExclusiveStartKey: lastKey }) }));
        items.push(...(r.Items || []));
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
      items = items.filter((it) => !esAjusteCerrado(it.PK, it.SK));
    }
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[ajustes GET]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al listar ajustes' });
  }
});

router.get('/ajustes/:pk/:sk', async (req, res) => {
  try {
    const { pk, sk } = req.params;
    if (await respondeSiNoPuedeLeer(req, res, pk, sk)) return;
    const r = await docClient.send(new GetCommand({ TableName: tableAjustesName, Key: { PK: pk, SK: sk } }));
    if (!r.Item) return res.status(404).json({ error: ERROR_NO_ENCONTRADO });
    return res.json({ ok: true, item: r.Item });
  } catch (err) {
    console.error('[ajustes GET/:pk/:sk]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al obtener ajuste' });
  }
});

/** @deprecated Usa sanitizarEnlacesPlanning para planning_dia/enlaces */
function aplicarValidacionEnlacesPlanning(body) {
  if (body.PK !== 'planning_dia' || body.SK !== 'enlaces') return null;

  if (body.Enlaces !== undefined) {
    const r = sanitizarEnlacesPlanning(body.Enlaces);
    if (!r.ok) return r.error;
    body.Enlaces = r.enlaces;
    delete body.UrlInventario;
    return null;
  }

  if (body.UrlInventario !== undefined) {
    const norm = normalizarUrlExterna(body.UrlInventario);
    if (norm === null) {
      return 'UrlInventario debe ser una URL http:// o https:// válida (o vacía)';
    }
    body.UrlInventario = norm;
  }

  return null;
}

router.post('/ajustes', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.PK || !body.SK) return res.status(400).json({ error: 'PK y SK son obligatorios' });
    if (typeof body.PK !== 'string' || typeof body.SK !== 'string') {
      return res.status(400).json({ error: 'PK y SK deben ser texto' });
    }
    // El POST reemplaza el ítem completo: sin esta comprobación, el candado del
    // PATCH se saltaría escribiendo el mismo ajuste por esta ruta.
    if (await respondeSiNoPuedeEscribir(req, res, body.PK, body.SK)) return;

    const errEnlaces = aplicarValidacionEnlacesPlanning(body);
    if (errEnlaces) return res.status(400).json({ error: errEnlaces });

    const item = { ...body, updatedAt: new Date().toISOString() };
    await docClient.send(new PutCommand({ TableName: tableAjustesName, Item: item }));
    return res.json({ ok: true, item });
  } catch (err) {
    console.error('[ajustes POST]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al crear ajuste' });
  }
});

router.patch('/ajustes/:pk/:sk', async (req, res) => {
  try {
    const { pk, sk } = req.params;
    const body = req.body || {};
    const keys = Object.keys(body).filter((k) => k !== 'PK' && k !== 'SK');
    if (keys.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    if (await respondeSiNoPuedeEscribir(req, res, pk, sk)) return;

    const patchBody = { ...body, PK: pk, SK: sk };
    const errEnlaces = aplicarValidacionEnlacesPlanning(patchBody);
    if (errEnlaces) return res.status(400).json({ error: errEnlaces });
    if (patchBody.Enlaces !== undefined) body.Enlaces = patchBody.Enlaces;

    const exprParts = [];
    const exprValues = {};
    const exprNames = {};
    keys.forEach((k, i) => {
      const alias = `#f${i}`;
      const val = `:v${i}`;
      exprNames[alias] = k;
      exprValues[val] = body[k];
      exprParts.push(`${alias} = ${val}`);
    });
    exprNames['#upd'] = 'updatedAt';
    exprValues[':upd'] = new Date().toISOString();
    exprParts.push('#upd = :upd');

    const r = await docClient.send(new UpdateCommand({
      TableName: tableAjustesName,
      Key: { PK: pk, SK: sk },
      UpdateExpression: 'SET ' + exprParts.join(', '),
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
      ReturnValues: 'ALL_NEW',
    }));
    return res.json({ ok: true, item: r.Attributes });
  } catch (err) {
    console.error('[ajustes PATCH]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al actualizar ajuste' });
  }
});

router.delete('/ajustes/:pk/:sk', async (req, res) => {
  try {
    const { pk, sk } = req.params;
    // Borrar el ajuste es otra forma de cambiar el comportamiento: al faltar el
    // ítem se usan los valores por defecto.
    if (await respondeSiNoPuedeEscribir(req, res, pk, sk)) return;
    await docClient.send(new DeleteCommand({ TableName: tableAjustesName, Key: { PK: pk, SK: sk } }));
    return res.json({ ok: true });
  } catch (err) {
    console.error('[ajustes DELETE]', err.message || err);
    return res.status(500).json({ error: err.message || 'Error al eliminar ajuste' });
  }
});

export default router;
