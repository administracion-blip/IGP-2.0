/**
 * Parser de ficheros Norma 43.
 *
 * Los ficheros de banco reales no son limpios: Santander, CaixaBank y BBVA
 * emiten en ISO-8859-1, recortan los espacios finales de cada línea y a veces
 * mandan el extracto como un único bloque continuo sin saltos. El parser tiene
 * que dar el mismo resultado en todos esos casos y, cuando un registro no
 * cuadra, anotarlo y seguir: perder el extracto entero por una línea rota
 * dejaría al usuario sin poder conciliar nada.
 *
 * Los ficheros de prueba se construyen aquí porque todavía no tenemos ninguno
 * real; en cuanto los haya, estos tests siguen valiendo como red de seguridad.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { parsearN43, normalizarConcepto, construirIbanN43 } from '../lib/n43/index.js';
import { validarIban } from '../lib/remesas/iban.js';

/** Cuenta de ejemplo del ISO 13616: CCC 2100 0418 45 0200051332. */
const ENTIDAD = '2100';
const OFICINA = '0418';
const CUENTA = '0200051332';
const IBAN = 'ES9121000418450200051332';

/** Escribe tramos [desde, hasta, valor] (1-indexados, inclusive) sobre un registro de 80. */
function reg(...tramos) {
  const buf = Array(80).fill(' ');
  for (const [desde, hasta, valor] of tramos) {
    const largo = hasta - desde + 1;
    const v = String(valor).slice(0, largo).padEnd(largo, ' ');
    for (let i = 0; i < largo; i += 1) buf[desde - 1 + i] = v[i];
  }
  return buf.join('');
}

function num(valor, largo) {
  return String(valor).padStart(largo, '0');
}

function cabecera({
  entidad = ENTIDAD,
  oficina = OFICINA,
  cuenta = CUENTA,
  desde = '240101',
  hasta = '240131',
  claveSaldo = '2',
  saldoCentimos = 123456,
  divisa = '978',
  modalidad = '3',
  nombre = 'HOSTELERIA DEL SUR SL',
} = {}) {
  return reg(
    [1, 2, '11'], [3, 6, entidad], [7, 10, oficina], [11, 20, cuenta],
    [21, 26, desde], [27, 32, hasta], [33, 33, claveSaldo],
    [34, 47, num(saldoCentimos, 14)], [48, 50, divisa], [51, 51, modalidad],
    [52, 77, nombre],
  );
}

function movimiento({
  entidad = ENTIDAD,
  oficina = OFICINA,
  fechaOperacion = '240115',
  fechaValor = '240116',
  conceptoComun = '03',
  conceptoPropio = '001',
  clave = '1',
  centimos = 4560,
  documento = '0000000001',
  referencia1 = 'REF1',
  referencia2 = 'REF2',
} = {}) {
  return reg(
    [1, 2, '22'], [3, 6, entidad], [7, 10, oficina], [11, 16, fechaOperacion], [17, 22, fechaValor],
    [23, 24, conceptoComun], [25, 27, conceptoPropio], [28, 28, clave],
    [29, 42, num(centimos, 14)], [43, 52, documento], [53, 64, referencia1],
    [65, 80, referencia2],
  );
}

function complementario(texto1 = '', texto2 = '', codigoDato = '01') {
  return reg([1, 2, '23'], [3, 4, codigoDato], [5, 42, texto1], [43, 80, texto2]);
}

function equivalencia({ codigoDato = '01', divisa = '840', centimos = 5000 } = {}) {
  return reg([1, 2, '24'], [3, 4, codigoDato], [5, 7, divisa], [8, 21, num(centimos, 14)]);
}

function finalCuenta({
  entidad = ENTIDAD,
  oficina = OFICINA,
  cuenta = CUENTA,
  apuntesDebe = 0,
  totalDebeCentimos = 0,
  apuntesHaber = 0,
  totalHaberCentimos = 0,
  claveSaldo = '2',
  saldoCentimos = 0,
  divisa = '978',
} = {}) {
  return reg(
    [1, 2, '33'], [3, 6, entidad], [7, 10, oficina], [11, 20, cuenta],
    [21, 25, num(apuntesDebe, 5)], [26, 39, num(totalDebeCentimos, 14)],
    [40, 44, num(apuntesHaber, 5)], [45, 58, num(totalHaberCentimos, 14)],
    [59, 59, claveSaldo], [60, 73, num(saldoCentimos, 14)], [74, 76, divisa],
  );
}

function finFichero(registros) {
  return reg([1, 2, '88'], [3, 20, '9'.repeat(18)], [21, 26, num(registros, 6)]);
}

/** Une registros y añade el 88 con el contador correcto (incluido él mismo). */
function fichero(registros, { separador = '\r\n', fin = true, contador = null } = {}) {
  const todos = fin ? [...registros, finFichero(contador ?? registros.length + 1)] : registros;
  return todos.join(separador);
}

function buffer(texto, codificacion = 'latin1') {
  return Buffer.from(texto, codificacion);
}

/** Fichero base: una cuenta, tres movimientos y registro 33 que cuadra. */
function ficheroUnaCuenta() {
  return fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    movimiento({ clave: '2', centimos: 100000, fechaOperacion: '240120', fechaValor: '240120' }),
    movimiento({ clave: '1', centimos: 99, fechaOperacion: '240131', fechaValor: '240131' }),
    finalCuenta({
      apuntesDebe: 2,
      totalDebeCentimos: 4659,
      apuntesHaber: 1,
      totalHaberCentimos: 100000,
      claveSaldo: '2',
      saldoCentimos: 218797,
    }),
  ]);
}

test('una cuenta con varios movimientos: campos, signos, fechas ISO e IBAN construido', () => {
  const r = parsearN43(buffer(ficheroUnaCuenta()));

  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.cuentas.length, 1);

  const c = r.cuentas[0];
  assert.equal(c.entidad, ENTIDAD);
  assert.equal(c.oficina, OFICINA);
  assert.equal(c.numeroCuenta, CUENTA);
  assert.equal(c.ccc, '21000418450200051332');
  assert.equal(c.iban, IBAN);
  assert.equal(c.ibanValido, true);
  assert.equal(c.fechaInicial, '2024-01-01');
  assert.equal(c.fechaFinal, '2024-01-31');
  assert.equal(c.saldoInicial, 1234.56);
  assert.equal(c.divisa, '978');
  assert.equal(c.nombreAbreviado, 'HOSTELERIA DEL SUR SL');

  assert.equal(c.movimientos.length, 3);
  const [m1, m2, m3] = c.movimientos;
  assert.equal(m1.importe, -45.6);
  assert.equal(m1.signo, 'D');
  assert.equal(m1.clave, '1');
  assert.equal(m1.fechaOperacion, '2024-01-15');
  assert.equal(m1.fechaValor, '2024-01-16');
  assert.equal(m1.conceptoComun, '03');
  assert.equal(m1.conceptoPropio, '001');
  assert.equal(m1.numeroDocumento, '0000000001');
  assert.equal(m1.referencia1, 'REF1');
  assert.equal(m1.referencia2, 'REF2');
  assert.equal(m2.importe, 1000);
  assert.equal(m2.signo, 'H');
  assert.equal(m3.importe, -0.99);

  assert.deepEqual(c.descuadres, []);
  assert.equal(c.totales.numeroApuntesDebe, 2);
  assert.equal(c.totales.totalDebe, 46.59);
  assert.equal(c.totales.numeroApuntesHaber, 1);
  assert.equal(c.totales.totalHaber, 1000);
  assert.equal(c.totales.saldoFinal, 2187.97);
  assert.equal(c.final.saldoFinal, 2187.97);
  assert.equal(r.finFichero.cuadra, true);
  assert.equal(r.hashFichero.length, 64);
});

test('el IBAN se construye calculando los dos dígitos de control que el fichero no trae', () => {
  const r = construirIbanN43({ entidad: ENTIDAD, oficina: OFICINA, numeroCuenta: CUENTA });
  assert.equal(r.valido, true);
  assert.equal(r.ccc, '21000418450200051332');
  assert.equal(r.iban, IBAN);
});

test('una cuenta con entidad u oficina no numéricas deja el IBAN vacío y avisa, sin reventar', () => {
  const r = parsearN43(buffer(fichero([
    cabecera({ entidad: '21X0' }),
    movimiento(),
    finalCuenta({ entidad: '21X0', apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));
  const c = r.cuentas[0];
  assert.equal(c.iban, '');
  assert.equal(c.ibanValido, false);
  assert.equal(c.movimientos.length, 1);
  assert.ok(r.avisos.some((a) => a.tipo === '11' && /IBAN/.test(a.motivo)));
  assert.deepEqual(r.errores, []);
});

test('los cinco registros 23 de un movimiento se concatenan en orden', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento(),
    complementario('UNO ', 'DOS '),
    complementario('TRES ', 'CUATRO '),
    complementario('CINCO ', 'SEIS '),
    complementario('SIETE ', 'OCHO '),
    complementario('NUEVE ', 'DIEZ'),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));

  const m = r.cuentas[0].movimientos[0];
  assert.equal(m.conceptosComplementarios.length, 5);
  assert.equal(m.conceptoTexto, 'UNO DOS TRES CUATRO CINCO SEIS SIETE OCHO NUEVE DIEZ');
  assert.deepEqual(r.errores, []);
});

test('fichero multicuenta: cada movimiento cae en la cuenta cuyo bloque 11…33 lo contiene', () => {
  const CUENTA_B = { entidad: '0049', oficina: '1500', cuenta: '0001234567' };
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
    cabecera({ ...CUENTA_B, saldoCentimos: 500000, nombre: 'BAR DEL PUERTO SL' }),
    movimiento({ clave: '2', centimos: 25000, fechaOperacion: '240118', fechaValor: '240118' }),
    movimiento({ clave: '2', centimos: 15000, fechaOperacion: '240119', fechaValor: '240119' }),
    finalCuenta({ ...CUENTA_B, apuntesHaber: 2, totalHaberCentimos: 40000, claveSaldo: '2', saldoCentimos: 540000 }),
  ])));

  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.cuentas.length, 2);
  assert.equal(r.cuentas[0].iban, IBAN);
  assert.equal(r.cuentas[0].movimientos.length, 1);
  assert.equal(r.cuentas[1].nombreAbreviado, 'BAR DEL PUERTO SL');
  assert.equal(r.cuentas[1].ccc, '00491500080001234567');
  assert.equal(validarIban(r.cuentas[1].iban).valido, true);
  assert.equal(r.cuentas[1].iban.slice(4), '00491500080001234567');
  assert.equal(r.cuentas[1].movimientos.length, 2);
  assert.deepEqual(r.cuentas[0].descuadres, []);
  assert.deepEqual(r.cuentas[1].descuadres, []);
});

test('el mismo extracto en ISO-8859-1 y en UTF-8 da el mismo texto con Ñ y acentos', () => {
  const texto = fichero([
    cabecera({ nombre: 'PEÑA & COMPAÑÍA SÁNCHEZ' }),
    movimiento(),
    complementario('CAFÉ ESPAÑOL Ñ ', 'JOSÉ MUÑOZ'),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ]);

  const latin = parsearN43(buffer(texto, 'latin1'));
  const utf = parsearN43(buffer(texto, 'utf8'));

  assert.equal(latin.codificacion, 'iso-8859-1');
  assert.equal(utf.codificacion, 'utf-8');
  assert.equal(latin.cuentas[0].nombreAbreviado, 'PEÑA & COMPAÑÍA SÁNCHEZ');
  assert.equal(utf.cuentas[0].nombreAbreviado, 'PEÑA & COMPAÑÍA SÁNCHEZ');
  assert.equal(
    latin.cuentas[0].movimientos[0].conceptoTexto,
    'CAFÉ ESPAÑOL Ñ JOSÉ MUÑOZ',
  );
  assert.equal(
    utf.cuentas[0].movimientos[0].conceptoTexto,
    latin.cuentas[0].movimientos[0].conceptoTexto,
  );
  assert.equal(
    utf.cuentas[0].movimientos[0].conceptoNormalizado,
    'CAFE ESPAÑOL Ñ JOSE MUÑOZ',
  );
  assert.deepEqual(latin.errores, []);
  assert.deepEqual(utf.errores, []);
});

test('un fichero sin saltos de línea se trocea cada 80 y da lo mismo que con CRLF o LF', () => {
  const registros = [
    cabecera(),
    movimiento(),
    complementario('PROVEEDOR X'),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ];
  const crlf = parsearN43(buffer(fichero(registros, { separador: '\r\n' })));
  const lf = parsearN43(buffer(fichero(registros, { separador: '\n' })));
  const continuo = parsearN43(buffer(fichero(registros, { separador: '' })));

  assert.deepEqual(crlf.cuentas, lf.cuentas);
  assert.deepEqual(crlf.cuentas, continuo.cuentas);
  assert.deepEqual(continuo.errores, []);
  assert.equal(continuo.totalRegistros, 5);
});

test('las líneas recortadas por la derecha se rellenan hasta 80 y se leen igual', () => {
  const registros = [
    cabecera(),
    movimiento(),
    complementario('PROVEEDOR X'),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ];
  const completo = parsearN43(buffer(fichero(registros)));
  const recortado = parsearN43(buffer(
    fichero(registros).split('\r\n').map((l) => l.replace(/\s+$/, '')).join('\r\n'),
  ));

  assert.deepEqual(recortado.errores, []);
  assert.deepEqual(recortado.cuentas, completo.cuentas);
});

test('las líneas en blanco no son un error', () => {
  const r = parsearN43(buffer([
    cabecera(),
    '',
    movimiento(),
    '   ',
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
    finFichero(4),
    '',
  ].join('\r\n')));

  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.totalRegistros, 4);
  assert.equal(r.cuentas[0].movimientos.length, 1);
});

test('un tipo de registro desconocido se lista con su línea y el resto del fichero se parsea', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    reg([1, 2, '99'], [3, 20, 'BASURA']),
    movimiento({ clave: '2', centimos: 1000, fechaOperacion: '240120', fechaValor: '240120' }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, apuntesHaber: 1, totalHaberCentimos: 1000, claveSaldo: '2', saldoCentimos: 119896 }),
  ])));

  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].linea, 3);
  assert.equal(r.errores[0].tipo, '99');
  assert.match(r.errores[0].motivo, /desconocido/);
  assert.equal(r.cuentas[0].movimientos.length, 2);
  assert.deepEqual(r.cuentas[0].descuadres, []);
});

test('una línea claramente más larga de 80 se lista como error y no arrastra al resto', () => {
  const r = parsearN43(buffer([
    cabecera(),
    `${movimiento()}${'X'.repeat(25)}`,
    movimiento({ clave: '2', centimos: 1000, fechaOperacion: '240120', fechaValor: '240120' }),
    finalCuenta({
      apuntesDebe: 1,
      totalDebeCentimos: 4560,
      apuntesHaber: 1,
      totalHaberCentimos: 1000,
      claveSaldo: '2',
      saldoCentimos: 118896,
    }),
    finFichero(4),
  ].join('\r\n')));

  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].linea, 2);
  assert.match(r.errores[0].motivo, /se esperaban 80/);
  assert.equal(r.cuentas[0].movimientos.length, 1);
  assert.ok(r.cuentas[0].descuadres.some((d) => d.campo === 'numeroApuntesDebe'));
});

test('un 23 huérfano, sin 22 delante, se registra como error en lugar de lanzar excepción', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    complementario('CONCEPTO SIN MOVIMIENTO'),
    movimiento(),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));

  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].tipo, '23');
  assert.equal(r.errores[0].linea, 2);
  assert.equal(r.cuentas[0].movimientos.length, 1);
});

test('un 24 huérfano tampoco rompe el fichero', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    equivalencia(),
    movimiento(),
    equivalencia({ divisa: '840', centimos: 5000 }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));

  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].tipo, '24');
  assert.equal(r.cuentas[0].movimientos[0].equivalencias.length, 1);
  assert.equal(r.cuentas[0].movimientos[0].equivalencias[0].importe, 50);
  assert.equal(r.cuentas[0].movimientos[0].equivalencias[0].divisa, '840');
});

test('un movimiento con fecha imposible se lista como error y el resto de la cuenta sigue', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ fechaOperacion: '241332', clave: '1', centimos: 4560 }),
    complementario('CONCEPTO DEL MOVIMIENTO DESCARTADO'),
    movimiento({ clave: '2', centimos: 1000, fechaOperacion: '240120', fechaValor: '240120' }),
    finalCuenta({
      apuntesDebe: 1,
      totalDebeCentimos: 4560,
      apuntesHaber: 1,
      totalHaberCentimos: 1000,
      claveSaldo: '2',
      saldoCentimos: 118896,
    }),
  ])));

  assert.equal(r.errores.length, 1);
  assert.equal(r.errores[0].linea, 2);
  assert.equal(r.errores[0].tipo, '22');
  assert.match(r.errores[0].motivo, /Mes inválido/);
  assert.equal(r.cuentas[0].movimientos.length, 1);
  assert.equal(r.cuentas[0].movimientos[0].importe, 10);
  // El banco sí declaró el apunte descartado en su 33: el descuadre es la
  // prueba de que se ha perdido un movimiento y hay que revisar el fichero.
  assert.deepEqual(
    r.cuentas[0].descuadres.map((d) => d.campo),
    ['numeroApuntesDebe', 'totalDebe', 'saldoFinal'],
  );
});

test('el descuadre del registro 33 se informa con el valor declarado y el calculado', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    movimiento({ clave: '1', centimos: 99, fechaOperacion: '240116', fechaValor: '240116' }),
    finalCuenta({
      apuntesDebe: 5,
      totalDebeCentimos: 9999,
      apuntesHaber: 0,
      totalHaberCentimos: 0,
      claveSaldo: '2',
      saldoCentimos: 113457,
    }),
  ])));

  const c = r.cuentas[0];
  const porCampo = new Map(c.descuadres.map((d) => [d.campo, d]));
  assert.deepEqual(porCampo.get('numeroApuntesDebe'), {
    campo: 'numeroApuntesDebe', declarado: 5, calculado: 2,
  });
  assert.deepEqual(porCampo.get('totalDebe'), {
    campo: 'totalDebe', declarado: 99.99, calculado: 46.59,
  });
  assert.deepEqual(porCampo.get('saldoFinal'), {
    campo: 'saldoFinal', declarado: 1134.57, calculado: 1187.97,
  });
  assert.ok(!porCampo.has('numeroApuntesHaber'));
  assert.deepEqual(r.errores, []);
});

test('el saldo final se comprueba como saldo inicial + haber − debe', () => {
  const r = parsearN43(buffer(fichero([
    cabecera({ claveSaldo: '1', saldoCentimos: 50000 }),
    movimiento({ clave: '2', centimos: 80000 }),
    finalCuenta({ apuntesHaber: 1, totalHaberCentimos: 80000, claveSaldo: '2', saldoCentimos: 30000 }),
  ])));

  assert.equal(r.cuentas[0].saldoInicial, -500);
  assert.equal(r.cuentas[0].totales.saldoFinal, 300);
  assert.deepEqual(r.cuentas[0].descuadres, []);
});

test('si falta el registro 88 se avisa, pero el extracto se entrega parseado', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento(),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ], { fin: false })));

  assert.deepEqual(r.errores, []);
  assert.equal(r.finFichero, null);
  assert.ok(r.avisos.some((a) => a.tipo === '88' && /Falta el registro 88/.test(a.motivo)));
  assert.equal(r.cuentas[0].movimientos.length, 1);
});

test('si el contador del registro 88 no cuadra es un aviso, no un error fatal', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento(),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ], { contador: 99 })));

  assert.deepEqual(r.errores, []);
  assert.equal(r.finFichero.registrosDeclarados, 99);
  assert.equal(r.finFichero.registrosLeidos, 4);
  assert.equal(r.finFichero.cuadra, false);
  assert.ok(r.avisos.some((a) => a.tipo === '88'));
  assert.equal(r.cuentas[0].movimientos.length, 1);
});

test('una cuenta sin registro 33 se avisa y aun así se calculan sus totales', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento(),
    cabecera({ entidad: '0049', oficina: '1500', cuenta: '0001234567' }),
    movimiento({ clave: '2', centimos: 1000 }),
    finalCuenta({ entidad: '0049', oficina: '1500', cuenta: '0001234567', apuntesHaber: 1, totalHaberCentimos: 1000, claveSaldo: '2', saldoCentimos: 124456 }),
  ])));

  assert.deepEqual(r.errores, []);
  assert.ok(r.avisos.some((a) => a.tipo === '11' && /registro 33/.test(a.motivo)));
  assert.equal(r.cuentas.length, 2);
  assert.equal(r.cuentas[0].final, null);
  assert.equal(r.cuentas[0].totales.totalDebe, 45.6);
  assert.deepEqual(r.cuentas[0].descuadres, []);
});

test('dos movimientos idénticos el mismo día son dos apuntes distintos: el ordinal los separa', () => {
  // Dos consumos iguales el mismo día son legítimos. Sin el ordinal en el hash
  // colapsarían en una única huella y la ingesta idempotente perdería uno.
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 350 }),
    movimiento({ clave: '1', centimos: 350 }),
    movimiento({ clave: '1', centimos: 350, fechaOperacion: '240116', fechaValor: '240116' }),
    finalCuenta({ apuntesDebe: 3, totalDebeCentimos: 1050, claveSaldo: '2', saldoCentimos: 122406 }),
  ])));

  const movs = r.cuentas[0].movimientos;
  assert.equal(movs.length, 3);
  assert.deepEqual(movs.map((m) => m.ordinal), [1, 2, 1]);
  assert.notEqual(movs[0].movementHash, movs[1].movementHash);
  assert.equal(new Set(movs.map((m) => m.movementHash)).size, 3);
  assert.deepEqual(r.cuentas[0].descuadres, []);
});

test('el registro 22 real de un extracto de BBVA se trocea en los campos correctos', () => {
  // Línea copiada tal cual de un extracto de BBVA. Fija el reparto de campos,
  // que es lo primero que se rompió: la fecha empieza en la posición 11 porque
  // antes van entidad (4) y oficina (4), no solo la oficina.
  const REAL = '2201823340260202260202032291000000001076430000000000ADEUDO DE IB'
    + 'ERDROLA         ';
  const r = parsearN43(buffer(fichero([
    cabecera(),
    REAL,
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 107643, claveSaldo: '1', saldoCentimos: 1076430 - 123456 }),
  ])));

  const m = r.cuentas[0].movimientos[0];
  assert.equal(m.entidadOrigen, '0182');
  assert.equal(m.oficinaOrigen, '3340');
  assert.equal(m.fechaOperacion, '2026-02-02');
  assert.equal(m.fechaValor, '2026-02-02');
  assert.equal(m.conceptoComun, '03');
  assert.equal(m.conceptoPropio, '229');
  assert.equal(m.signo, 'D');
  assert.equal(m.importe, -1076.43);
  // BBVA no manda registro 23: la descripción viene partida en las referencias.
  assert.equal(m.conceptoTexto, 'ADEUDO DE IBERDROLA');
  assert.equal(m.conceptoNormalizado, 'IBERDROLA');
});

test('el ordinal no depende del orden en que el fichero liste los apuntes del día', () => {
  // Los extractos en Excel vienen del más reciente al más antiguo y el Norma 43
  // al revés. Si el ordinal contara por día en vez de por importe repetido, el
  // mismo apunte tendría huella distinta según el formato y entraría dos veces.
  const ascendente = [
    movimiento({ clave: '1', centimos: 1000 }),
    movimiento({ clave: '1', centimos: 2000 }),
    movimiento({ clave: '1', centimos: 3000 }),
  ];
  const cierre = finalCuenta({ apuntesDebe: 3, totalDebeCentimos: 6000, claveSaldo: '2', saldoCentimos: 63456 });
  const a = parsearN43(buffer(fichero([cabecera(), ...ascendente, cierre])));
  const b = parsearN43(buffer(fichero([cabecera(), ...[...ascendente].reverse(), cierre])));

  assert.deepEqual(
    a.cuentas[0].movimientos.map((m) => m.movementHash).sort(),
    b.cuentas[0].movimientos.map((m) => m.movementHash).sort(),
  );
});

test('el mismo movimiento en dos cuentas distintas tiene hash distinto', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 350 }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 350, claveSaldo: '2', saldoCentimos: 123106 }),
    cabecera({ entidad: '0049', oficina: '1500', cuenta: '0001234567' }),
    movimiento({ clave: '1', centimos: 350 }),
    finalCuenta({ entidad: '0049', oficina: '1500', cuenta: '0001234567', apuntesDebe: 1, totalDebeCentimos: 350, claveSaldo: '2', saldoCentimos: 123106 }),
  ])));

  assert.notEqual(
    r.cuentas[0].movimientos[0].movementHash,
    r.cuentas[1].movimientos[0].movementHash,
  );
});

test('una misma cuenta repartida en dos bloques del fichero no colapsa apuntes idénticos', () => {
  // Algunos emisores parten el extracto en varios pares 11/33 de la misma
  // cuenta. Si el ordinal se reiniciara en cada bloque, el apunte repetido
  // recibiría el ordinal 1 en los dos, tendría la misma huella y la ingesta
  // idempotente descartaría el segundo dando el extracto por bueno.
  const apunte = movimiento({ clave: '1', centimos: 350 });
  const cierre = finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 350, claveSaldo: '2', saldoCentimos: 123106 });
  const r = parsearN43(buffer(fichero([
    cabecera({ desde: '240101', hasta: '240115' }),
    apunte,
    cierre,
    cabecera({ desde: '240116', hasta: '240131' }),
    apunte,
    cierre,
  ])));

  assert.equal(r.cuentas.length, 2);
  assert.deepEqual(
    [r.cuentas[0].movimientos[0].ordinal, r.cuentas[1].movimientos[0].ordinal],
    [1, 2],
  );
  assert.notEqual(
    r.cuentas[0].movimientos[0].movementHash,
    r.cuentas[1].movimientos[0].movementHash,
  );
});

test('la huella ignora la fecha de valor y las referencias: son campos que el Excel no trae', () => {
  // El mismo apunte llega unas veces en Norma 43 y otras en el Excel del banco.
  // Si la huella dependiera de datos exclusivos del N43, el de Excel entraría
  // como un movimiento nuevo y lo veríamos duplicado en pantalla.
  const conRefs = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));
  const sinRefs = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560, fechaValor: '240131', referencia1: '', referencia2: '' }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));

  assert.equal(
    conRefs.cuentas[0].movimientos[0].movementHash,
    sinRefs.cuentas[0].movimientos[0].movementHash,
  );
});

test('la huella sí distingue el importe: un céntimo de diferencia es otro apunte', () => {
  const a = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));
  const b = parsearN43(buffer(fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4561 }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4561, claveSaldo: '2', saldoCentimos: 118895 }),
  ])));

  assert.notEqual(
    a.cuentas[0].movimientos[0].movementHash,
    b.cuentas[0].movimientos[0].movementHash,
  );
});

test('parsear dos veces el mismo fichero da exactamente los mismos hashes', () => {
  const buf = buffer(ficheroUnaCuenta());
  const a = parsearN43(buf);
  const b = parsearN43(buf);

  assert.equal(a.hashFichero, b.hashFichero);
  assert.deepEqual(a, b);
});

test('importes grandes con decimales no pierden precisión al sumar en céntimos', () => {
  const GRANDE = 9999999999; // 99.999.999,99 €
  const r = parsearN43(buffer(fichero([
    cabecera({ claveSaldo: '2', saldoCentimos: 0 }),
    movimiento({ clave: '2', centimos: GRANDE }),
    movimiento({ clave: '1', centimos: GRANDE, fechaOperacion: '240120', fechaValor: '240120' }),
    finalCuenta({
      apuntesDebe: 1,
      totalDebeCentimos: GRANDE,
      apuntesHaber: 1,
      totalHaberCentimos: GRANDE,
      claveSaldo: '2',
      saldoCentimos: 0,
    }),
  ])));

  const c = r.cuentas[0];
  assert.equal(c.movimientos[0].importe, 99999999.99);
  assert.equal(c.movimientos[1].importe, -99999999.99);
  assert.equal(c.totales.totalHaber, 99999999.99);
  assert.equal(c.totales.totalDebe, 99999999.99);
  assert.equal(c.totales.saldoFinal, 0);
  assert.deepEqual(c.descuadres, []);
});

test('la suma de céntimos con decimales que se descuadran en coma flotante cuadra igual', () => {
  // 0,10 + 0,20 en coma flotante da 0,30000000000000004; en céntimos, 30.
  const r = parsearN43(buffer(fichero([
    cabecera({ claveSaldo: '2', saldoCentimos: 0 }),
    movimiento({ clave: '1', centimos: 10 }),
    movimiento({ clave: '1', centimos: 20 }),
    finalCuenta({ apuntesDebe: 2, totalDebeCentimos: 30, claveSaldo: '1', saldoCentimos: 30 }),
  ])));

  assert.equal(r.cuentas[0].totales.totalDebe, 0.3);
  assert.equal(r.cuentas[0].totales.saldoFinal, -0.3);
  assert.deepEqual(r.cuentas[0].descuadres, []);
});

test('el concepto normalizado deja el nombre del contrario limpio y saca el NIF aparte', () => {
  const r = normalizarConcepto(['TRANSF DE JOSÉ MARÍA PIÑERO  ', 'S.L.   B12345678']);
  assert.equal(r.conceptoTexto, 'TRANSF DE JOSÉ MARÍA PIÑERO S.L. B12345678');
  assert.equal(r.conceptoNormalizado, 'JOSE MARIA PIÑERO S.L. B12345678');
  assert.equal(r.nif, 'B12345678');
});

test('los prefijos de tipo de operación se quitan del concepto normalizado', () => {
  const casos = [
    ['TRANSFERENCIA A ELECTRICA XYZ', 'ELECTRICA XYZ'],
    ['RECIBO   AGUAS DEL SUR', 'AGUAS DEL SUR'],
    ['ADEUDO DEL SEGURO GENERAL', 'SEGURO GENERAL'],
    ['PAGO: CÁMARA FRIGORÍFICA', 'CAMARA FRIGORIFICA'],
    ['ABONO TARJETAS 12/01', 'TARJETAS 12/01'],
    ['TRASPASO DE CUENTA PROPIA', 'CUENTA PROPIA'],
    ['CUOTA MENSUAL ESPAÑA SL', 'CUOTA MENSUAL ESPAÑA SL'],
  ];
  for (const [entrada, esperado] of casos) {
    assert.equal(normalizarConcepto(entrada).conceptoNormalizado, esperado, entrada);
  }
});

test('sin NIF en el concepto, el campo queda vacío en lugar de inventarse', () => {
  assert.equal(normalizarConcepto('RECIBO AGUAS DEL SUR REF 123456').nif, '');
  assert.equal(normalizarConcepto('NOMINA ENERO 12345678Z').nif, '12345678Z');
});

test('el concepto normalizado del movimiento se rellena con sus registros 23', () => {
  const r = parsearN43(buffer(fichero([
    cabecera(),
    movimiento(),
    complementario('TRANSF DE ELÉCTRICA MUÑOZ ', 'SA A28017895'),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, claveSaldo: '2', saldoCentimos: 118896 }),
  ])));

  const m = r.cuentas[0].movimientos[0];
  assert.equal(m.conceptoTexto, 'TRANSF DE ELÉCTRICA MUÑOZ SA A28017895');
  assert.equal(m.conceptoNormalizado, 'ELECTRICA MUÑOZ SA A28017895');
  assert.equal(m.nif, 'A28017895');
});

test('un fichero vacío no lanza: devuelve cero cuentas y el aviso de fin de fichero', () => {
  const r = parsearN43(Buffer.alloc(0));
  assert.deepEqual(r.cuentas, []);
  assert.deepEqual(r.errores, []);
  assert.equal(r.totalRegistros, 0);
  assert.equal(r.finFichero, null);
  assert.equal(r.hashFichero.length, 64);
});
