/**
 * Tabla `Igp_BankAccounts` — cuentas bancarias de las empresas (N por empresa).
 *
 * PK = "ACCOUNT#<iban>" · SK = "META"
 * GSI EmpresaId-Iban-index: HASH empresaId, RANGE iban (proyección ALL).
 *
 * El IBAN es la clave de partición, así que un mismo IBAN no puede estar dado
 * de alta en dos empresas: la colisión se detecta y se informa (pasa de verdad
 * con proveedores duplicados en el maestro).
 *
 * Las cuentas no tienen "uso" (cobros/pagos/nóminas): son cuentas de la
 * empresa. La cuenta predeterminada NO es un flag de la cuenta, es el puntero
 * `IbanPredeterminado` de la ficha de empresa (`igp_Empresas`), de modo que es
 * imposible tener dos predeterminadas o ninguna. Una cuenta nunca se borra:
 * se desactiva (`activa: false`).
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { validarIban, limpiarIban } from '../remesas/iban.js';
import { formatId6 } from '../usuarioLocales.js';

const TABLE_NAME = tables.bankAccounts;

export const GSI_EMPRESA_IBAN = 'EmpresaId-Iban-index';
export const SK_META = 'META';

/** Catálogo de entidades españolas (4 primeros dígitos del IBAN ES). Editable. */
const ENTIDADES_ES = {
  '0019': 'Deutsche Bank',
  '0030': 'Banesto',
  '0049': 'Banco Santander',
  '0237': 'Cajasur Banco',
  '0487': 'Banco Mare Nostrum',
  '3023': 'Caja Rural de Granada',
  '0075': 'Banco Popular',
  '0081': 'Banco Sabadell',
  '0073': 'Open Bank',
  '0128': 'Bankinter',
  '0182': 'BBVA',
  '0186': 'Banco Mediolanum',
  '0234': 'Banco Caminos',
  '0239': 'EVO Banco',
  '0061': 'Banca March',
  '1465': 'ING',
  '1491': 'Triodos Bank',
  '2100': 'CaixaBank',
  '2038': 'Bankia',
  '2080': 'Abanca',
  '2085': 'Ibercaja',
  '2095': 'Kutxabank',
  '2103': 'Unicaja Banco',
  '3058': 'Cajamar',
  '3025': "Caixa d'Enginyers",
  '3081': 'Eurocaja Rural',
  '3183': 'Arquia Bank',
  '3187': 'Caja Rural de Aragón',
};

/** Clave de partición de una cuenta. */
export function pkCuenta(iban) {
  return `ACCOUNT#${limpiarIban(iban)}`;
}

/**
 * Deduce entidad bancaria del IBAN. Solo IBAN español: los 4 dígitos de
 * entidad ocupan las posiciones 4..8. Si el código no está en el catálogo,
 * devuelve el código con nombre vacío (se rellena a mano desde la ficha).
 * @param {string} iban
 * @returns {{ bancoCodigo: string, bancoNombre: string }}
 */
export function bancoDesdeIban(iban) {
  const norm = limpiarIban(iban);
  if (!norm.startsWith('ES') || norm.length < 8) return { bancoCodigo: '', bancoNombre: '' };
  const bancoCodigo = norm.slice(4, 8);
  if (!/^\d{4}$/.test(bancoCodigo)) return { bancoCodigo: '', bancoNombre: '' };
  return { bancoCodigo, bancoNombre: ENTIDADES_ES[bancoCodigo] || '' };
}

/**
 * Compara dos id_empresa. Los ids del maestro no están normalizados de forma
 * consistente (unos con ceros a la izquierda y otros no), así que se compara
 * también con padding a 6 dígitos.
 */
function mismaEmpresa(a, b) {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  return formatId6(sa) === formatId6(sb);
}

function texto(val) {
  return val != null ? String(val).trim() : '';
}

/**
 * Cuentas de una empresa (Query sobre el GSI, ordenadas por IBAN).
 * Consulta también la variante del id con ceros a la izquierda cuando difiere,
 * porque el maestro guarda unos ids rellenos y otros no.
 * @param {string} empresaId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listarCuentasDeEmpresa(empresaId) {
  const id = texto(empresaId);
  if (!id) return [];
  const candidatos = [id];
  const relleno = formatId6(id);
  if (relleno !== id && relleno !== '000000') candidatos.push(relleno);
  // …y la forma sin ceros: el maestro guarda unos ids como "12" y otros "000012".
  const escueto = String(parseInt(id, 10) || 0);
  if (escueto !== '0' && !candidatos.includes(escueto)) candidatos.push(escueto);

  const porIban = new Map();
  for (const candidato of candidatos) {
    let lastKey = null;
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: GSI_EMPRESA_IBAN,
          KeyConditionExpression: 'empresaId = :empresaId',
          ExpressionAttributeValues: { ':empresaId': candidato },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }),
      );
      for (const item of result.Items || []) {
        const clave = limpiarIban(item?.iban);
        if (clave && !porIban.has(clave)) porIban.set(clave, item);
      }
      lastKey = result.LastEvaluatedKey || null;
    } while (lastKey);
  }
  return [...porIban.values()].sort((a, b) => String(a.iban).localeCompare(String(b.iban)));
}

/**
 * Cuenta por IBAN (GetItem). Lo usará el módulo N43 para resolver la empresa
 * de un extracto a partir del IBAN del fichero.
 * @param {string} iban
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function getCuentaByIban(iban) {
  const norm = limpiarIban(iban);
  if (!norm) return null;
  const result = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: pkCuenta(norm), SK: SK_META } }),
  );
  return result.Item || null;
}

/**
 * Ordena cuentas para listados: primero la predeterminada, luego las activas,
 * al final las desactivadas; dentro de cada grupo, por IBAN.
 * @param {Array<Record<string, unknown>>} cuentas
 * @param {string} ibanPredeterminado
 */
export function ordenarCuentas(cuentas, ibanPredeterminado) {
  const pred = limpiarIban(ibanPredeterminado);
  const peso = (c) => {
    if (pred && limpiarIban(c?.iban) === pred) return 0;
    return c?.activa === false ? 2 : 1;
  };
  return [...(cuentas || [])].sort((a, b) => {
    const d = peso(a) - peso(b);
    if (d !== 0) return d;
    return String(a?.iban ?? '').localeCompare(String(b?.iban ?? ''));
  });
}

/** Reactiva una cuenta inactiva de la misma empresa (con los datos nuevos). */
async function reactivarCuenta(existente, { bancoCodigo, bancoNombre, notas, autor, ahora }) {
  const sets = ['activa = :activa', 'actualizadoEn = :ahora', 'actualizadoPor = :autor'];
  const values = { ':activa': true, ':ahora': ahora, ':autor': autor };
  if (bancoCodigo) {
    sets.push('bancoCodigo = :bancoCodigo');
    values[':bancoCodigo'] = bancoCodigo;
  }
  if (bancoNombre) {
    sets.push('bancoNombre = :bancoNombre');
    values[':bancoNombre'] = bancoNombre;
  }
  if (notas) {
    sets.push('notas = :notas');
    values[':notas'] = notas;
  }
  values[':empresaId'] = existente.empresaId;
  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: existente.PK, SK: existente.SK ?? SK_META },
      UpdateExpression: `SET ${sets.join(', ')}`,
      // La cuenta puede haber cambiado de manos entre el Get y el Update.
      ConditionExpression: 'attribute_exists(PK) AND empresaId = :empresaId',
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return { ok: true, reactivada: true, cuenta: result.Attributes };
}

/** Decide qué hacer cuando el IBAN ya existe en la tabla. */
async function resolverCuentaExistente(existente, datos) {
  if (!mismaEmpresa(existente.empresaId, datos.empresaId)) {
    return {
      ok: false,
      code: 'IBAN_DUPLICADO',
      empresaId: texto(existente.empresaId),
      empresaNombre: texto(existente.empresaNombre),
    };
  }
  if (existente.activa === false) return reactivarCuenta(existente, datos);
  return { ok: false, code: 'CUENTA_YA_EXISTE', cuenta: existente };
}

/**
 * Crea una cuenta bancaria de una empresa.
 *
 * Si el IBAN ya existe: en otra empresa devuelve `IBAN_DUPLICADO` (con la
 * empresa que lo tiene), en la misma empresa pero inactivo lo reactiva, y en la
 * misma empresa activo devuelve `CUENTA_YA_EXISTE`.
 *
 * @param {{ iban: string, empresaId: string, empresaCif?: string, empresaNombre?: string,
 *   bancoCodigo?: string, bancoNombre?: string, notas?: string, usuario?: string }} datos
 * @returns {Promise<{ ok: true, cuenta: Record<string, unknown>, reactivada?: boolean }
 *   | { ok: false, code: string, motivo?: string, empresaId?: string, empresaNombre?: string,
 *       cuenta?: Record<string, unknown> }>}
 */
export async function crearCuenta({
  iban,
  empresaId,
  empresaCif,
  empresaNombre,
  bancoCodigo,
  bancoNombre,
  notas,
  usuario,
}) {
  const validacion = validarIban(limpiarIban(iban));
  if (!validacion.valido) {
    return { ok: false, code: 'IBAN_INVALIDO', motivo: validacion.motivo || 'IBAN inválido' };
  }
  const ibanNorm = validacion.iban;
  const empresa = texto(empresaId);
  if (!empresa) {
    return { ok: false, code: 'EMPRESA_REQUERIDA', motivo: 'Falta la empresa de la cuenta' };
  }

  const deducido = bancoDesdeIban(ibanNorm);
  const datos = {
    empresaId: empresa,
    bancoCodigo: texto(bancoCodigo) || deducido.bancoCodigo,
    bancoNombre: texto(bancoNombre) || deducido.bancoNombre,
    notas: texto(notas),
    autor: texto(usuario),
    ahora: new Date().toISOString(),
  };

  const existente = await getCuentaByIban(ibanNorm);
  if (existente) return resolverCuentaExistente(existente, datos);

  const item = {
    PK: pkCuenta(ibanNorm),
    SK: SK_META,
    iban: ibanNorm,
    empresaId: empresa,
    empresaCif: texto(empresaCif),
    empresaNombre: texto(empresaNombre),
    bancoCodigo: datos.bancoCodigo,
    bancoNombre: datos.bancoNombre,
    notas: datos.notas,
    activa: true,
    creadoEn: datos.ahora,
    creadoPor: datos.autor,
    actualizadoEn: datos.ahora,
    actualizadoPor: datos.autor,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        // Sin la condición, dos altas simultáneas del mismo IBAN se pisarían:
        // el Get de arriba no protege la ventana hasta el Put.
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return { ok: true, cuenta: item };
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    const ganador = await getCuentaByIban(ibanNorm);
    if (!ganador) throw err;
    return resolverCuentaExistente(ganador, datos);
  }
}

/**
 * Actualiza los datos editables de una cuenta. El IBAN no se puede cambiar
 * (es la clave): para eso se desactiva la cuenta y se crea otra.
 * Solo se tocan los campos presentes en `datos`.
 *
 * @param {{ iban: string, bancoCodigo?: string, bancoNombre?: string, notas?: string,
 *   activa?: boolean, usuario?: string }} datos
 * @returns {Promise<{ ok: true, cuenta: Record<string, unknown> }
 *   | { ok: false, code: string, motivo?: string }>}
 */
export async function actualizarCuenta({ iban, bancoCodigo, bancoNombre, notas, activa, usuario }) {
  const validacion = validarIban(limpiarIban(iban));
  if (!validacion.valido) {
    return { ok: false, code: 'IBAN_INVALIDO', motivo: validacion.motivo || 'IBAN inválido' };
  }
  const ibanNorm = validacion.iban;

  const sets = ['actualizadoEn = :ahora', 'actualizadoPor = :autor'];
  const values = { ':ahora': new Date().toISOString(), ':autor': texto(usuario) };
  if (bancoCodigo !== undefined) {
    sets.push('bancoCodigo = :bancoCodigo');
    values[':bancoCodigo'] = texto(bancoCodigo);
  }
  if (bancoNombre !== undefined) {
    sets.push('bancoNombre = :bancoNombre');
    values[':bancoNombre'] = texto(bancoNombre);
  }
  if (notas !== undefined) {
    sets.push('notas = :notas');
    values[':notas'] = texto(notas);
  }
  if (activa !== undefined) {
    sets.push('activa = :activa');
    values[':activa'] = activa === true || String(activa) === 'true';
  }

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: pkCuenta(ibanNorm), SK: SK_META },
        UpdateExpression: `SET ${sets.join(', ')}`,
        // Sin la condición, un Update crearía la cuenta desde cero (sin empresa).
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return { ok: true, cuenta: result.Attributes };
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return { ok: false, code: 'NO_ENCONTRADA', motivo: 'La cuenta bancaria no existe' };
    }
    throw err;
  }
}

/**
 * Desactiva una cuenta (nunca se borra).
 * @param {string} iban
 * @param {string} [usuario]
 */
export async function desactivarCuenta(iban, usuario) {
  return actualizarCuenta({ iban, activa: false, usuario });
}
