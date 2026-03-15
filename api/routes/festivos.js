import crypto from 'node:crypto';
import express from 'express';
import { ScanCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';

const router = express.Router();

// GET /gestion-festivos
router.get('/gestion-festivos', async (req, res) => {
  try {
    const items = [];
    let lastKey = null;
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: tables.gestionFestivos,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
    const registros = items
      .filter((i) => i.PK != null && i.SK != null)
      .map(({ PK, SK, ...rest }) => ({ id: `${PK}#${SK}`, PK, _pk: PK, _sk: SK, ...rest }))
      .sort((a, b) => String(a.FechaComparativa ?? a.Fecha ?? '').localeCompare(String(b.FechaComparativa ?? b.Fecha ?? '')));
    res.json({ registros });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return res.json({ registros: [], error: 'Tabla no existe. Ejecuta: node api/scripts/create-gestion-festivos-table.js' });
    }
    console.error('[gestion-festivos GET]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al listar' });
  }
});

// POST /gestion-festivos
router.post('/gestion-festivos', async (req, res) => {
  const body = req.body || {};
  const fechaComparativa = String(body.FechaComparativa ?? body.fechaComparativa ?? body.Fecha ?? body.fecha ?? '').trim();
  if (!fechaComparativa) {
    return res.status(400).json({ error: 'FechaComparativa obligatoria' });
  }
  try {
    const id = crypto.randomUUID();
    const festivo = body.Festivo === true || body.festivo === true || body.Festivo === 'true' || body.festivo === 'true';
    const item = {
      PK: 'GLOBAL',
      SK: id,
      FechaComparativa: fechaComparativa,
      Festivo: festivo,
      NombreFestivo: String(body.NombreFestivo ?? body.nombreFestivo ?? '').trim(),
    };
    await docClient.send(new PutCommand({
      TableName: tables.gestionFestivos,
      Item: item,
    }));
    res.json({ ok: true, registro: { id: `GLOBAL#${id}`, ...item } });
  } catch (err) {
    console.error('[gestion-festivos POST]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al crear' });
  }
});

// PUT /gestion-festivos
router.put('/gestion-festivos', async (req, res) => {
  const body = req.body || {};
  const idRaw = String(body.id ?? body.ID ?? '').trim();
  if (!idRaw) return res.status(400).json({ error: 'id es obligatorio para editar' });
  const [pk, sk] = idRaw.includes('#') ? idRaw.split('#') : ['GLOBAL', idRaw];
  const fechaComparativa = String(body.FechaComparativa ?? body.fechaComparativa ?? body.Fecha ?? body.fecha ?? '').trim();
  if (!fechaComparativa) {
    return res.status(400).json({ error: 'FechaComparativa obligatoria' });
  }
  try {
    const festivo = body.Festivo === true || body.festivo === true || body.Festivo === 'true' || body.festivo === 'true';
    const item = {
      PK: pk,
      SK: sk,
      FechaComparativa: fechaComparativa,
      Festivo: festivo,
      NombreFestivo: String(body.NombreFestivo ?? body.nombreFestivo ?? '').trim(),
    };
    await docClient.send(new PutCommand({
      TableName: tables.gestionFestivos,
      Item: item,
    }));
    res.json({ ok: true, registro: { id: `${pk}#${sk}`, ...item } });
  } catch (err) {
    console.error('[gestion-festivos PUT]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al actualizar' });
  }
});

// DELETE /gestion-festivos
router.delete('/gestion-festivos', async (req, res) => {
  const idRaw = (req.query?.id ?? req.body?.id ?? '').toString().trim();
  if (!idRaw) return res.status(400).json({ error: 'id es obligatorio para borrar' });
  const [pk, sk] = idRaw.includes('#') ? idRaw.split('#') : ['GLOBAL', idRaw];
  try {
    await docClient.send(new DeleteCommand({
      TableName: tables.gestionFestivos,
      Key: { PK: pk, SK: sk },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[gestion-festivos DELETE]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al borrar' });
  }
});

// POST /gestion-festivos/generar-rango
router.post('/gestion-festivos/generar-rango', async (req, res) => {
  const body = req.body || {};
  const dateFrom = String(body.dateFrom ?? body.fechaDesde ?? body.fechaInicio ?? '').trim();
  const dateTo = String(body.dateTo ?? body.fechaHasta ?? body.fechaFin ?? '').trim();
  if (!dateFrom || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !dateTo || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return res.status(400).json({ error: 'dateFrom y dateTo obligatorios (YYYY-MM-DD)' });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ error: 'dateFrom debe ser <= dateTo' });
  }
  try {
    let count = 0;
    const start = new Date(dateFrom + 'T12:00:00');
    const end = new Date(dateTo + 'T12:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const fecha = d.toISOString().slice(0, 10);
      const item = {
        PK: fecha,
        SK: '0',
        FechaComparativa: fecha,
        Festivo: false,
        NombreFestivo: '',
      };
      await docClient.send(new PutCommand({
        TableName: tables.gestionFestivos,
        Item: item,
      }));
      count++;
    }
    res.json({ ok: true, creados: count });
  } catch (err) {
    console.error('[gestion-festivos generar-rango]', err.message || err);
    res.status(500).json({ error: err.message || 'Error al generar registros' });
  }
});

export default router;
