/**
 * Alta (o reactivación) de una cuenta bancaria en el maestro de empresas.
 *
 * Compartido por `POST /empresas/:id/cuentas` y
 * `POST /banca/ficheros/:hash/asignar-cuenta` para no divergir criterios de
 * predeterminada ni de asignación de movimientos huérfanos.
 */

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from './db.js';
import {
  normalizeCif,
  getCifFromEmpresaItem,
  getIdEmpresaFromItem,
  getNombreFromEmpresaItem,
} from './empresaCif.js';
import { ibanPredeterminadoDeEmpresa } from './empresaIban.js';
import { limpiarIban } from './remesas/iban.js';
import {
  bancoDesdeIban,
  listarCuentasDeEmpresa,
  crearCuenta,
} from './dynamo/bankAccounts.js';
import { asignarEmpresaAMovimientos } from './banca/store.js';

const tableEmpresasName = tables.empresas;

/** Escritura dual del puntero: `IbanPredeterminado` + el campo viejo `Iban`. */
export async function fijarIbanPredeterminado(empresaItem, iban) {
  await docClient.send(new UpdateCommand({
    TableName: tableEmpresasName,
    // Valor literal del ítem: nunca formatId6(), o se crea una empresa huérfana.
    Key: { id_empresa: getIdEmpresaFromItem(empresaItem) },
    UpdateExpression: 'SET IbanPredeterminado = :iban, Iban = :iban',
    ConditionExpression: 'attribute_exists(id_empresa)',
    ExpressionAttributeValues: { ':iban': iban },
  }));
}

/**
 * @param {Record<string, unknown>} empresa ítem de `igp_Empresas` ya localizado
 * @param {{ iban: string, bancoCodigo?: unknown, bancoNombre?: unknown, notas?: unknown,
 *   predeterminada: boolean, usuario?: string }} datos
 * @returns {Promise<
 *   | { ok: true, cuenta: Record<string, unknown>, reactivada: boolean,
 *       ibanPredeterminado: string, movimientosAsignados: number }
 *   | { ok: false, code: string, motivo?: string, empresaId?: string, empresaNombre?: string }
 * >}
 */
export async function altaCuentaBancariaEmpresa(empresa, {
  iban,
  bancoCodigo,
  bancoNombre,
  notas,
  predeterminada,
  usuario,
}) {
  const ibanSolicitado = limpiarIban(iban);
  if (!ibanSolicitado) {
    return { ok: false, code: 'IBAN_INVALIDO', motivo: 'iban es obligatorio' };
  }

  const idEmpresa = getIdEmpresaFromItem(empresa);
  const cuentasPrevias = await listarCuentasDeEmpresa(idEmpresa);
  const banco = bancoDesdeIban(ibanSolicitado);

  const resultado = await crearCuenta({
    iban: ibanSolicitado,
    empresaId: idEmpresa,
    empresaCif: normalizeCif(getCifFromEmpresaItem(empresa)),
    empresaNombre: getNombreFromEmpresaItem(empresa),
    bancoCodigo: bancoCodigo != null && String(bancoCodigo).trim() !== ''
      ? bancoCodigo
      : banco.bancoCodigo,
    bancoNombre: bancoNombre != null && String(bancoNombre).trim() !== ''
      ? bancoNombre
      : banco.bancoNombre,
    notas,
    usuario,
  });

  if (!resultado.ok) {
    return {
      ok: false,
      code: resultado.code,
      motivo: resultado.motivo,
      empresaId: resultado.empresaId,
      empresaNombre: resultado.empresaNombre,
    };
  }

  const cuenta = resultado.cuenta;
  const ibanPredeterminadoActual = ibanPredeterminadoDeEmpresa(empresa);
  // Primera cuenta de la empresa (o empresa sin puntero): tiene que quedar apuntada.
  const debePredeterminar = predeterminada === true
    || cuentasPrevias.length === 0
    || !ibanPredeterminadoActual;
  if (debePredeterminar) await fijarIbanPredeterminado(empresa, cuenta.iban);

  let movimientosAsignados = 0;
  try {
    ({ actualizados: movimientosAsignados } = await asignarEmpresaAMovimientos(
      cuenta.iban,
      idEmpresa,
      { empresaNombre: getNombreFromEmpresaItem(empresa) },
    ));
  } catch (err) {
    // Que falle no invalida el alta de la cuenta.
    console.error('No se pudieron asignar los movimientos bancarios a la empresa:', err);
  }

  return {
    ok: true,
    cuenta,
    reactivada: resultado.reactivada === true,
    ibanPredeterminado: debePredeterminar ? cuenta.iban : ibanPredeterminadoActual,
    movimientosAsignados,
  };
}

/**
 * Traduce el fallo de `altaCuentaBancariaEmpresa` / `crearCuenta` a status + body HTTP.
 * @param {{ code?: string, motivo?: string, empresaId?: string, empresaNombre?: string }} resultado
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function httpErrorAltaCuenta(resultado) {
  if (resultado?.code === 'IBAN_INVALIDO') {
    return { status: 400, body: { error: resultado.motivo || 'IBAN inválido' } };
  }
  if (resultado?.code === 'IBAN_DUPLICADO') {
    const donde = resultado.empresaNombre || `la empresa ${resultado.empresaId}`;
    return {
      status: 409,
      body: {
        error: `Ese IBAN ya está dado de alta en ${donde}`,
        empresaId: resultado.empresaId,
        empresaNombre: resultado.empresaNombre,
      },
    };
  }
  if (resultado?.code === 'CUENTA_YA_EXISTE') {
    return { status: 409, body: { error: 'Esa cuenta ya existe en esta empresa' } };
  }
  return { status: 400, body: { error: resultado?.motivo || 'No se pudo crear la cuenta bancaria' } };
}
