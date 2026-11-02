/**
 * Parser puro del dictado por voz del conteo. Sin Dynamo, sin red, sin IA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { partirCantidad, numeroEnPalabras, parsearDictado } = await import(
  '../lib/inventarios/dictado/parser.js'
);

function una(texto, opciones) {
  const { ordenes } = parsearDictado(texto, opciones);
  assert.equal(ordenes.length, 1, `«${texto}» debería dar una orden y da ${ordenes.length}`);
  return ordenes[0];
}

function cantidad(total, stockReal, botellasAbiertas) {
  return { total, stockReal, botellasAbiertas };
}

// --- partirCantidad --------------------------------------------------------

test('partirCantidad suma con botella abierta repartiendo el total', () => {
  assert.deepEqual(partirCantidad(0.5 + 0.75), { stockReal: 1, botellasAbiertas: 0.25, redondeada: false });
});

test('partirCantidad lleva la fracción a la botella más cercana y lo marca', () => {
  assert.deepEqual(partirCantidad(2.2), { stockReal: 2, botellasAbiertas: 0.25, redondeada: true });
  assert.deepEqual(partirCantidad(2.9), { stockReal: 2, botellasAbiertas: 0.9, redondeada: false });
  assert.deepEqual(partirCantidad(7), { stockReal: 7, botellasAbiertas: 0, redondeada: false });
  assert.deepEqual(partirCantidad(0), { stockReal: 0, botellasAbiertas: 0, redondeada: false });
});

test('partirCantidad con negativo devuelve las partes con signo', () => {
  assert.deepEqual(partirCantidad(-1.5), { stockReal: -1, botellasAbiertas: -0.5, redondeada: false });
});

test('partirCantidad rechaza valores no numéricos', () => {
  assert.throws(() => partirCantidad(Number.NaN), TypeError);
  assert.throws(() => partirCantidad('3'), TypeError);
});

// --- números en palabras ---------------------------------------------------

test('numeroEnPalabras lee números en español', () => {
  const casos = {
    cero: 0, uno: 1, una: 1, un: 1, siete: 7, veinte: 20, veintiuno: 21, 'veintidós': 22,
    'treinta y uno': 31, 'treinta y dos': 32, cuarenta: 40, cincuenta: 50, noventa: 90,
    cien: 100, 'ciento veinte': 120, 'ciento cinco': 105, doscientos: 200, 'novecientos noventa y nueve': 999,
    mil: 1000, 'mil doscientos': 1200, 'dos mil': 2000, '2,5': 2.5, '2.5': 2.5,
    'dos coma cinco': 2.5, medio: 0.5, media: 0.5, 'tres y media': 3.5, 'DIECISÉIS': 16,
  };
  for (const [texto, valor] of Object.entries(casos)) {
    assert.equal(numeroEnPalabras(texto), valor, texto);
  }
  assert.equal(numeroEnPalabras('Roku'), null);
  assert.equal(numeroEnPalabras(''), null);
});

// --- cálculos ------------------------------------------------------------

test('cajas de M más K', () => {
  const o = una('Coca-Cola 12 cajas de 24 más 5');
  assert.equal(o.tipo, 'linea');
  assert.equal(o.textoProducto, 'Coca-Cola');
  assert.deepEqual(o.cantidad, cantidad(293, 293, 0));
  assert.deepEqual(o.calculo, { expresion: '12×24+5', total: 293, faltaFormato: false });
  assert.equal(o.confirmar, true);
  assert.deepEqual(o.motivos, ['calculo']);
});

test('packs de M', () => {
  const o = una('Heineken 3 packs de 6');
  assert.equal(o.textoProducto, 'Heineken');
  assert.equal(o.cantidad.total, 18);
  assert.equal(o.calculo.expresion, '3×6');
});

test('cajas y media de M', () => {
  const o = una('Fanta 2 cajas y media de 24');
  assert.equal(o.textoProducto, 'Fanta');
  assert.equal(o.cantidad.total, 60);
  assert.equal(o.calculo.expresion, '2,5×24');
});

test('cajas sin «de M» usa el formato resuelto', () => {
  const o = una('Sprite 12 cajas', {
    resolverFormato: (texto) => (texto === 'Sprite' ? { unidadesCaja: 24 } : null),
  });
  assert.equal(o.textoProducto, 'Sprite');
  assert.equal(o.cantidad.total, 288);
  assert.deepEqual(o.calculo, { expresion: '12×24', total: 288, faltaFormato: false });
});

test('cajas sin formato marcan faltaFormato y no dan total', () => {
  const o = una('Sprite 12 cajas');
  assert.equal(o.textoProducto, 'Sprite');
  assert.equal(o.cantidad, null);
  assert.equal(o.calculo.faltaFormato, true);
  assert.equal(o.calculo.total, null);
  assert.equal(o.confirmar, true);
  assert.deepEqual(o.motivos, ['calculo', 'falta_formato']);
});

test('formatos por nombre o por producto activo; packs usa unidadesPack', () => {
  const formatos = new Map([['Heineken', { unidadesCaja: 24, unidadesPack: 6 }]]);
  assert.equal(una('heineken 2 packs', { formatos }).cantidad.total, 12);
  assert.equal(una('heineken 2 cajas', { formatos }).cantidad.total, 48);
  const o = una('3 cajas', { formatos: { P1: { unidadesCaja: 12 } }, productId: 'P1' });
  assert.equal(o.textoProducto, null);
  assert.equal(o.cantidad.total, 36);
  assert.equal(una('Heineken 2 packs', { formatos: { Heineken: { unidadesCaja: 24 } } }).calculo.faltaFormato, true);
});

test('cajas de M menos K', () => {
  const o = una('Red Bull 10 cajas de 24 menos 3');
  assert.equal(o.textoProducto, 'Red Bull');
  assert.equal(o.cantidad.total, 237);
  assert.equal(o.calculo.expresion, '10×24−3');
});

test('el número del nombre no se multiplica', () => {
  const o = una('Larios 12 2 cajas de 6');
  assert.equal(o.textoProducto, 'Larios 12');
  assert.equal(o.cantidad.total, 12);
  assert.equal(o.calculo.expresion, '2×6');
});

test('N por M', () => {
  const o = una('Pepsi 9 por 24');
  assert.equal(o.textoProducto, 'Pepsi');
  assert.equal(o.cantidad.total, 216);
  assert.equal(o.calculo.expresion, '9×24');
});

// --- comandos --------------------------------------------------------------

test('sumar: «suma N a prod» y «prod N más»', () => {
  for (const texto of ['suma 3 a Roku', 'Roku 3 más', 'Roku 3 mas', 'se añadieron 3 Roku']) {
    const o = una(texto);
    assert.equal(o.tipo, 'sumar', texto);
    assert.equal(o.textoProducto, 'Roku', texto);
    assert.deepEqual(o.cantidad, cantidad(3, 3, 0), texto);
    assert.equal(o.confirmar, false, texto);
  }
});

test('quitar es sumar con total negativo', () => {
  const o = una('quita 2 a Roku');
  assert.equal(o.tipo, 'sumar');
  assert.equal(o.textoProducto, 'Roku');
  assert.deepEqual(o.cantidad, cantidad(-2, -2, 0));
});

test('reemplazar con y sin producto', () => {
  const sin = una('ahora son 10');
  assert.equal(sin.tipo, 'reemplazar');
  assert.equal(sin.textoProducto, null);
  assert.deepEqual(sin.cantidad, cantidad(10, 10, 0));
  const con = una('Roku ahora son 10');
  assert.equal(con.tipo, 'reemplazar');
  assert.equal(con.textoProducto, 'Roku');
  assert.deepEqual(con.cantidad, cantidad(10, 10, 0));
});

test('corregir, borrar y control', () => {
  for (const texto of ['corrige, Roku 8', 'corrige Roku 8']) {
    const o = una(texto);
    assert.equal(o.tipo, 'corregir', texto);
    assert.equal(o.textoProducto, 'Roku');
    assert.deepEqual(o.cantidad, cantidad(8, 8, 0));
  }
  const b = una('borra Roku');
  assert.equal(b.tipo, 'borrar');
  assert.equal(b.textoProducto, 'Roku');
  assert.equal(b.cantidad, null);
  assert.equal(una('revierte Larios 12').textoProducto, 'Larios 12');
  assert.equal(una('pausa').tipo, 'pausa');
  assert.equal(una('Pausa.').tipo, 'pausa');
  assert.equal(una('sigue').tipo, 'sigue');
  assert.equal(una('continúa').tipo, 'sigue');
});

// --- fracciones ----------------------------------------------------------

test('«X con Y» redondeada pide confirmar', () => {
  const o = una('Bombay 2 con 20');
  assert.equal(o.textoProducto, 'Bombay');
  assert.deepEqual(o.cantidad, cantidad(2.2, 2, 0.25));
  assert.equal(o.confirmar, true);
  assert.deepEqual(o.motivos, ['fraccion_redondeada']);
  assert.equal(o.calculo, undefined);
});

test('«X con Y» exacta no pide confirmar', () => {
  assert.deepEqual(una('Roku 2 con 25').cantidad, cantidad(2.25, 2, 0.25));
  assert.equal(una('Roku 2 con 25').confirmar, false);
  assert.deepEqual(una('Roku 2 con 50').cantidad, cantidad(2.5, 2, 0.5));
  assert.deepEqual(una('Roku 2 con 5').cantidad, cantidad(2.5, 2, 0.5));
  assert.deepEqual(una('Roku 1 con 90').cantidad, cantidad(1.9, 1, 0.9));
});

test('enteros, «y media» y decimales', () => {
  const roku = una('Roku 7');
  assert.equal(roku.tipo, 'linea');
  assert.deepEqual(roku.cantidad, cantidad(7, 7, 0));
  assert.equal(roku.confirmar, false);
  assert.deepEqual(roku.motivos, []);

  const johnnie = una('Johnnie 3 y media');
  assert.equal(johnnie.textoProducto, 'Johnnie');
  assert.deepEqual(johnnie.cantidad, cantidad(3.5, 3, 0.5));
  assert.equal(johnnie.confirmar, false);

  for (const texto of ['Beefeater dos coma cinco', 'Beefeater 2,5', 'Beefeater 2.5']) {
    const o = una(texto);
    assert.equal(o.textoProducto, 'Beefeater', texto);
    assert.deepEqual(o.cantidad, cantidad(2.5, 2, 0.5), texto);
  }
});

// --- números en palabras dentro de la frase ---------------------------------

test('números dictados en palabras', () => {
  assert.deepEqual(una('Roku siete').cantidad, cantidad(7, 7, 0));
  const coca = una('Coca-Cola doce cajas de veinticuatro más cinco');
  assert.equal(coca.textoProducto, 'Coca-Cola');
  assert.equal(coca.cantidad.total, 293);
  assert.equal(coca.calculo.expresion, '12×24+5');
  assert.equal(una('treinta y dos').cantidad.total, 32);
  assert.equal(una('ciento veinte').cantidad.total, 120);
  assert.equal(una('Roku treinta y dos').textoProducto, 'Roku');
});

// --- frases reales de la prueba del 2-nov -------------------------------------

test('frases reales del 2-nov', () => {
  const casos = [
    ['Larios 12 32', 'Larios 12', 32],
    ['Roku 7', 'Roku', 7],
    ['Bombay 7', 'Bombay', 7],
    ['Puerto de Indias 00 3', 'Puerto de Indias 00', 3],
    ['818 4', '818', 4],
    ['Licor de café 2 con 50', 'Licor de café', 2.5],
    ['Martini Extra Dry 1', 'Martini Extra Dry', 1],
  ];
  for (const [texto, producto, total] of casos) {
    const o = una(texto);
    assert.equal(o.tipo, 'linea', texto);
    assert.equal(o.textoProducto, producto, texto);
    assert.equal(o.cantidad.total, total, texto);
    assert.equal(o.confirmar, false, texto);
  }
});

// --- varias órdenes ----------------------------------------------------------

test('varias órdenes separadas por coma o «y»', () => {
  const { ordenes } = parsearDictado('Roku 7, Larios 12 4');
  assert.deepEqual(
    ordenes.map((o) => [o.textoProducto, o.cantidad.total]),
    [['Roku', 7], ['Larios 12', 4]],
  );
  const conY = parsearDictado('Roku 7 y Larios 12 4. Bombay 3 y media y borra Gordon').ordenes;
  assert.deepEqual(
    conY.map((o) => [o.tipo, o.textoProducto, o.cantidad?.total ?? null]),
    [['linea', 'Roku', 7], ['linea', 'Larios 12', 4], ['linea', 'Bombay', 3.5], ['borrar', 'Gordon', null]],
  );
  assert.equal(parsearDictado('Ron y Miel 3').ordenes[0].textoProducto, 'Ron y Miel');
});

test('comas del transcriptor dentro de una misma orden', () => {
  assert.deepEqual(
    parsearDictado('Roku, 7').ordenes.map((o) => [o.textoProducto, o.cantidad.total]),
    [['Roku', 7]],
  );
  assert.deepEqual(
    parsearDictado('Larios 12, 32').ordenes.map((o) => [o.textoProducto, o.cantidad.total]),
    [['Larios 12', 32]],
  );
});

test('producto sin cantidad pide confirmar', () => {
  const o = una('Roku');
  assert.equal(o.textoProducto, 'Roku');
  assert.equal(o.cantidad, null);
  assert.equal(o.confirmar, true);
  assert.deepEqual(o.motivos, ['sin_cantidad']);
});

// --- robustez ----------------------------------------------------------------

test('mayúsculas, acentos, puntuación y espacios', () => {
  const o = una('  COCA-COLA   12 CAJAS DE 24 MAS 5. ');
  assert.equal(o.textoProducto, 'COCA-COLA');
  assert.equal(o.cantidad.total, 293);
  assert.equal(una('Roku 7,').cantidad.total, 7);
  assert.equal(una('roku   ahora   SON  diez.').cantidad.total, 10);
  assert.equal(una('Roku 3 MÁS').tipo, 'sumar');
});

test('texto vacío no da órdenes', () => {
  assert.deepEqual(parsearDictado(''), { ordenes: [] });
  assert.deepEqual(parsearDictado('   . , '), { ordenes: [] });
  assert.deepEqual(parsearDictado(null), { ordenes: [] });
});

test('cada orden guarda su texto original', () => {
  const { ordenes } = parsearDictado('Roku 7, Bombay 2 con 20');
  assert.deepEqual(ordenes.map((o) => o.textoOriginal), ['Roku 7', 'Bombay 2 con 20']);
});

// --- revisión: ante la duda, confirmar -----------------------------------------

test('«<prod> más N» / «suma N» / «menos N» es sumar', () => {
  for (const texto of ['Roku más 3', 'Roku suma 3']) {
    const o = una(texto);
    assert.equal(o.tipo, 'sumar', texto);
    assert.equal(o.textoProducto, 'Roku', texto);
    assert.deepEqual(o.cantidad, cantidad(3, 3, 0), texto);
    assert.equal(o.confirmar, false, texto);
  }
  const menos = una('Roku menos 2');
  assert.equal(menos.tipo, 'sumar');
  assert.equal(menos.textoProducto, 'Roku');
  assert.deepEqual(menos.cantidad, cantidad(-2, -2, 0));
});

test('trozo con dos números tras coma es otra orden', () => {
  const { ordenes } = parsearDictado('Roku 7, 818 4');
  assert.deepEqual(
    ordenes.map((o) => [o.tipo, o.textoProducto, o.cantidad.total, o.confirmar]),
    [['linea', 'Roku', 7, false], ['linea', '818', 4, false]],
  );
});

test('número suelto tras coma se une y pide confirmar', () => {
  const o = una('Larios 12, 32');
  assert.equal(o.textoProducto, 'Larios 12');
  assert.equal(o.cantidad.total, 32);
  assert.equal(o.confirmar, true);
  assert.ok(o.motivos.includes('nombre_ambiguo'));
});

test('punto de miles pide confirmar; coma y punto con 1-2 cifras son decimales', () => {
  const o = una('Coca-Cola 1.500');
  assert.equal(o.textoProducto, 'Coca-Cola');
  assert.equal(o.cantidad.total, 1500);
  assert.equal(o.confirmar, true);
  assert.deepEqual(o.motivos, ['numero_ambiguo']);
  assert.equal(una('Coca-Cola 2.000').cantidad.total, 2000);
  assert.equal(una('Roku 2.5').cantidad.total, 2.5);
  assert.equal(una('Roku 2.5').confirmar, false);
  assert.equal(una('Roku 1,500').cantidad.total, 1.5);
});

test('restos de cantidad en el nombre piden revisar el texto', () => {
  for (const [texto, producto, total] of [
    ['Coca-Cola 12 cajas de 24 5', 'Coca-Cola 12 cajas de 24', 5],
    ['Fanta 2 cajas 6', 'Fanta 2 cajas', 6],
  ]) {
    const o = una(texto);
    assert.equal(o.textoProducto, producto, texto);
    assert.equal(o.cantidad.total, total, texto);
    assert.equal(o.confirmar, true, texto);
    assert.ok(o.motivos.includes('revisar_texto'), texto);
  }
});

test('«N media» es N,5 pero pide revisar', () => {
  const o = una('Roku 7 media');
  assert.equal(o.textoProducto, 'Roku');
  assert.deepEqual(o.cantidad, cantidad(7.5, 7, 0.5));
  assert.equal(o.confirmar, true);
  assert.ok(o.motivos.includes('revisar_texto'));
});

test('«y cuarto», «y un cuarto», «y tres cuartos»', () => {
  for (const [texto, esperada] of [
    ['Johnnie 3 y cuarto', cantidad(3.25, 3, 0.25)],
    ['Johnnie 3 y un cuarto', cantidad(3.25, 3, 0.25)],
    ['Johnnie 3 y tres cuartos', cantidad(3.75, 3, 0.75)],
  ]) {
    const o = una(texto);
    assert.equal(o.textoProducto, 'Johnnie', texto);
    assert.deepEqual(o.cantidad, esperada, texto);
    assert.equal(o.confirmar, false, texto);
  }
  assert.equal(numeroEnPalabras('tres y cuarto'), 3.25);
});

test('alternativas con el número dentro del nombre', () => {
  const larios = una('Larios 12');
  assert.equal(larios.textoProducto, 'Larios');
  assert.equal(larios.cantidad.total, 12);
  assert.equal(larios.confirmar, false);
  assert.deepEqual(larios.alternativas, [{ textoProducto: 'Larios 12', cantidad: null }]);

  const media = una('Larios 12 y media');
  assert.equal(media.textoProducto, 'Larios');
  assert.deepEqual(media.cantidad, cantidad(12.5, 12, 0.5));
  assert.deepEqual(media.alternativas, [{ textoProducto: 'Larios 12', cantidad: cantidad(0.5, 0, 0.5) }]);

  const doble = una('Larios 12 32');
  assert.equal(doble.textoProducto, 'Larios 12');
  assert.equal(doble.cantidad.total, 32);
  assert.deepEqual(doble.alternativas, [{ textoProducto: 'Larios 12 32', cantidad: null }]);

  assert.deepEqual(una('Coca-Cola 12 cajas de 24').alternativas, []);
  assert.deepEqual(una('borra Roku').alternativas, []);
});

test('autocorrección dentro de la frase', () => {
  for (const texto of ['Roku 7, no, 8', 'Roku 7 no 8', 'Roku 7, perdón, 8', 'Roku 7, digo 8', 'Roku 7, mejor dicho, 8']) {
    const o = una(texto);
    assert.equal(o.tipo, 'linea', texto);
    assert.equal(o.textoProducto, 'Roku', texto);
    assert.deepEqual(o.cantidad, cantidad(8, 8, 0), texto);
    assert.equal(o.confirmar, true, texto);
    assert.deepEqual(o.motivos, ['autocorreccion'], texto);
  }
  const { ordenes } = parsearDictado('Roku 7, no, Bombay 8');
  assert.deepEqual(
    ordenes.map((o) => [o.tipo, o.textoProducto, o.cantidad.total, o.confirmar]),
    [['linea', 'Roku', 7, false], ['corregir', 'Bombay', 8, true]],
  );
  assert.deepEqual(ordenes[1].motivos, ['autocorreccion']);
});

test('símbolos del transcriptor son cálculo; el guion entre letras no', () => {
  const rb = una('Red Bull 10×24−3');
  assert.equal(rb.textoProducto, 'Red Bull');
  assert.equal(rb.cantidad.total, 237);
  assert.equal(rb.calculo.expresion, '10×24−3');
  assert.equal(rb.confirmar, true);
  for (const [texto, total, expresion] of [
    ['Pepsi 9x24', 216, '9×24'],
    ['Pepsi 9 * 24', 216, '9×24'],
    ['Roku 7+3', 10, '7+3'],
    ['Roku 10-3', 7, '10−3'],
    ['Red Bull 10 x 24 - 3', 237, '10×24−3'],
  ]) {
    const o = una(texto);
    assert.equal(o.cantidad.total, total, texto);
    assert.equal(o.calculo.expresion, expresion, texto);
    assert.equal(o.confirmar, true, texto);
  }
  const coca = una('Coca-Cola 3');
  assert.equal(coca.textoProducto, 'Coca-Cola');
  assert.equal(coca.cantidad.total, 3);
  assert.equal(coca.confirmar, false);
});

test('texto demasiado largo lanza error 400', () => {
  assert.throws(
    () => parsearDictado('a'.repeat(2001)),
    (e) => e.status === 400 && e.message === 'El dictado es demasiado largo.',
  );
});

test('cantidades fuera de rango no lanzan y dejan la orden sin cantidad', () => {
  for (const texto of [`Roku ${'9'.repeat(400)}`, `Roku ${'9'.repeat(200)}`, 'Roku 200000', `${'9'.repeat(400)} cajas de ${'9'.repeat(400)}`]) {
    const o = una(texto);
    assert.equal(o.cantidad, null, texto);
    assert.equal(o.confirmar, true, texto);
    assert.ok(o.motivos.includes('cantidad_fuera_de_rango'), texto);
  }
  assert.equal(una('Roku 100000').cantidad.total, 100000);
  assert.equal(numeroEnPalabras('9'.repeat(400)), null);
});

test('texto largo se procesa en tiempo lineal', () => {
  const texto = 'Roku 7, '.repeat(250);
  assert.ok(texto.length <= 2000);
  const inicio = Date.now();
  const { ordenes } = parsearDictado(texto);
  assert.equal(ordenes.length, 250);
  const largo = parsearDictado(`${'Larios '.repeat(280)}7`);
  assert.equal(largo.ordenes[0].cantidad.total, 7);
  assert.ok(Date.now() - inicio < 1000);
});
