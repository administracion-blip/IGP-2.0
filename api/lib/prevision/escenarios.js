/**
 * Escenarios guardados de la Previsión por franjas (Igp_PrevisionEscenarios).
 * PK = USER#<id_usuario> (propios) | GLOBAL (compartidos), SK = ESC#<uuid>.
 */
import crypto from 'crypto';
import { QueryCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { esFechaIso } from './franjas.js';

export const AMBITOS = Object.freeze({ PROPIO: 'propio', GLOBAL: 'global' });
const MAX_NOMBRE = 80;
const MAX_LISTA = 100;
const RE_ID = /^[0-9a-f-]{36}$/i;

function errorHttp(mensaje, status = 400) {
  return Object.assign(new Error(mensaje), { status });
}

export function idUsuarioDe(user) {
  return String(user?.sub ?? user?.id_usuario ?? '').trim();
}

export function normalizarAmbito(valor) {
  const a = String(valor ?? AMBITOS.PROPIO).trim().toLowerCase();
  if (a !== AMBITOS.PROPIO && a !== AMBITOS.GLOBAL) throw errorHttp("ambito debe ser 'propio' o 'global'");
  return a;
}

/** PK del ámbito. El propio sale siempre del usuario autenticado, nunca del cuerpo. */
export function pkDeAmbito(ambito, user) {
  if (ambito === AMBITOS.GLOBAL) return 'GLOBAL';
  const id = idUsuarioDe(user);
  if (!id) throw errorHttp('No se pudo identificar al usuario', 401);
  return `USER#${id}`;
}

export function normalizarIdEscenario(valor) {
  const id = String(valor ?? '').trim();
  if (!RE_ID.test(id)) throw errorHttp('id de escenario no válido');
  return id;
}

function listaFechas(valor, campo) {
  const lista = valor ?? [];
  if (!Array.isArray(lista) || lista.length > MAX_LISTA) {
    throw errorHttp(`${campo} debe ser una lista de hasta ${MAX_LISTA} elementos`);
  }
  for (const f of lista) if (!esFechaIso(f)) throw errorHttp(`${campo} contiene fechas no válidas`);
  return [...new Set(lista)];
}

function listaCodigos(valor, campo) {
  const lista = valor ?? [];
  if (!Array.isArray(lista) || lista.length > MAX_LISTA) {
    throw errorHttp(`${campo} debe ser una lista de hasta ${MAX_LISTA} elementos`);
  }
  const out = [];
  for (const v of lista) {
    const s = String(v ?? '').trim();
    if (!s || s.length > 40) throw errorHttp(`${campo} contiene valores no válidos`);
    out.push(s);
  }
  return [...new Set(out)];
}

/** Valida los datos editables de un escenario. Lanza Error con status 400. */
export function validarDatosEscenario(body) {
  const nombre = String(body?.nombre ?? '').trim();
  if (!nombre) throw errorHttp('nombre es obligatorio');
  if (nombre.length > MAX_NOMBRE) throw errorHttp(`nombre no puede superar ${MAX_NOMBRE} caracteres`);
  const fechaDesde = String(body?.fechaDesde ?? '').trim();
  const fechaHasta = String(body?.fechaHasta ?? '').trim();
  if (!esFechaIso(fechaDesde) || !esFechaIso(fechaHasta)) {
    throw errorHttp('fechaDesde y fechaHasta deben ser fechas YYYY-MM-DD');
  }
  if (fechaDesde > fechaHasta) throw errorHttp('fechaDesde no puede ser posterior a fechaHasta');
  const plantillaId = String(body?.plantillaId ?? '').trim();
  if (!plantillaId || plantillaId.length > 100) throw errorHttp('plantillaId es obligatorio');
  const objetivo = Number(body?.objetivoEurEmpHora);
  if (!Number.isFinite(objetivo) || objetivo <= 0) {
    throw errorHttp('objetivoEurEmpHora debe ser un número mayor que 0');
  }
  return {
    nombre,
    fechaDesde,
    fechaHasta,
    diasExcluidos: listaFechas(body?.diasExcluidos, 'diasExcluidos'),
    workplaceIds: listaCodigos(body?.workplaceIds, 'workplaceIds'),
    plantillaId,
    objetivoEurEmpHora: objetivo,
  };
}

export function aRespuesta(item) {
  const ambito = item.PK === 'GLOBAL' ? AMBITOS.GLOBAL : AMBITOS.PROPIO;
  return {
    id: String(item.SK).replace(/^ESC#/, ''),
    ambito,
    nombre: item.nombre ?? '',
    fechaDesde: item.fechaDesde ?? '',
    fechaHasta: item.fechaHasta ?? '',
    diasExcluidos: Array.isArray(item.diasExcluidos) ? item.diasExcluidos : [],
    workplaceIds: Array.isArray(item.workplaceIds) ? item.workplaceIds : [],
    plantillaId: item.plantillaId ?? '',
    objetivoEurEmpHora: Number(item.objetivoEurEmpHora) || 0,
    creadoPor: item.creadoPor ?? '',
    creadoEn: item.creadoEn ?? '',
    actualizadoEn: item.actualizadoEn ?? '',
  };
}

async function queryPk(pk) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: tables.previsionEscenarios,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :esc)',
      ExpressionAttributeValues: { ':pk': pk, ':esc': 'ESC#' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/** Propios del usuario + globales, ordenados por nombre. */
export async function listarEscenarios(user) {
  const [propios, globales] = await Promise.all([
    queryPk(pkDeAmbito(AMBITOS.PROPIO, user)),
    queryPk('GLOBAL'),
  ]);
  return [...propios, ...globales]
    .map(aRespuesta)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
}

export async function crearEscenario(user, ambito, datos) {
  const ahora = new Date().toISOString();
  const item = {
    PK: pkDeAmbito(ambito, user),
    SK: `ESC#${crypto.randomUUID()}`,
    ...datos,
    creadoPor: idUsuarioDe(user),
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
  await docClient.send(new PutCommand({
    TableName: tables.previsionEscenarios,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  return aRespuesta(item);
}

export async function actualizarEscenario(user, ambito, id, datos) {
  const ahora = new Date().toISOString();
  const campos = { ...datos, actualizadoEn: ahora };
  const nombres = {};
  const valores = {};
  const sets = Object.entries(campos).map(([k, v], i) => {
    nombres[`#c${i}`] = k;
    valores[`:v${i}`] = v;
    return `#c${i} = :v${i}`;
  });
  try {
    const r = await docClient.send(new UpdateCommand({
      TableName: tables.previsionEscenarios,
      Key: { PK: pkDeAmbito(ambito, user), SK: `ESC#${id}` },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: nombres,
      ExpressionAttributeValues: valores,
      ReturnValues: 'ALL_NEW',
    }));
    return aRespuesta(r.Attributes);
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') throw errorHttp('Escenario no encontrado', 404);
    throw err;
  }
}

export async function borrarEscenario(user, ambito, id) {
  try {
    await docClient.send(new DeleteCommand({
      TableName: tables.previsionEscenarios,
      Key: { PK: pkDeAmbito(ambito, user), SK: `ESC#${id}` },
      ConditionExpression: 'attribute_exists(PK)',
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') throw errorHttp('Escenario no encontrado', 404);
    throw err;
  }
}
