/**
 * Lector de extractos de CaixaBank en Excel.
 *
 * Los ficheros reales del banco no están en el repo: cada test genera su propio
 * .xlsx en memoria con la maqueta (título con IBAN, cabecera Fecha/…/Saldo y
 * movimientos del más reciente al más antiguo).
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import ExcelJS from 'exceljs';
import { FORMATO_BBVA_XLSX, leerBbvaXlsx } from '../lib/banca/bbvaXlsx.js';
import { FORMATO_CAIXA_XLSX, leerCaixaXlsx } from '../lib/banca/caixaXlsx.js';
import { huellaMovimiento } from '../lib/banca/canonico.js';
import { detectarLector, listarFormatos } from '../lib/banca/lectores.js';
import { leerExcelBancario } from '../lib/banca/xlsxAuto.js';

const IBAN = 'ES7821004224312200316426';
const IBAN_TITULO = 'ES78 2100 4224 3122 0031 6426';

const CABECERA = ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo'];

/**
 * Genera un .xlsx con la maqueta del extracto de CaixaBank.
 * `desplazar` empuja todo hacia abajo para no depender de números de fila fijos.
 */
async function libroCaixa({
  titulo = `Movimientos de la cuenta ${IBAN_TITULO} (CCC: 2100 4224 31 22 0031 6426)`,
  movimientos = [],
  cabecera = CABECERA,
  conTitulo = true,
  desplazar = 0,
  nombreHoja = 'Movimientos_cuenta_0316426',
} = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(nombreHoja);
  const pon = (fila, columna, valor) => {
    if (valor === '' || valor == null) return;
    ws.getCell(fila, columna).value = valor;
  };

  let f = 1 + desplazar;
  if (conTitulo) {
    pon(f, 1, titulo);
    f += 1;
    pon(f, 1, 'Importes expresados en euros');
    f += 1;
  }

  cabecera.forEach((nombre, i) => pon(f, i + 1, nombre));
  f += 1;

  for (const m of movimientos) {
    [
      m.fecha,
      m.fechaValor ?? m.fecha,
      m.movimiento,
      m.masDatos,
      m.importe,
      m.saldo,
    ].forEach((valor, i) => pon(f, i + 1, valor));
    f += 1;
  }

  ws.getCell(f + 50, 1).border = { top: { style: 'thin' } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Maqueta mínima BBVA (suficiente para que la autodetection no la confunda con Caixa). */
async function libroBbvaMinimo() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Historico');
  ws.getCell(5, 3).value = 'Cuenta';
  ws.getCell(5, 6).value = 'ES6201822745140201566714';
  ws.getCell(8, 3).value = 'F. CONTABLE';
  ws.getCell(8, 4).value = 'F. VALOR';
  ws.getCell(8, 5).value = 'CÓDIGO';
  ws.getCell(8, 6).value = 'CONCEPTO';
  ws.getCell(8, 7).value = 'BENEFICIARIO/ORDENANTE';
  ws.getCell(8, 8).value = 'OBSERVACIONES';
  ws.getCell(8, 9).value = 'IMPORTE';
  ws.getCell(8, 10).value = 'SALDO';
  ws.getCell(9, 3).value = '02/02/2026';
  ws.getCell(9, 4).value = '02/02/2026';
  ws.getCell(9, 5).value = '00317';
  ws.getCell(9, 6).value = 'RECIBO';
  ws.getCell(9, 9).value = -100;
  ws.getCell(9, 10).value = 900;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Encadena en SALDO el saldo posterior (movimientos en orden ascendente). */
function conSaldos(movimientosAsc, saldoInicial) {
  let centimos = Math.round(saldoInicial * 100);
  return movimientosAsc.map((m) => {
    centimos += Math.round(m.importe * 100);
    return { ...m, saldo: centimos / 100 };
  });
}

/** Tres apuntes de agosto, del más antiguo al más reciente. */
const AGOSTO_ASC = conSaldos([
  {
    fecha: '2026-08-11',
    movimiento: 'TRASPASO',
    masDatos: 'LDMEG INVESTMENT SL',
    importe: -4000,
  },
  {
    fecha: '2026-08-12',
    movimiento: '2026F40 d7f4b76c',
    masDatos: 'COCTEMATIAS SL',
    importe: -340.23,
  },
  {
    fecha: '2026-08-17',
    movimiento: 'ON 369052451 1608',
    masDatos: 'Comercia Global Payments',
    importe: 2851.85,
  },
], 80756.12);

const AGOSTO_DESC = [...AGOSTO_ASC].reverse();

test('lee el IBAN del título y cuenta los movimientos', async () => {
  const extracto = await leerCaixaXlsx(await libroCaixa({ movimientos: AGOSTO_DESC }));

  assert.equal(extracto.formato, FORMATO_CAIXA_XLSX);
  assert.equal(extracto.codificacion, 'xlsx');
  assert.equal(extracto.hashFichero.length, 64);
  assert.deepEqual(extracto.errores, []);
  assert.equal(extracto.cuentas.length, 1);

  const cuenta = extracto.cuentas[0];
  assert.equal(cuenta.iban, IBAN);
  assert.equal(cuenta.cuentaRef, IBAN);
  assert.equal(cuenta.ibanValido, true);
  assert.equal(cuenta.divisa, '978');
  assert.equal(cuenta.movimientos.length, 3);
});

test('conserva signos e importes en céntimos enteros (incluye decimales)', async () => {
  const extracto = await leerCaixaXlsx(await libroCaixa({ movimientos: AGOSTO_DESC }));
  const movs = extracto.cuentas[0].movimientos;

  assert.deepEqual(movs.map((m) => m.fechaOperacion), ['2026-08-17', '2026-08-12', '2026-08-11']);
  assert.deepEqual(movs.map((m) => m.importe), [2851.85, -340.23, -4000]);
  assert.deepEqual(movs.map((m) => m.importeCentimos), [285185, -34023, -400000]);
  assert.deepEqual(movs.map((m) => m.signo), ['H', 'D', 'D']);
  for (const m of movs) assert.ok(Number.isInteger(m.importeCentimos));
});

test('referencia1 es Más datos (beneficiario) y el concepto junta Movimiento + Más datos', async () => {
  const extracto = await leerCaixaXlsx(await libroCaixa({ movimientos: AGOSTO_DESC }));
  const [tpv, traspasoInterno, traspaso] = extracto.cuentas[0].movimientos;

  assert.equal(tpv.referencia1, 'Comercia Global Payments');
  assert.equal(tpv.referencia2, '');
  assert.equal(tpv.numeroDocumento, '');
  assert.equal(tpv.conceptoPropio, '');
  assert.equal(tpv.conceptoComun, '');
  assert.match(tpv.concepto, /ON 369052451 1608/);
  assert.match(tpv.concepto, /Comercia Global Payments/);

  assert.equal(traspasoInterno.referencia1, 'COCTEMATIAS SL');
  assert.equal(traspaso.referencia1, 'LDMEG INVESTMENT SL');
  assert.equal(traspaso.conceptoPropio, '');
});

test('el ordinal no depende del orden de las filas (asc vs desc → mismas huellas)', async () => {
  const asc = conSaldos([
    { fecha: '2026-08-05', movimiento: 'CONSUMO', masDatos: 'A', importe: -3.5 },
    { fecha: '2026-08-05', movimiento: 'CONSUMO', masDatos: 'B', importe: -3.5 },
    { fecha: '2026-08-05', movimiento: 'CONSUMO', masDatos: 'C', importe: -7 },
    { fecha: '2026-08-06', movimiento: 'CONSUMO', masDatos: 'D', importe: -3.5 },
  ], 100);

  const ascendente = await leerCaixaXlsx(await libroCaixa({ movimientos: asc }));
  const descendente = await leerCaixaXlsx(await libroCaixa({ movimientos: [...asc].reverse() }));

  assert.deepEqual(ascendente.cuentas[0].movimientos.map((m) => m.ordinal), [1, 2, 1, 1]);
  assert.deepEqual(descendente.cuentas[0].movimientos.map((m) => m.ordinal), [1, 1, 1, 2]);

  const huellas = (e) => e.cuentas[0].movimientos.map((m) => m.movementHash).sort();
  assert.deepEqual(huellas(ascendente), huellas(descendente));
  assert.equal(new Set(huellas(ascendente)).size, 4);
});

test('la huella es huellaMovimiento del canónico', async () => {
  const extracto = await leerCaixaXlsx(await libroCaixa({ movimientos: AGOSTO_DESC }));
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
    );
  }

  assert.equal(
    movs[0].movementHash,
    huellaMovimiento({
      cuenta: IBAN,
      fechaOperacion: '2026-08-17',
      importeCentimos: 285185,
      ordinal: 1,
    }),
  );
});

test('una fila con fecha corrupta se anota en errores y el resto se lee', async () => {
  const movimientos = [
    { fecha: '32/13/2026', movimiento: 'ROTO', masDatos: 'X', importe: -50, saldo: 950 },
    ...conSaldos([
      { fecha: '2026-08-10', movimiento: 'OK', masDatos: 'A', importe: -100 },
      { fecha: '2026-08-11', movimiento: 'OK', masDatos: 'B', importe: 250 },
    ], 1000).reverse(),
  ];

  const extracto = await leerCaixaXlsx(await libroCaixa({ movimientos }));

  assert.equal(extracto.errores.length, 1);
  assert.equal(extracto.errores[0].tipo, 'FILA');
  assert.match(extracto.errores[0].motivo, /Fecha/);
  assert.deepEqual(
    extracto.cuentas[0].movimientos.map((m) => m.importe),
    [250, -100],
  );
});

test('los saldos cuadran; un descuadre se informa sin perder el extracto', async () => {
  const ok = await leerCaixaXlsx(await libroCaixa({ movimientos: AGOSTO_DESC }));
  assert.equal(ok.cuentas[0].saldoInicial, 80756.12);
  assert.equal(ok.cuentas[0].saldoFinal, 79267.74);
  assert.deepEqual(ok.cuentas[0].descuadres, []);

  const movimientos = AGOSTO_DESC.map((m, i) => (
    i === 0 ? { ...m, saldo: m.saldo + 100 } : m
  ));
  const mal = await leerCaixaXlsx(await libroCaixa({ movimientos }));
  assert.equal(mal.cuentas[0].movimientos.length, 3);
  assert.deepEqual(mal.cuentas[0].descuadres, [
    { campo: 'saldoFinal', declarado: 79367.74, calculado: 79267.74 },
  ]);
  assert.deepEqual(mal.errores, []);
});

test('sin cabecera o sin IBAN en el título se rechaza con mensaje claro', async () => {
  const otro = new ExcelJS.Workbook();
  otro.addWorksheet('Hoja1').getCell('A1').value = 'Listado de proveedores';
  const sinCabecera = Buffer.from(await otro.xlsx.writeBuffer());
  const sinIban = await libroCaixa({
    movimientos: AGOSTO_DESC,
    titulo: 'Movimientos de la cuenta (sin IBAN)',
  });

  await assert.rejects(() => leerCaixaXlsx(sinCabecera), /no se encuentra la fila de cabecera/);
  await assert.rejects(() => leerCaixaXlsx(sinIban), /no se encuentra el IBAN/);
});

test('listarFormatos incluye BBVA_XLSX y CAIXA_XLSX; .xlsx usa autodetection', () => {
  const claves = listarFormatos().map((f) => f.clave);
  assert.ok(claves.includes(FORMATO_BBVA_XLSX));
  assert.ok(claves.includes(FORMATO_CAIXA_XLSX));
  assert.ok(!claves.includes('XLSX'));

  const porExtension = detectarLector({ nombreFichero: 'extracto agosto.xlsx' });
  assert.equal(porExtension.ok, true);
  assert.equal(porExtension.lector.clave, 'XLSX');
  assert.equal(porExtension.lector.traeIban, true);

  const forzadoCaixa = detectarLector({ nombreFichero: 'x.dat', formato: FORMATO_CAIXA_XLSX });
  assert.equal(forzadoCaixa.ok, true);
  assert.equal(forzadoCaixa.lector.clave, FORMATO_CAIXA_XLSX);

  const forzadoBbva = detectarLector({ nombreFichero: 'x.dat', formato: FORMATO_BBVA_XLSX });
  assert.equal(forzadoBbva.ok, true);
  assert.equal(forzadoBbva.lector.clave, FORMATO_BBVA_XLSX);
});

test('la autodetection no confunde maqueta BBVA con Caixa ni al revés', async () => {
  const bufCaixa = await libroCaixa({ movimientos: AGOSTO_DESC });
  const bufBbva = await libroBbvaMinimo();

  const porCaixa = await leerCaixaXlsx(bufCaixa);
  const porBbva = await leerBbvaXlsx(bufBbva);
  assert.equal(porCaixa.formato, FORMATO_CAIXA_XLSX);
  assert.equal(porBbva.formato, FORMATO_BBVA_XLSX);

  const autoCaixa = await leerExcelBancario(bufCaixa);
  const autoBbva = await leerExcelBancario(bufBbva);
  assert.equal(autoCaixa.formato, FORMATO_CAIXA_XLSX);
  assert.equal(autoBbva.formato, FORMATO_BBVA_XLSX);
  assert.equal(autoCaixa.cuentas[0].iban, IBAN);
  assert.equal(autoBbva.cuentas[0].iban, 'ES6201822745140201566714');

  const lector = detectarLector({ nombreFichero: 'cualquiera.xlsx' }).lector;
  assert.equal((await lector.leer(bufCaixa)).formato, FORMATO_CAIXA_XLSX);
  assert.equal((await lector.leer(bufBbva)).formato, FORMATO_BBVA_XLSX);

  const vacio = new ExcelJS.Workbook();
  vacio.addWorksheet('Hoja1').getCell('A1').value = 'nada';
  const bufVacio = Buffer.from(await vacio.xlsx.writeBuffer());
  await assert.rejects(
    () => leerExcelBancario(bufVacio),
    /no parece un extracto BBVA ni CaixaBank/,
  );
});
