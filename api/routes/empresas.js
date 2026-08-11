import { Router } from 'express';
import { ScanCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { normalizeCif, getCifFromEmpresaItem, getIdEmpresaFromItem } from '../lib/empresaCif.js';
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

const TABLE_EMPRESAS_ATTRS = ['id_empresa', 'Nombre', 'Cif', 'Iban', 'IbanAlternativo', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Email', 'Telefono', 'Tipo de recibo', 'Vencimiento', 'Etiqueta', 'Cuenta contable', 'Administrador', 'Sede', 'CCC'];

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

export default router;
