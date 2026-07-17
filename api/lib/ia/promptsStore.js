/**
 * Plantillas de redacción editables por fuente sobre `Igp_IaPrompts`.
 *
 * Esquema (crear la tabla a mano en AWS):
 *   PK (String) — "FUENTE#<clave>"
 *   SK (String) — "PROMPT#<promptId>"
 *
 * Invariante: como máximo UNA plantilla con esDefault=true por fuente. Al marcar
 * una como default, se desmarcan las demás de esa fuente.
 *
 * Además de las plantillas de usuario, siempre existe una plantilla "default"
 * de código (no almacenada, no borrable) que actúa de fallback. La redacción de
 * la plantilla solo afecta al TEXTO del informe, nunca a los datos.
 */
import { GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { plantillaDefault } from './prompts.js';
import { nowIso, uuid } from './store.js';

export const PROMPT_ID_DEFAULT = 'default';

function pkFuente(fuente) {
  return `FUENTE#${fuente}`;
}

function skPrompt(promptId) {
  return `PROMPT#${promptId}`;
}

function limpiar(item) {
  const { PK, SK, ...resto } = item;
  return resto;
}

/** Plantilla default de código como objeto seleccionable (virtual). */
export function plantillaCodigo(fuenteClave) {
  const base = plantillaDefault(fuenteClave);
  return {
    promptId: PROMPT_ID_DEFAULT,
    fuente: fuenteClave,
    nombre: `${base.nombre} (por defecto)`,
    instrucciones: base.instrucciones,
    esDefault: true,
    deCodigo: true,
    actualizadoEn: 'code',
  };
}

/** Lista las plantillas de usuario de una fuente (sin la de código). */
export async function listarPlantillasUsuario(fuente) {
  const r = await docClient.send(new QueryCommand({
    TableName: tables.iaPrompts,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
    ExpressionAttributeValues: { ':pk': pkFuente(fuente), ':p': 'PROMPT#' },
  }));
  return (r.Items || []).map(limpiar);
}

/**
 * Todas las plantillas seleccionables de una fuente: la de código + las de
 * usuario. Si alguna de usuario es default, la de código deja de estar marcada.
 */
export async function listarPlantillas(fuente) {
  const usuario = await listarPlantillasUsuario(fuente);
  const hayDefaultUsuario = usuario.some((p) => p.esDefault);
  const codigo = plantillaCodigo(fuente);
  if (hayDefaultUsuario) codigo.esDefault = false;
  usuario.sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
  return [codigo, ...usuario];
}

/** Resuelve una plantilla concreta para ejecutar (código o usuario). */
export async function resolverPlantilla(fuente, promptId) {
  if (!promptId || promptId === PROMPT_ID_DEFAULT) {
    return plantillaCodigo(fuente);
  }
  const r = await docClient.send(new GetCommand({
    TableName: tables.iaPrompts,
    Key: { PK: pkFuente(fuente), SK: skPrompt(promptId) },
  }));
  if (!r.Item) return null;
  return limpiar(r.Item);
}

async function desmarcarDefaults(fuente, exceptoPromptId) {
  const usuario = await listarPlantillasUsuario(fuente);
  await Promise.all(
    usuario
      .filter((p) => p.esDefault && p.promptId !== exceptoPromptId)
      .map((p) =>
        docClient.send(new UpdateCommand({
          TableName: tables.iaPrompts,
          Key: { PK: pkFuente(fuente), SK: skPrompt(p.promptId) },
          UpdateExpression: 'SET esDefault = :f',
          ExpressionAttributeValues: { ':f': false },
        })),
      ),
  );
}

export async function crearPlantilla(fuente, { nombre, instrucciones, esDefault }, user) {
  const promptId = uuid();
  const ts = nowIso();
  const item = {
    PK: pkFuente(fuente),
    SK: skPrompt(promptId),
    promptId,
    fuente,
    nombre: String(nombre || '').trim(),
    instrucciones: String(instrucciones || '').trim(),
    esDefault: Boolean(esDefault),
    creadoPor: String(user?.id_usuario ?? user?.email ?? ''),
    creadoEn: ts,
    actualizadoEn: ts,
  };
  await docClient.send(new PutCommand({ TableName: tables.iaPrompts, Item: item }));
  if (item.esDefault) await desmarcarDefaults(fuente, promptId);
  return limpiar(item);
}

export async function actualizarPlantilla(fuente, promptId, { nombre, instrucciones, esDefault }) {
  const existente = await resolverPlantilla(fuente, promptId);
  if (!existente || existente.deCodigo) return null;
  const item = {
    PK: pkFuente(fuente),
    SK: skPrompt(promptId),
    promptId,
    fuente,
    nombre: nombre !== undefined ? String(nombre).trim() : existente.nombre,
    instrucciones: instrucciones !== undefined ? String(instrucciones).trim() : existente.instrucciones,
    esDefault: esDefault !== undefined ? Boolean(esDefault) : Boolean(existente.esDefault),
    creadoPor: existente.creadoPor,
    creadoEn: existente.creadoEn,
    actualizadoEn: nowIso(),
  };
  await docClient.send(new PutCommand({ TableName: tables.iaPrompts, Item: item }));
  if (item.esDefault) await desmarcarDefaults(fuente, promptId);
  return limpiar(item);
}

export async function borrarPlantilla(fuente, promptId) {
  if (!promptId || promptId === PROMPT_ID_DEFAULT) return false;
  await docClient.send(new DeleteCommand({
    TableName: tables.iaPrompts,
    Key: { PK: pkFuente(fuente), SK: skPrompt(promptId) },
  }));
  return true;
}
