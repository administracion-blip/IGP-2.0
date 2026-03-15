import { Router } from 'express';
import { ScanCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = Router();
const tableEmpresasName = tables.empresas;

function formatId6(val) {
  if (val == null || val === '') return '000000';
  const n = parseInt(String(val).replace(/^0+/, ''), 10) || 0;
  return String(Math.max(0, n)).padStart(6, '0');
}

function normalizeCif(val) {
  return String(val ?? '').trim().toUpperCase();
}

function normalizarEtiqueta(val) {
  if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
  if (val != null && val !== '') return [String(val).trim()];
  return [];
}

const TABLE_EMPRESAS_ATTRS = ['id_empresa', 'Nombre', 'Cif', 'Iban', 'IbanAlternativo', 'Direccion', 'Cp', 'Municipio', 'Provincia', 'Email', 'Telefono', 'Tipo de recibo', 'Vencimiento', 'Etiqueta', 'Cuenta contable', 'Administrador', 'Sede', 'CCC'];

router.get('/empresas', async (req, res) => {
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

router.get('/empresas/check-cif', async (req, res) => {
  const cif = normalizeCif(req.query?.cif);
  const excludeId = req.query?.excludeId != null ? String(req.query.excludeId).trim() : '';
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
      const itemCif = normalizeCif(item?.Cif);
      return itemCif && itemCif === cif && String(item.id_empresa ?? '') !== excludeId;
    });
    return res.json({ exists });
  } catch (err) {
    console.error('DynamoDB error:', err);
    return res.status(500).json({ error: err.message || 'Error al comprobar CIF' });
  }
});

router.post('/empresas', async (req, res) => {
  const body = req.body || {};
  if (!body.Nombre || !String(body.Nombre).trim()) {
    return res.status(400).json({ error: 'Nombre es obligatorio' });
  }
  if (!body.Cif || !String(body.Cif).trim()) {
    return res.status(400).json({ error: 'CIF es obligatorio' });
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
    const dup = items.some((item) => normalizeCif(item?.Cif) === cifValue);
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') {
        const v = body.id_empresa;
        item[key] = v != null ? formatId6(v) : '000000';
      } else if (key === 'Etiqueta') {
        item[key] = normalizarEtiqueta(body[key]);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : '';
      }
    }
    await docClient.send(new PutCommand({
      TableName: tableEmpresasName,
      Item: item,
    }));
    res.json({ ok: true, empresa: item });
  } catch (err) {
    console.error('DynamoDB error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar la empresa' });
  }
});

router.put('/empresas', async (req, res) => {
  const body = req.body || {};
  const idEmpresa = body.id_empresa != null ? String(body.id_empresa) : '';
  if (!idEmpresa) return res.status(400).json({ error: 'id_empresa es obligatorio para editar' });
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
    const dup = items.find(
      (item) => normalizeCif(item?.Cif) === cifValue && String(item.id_empresa ?? '') !== idEmpresa
    );
    if (dup) {
      return res.status(409).json({ error: 'CIF ya existe' });
    }

    const getCmd = new GetCommand({
      TableName: tableEmpresasName,
      Key: { id_empresa: idEmpresa },
    });
    const got = await docClient.send(getCmd);
    const existing = got.Item || {};
    const item = {};
    for (const key of TABLE_EMPRESAS_ATTRS) {
      if (key === 'id_empresa') item[key] = idEmpresa;
      else if (key === 'Etiqueta') {
        item[key] = body[key] != null ? normalizarEtiqueta(body[key]) : normalizarEtiqueta(existing[key] ?? existing.Alias);
      } else if (key === 'Cif') {
        item[key] = cifValue;
      } else {
        const v = body[key];
        item[key] = v != null && v !== '' ? String(v) : String(existing[key] ?? '');
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

router.delete('/empresas', async (req, res) => {
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
