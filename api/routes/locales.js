import express from 'express';
import { ScanCommand, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { formatId6 } from '../lib/usuarioLocales.js';

const router = express.Router();

// Cache en memoria para listado mínimo de locales (dropdowns). TTL 5 min.
let cachedLocalesMinimal = null;
let cachedLocalesMinimalTime = 0;
const CACHE_LOCALES_TTL_MS = 5 * 60 * 1000;

/**
 * `id_empresa` con el mismo padding a 6 dígitos que usa el maestro de empresas,
 * para que el formato no dependa de quién escriba (pantalla, API o migración).
 * Sin valor devuelve cadena vacía: '000000' no es una empresa válida y guardarlo
 * inventaría un vínculo inexistente.
 */
function formatIdEmpresa(val) {
  const s = val != null ? String(val).trim() : '';
  if (!s) return '';
  const norm = formatId6(s);
  return norm === '000000' ? '' : norm;
}

/**
 * Siguiente `id_Locales` libre (máximo del maestro + 1). Solo se usa en altas sin
 * identificador (creación rápida desde Usuarios): antes se asignaba '000000' fijo,
 * que pisaba el local que ya tuviera ese id.
 */
async function siguienteIdLocalLibre() {
  let max = 0;
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: tables.locales,
      ProjectionExpression: 'id_Locales',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const it of r.Items || []) {
      const n = parseInt(String(it?.id_Locales ?? '').trim(), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return formatId6(max + 1);
}

// Estructura exacta de la tabla igp_Locales en AWS (orden: id_Locales, nombre, agoraCode, empresa, ...).
// `factorial_location_id` es opcional: lo rellena el admin manualmente con el ID de la location de Factorial HR.
// `estilo_visual_brief` / `estilo_visual_imagen_keys` / `web` (sitio del local) los edita Marketing (PATCH /marketing/locales/:id/estilo);
// aquí solo se listan para que el PUT /locales no los machaque al reconstruir el item.
// `ratio_personal` / `ratio_musicos` / `ratio_mercaderia`: porcentaje (0–100) del facturado que se
// destina a cada partida. `ratio_personal` se usa en RRHH → Horas por facturación para estimar horas.
// `km_desplazamiento`: kilómetros de un trayecto de ida desde la sede central hasta el local. Se
// rellena a mano (no se calcula) y lo usa Mantenimiento para valorar el desplazamiento del técnico.
// `id_empresa`: identificador real en `igp_Empresas`, vínculo estable con la empresa del local.
// Convive con `empresa` (nombre), que siguen usando pedidos/abonos, arqueos reales y cashflow;
// `empresa` es copia desnormalizada legible y `id_empresa` es la referencia que no se rompe al renombrar.
const TABLE_LOCALES_ATTRS = ['id_Locales', 'nombre', 'agoraCode', 'empresa', 'id_empresa', 'direccion', 'cp', 'municipio', 'provincia', 'almacen origen', 'sede', 'lat', 'lng', 'km_desplazamiento', 'imagen', 'factorial_location_id', 'ratio_personal', 'ratio_musicos', 'ratio_mercaderia', 'estilo_visual_brief', 'estilo_visual_imagen_keys', 'web'];

// Acepta body con claves en minúsculas (API) o PascalCase (frontend).
function bodyLocalesVal(body, key) {
  if (body[key] != null && body[key] !== '') return body[key];
  const cap = key.split(' ').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  if (body[cap] != null && body[cap] !== '') return body[cap];
  // Fallback: "Almacen origen" (solo primera palabra capitalizada, resto original)
  const alt = key.split(' ').map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p)).join(' ');
  return body[alt];
}

/** Locales cuya sede pertenece al grupo (misma lógica que facturación: texto contiene PARIPE). */
function localGrupoParipe(loc) {
  const s = String(loc?.sede ?? loc?.Sede ?? '').toUpperCase();
  return s.includes('PARIPE');
}

router.get('/locales', async (req, res) => {
  const minimal = req.query.minimal === '1' || req.query.minimal === 'true';
  const grupoParipe = req.query.grupoParipe === '1' || req.query.grupoParipe === 'true';
  if (minimal && !grupoParipe && cachedLocalesMinimal != null && (Date.now() - cachedLocalesMinimalTime) < CACHE_LOCALES_TTL_MS) {
    return res.json({ locales: cachedLocalesMinimal });
  }
  const items = [];
  let lastKey = null;
  do {
    const cmd = new ScanCommand({
      TableName: tables.locales,
      ...(minimal && !grupoParipe && { ProjectionExpression: 'id_Locales, nombre, id_empresa, estilo_visual_brief, km_desplazamiento' }),
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    });
    const result = await docClient.send(cmd);
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  let locales = items.map((item) => (item ? { ...item } : {}));
  if (grupoParipe) {
    locales = locales.filter(localGrupoParipe);
  }
  if (minimal && !grupoParipe) {
    cachedLocalesMinimal = locales;
    cachedLocalesMinimalTime = Date.now();
  }
  res.json({ locales });
});

router.post('/locales', async (req, res) => {
  const body = req.body || {};
  if (!bodyLocalesVal(body, 'nombre') || !String(bodyLocalesVal(body, 'nombre')).trim()) {
    return res.status(400).json({ error: 'nombre es obligatorio' });
  }
  const idBody = body.id_Locales ?? body.Id_Locales;
  const idExplicito = idBody != null && String(idBody).trim() !== '';
  const item = {};
  for (const key of TABLE_LOCALES_ATTRS) {
    if (key === 'id_Locales') {
      item[key] = idExplicito ? formatId6(idBody) : '';
    } else if (key === 'id_empresa') {
      item[key] = formatIdEmpresa(bodyLocalesVal(body, key));
    } else if (key === 'estilo_visual_imagen_keys') {
      const raw = body.estilo_visual_imagen_keys;
      item[key] = Array.isArray(raw)
        ? raw.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
        : [];
    } else {
      const v = bodyLocalesVal(body, key);
      item[key] = v != null && v !== '' ? String(v) : '';
    }
  }

  // El id se calcula en el cliente sobre una lista que puede estar obsoleta: sin
  // condición, un Put pisaría por completo el local existente con ese id.
  const MAX_INTENTOS = idExplicito ? 1 : 3;
  for (let intento = 1; intento <= MAX_INTENTOS; intento += 1) {
    if (!idExplicito) item.id_Locales = await siguienteIdLocalLibre();
    try {
      await docClient.send(new PutCommand({
        TableName: tables.locales,
        Item: item,
        ConditionExpression: 'attribute_not_exists(id_Locales)',
      }));
      cachedLocalesMinimal = null;
      return res.json({ ok: true, local: item });
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') {
        console.error('DynamoDB error:', err);
        return res.status(500).json({ error: err.message || 'Error al guardar el local' });
      }
      if (intento === MAX_INTENTOS) {
        return res.status(409).json({
          error: idExplicito
            ? `El identificador de local ${item.id_Locales} ya está en uso. Recarga la pantalla de locales y vuelve a crearlo con el siguiente identificador libre.`
            : 'No se ha podido asignar un identificador de local libre porque se están creando locales a la vez. Recarga la pantalla y vuelve a intentarlo.',
        });
      }
    }
  }
});

router.put('/locales', async (req, res) => {
  const body = req.body || {};
  const idLocales = (body.id_Locales ?? body.Id_Locales) != null ? String(body.id_Locales ?? body.Id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para editar' });
  if (!bodyLocalesVal(body, 'nombre') || !String(bodyLocalesVal(body, 'nombre')).trim()) return res.status(400).json({ error: 'nombre es obligatorio' });
  const getCmd = new GetCommand({
    TableName: tables.locales,
    Key: { id_Locales: idLocales },
  });
  const got = await docClient.send(getCmd);
  const existing = got.Item || {};
  const item = {};
  for (const key of TABLE_LOCALES_ATTRS) {
    if (key === 'id_Locales') item[key] = idLocales;
    else if (key === 'id_empresa') {
      const v = bodyLocalesVal(body, key);
      item[key] = formatIdEmpresa(v != null && v !== '' ? v : existing[key]);
    } else if (key === 'estilo_visual_imagen_keys') {
      const raw = body.estilo_visual_imagen_keys;
      if (Array.isArray(raw)) {
        item[key] = raw.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
      } else {
        item[key] = Array.isArray(existing.estilo_visual_imagen_keys)
          ? existing.estilo_visual_imagen_keys
          : [];
      }
    } else {
      const v = bodyLocalesVal(body, key);
      item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
    }
  }
  await docClient.send(new PutCommand({
    TableName: tables.locales,
    Item: item,
  }));
  cachedLocalesMinimal = null;
  res.json({ ok: true, local: item });
});

router.delete('/locales', async (req, res) => {
  const idLocales = req.body?.id_Locales != null ? String(req.body.id_Locales) : req.query?.id_Locales != null ? String(req.query.id_Locales) : '';
  if (!idLocales) return res.status(400).json({ error: 'id_Locales es obligatorio para borrar' });
  await docClient.send(new DeleteCommand({
    TableName: tables.locales,
    Key: { id_Locales: idLocales },
  }));
  cachedLocalesMinimal = null;
  res.json({ ok: true });
});

export default router;
