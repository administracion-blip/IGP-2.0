import { Router } from 'express';
import { ScanCommand, QueryCommand, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { hasPermission } from '../middleware/auth.js';
import { normalizarUrlExterna, sanitizarEnlacesPlanning } from '../lib/planningEnlaces.js';

const router = Router();
const tableAjustesName = tables.ajustes;

/**
 * Ajustes que deciden comportamiento sensible y necesitan permiso para
 * escribirse. Se protege **por clave** y no la ruta entera porque este CRUD
 * genérico lo usa cualquier usuario autenticado para cosas suyas (los favoritos
 * de cada uno se guardan con PATCH aquí mismo): un middleware en la ruta dejaría
 * sin favoritos a todo el que no tenga el permiso.
 *
 * `mantenimiento/facturacion` y `compras/facturacion` son los interruptores de la
 * generación automática de las facturas mensuales (reparaciones, ventas internas
 * del grupo y abonos de rappel) y deciden la sociedad emisora y las series, así
 * que se pide el mismo permiso que ya gobierna cada una de esas facturaciones.
 * Un solo ítem para las dos series de compras: quien puede tocar una serie de
 * facturación de compras puede tocar la otra. Sin esto, el
 * bloqueo que la pantalla de ajustes aplica a esos formularios sería solo
 * cosmético: bastaría con llamar al endpoint.
 *
 * La protección es **por prefijo de SK**, no por clave exacta, porque la
 * facturación periódica guarda más ítems bajo el mismo PK que su configuración:
 * los cerrojos de ejecución (`facturacion_lock`, `facturacion_rappel_lock`). Un
 * cerrojo es tan sensible como el interruptor: escribir uno con caducidad lejana
 * deja la facturación mensual muerta —la adquisición devuelve 409 para siempre,
 * el trabajo programado se salta todos los ciclos y el botón manual rebota— y
 * borrarlo a media tanda la aborta. Con la protección por clave exacta eso lo
 * podía hacer cualquier usuario autenticado.
 *
 * El prefijo no bloquea nada legítimo: bajo `mantenimiento` y `compras` no hay
 * más ítems de ajustes que los de facturación, y los ítems de cualquier usuario
 * (favoritos, personalización, agrupaciones) viven en otros PK.
 */
const PREFIJOS_AJUSTES_PROTEGIDOS = [
  { pk: 'mantenimiento', prefijoSk: 'facturacion', permiso: 'mantenimiento.facturar' },
  { pk: 'compras', prefijoSk: 'facturacion', permiso: 'compras.facturar' },
];

/** Permiso necesario para escribir un ajuste, o null si no está protegido. */
function permisoDeAjuste(pk, sk) {
  const pkTexto = String(pk ?? '');
  const skTexto = String(sk ?? '');
  const regla = PREFIJOS_AJUSTES_PROTEGIDOS.find(
    (r) => r.pk === pkTexto && skTexto.startsWith(r.prefijoSk)
  );
  return regla?.permiso ?? null;
}

/**
 * Corta la petición con 401/403 si el ajuste está protegido y el usuario no tiene
 * el permiso. Devuelve true si ya ha respondido.
 */
async function respondeSiNoPuedeEscribir(req, res, pk, sk) {
  const permiso = permisoDeAjuste(pk, sk);
  if (!permiso) return false;
  if (req.isInternal) return false;
  if (!req.user) {
    res.status(401).json({ error: 'No autenticado' });
    return true;
  }
  try {
    if (await hasPermission(req.user, permiso)) return false;
  } catch (err) {
    console.error('[ajustes permisos]', err.message || err);
    res.status(500).json({ error: 'Error verificando permisos' });
    return true;
  }
  res.status(403).json({ error: 'No tienes permiso para cambiar esta configuración' });
  return true;
}

router.get('/ajustes', async (req, res) => {
  try {
    const { categoria } = req.query;
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
    } else {
      do {
        const r = await docClient.send(new ScanCommand({ TableName: tableAjustesName, ...(lastKey && { ExclusiveStartKey: lastKey }) }));
        items.push(...(r.Items || []));
        lastKey = r.LastEvaluatedKey || null;
      } while (lastKey);
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
    const r = await docClient.send(new GetCommand({ TableName: tableAjustesName, Key: { PK: pk, SK: sk } }));
    if (!r.Item) return res.status(404).json({ error: 'Ajuste no encontrado' });
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
    // El POST reemplaza el ítem completo: si no se comprobara aquí, el candado
    // del PATCH se saltaría escribiendo el mismo ajuste por esta ruta.
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
