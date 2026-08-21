/**
 * Asignación de IBAN pendiente_cuenta en el resumen de una carga (`Igp_BankFiles`).
 *
 * Se prueba la lógica pura (`aplicarAsignacionCuentaEnFichero`): no DynamoDB ni
 * express, mismo criterio que `bancaIngesta.test.mjs`.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  aplicarAsignacionCuentaEnFichero,
  ESTADO_FICHERO_CARGADO,
  ESTADO_FICHERO_EN_CURSO,
  ESTADO_FICHERO_PENDIENTE_CUENTA,
} from '../lib/banca/store.js';

const IBAN_A = 'ES9121000418450200051332';
const IBAN_B = 'ES1000492352082414205416';

function ficheroBase({ estado = ESTADO_FICHERO_PENDIENTE_CUENTA, cuentas } = {}) {
  return {
    hashFichero: 'hash-test',
    estado,
    cuentas: cuentas || [
      {
        iban: IBAN_A,
        cuentaRef: IBAN_A,
        pendienteAsignar: true,
        empresaId: '',
        empresaNombre: '',
        nuevos: 3,
      },
    ],
  };
}

test('tras asignar la única cuenta pendiente, el fichero pasa a cargado', () => {
  const actualizado = aplicarAsignacionCuentaEnFichero(
    ficheroBase(),
    IBAN_A,
    { empresaId: '000007', empresaNombre: 'HOSTELERIA DEL SUR SL' },
  );

  assert.ok(actualizado);
  assert.equal(actualizado.estado, ESTADO_FICHERO_CARGADO);
  assert.equal(actualizado.cuentas.length, 1);
  assert.equal(actualizado.cuentas[0].pendienteAsignar, false);
  assert.equal(actualizado.cuentas[0].empresaId, '000007');
  assert.equal(actualizado.cuentas[0].empresaNombre, 'HOSTELERIA DEL SUR SL');
});

test('si quedan otras cuentas pendientes, el estado sigue pendiente_cuenta', () => {
  const fichero = ficheroBase({
    cuentas: [
      {
        iban: IBAN_A,
        cuentaRef: IBAN_A,
        pendienteAsignar: true,
        empresaId: '',
        empresaNombre: '',
      },
      {
        iban: IBAN_B,
        cuentaRef: IBAN_B,
        pendienteAsignar: true,
        empresaId: '',
        empresaNombre: '',
      },
    ],
  });

  const actualizado = aplicarAsignacionCuentaEnFichero(
    fichero,
    IBAN_A,
    { empresaId: '000007', empresaNombre: 'EMPRESA A' },
  );

  assert.ok(actualizado);
  assert.equal(actualizado.estado, ESTADO_FICHERO_PENDIENTE_CUENTA);
  assert.equal(actualizado.cuentas[0].pendienteAsignar, false);
  assert.equal(actualizado.cuentas[0].empresaId, '000007');
  assert.equal(actualizado.cuentas[1].pendienteAsignar, true);
  assert.equal(actualizado.cuentas[1].empresaId, '');
});

test('no asigna si la cuenta del extracto no estaba pendiente', () => {
  const fichero = ficheroBase({
    estado: ESTADO_FICHERO_CARGADO,
    cuentas: [
      {
        iban: IBAN_A,
        cuentaRef: IBAN_A,
        pendienteAsignar: false,
        empresaId: '000007',
        empresaNombre: 'Ya asignada',
      },
    ],
  });

  const actualizado = aplicarAsignacionCuentaEnFichero(
    fichero,
    IBAN_A,
    { empresaId: '000099', empresaNombre: 'Otra' },
  );
  assert.equal(actualizado, null);
});

test('no asigna si la cuenta del extracto no estaba en el fichero', () => {
  const actualizado = aplicarAsignacionCuentaEnFichero(
    ficheroBase(),
    IBAN_B,
    { empresaId: '000007', empresaNombre: 'X' },
  );
  assert.equal(actualizado, null);
});

test('no toca un fichero en_curso', () => {
  const actualizado = aplicarAsignacionCuentaEnFichero(
    ficheroBase({ estado: ESTADO_FICHERO_EN_CURSO }),
    IBAN_A,
    { empresaId: '000007', empresaNombre: 'X' },
  );
  assert.equal(actualizado, null);
});

test('empareja por cuentaRef aunque el IBAN del body venga con guiones', () => {
  const fichero = ficheroBase({
    cuentas: [
      {
        iban: '',
        cuentaRef: IBAN_A,
        pendienteAsignar: true,
        empresaId: '',
        empresaNombre: '',
      },
    ],
  });

  const actualizado = aplicarAsignacionCuentaEnFichero(
    fichero,
    'ES91-2100-0418-4502-0005-1332',
    { empresaId: '000001', empresaNombre: 'Demo' },
  );

  assert.ok(actualizado);
  assert.equal(actualizado.estado, ESTADO_FICHERO_CARGADO);
  assert.equal(actualizado.cuentas[0].pendienteAsignar, false);
  assert.equal(actualizado.cuentas[0].empresaId, '000001');
});

test('devuelve null si el fichero no existe', () => {
  assert.equal(
    aplicarAsignacionCuentaEnFichero(null, IBAN_A, { empresaId: '1' }),
    null,
  );
});
