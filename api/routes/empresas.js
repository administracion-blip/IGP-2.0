import { Router } from 'express';
import { ScanCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import {
  normalizeCif,
  getCifFromEmpresaItem,
  getIdEmpresaFromItem,
} from '../lib/empresaCif.js';
import { ibanPredeterminadoDeEmpresa } from '../lib/empresaIban.js';
import { limpiarIban } from '../lib/remesas/iban.js';
import {
  listarCuentasDeEmpresa,
  getCuentaByIban,
  actualizarCuenta,
  desactivarCuenta,
  ordenarCuentas,
} from '../lib/dynamo/bankAccounts.js';
import {
  altaCuentaBancariaEmpresa,
  fijarIbanPredeterminado,
  httpErrorAltaCuenta,
} from '../lib/empresaCuentaAlta.js';
import { requirePermission, requireAnyPermission, requireRole } from '../middleware/auth.js';

const router = Router();
const tableEmpresasName = tables.empresas;

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

function idEmpresaCoincide(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  return formatId6(a) === formatId6(b);
}

function normalizarEtiqueta(val) {
  if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
  if (val != null && val !== '') return [String(val).trim()];
  return [];
}

function trimCampoString(val) {
  return val != null && val !== '' ? String(val).trim() : '';
}

// Ojo: PUT /empresas reescribe el ítem completo, así que todo atributo que no
// esté en esta lista se pierde al editar una empresa. `IbanPredeterminado` es
// el puntero a la cuenta bancaria predeterminada (tabla Igp_BankAccounts).
const TABLE_EMPRESAS_ATTRS = ['id_empresa', 'Nombre', 'Cif', 'Iban', 'IbanAlternativo', 'IbanPredeterminado', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Email', 'Telefono', 'Tipo de recibo', 'Vencimiento', 'Etiqueta', 'Cuenta contable', 'Administrador', 'Sede', 'CCC'];

// [SEC S-02]
router.get('/empresas', requirePermission('empresas.ver'), async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const empresas = items.map((item) => {
      if (!item) return {};
      const out = { ...item };
      if (out.Etiqueta == null && out.Alias != null) out.Etiqueta = normalizarEtiqueta(out.Alias);
      if (out.Etiqueta != null && !Array.isArray(out.Etiqueta)) out.Etiqueta = normalizarEtiqueta(out.Etiqueta);
      return out;
    });
    res.json({ empresas });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al listar empresas' });
  }
});

// [SEC S-02]
router.get('/empresas/check-cif', requireAnyPermission('empresas.ver', 'empresas.crear', 'empresas.editar'), async (req, res) => {
  const cif = normalizeCif(req.query?.cif);
  const excludeId = req.query?.excludeId != null ? formatId6(req.query.excludeId) : '';
  if (!cif) return res.status(400).json({ error: 'cif es obligatorio' });
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const exists = items.some((item) => {
      const itemCif = normalizeCif(getCifFromEmpresaItem(item));
      return itemCif && itemCif === cif && !idEmpresaCoincide(getIdEmpresaFromItem(item), excludeId);
    });
    return res.json({ exists });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al comprobar CIF' });
  }
});

// [SEC S-02]
router.post('/empresas', requirePermission('empresas.crear'), async (req, res) => {
  const body = req.body || {};
  if (!body.Nombre || !String(body.Nombre).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  if (!body.Cif || !String(body.Cif).trim()) {
    return res.status(400).json({ error: 'CIF es obligatorio' });
  }
  if (body.id_empresa == null || !String(body.id_empresa).trim()) {
    return res.status(400).json({ error: 'id_empresa es obligatorio' });
  }
  const idEmpresa = formatId6(body.id_empresa);
  if (idEmpresa === '000000') {
    return res.status(400).json({ error: 'id_empresa es obligatorio y debe ser mayor que 0' });
  }
  const cifValue = normalizeCif(body.Cif);
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const dup = items.some((item) => normalizeCif(getCifFromEmpresaItem(item)) === cifValue);
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') {
        item[key] = idEmpresa;
      } else if (key === 'Etiqueta') {
        item[key] = normalizarEtiqueta(body[key]);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        item[key] = trimCampoString(body[key]);
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableEmpresasName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(id_empresa)',
    }));
    res.json({ ok: true, empresa: item });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({ error: `Ya existe una empresa con el id ${idEmpresa}` });
    }
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar la empresa' });
  }
});

// [SEC S-02]
router.put('/empresas', requirePermission('empresas.editar'), async (req, res) => {
  const body = req.body || {};
  const idSolicitado = body.id_empresa != null ? formatId6(body.id_empresa) : '';
  if (!idSolicitado || idSolicitado === '000000') {
    return res.status(400).json({ error: 'id_empresa es obligatorio para editar' });
  }
  if (!body.Nombre || !String(body.Nombre).trim()) return res.status(400).json({ error: 'Nombre es obligatorio' });
  if (!body.Cif || !String(body.Cif).trim()) return res.status(400).json({ error: 'CIF es obligatorio' });
  const cifValue = normalizeCif(body.Cif);
  try {
    const items = [];
    let lastKey = null;
    do {
      const cmd = new ScanCommand({
        TableName: tableEmpresasName,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      });
      const result = await docClient.send(cmd);
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const existingItem = items.find((item) => idEmpresaCoincide(getIdEmpresaFromItem(item), idSolicitado));
    if (!existingItem) return res.status(404).json({ error: 'Empresa no encontrada' });

    const dup = items.find(
      (item) =>
        normalizeCif(getCifFromEmpresaItem(item)) === cifValue
        && !idEmpresaCoincide(getIdEmpresaFromItem(item), idSolicitado),
    );
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const idEmpresa = getIdEmpresaFromItem(existingItem);
    const existing = existingItem;
    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') item[key] = idEmpresa;
      else if (key === 'Etiqueta') {
        item[key] = body[key] != null ? normalizarEtiqueta(body[key]) : normalizarEtiqueta(existing[key] ?? existing.Alias);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        // Si el campo viene en el body (aunque sea ''), se persiste; si no viene, se conserva el existente.
        item[key] =
          body[key] !== undefined
            ? trimCampoString(body[key])
            : trimCampoString(existing[key] ?? '');
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableEmpresasName,
      Item: item,
    }));
    res.json({ ok: true, empresa: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar la empresa' });
  }
});

// [SEC S-02]
router.delete('/empresas', requireRole('Administrador'), async (req, res) => {
  const idEmpresa = req.body?.id_empresa != null ? String(req.body.id_empresa) : req.query?.id_empresa != null ? String(req.query.id_empresa) : '';
  if (!idEmpresa) return res.status(400).json({ error: 'id_empresa es obligatorio para borrar' });
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableEmpresasName,
      Key: { id_empresa: idEmpresa },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al borrar la empresa' });
  }
});

/* ── Cuentas bancarias de la empresa (tabla Igp_BankAccounts) ───────────────
 * Modelo de N cuentas por empresa. La predeterminada no es un flag de la
 * cuenta: es el puntero `IbanPredeterminado` de la ficha de empresa.
 * Fase *expand*: al cambiar la predeterminada se escribe también el campo
 * viejo `Iban`, para que todo lo que aún lo lee siga viendo lo correcto.
 */

async function scanEmpresas() {
  const items = [];
  let lastKey = null;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tableEmpresasName,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/**
 * Localiza el ítem real de la empresa. Los `id_empresa` guardados no están
 * normalizados igual (unos con ceros a la izquierda y otros no), así que hay
 * que buscar por comparación y luego escribir con el valor literal del ítem:
 * construir la Key con formatId6() crearía ítems huérfanos.
 */
async function buscarEmpresaPorId(idSolicitado) {
  const id = idSolicitado != null ? formatId6(idSolicitado) : '';
  if (!id || id === '000000') return null;
  const items = await scanEmpresas();
  return items.find((item) => idEmpresaCoincide(getIdEmpresaFromItem(item), id)) || null;
}

function usuarioDePeticion(req) {
  return String(req.user?.email ?? req.user?.sub ?? '').trim();
}

/** Cuenta de esa empresa, o null si no existe o pertenece a otra. */
async function buscarCuentaDeEmpresa(empresaItem, iban) {
  const cuenta = await getCuentaByIban(iban);
  if (!cuenta) return null;
  if (!idEmpresaCoincide(cuenta.empresaId, getIdEmpresaFromItem(empresaItem))) return null;
  return cuenta;
}

/**
 * Booleano estricto: un `activa: 0` o `activa: 'sí'` interpretado como false
 * desactivaría una cuenta sin que nadie lo haya pedido.
 * @returns {boolean|undefined|null} null si el valor no es booleano
 */
function leerBooleano(val) {
  if (val === undefined) return undefined;
  if (val === true || val === 'true') return true;
  if (val === false || val === 'false') return false;
  return null;
}

// [SEC S-02]
router.get('/empresas/:idEmpresa/cuentas', requirePermission('empresas.ver'), async (req, res) => {
  try {
    const empresa = await buscarEmpresaPorId(req.params.idEmpresa);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    const ibanPredeterminado = ibanPredeterminadoDeEmpresa(empresa);
    const cuentas = await listarCuentasDeEmpresa(getIdEmpresaFromItem(empresa));
    // El puntero puede venir del campo viejo `Iban` de una empresa que quedó en
    // cuarentena: la pantalla debe poder avisar en vez de pintar un imposible.
    const punteroSinCuenta = Boolean(ibanPredeterminado)
      && !cuentas.some((c) => limpiarIban(c?.iban) === ibanPredeterminado);
    return res.json({
      cuentas: ordenarCuentas(cuentas, ibanPredeterminado),
      ibanPredeterminado,
      punteroSinCuenta,
    });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al listar las cuentas bancarias' });
  }
});

// [SEC S-02]
router.post('/empresas/:idEmpresa/cuentas', requirePermission('empresas.editar'), async (req, res) => {
  const body = req.body || {};
  const ibanSolicitado = limpiarIban(body.iban);
  if (!ibanSolicitado) return res.status(400).json({ error: 'iban es obligatorio' });
  const predeterminada = leerBooleano(body.predeterminada);
  if (predeterminada === null) {
    return res.status(400).json({ error: 'predeterminada debe ser true o false' });
  }
  try {
    const empresa = await buscarEmpresaPorId(req.params.idEmpresa);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });

    const resultado = await altaCuentaBancariaEmpresa(empresa, {
      iban: ibanSolicitado,
      bancoCodigo: body.bancoCodigo,
      bancoNombre: body.bancoNombre,
      notas: body.notas,
      predeterminada,
      usuario: usuarioDePeticion(req),
    });

    if (!resultado.ok) {
      const { status, body: errorBody } = httpErrorAltaCuenta(resultado);
      return res.status(status).json(errorBody);
    }

    return res.json({
      ok: true,
      cuenta: resultado.cuenta,
      reactivada: resultado.reactivada,
      ibanPredeterminado: resultado.ibanPredeterminado,
      movimientosAsignados: resultado.movimientosAsignados,
    });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al crear la cuenta bancaria' });
  }
});

// [SEC S-02]
router.put('/empresas/:idEmpresa/cuentas/:iban', requirePermission('empresas.editar'), async (req, res) => {
  const body = req.body || {};
  const iban = limpiarIban(req.params.iban);
  if (!iban) return res.status(400).json({ error: 'iban es obligatorio' });
  try {
    const empresa = await buscarEmpresaPorId(req.params.idEmpresa);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    const cuenta = await buscarCuentaDeEmpresa(empresa, iban);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta bancaria no encontrada en esta empresa' });

    const activa = leerBooleano(body.activa);
    if (activa === null) return res.status(400).json({ error: 'activa debe ser true o false' });
    if (activa === false && iban === ibanPredeterminadoDeEmpresa(empresa)) {
      return res.status(409).json({
        error: 'No se puede desactivar la cuenta predeterminada. Marca antes otra cuenta como predeterminada.',
      });
    }

    const resultado = await actualizarCuenta({
      iban,
      ...(body.bancoCodigo !== undefined && { bancoCodigo: body.bancoCodigo }),
      ...(body.bancoNombre !== undefined && { bancoNombre: body.bancoNombre }),
      ...(body.notas !== undefined && { notas: body.notas }),
      ...(activa !== undefined && { activa }),
      usuario: usuarioDePeticion(req),
    });
    if (!resultado.ok) {
      const estado = resultado.code === 'NO_ENCONTRADA' ? 404 : 400;
      return res.status(estado).json({ error: resultado.motivo || 'No se pudo actualizar la cuenta bancaria' });
    }
    return res.json({ ok: true, cuenta: resultado.cuenta });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al actualizar la cuenta bancaria' });
  }
});

// [SEC S-02]
router.put('/empresas/:idEmpresa/cuentas/:iban/predeterminada', requirePermission('empresas.editar'), async (req, res) => {
  const iban = limpiarIban(req.params.iban);
  if (!iban) return res.status(400).json({ error: 'iban es obligatorio' });
  try {
    const empresa = await buscarEmpresaPorId(req.params.idEmpresa);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    const cuenta = await buscarCuentaDeEmpresa(empresa, iban);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta bancaria no encontrada en esta empresa' });
    if (cuenta.activa === false) {
      return res.status(409).json({ error: 'La cuenta está desactivada: actívala antes de marcarla como predeterminada' });
    }
    await fijarIbanPredeterminado(empresa, cuenta.iban);
    return res.json({ ok: true, ibanPredeterminado: cuenta.iban });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al marcar la cuenta como predeterminada' });
  }
});

// [SEC S-02]
router.delete('/empresas/:idEmpresa/cuentas/:iban', requirePermission('empresas.editar'), async (req, res) => {
  const iban = limpiarIban(req.params.iban);
  if (!iban) return res.status(400).json({ error: 'iban es obligatorio' });
  try {
    const empresa = await buscarEmpresaPorId(req.params.idEmpresa);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    const cuenta = await buscarCuentaDeEmpresa(empresa, iban);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta bancaria no encontrada en esta empresa' });
    if (iban === ibanPredeterminadoDeEmpresa(empresa)) {
      return res.status(409).json({
        error: 'No se puede desactivar la cuenta predeterminada. Marca antes otra cuenta como predeterminada.',
      });
    }
    // Las cuentas no se borran nunca: se desactivan.
    const resultado = await desactivarCuenta(iban, usuarioDePeticion(req));
    if (!resultado.ok) {
      const estado = resultado.code === 'NO_ENCONTRADA' ? 404 : 400;
      return res.status(estado).json({ error: resultado.motivo || 'No se pudo desactivar la cuenta bancaria' });
    }
    return res.json({ ok: true, cuenta: resultado.cuenta });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al desactivar la cuenta bancaria' });
  }
});

export default router;
