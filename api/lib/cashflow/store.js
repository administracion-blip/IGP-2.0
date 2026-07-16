import crypto from 'crypto';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';

const table = () => tables.cashflow;

export function pkLocal(localId) {
  return `LOCAL#${formatId6(localId)}`;
}

export function skFecha(fecha, movimientoId) {
  return `FECHA#${fecha}#${movimientoId}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return crypto.randomUUID();
}

export async function nextNumeroRecibo(anio) {
  const y = String(anio);
  const Key = { PK: 'META#SECUENCIAL', SK: `CF#${y}` };
  const r = await docClient.send(
    new UpdateCommand({
      TableName: table(),
      Key,
      UpdateExpression: 'ADD #n :one SET entityType = :t',
      ExpressionAttributeNames: { '#n': 'n' },
      ExpressionAttributeValues: { ':one': 1, ':t': 'secuencial' },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const n = Number(r.Attributes?.n) || 1;
  return `CF-${y}-${String(n).padStart(5, '0')}`;
}

export async function getMovimientoById(movimientoId) {
  const r = await docClient.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'MovimientoId-index',
      KeyConditionExpression: 'movimientoId = :id',
      ExpressionAttributeValues: { ':id': String(movimientoId) },
      Limit: 1,
    }),
  );
  return r.Items?.[0] || null;
}

export async function queryMovimientosLocalRango(localId, dateFrom, dateTo) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
        ExpressionAttributeValues: {
          ':pk': pkLocal(localId),
          ':lo': `FECHA#${dateFrom}#`,
          ':hi': `FECHA#${dateTo}#\uffff`,
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

export async function putMovimiento(item) {
  await docClient.send(new PutCommand({ TableName: table(), Item: item }));
  return item;
}

export async function resolveLocalEmpresa(localId) {
  const id = formatId6(localId);
  const locR = await docClient.send(
    new GetCommand({ TableName: tables.locales, Key: { id_Locales: id } }),
  );
  const loc = locR.Item;
  if (!loc) return null;
  const localNombre = String(loc.nombre ?? loc.Nombre ?? '').trim();
  const empresaNombre = String(loc.empresa ?? loc.Empresa ?? '').trim();
  const agoraCode = String(loc.agoraCode ?? loc.AgoraCode ?? '').trim();

  let empresaId = '';
  let empresaCif = '';
  if (empresaNombre) {
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    const empScan = await docClient.send(new ScanCommand({ TableName: tables.empresas }));
    const norm = empresaNombre.toLowerCase();
    const emp = (empScan.Items || []).find(
      (e) => String(e.Nombre ?? '').trim().toLowerCase() === norm,
    );
    if (emp) {
      empresaId = String(emp.id_empresa ?? '').trim();
      empresaCif = String(emp.Cif ?? emp.CIF ?? '').trim();
    }
  }

  return {
    localId: id,
    localNombre,
    empresaNombre,
    empresaId,
    empresaCif,
    agoraCode,
  };
}

/** Agrega movimientos firmados para efectivo a ingresar. */
export function agregarCashflowPorLocal(items) {
  let pagos = 0;
  let cobrosBanco = 0;
  let cobrosReparto = 0;
  for (const m of items) {
    if (String(m.estado) !== 'Firmado') continue;
    const imp = Number(m.importe) || 0;
    if (m.tipo === 'pago') pagos += imp;
    else if (m.tipo === 'cobro') {
      if (m.destinoCobro === 'reparto_socios') cobrosReparto += imp;
      else if (m.destinoCobro === 'banco' || !m.destinoCobro) cobrosBanco += imp;
    }
  }
  return {
    pagosFueraCaja: Math.round(pagos * 100) / 100,
    cobrosFueraCaja: Math.round(cobrosBanco * 100) / 100,
    cobrosRepartoSocios: Math.round(cobrosReparto * 100) / 100,
    ajusteNeto: Math.round((cobrosBanco - pagos) * 100) / 100,
  };
}
