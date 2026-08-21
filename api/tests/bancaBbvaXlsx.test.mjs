/**
 * Lector de extractos de BBVA en Excel.
 *
 * Los ficheros reales del banco no están en el repo, así que cada test genera su
 * propio .xlsx en memoria replicando la maqueta del extracto: bloque de
 * etiquetas arriba, cabecera de tabla y movimientos del más reciente al más
 * antiguo. Lo que más importa aquí es la huella: el mismo apunte descargado en
 * Norma 43 y en Excel tiene que producir la misma, o entraría dos veces.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import ExcelJS from 'exceljs';
import { FORMATO_BBVA_XLSX, leerBbvaXlsx } from '../lib/banca/bbvaXlsx.js';
import { huellaMovimiento } from '../lib/banca/canonico.js';
import { detectarLector } from '../lib/banca/lectores.js';

const IBAN = 'ES6201822745140201566714';
const TITULAR = 'COCTEMATIAS S.L.';
const PERIODO = '01/02/2026-31/07/2026';

/** Columnas de la tabla, en el orden real del extracto (de la C a la M). */
const CABECERA = [
  'F. CONTABLE', 'F. VALOR', 'CÓDIGO', 'CONCEPTO', 'BENEFICIARIO/ORDENANTE',
  'OBSERVACIONES', 'IMPORTE', 'SALDO', 'DIVISA', 'OFICINA', 'REMESA',
];

/** En el fichero de BBVA las dos primeras columnas van vacías. */
const COL_PRIMERA = 3;

/**
 * Genera un .xlsx con la maqueta del extracto de BBVA.
 * `desplazar` empuja todo hacia abajo para comprobar que no se dependa de
 * números de fila fijos.
 */
async function libroBbva({
  cuenta = IBAN,
  titular = TITULAR,
  periodo = PERIODO,
  divisa = 'EUR',
  movimientos = [],
  cabecera = CABECERA,
  conEtiquetas = true,
  desplazar = 0,
} = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Historico');
  const pon = (fila, columna, valor) => {
    if (valor === '' || valor == null) return;
    ws.getCell(fila, columna).value = valor;
  };

  let f = 5 + desplazar;
  pon(f, COL_PRIMERA, 'Movimientos');
  f += 2;

  if (conEtiquetas) {
    for (const [nombre, valor] of [
      ['Titular', titular],
      ['Cuenta', cuenta],
      ['Divisa', divisa],
      ['Banco', 'BANCO BILBAO VIZCAYA ARGENTARIA, S.A.'],
      ['Fecha', '20/08/2026 Hora  22:14'],
      ['Importe', 'Todos'],
      ['Periodo', periodo],
      ['Filtros', 'Todos'],
    ]) {
      pon(f, COL_PRIMERA, nombre);
      pon(f, COL_PRIMERA + 3, valor);
      f += 1;
    }
  }

  f += 1;
  cabecera.forEach((nombre, i) => pon(f, COL_PRIMERA + i, nombre));
  f += 1;

  for (const m of movimientos) {
    [
      m.fechaContable,
      m.fechaValor ?? m.fechaContable,
      m.codigo ?? '00317',
      m.concepto,
      m.contraparte,
      m.observaciones,
      m.importe,
      m.saldo,
      m.divisa ?? 'EUR',
      m.oficina ?? '6051',
      m.remesa,
    ].forEach((valor, i) => pon(f, COL_PRIMERA + i, valor));
    f += 1;
  }

  // El extracto real trae cientos de filas vacías al final: se simulan dando
  // estilo a una celda muy por debajo, que es lo que estira el rango usado.
  ws.getCell(f + 300, COL_PRIMERA).border = { top: { style: 'thin' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Encadena en la columna SALDO el saldo posterior a cada movimiento (orden ascendente). */
function conSaldos(movimientosAsc, saldoInicial) {
  let centimos = Math.round(saldoInicial * 100);
  return movimientosAsc.map((m) => {
    centimos += Math.round(m.importe * 100);
    return { ...m, saldo: centimos / 100 };
  });
}

/** Tres apuntes de febrero, del más antiguo al más reciente. */
const FEBRERO_ASC = conSaldos([
  {
    fechaContable: '02/02/2026',
    concepto: 'ADEUDOS POR DOMICILIACIONES',
    contraparte: 'IBERDROLA CLIENTES SAU',
    observaciones: 'FACTURA LUZ ENERO',
    importe: -1076.43,
    remesa: '000000000123',
  },
  {
    fechaContable: '10/02/2026',
    fechaValor: '11/02/2026',
    concepto: 'TRANSFERENCIAS',
    contraparte: 'ELECTRICA MUÑOZ SA',
    observaciones: 'ABONO A28017895',
    importe: 50019.85,
  },
  {
    fechaContable: '28/02/2026',
    concepto: 'PAGO DE NOMINAS POR SU CUENTA',
    contraparte: '*************',
    observaciones: 'ABONO NOMINA 02 2026',
    importe: -5000,
  },
], 1000);

/** BBVA lista del más reciente al más antiguo. */
const FEBRERO_DESC = [...FEBRERO_ASC].reverse();

test('la cabecera da el IBAN, el titular, la divisa y el periodo del extracto', async () => {
  const extracto = await leerBbvaXlsx(await libroBbva({ movimientos: FEBRERO_DESC }));

  assert.equal(extracto.formato, FORMATO_BBVA_XLSX);
  assert.equal(extracto.codificacion, 'xlsx');
  assert.equal(extracto.hashFichero.length, 64);
  assert.deepEqual(extracto.errores, []);
  assert.deepEqual(extracto.avisos, []);
  assert.equal(extracto.cuentas.length, 1);

  const cuenta = extracto.cuentas[0];
  assert.equal(cuenta.iban, IBAN);
  assert.equal(cuenta.cuentaRef, IBAN);
  assert.equal(cuenta.ibanValido, true);
  assert.equal(cuenta.titular, TITULAR);
  // El canónico guarda el código numérico ISO, como el Norma 43.
  assert.equal(cuenta.divisa, '978');
  assert.equal(cuenta.fechaInicial, '2026-02-01');
  assert.equal(cuenta.fechaFinal, '2026-07-31');
});

test('los movimientos se cuentan enteros y conservan el signo del importe', async () => {
  const extracto = await leerBbvaXlsx(await libroBbva({ movimientos: FEBRERO_DESC }));
  const movs = extracto.cuentas[0].movimientos;

  assert.equal(movs.length, 3);
  // Se leen en el orden del fichero: del más reciente al más antiguo.
  assert.deepEqual(movs.map((m) => m.fechaOperacion), ['2026-02-28', '2026-02-10', '2026-02-02']);

  const [nomina, abono, luz] = movs;
  assert.equal(nomina.importe, -5000);
  assert.equal(nomina.importeCentimos, -500000);
  assert.equal(nomina.signo, 'D');
  assert.equal(abono.importe, 50019.85);
  assert.equal(abono.signo, 'H');
  assert.equal(luz.importe, -1076.43);
  assert.equal(luz.signo, 'D');

  // Reparto de columnas: el concepto legible junta CONCEPTO, la contraparte y
  // las observaciones; el NIF sale de ahí y las referencias quedan aparte.
  assert.equal(luz.concepto, 'ADEUDOS POR DOMICILIACIONES IBERDROLA CLIENTES SAU FACTURA LUZ ENERO');
  assert.equal(luz.conceptoNormalizado, 'DOMICILIACIONES IBERDROLA CLIENTES SAU FACTURA LUZ ENERO');
  assert.equal(luz.referencia1, 'IBERDROLA CLIENTES SAU');
  assert.equal(luz.referencia2, 'FACTURA LUZ ENERO');
  assert.equal(luz.numeroDocumento, '000000000123');
  assert.equal(luz.conceptoPropio, '00317');
  assert.equal(luz.conceptoComun, '');
  assert.equal(luz.divisa, '978');
  assert.equal(luz.fechaValor, '2026-02-02');
  assert.equal(abono.fechaValor, '2026-02-11');
  assert.equal(abono.nif, 'A28017895');
  // La fila de Excel se guarda para poder auditar el apunte.
  assert.equal(luz.lineaOrigen, 19);
});

test('los importes se convierten a céntimos enteros sin arrastrar la coma flotante', async () => {
  // 4,35 × 100 da 434,99999999999994: truncado serían 4,34 €.
  const movimientos = conSaldos([
    { fechaContable: '02/03/2026', concepto: 'COMISION', importe: 4.35 },
    { fechaContable: '03/03/2026', concepto: 'RECIBO', importe: -5019.85 },
    { fechaContable: '04/03/2026', concepto: 'REDONDEO', importe: 0.1 },
    { fechaContable: '05/03/2026', concepto: 'REDONDEO', importe: 0.2 },
  ], 0).reverse();

  const extracto = await leerBbvaXlsx(await libroBbva({ movimientos }));
  const movs = extracto.cuentas[0].movimientos;

  for (const m of movs) assert.ok(Number.isInteger(m.importeCentimos), `${m.importe}`);
  assert.deepEqual(movs.map((m) => m.importeCentimos), [20, 10, -501985, 435]);
  assert.deepEqual(movs.map((m) => m.importe), [0.2, 0.1, -5019.85, 4.35]);
  assert.deepEqual(extracto.cuentas[0].descuadres, []);
});

test('las fechas se leen igual si Excel las guardó como fecha o como texto', async () => {
  // exceljs devuelve las fechas de Excel en UTC: leídas con getters locales, en
  // España el 02/02 se convertiría en el 01/02.
  const comoTexto = conSaldos([
    { fechaContable: '02/02/2026', fechaValor: '03/02/2026', concepto: 'RECIBO', importe: -100 },
  ], 500);
  const comoFecha = comoTexto.map((m) => ({
    ...m,
    fechaContable: new Date(Date.UTC(2026, 1, 2)),
    fechaValor: new Date(Date.UTC(2026, 1, 3)),
  }));

  const texto = await leerBbvaXlsx(await libroBbva({ movimientos: comoTexto }));
  const fecha = await leerBbvaXlsx(await libroBbva({ movimientos: comoFecha }));

  assert.equal(texto.cuentas[0].movimientos[0].fechaOperacion, '2026-02-02');
  assert.equal(texto.cuentas[0].movimientos[0].fechaValor, '2026-02-03');
  assert.deepEqual(
    fecha.cuentas[0].movimientos.map((m) => [m.fechaOperacion, m.fechaValor]),
    texto.cuentas[0].movimientos.map((m) => [m.fechaOperacion, m.fechaValor]),
  );
  assert.deepEqual(fecha.errores, []);
});

test('el ordinal agrupa por fecha e importe, así que no depende del orden de las filas', async () => {
  // El Excel viene del más reciente al más antiguo y el Norma 43 al revés: si el
  // ordinal contara por orden de lectura, el mismo apunte tendría huella
  // distinta según el formato y se guardaría dos veces.
  const asc = conSaldos([
    { fechaContable: '05/02/2026', concepto: 'CONSUMO', importe: -3.5 },
    { fechaContable: '05/02/2026', concepto: 'CONSUMO', importe: -3.5 },
    { fechaContable: '05/02/2026', concepto: 'CONSUMO', importe: -7 },
    { fechaContable: '06/02/2026', concepto: 'CONSUMO', importe: -3.5 },
  ], 100);

  const ascendente = await leerBbvaXlsx(await libroBbva({ movimientos: asc }));
  const descendente = await leerBbvaXlsx(await libroBbva({ movimientos: [...asc].reverse() }));

  assert.deepEqual(ascendente.cuentas[0].movimientos.map((m) => m.ordinal), [1, 2, 1, 1]);
  assert.deepEqual(descendente.cuentas[0].movimientos.map((m) => m.ordinal), [1, 1, 1, 2]);

  const huellas = (e) => e.cuentas[0].movimientos.map((m) => m.movementHash).sort();
  assert.deepEqual(huellas(ascendente), huellas(descendente));
  assert.equal(new Set(huellas(ascendente)).size, 4);
});

test('la huella del apunte es la del canónico: el mismo movimiento no se duplica entre formatos', async () => {
  const extracto = await leerBbvaXlsx(await libroBbva({ movimientos: FEBRERO_DESC }));
  const movs = extracto.cuentas[0].movimientos;

  for (const m of movs) {
    assert.equal(
      m.movementHash,
      huellaMovimiento({
        cuenta: IBAN,
        fechaOperacion: m.fechaOperacion,
        importeCentimos: m.importeCentimos,
        ordinal: m.ordinal,
      }),
      `${m.fechaOperacion} ${m.importe}`,
    );
  }

  // La receta no usa nada exclusivo del Excel: con la cuenta, la fecha, el
  // importe en céntimos y el ordinal, el Norma 43 del mismo apunte sale igual.
  assert.equal(
    movs[0].movementHash,
    huellaMovimiento({
      cuenta: IBAN,
      fechaOperacion: '2026-02-28',
      importeCentimos: -500000,
      ordinal: 1,
    }),
  );
});

test('una fila con la fecha corrupta se anota en errores y el resto del extracto se lee', async () => {
  const movimientos = [
    { fechaContable: '32/13/2026', concepto: 'RECIBO ROTO', importe: -50, saldo: 950 },
    ...conSaldos([
      { fechaContable: '10/02/2026', concepto: 'RECIBO', importe: -100 },
      { fechaContable: '11/02/2026', concepto: 'ABONO', importe: 250 },
    ], 1000).reverse(),
    { fechaContable: '', concepto: 'IMPORTE ROTO', importe: 'no es un número', saldo: 900 },
  ];

  const extracto = await leerBbvaXlsx(await libroBbva({ movimientos }));

  assert.equal(extracto.errores.length, 2);
  assert.equal(extracto.errores[0].tipo, 'FILA');
  assert.match(extracto.errores[0].motivo, /Fecha contable/);
  assert.match(extracto.errores[1].motivo, /no es numérico/);
  assert.deepEqual(
    extracto.cuentas[0].movimientos.map((m) => m.importe),
    [250, -100],
  );
});

test('los saldos salen de la columna SALDO y la suma de importes tiene que cuadrar', async () => {
  const extracto = await leerBbvaXlsx(await libroBbva({ movimientos: FEBRERO_DESC }));
  const cuenta = extracto.cuentas[0];

  // Saldo inicial 1.000 €; el último saldo del extracto es el más reciente.
  assert.equal(cuenta.saldoInicial, 1000);
  assert.equal(cuenta.saldoFinal, 44943.42);
  assert.deepEqual(cuenta.descuadres, []);
});

test('un saldo que no cuadra con los importes se informa como descuadre, sin perder el extracto', async () => {
  const movimientos = FEBRERO_DESC.map((m, i) => (
    // Se toca el saldo del apunte más reciente (el primero del listado).
    i === 0 ? { ...m, saldo: m.saldo + 100 } : m
  ));

  const extracto = await leerBbvaXlsx(await libroBbva({ movimientos }));
  const cuenta = extracto.cuentas[0];

  assert.equal(cuenta.movimientos.length, 3);
  assert.deepEqual(cuenta.descuadres, [
    { campo: 'saldoFinal', declarado: 45043.42, calculado: 44943.42 },
  ]);
  assert.deepEqual(extracto.errores, []);
});

test('la maqueta puede moverse de sitio: la tabla se busca por sus etiquetas y columnas', async () => {
  const normal = await leerBbvaXlsx(await libroBbva({ movimientos: FEBRERO_DESC }));
  const desplazado = await leerBbvaXlsx(await libroBbva({ movimientos: FEBRERO_DESC, desplazar: 7 }));

  assert.equal(desplazado.cuentas[0].iban, IBAN);
  assert.equal(desplazado.cuentas[0].titular, TITULAR);
  assert.equal(desplazado.cuentas[0].fechaInicial, '2026-02-01');
  assert.deepEqual(
    desplazado.cuentas[0].movimientos.map((m) => m.movementHash),
    normal.cuentas[0].movimientos.map((m) => m.movementHash),
  );
  // Lo que sí cambia es la fila de origen, que es la real del fichero.
  assert.deepEqual(
    desplazado.cuentas[0].movimientos.map((m) => m.lineaOrigen),
    normal.cuentas[0].movimientos.map((m) => m.lineaOrigen + 7),
  );
});

test('un IBAN de cuenta que no valida no bloquea la lectura: avisa y usa el texto como referencia', async () => {
  const extracto = await leerBbvaXlsx(await libroBbva({
    cuenta: 'ES9999182274514020156671',
    movimientos: FEBRERO_DESC,
  }));
  const cuenta = extracto.cuentas[0];

  assert.equal(cuenta.ibanValido, false);
  assert.equal(cuenta.iban, '');
  assert.equal(cuenta.cuentaRef, 'ES9999182274514020156671');
  assert.equal(cuenta.movimientos.length, 3);
  assert.equal(cuenta.movimientos[0].cuentaRef, 'ES9999182274514020156671');
  assert.ok(extracto.avisos.some((a) => a.tipo === 'CUENTA' && /no es un IBAN válido/.test(a.motivo)));
});

test('un Excel que no es un extracto de BBVA se rechaza con un mensaje claro', async () => {
  const otroLibro = new ExcelJS.Workbook();
  otroLibro.addWorksheet('Hoja1').getCell('A1').value = 'Listado de proveedores';
  const sinCabecera = Buffer.from(await otroLibro.xlsx.writeBuffer());
  const sinCuenta = await libroBbva({ movimientos: FEBRERO_DESC, conEtiquetas: false });

  await assert.rejects(() => leerBbvaXlsx(sinCabecera), /no se encuentra la fila de cabecera/);
  await assert.rejects(() => leerBbvaXlsx(sinCuenta), /no se encuentra la etiqueta "Cuenta"/);
});

test('un .xlsx usa autodetection; el formato explícito manda sobre la extensión', () => {
  const porExtension = detectarLector({ nombreFichero: 'extracto agosto.xlsx' });
  assert.equal(porExtension.ok, true);
  assert.equal(porExtension.lector.clave, 'XLSX');
  assert.equal(porExtension.lector.traeIban, true);

  const forzado = detectarLector({ nombreFichero: 'extracto.dat', formato: FORMATO_BBVA_XLSX });
  assert.equal(forzado.ok, true);
  assert.equal(forzado.lector.clave, FORMATO_BBVA_XLSX);
});
