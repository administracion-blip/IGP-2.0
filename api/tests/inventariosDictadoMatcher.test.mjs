/**
 * Matcher puro del dictado por voz del conteo (texto → producto). Sin Dynamo, sin red, sin IA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizarTexto, normalizarCompacto, normalizarAlias, MAX_LONGITUD_ALIAS, prepararIndice, emparejarProducto,
  vocabularioTranscripcion,
  filtrarCandidatosParecidos,
} = await import('../lib/inventarios/dictado/matcher.js');
const { ALIAS_SEMILLA } = await import('../lib/inventarios/dictado/aliasesSemilla.js');
const { parsearDictado } = await import('../lib/inventarios/dictado/parser.js');

const NOMBRES = [
  'LARIOS 12', 'LARIOS', 'ROKU', 'BOMBAY SAPPHIRE', 'PUERTO DE INDIAS 00', '818 TEQUILA', 'LICOR DE CAFE',
  'MARTINI EXTRA DRY', 'COCA COLA 35CL', 'COCA COLA ZERO 35CL', 'JOHNNIE WALKER RED LABEL',
  'JOHNNIE WALKER BLACK LABEL', 'RON Y MIEL', 'HEINEKEN TERCIO', 'RED BULL', 'MAHOU 5 ESTRELLAS',
];
const id = (nombre) => `P-${nombre.replace(/ /g, '_')}`;
const producto = (nombre, extra = {}) => ({ productId: id(nombre), nombre, familiaNombre: 'Bebidas', unidad: 'ud', ...extra });
const PRODUCTOS = NOMBRES.map((n) => producto(n));
const solo = (...nombres) => nombres.map((n) => producto(n));

function una(texto) {
  const { ordenes } = parsearDictado(texto);
  assert.equal(ordenes.length, 1, `«${texto}» debería dar una orden`);
  return ordenes[0];
}

function emparejar(texto, opciones = {}) {
  return emparejarProducto(una(texto), { productos: PRODUCTOS, ...opciones });
}

const ids = (r) => r.candidatos.map((c) => c.productId);

// --- normalización -----------------------------------------------------------

test('normalizarTexto: minúsculas, sin acentos, puntuación a espacio, compactado', () => {
  assert.equal(normalizarTexto('Coca-Cola'), 'coca cola');
  assert.equal(normalizarTexto('COCA COLA'), 'coca cola');
  assert.equal(normalizarTexto('  Licor   de Café. '), 'licor de cafe');
  assert.equal(normalizarTexto('Jägermeister'), 'jagermeister');
  assert.equal(normalizarTexto('Añejo'), 'anejo');
  assert.equal(normalizarTexto("Hendrick's"), 'hendricks');
  assert.equal(normalizarTexto('J&B'), 'j b');
  assert.equal(normalizarTexto('TXT#roku/7'), 'txt roku 7');
  assert.equal(normalizarTexto(null), '');
  assert.equal(normalizarTexto(' .,- '), '');
  assert.equal(normalizarCompacto('Coca-Cola'), 'cocacola');
  assert.equal(normalizarCompacto('cocacola'), 'cocacola');
});

test('normalizarTexto es estable (idempotente) y válida como segmento de clave', () => {
  for (const t of [...NOMBRES, 'Coca-Cola', 'Ñandú #1', 'Pâté «extra»', '1,5L']) {
    const n = normalizarTexto(t);
    assert.equal(normalizarTexto(n), n, t);
    assert.match(n, /^[a-z0-9]+( [a-z0-9]+)*$/, t);
  }
});

// --- exacto y tokens --------------------------------------------------------

test('nombre exacto: «Roku 7» → ROKU sin dudas', () => {
  const r = emparejar('Roku 7');
  assert.equal(r.productId, id('ROKU'));
  assert.equal(r.nombre, 'ROKU');
  assert.equal(r.via, 'exacto');
  assert.equal(r.confianza, 1);
  assert.deepEqual(r.lectura, { textoProducto: 'Roku', cantidad: { total: 7, stockReal: 7, botellasAbiertas: 0 } });
  assert.equal(r.confirmar, false);
  assert.deepEqual(r.motivos, []);
  assert.equal(r.candidatos[0].productId, id('ROKU'));
});

test('prefijo único: «Bombay» → BOMBAY SAPPHIRE sin confirmar; «818» → 818 TEQUILA', () => {
  const b = emparejar('Bombay 7');
  assert.equal(b.productId, id('BOMBAY SAPPHIRE'));
  assert.equal(b.via, 'palabras');
  assert.equal(b.confirmar, false);
  const t = emparejar('818 4');
  assert.equal(t.productId, id('818 TEQUILA'));
  assert.equal(t.lectura.cantidad.total, 4);
  assert.equal(t.confirmar, false);
});

test('marca con dos variantes en la plantilla: «Bombay» y «818» son ambiguos', () => {
  const casos = [
    ['Bombay 7', ['BOMBAY SAPPHIRE', 'BOMBAY ORIGINAL'], 7],
    ['818 4', ['818 SILVER', '818 REPOSADO'], 4],
  ];
  for (const [texto, nombres, cantidad] of casos) {
    const productos = [...PRODUCTOS.filter((p) => !p.nombre.startsWith(nombres[0].split(' ')[0])), ...solo(...nombres)];
    for (const semilla of [ALIAS_SEMILLA, []]) {
      const r = emparejarProducto(una(texto), { productos, semilla });
      assert.equal(r.productId, null, texto);
      assert.equal(r.confirmar, true, texto);
      assert.ok(r.motivos.includes('ambiguo'), texto);
      assert.deepEqual(ids(r).slice(0, 2).sort(), nombres.map(id).sort(), texto);
      assert.equal(r.lectura.cantidad.total, cantidad, texto);
    }
  }
});

test('«Johnnie» con RED y BLACK LABEL es ambiguo', () => {
  for (const semilla of [ALIAS_SEMILLA, []]) {
    const r = emparejar('Johnnie 3', { semilla });
    assert.equal(r.productId, null);
    assert.equal(r.via, null);
    assert.equal(r.confirmar, true);
    assert.ok(r.motivos.includes('ambiguo'));
    assert.ok(ids(r).includes(id('JOHNNIE WALKER RED LABEL')));
    assert.ok(ids(r).includes(id('JOHNNIE WALKER BLACK LABEL')));
  }
});

test('«Coca-Cola»: gana la versión sin variante; el tamaño no penaliza', () => {
  for (const semilla of [ALIAS_SEMILLA, []]) {
    const r = emparejar('Coca-Cola 3', { semilla });
    assert.equal(r.productId, id('COCA COLA 35CL'));
    assert.equal(r.confirmar, false);
  }
  assert.equal(emparejar('Coca Cola Zero 3').productId, id('COCA COLA ZERO 35CL'));
  assert.equal(emparejar('Coca zero 3').productId, id('COCA COLA ZERO 35CL'));
  assert.equal(emparejar('cocacola 3').productId, id('COCA COLA 35CL'));
  // Dos tamaños sin variante: empate → confirmar.
  const empate = emparejarProducto(una('Coca-Cola 3'), { productos: solo('COCA COLA 35CL', 'COCA COLA 1L') });
  assert.equal(empate.productId, null);
  assert.ok(empate.motivos.includes('ambiguo'));
  assert.equal(empate.candidatos.length, 2);
});

test('formato «tercio» no penaliza: «Heineken 6» → HEINEKEN TERCIO', () => {
  const r = emparejar('Heineken 6');
  assert.equal(r.productId, id('HEINEKEN TERCIO'));
  assert.equal(r.confirmar, false);
});

test('nombre compacto: «Redbull 3» → RED BULL', () => {
  const r = emparejar('Redbull 3');
  assert.equal(r.productId, id('RED BULL'));
  assert.equal(r.confirmar, false);
});

test('palabra no inicial y única en la lista: «Estrella» → MAHOU, y el 5 no dicho confirma', () => {
  const r = emparejar('Estrella 3');
  assert.equal(r.productId, id('MAHOU 5 ESTRELLAS'));
  assert.equal(r.via, 'palabras');
  assert.equal(r.confirmar, true);
  assert.ok(r.motivos.includes('variante_no_dicha'));
});

// --- lecturas con número en el nombre ---------------------------------------------

test('«Larios 12» con LARIOS y LARIOS 12: elige {LARIOS, 12} pero ambiguo', () => {
  const r = emparejar('Larios 12');
  assert.equal(r.productId, id('LARIOS'));
  assert.equal(r.lectura.textoProducto, 'Larios');
  assert.equal(r.lectura.cantidad.total, 12);
  assert.equal(r.confirmar, true);
  assert.ok(r.motivos.includes('ambiguo'));
  assert.ok(ids(r).includes(id('LARIOS 12')));
});

test('«Larios 12» con solo LARIOS 12: {LARIOS 12, sin cantidad}', () => {
  const r = emparejarProducto(una('Larios 12'), { productos: solo('LARIOS 12', 'ROKU') });
  assert.equal(r.productId, id('LARIOS 12'));
  assert.deepEqual(r.lectura, { textoProducto: 'Larios 12', cantidad: null });
  assert.equal(r.via, 'exacto');
  assert.equal(r.confirmar, true);
  assert.ok(r.motivos.includes('sin_cantidad'));
});

test('«Larios 12» con solo LARIOS: {LARIOS, 12} sin dudas', () => {
  const r = emparejarProducto(una('Larios 12'), { productos: solo('LARIOS', 'ROKU') });
  assert.equal(r.productId, id('LARIOS'));
  assert.equal(r.lectura.cantidad.total, 12);
  assert.equal(r.confirmar, false);
});

test('«Larios 12 32» con ambos → LARIOS 12, 32 sin dudas', () => {
  const r = emparejar('Larios 12 32');
  assert.equal(r.productId, id('LARIOS 12'));
  assert.equal(r.lectura.cantidad.total, 32);
  assert.equal(r.confirmar, false);
  assert.deepEqual(r.motivos, []);
});

test('«Larios 12 y media» con ambos → ambiguo', () => {
  const r = emparejar('Larios 12 y media');
  assert.equal(r.confirmar, true);
  assert.ok(r.motivos.includes('ambiguo'));
  assert.ok(ids(r).includes(id('LARIOS')));
  assert.ok(ids(r).includes(id('LARIOS 12')));
  const soloL12 = emparejarProducto(una('Larios 12 y media'), { productos: solo('LARIOS 12') });
  assert.equal(soloL12.productId, id('LARIOS 12'));
  assert.equal(soloL12.confirmar, true, '12,5 o 0,5 de LARIOS 12');
  assert.ok(soloL12.motivos.includes('ambiguo'));
});

test('número del nombre no dicho: «Mahou 5» y «Mahou 4» confirman', () => {
  const cinco = emparejar('Mahou 5');
  assert.equal(cinco.productId, id('MAHOU 5 ESTRELLAS'));
  assert.equal(cinco.confirmar, true);
  const cuatro = emparejar('Mahou 4');
  assert.equal(cuatro.productId, id('MAHOU 5 ESTRELLAS'));
  assert.equal(cuatro.lectura.cantidad.total, 4);
  assert.equal(cuatro.confirmar, true);
  assert.ok(cuatro.motivos.includes('variante_no_dicha'), 'el «5» de MAHOU 5 ESTRELLAS no se dijo');
});

test('borrar no necesita cantidad', () => {
  const r = emparejar('borra Larios 12');
  assert.equal(r.productId, id('LARIOS 12'));
  assert.equal(r.confirmar, false);
  assert.deepEqual(r.motivos, []);
});

// --- aproximado y sin coincidencia ------------------------------------------

test('aproximado siempre confirma', () => {
  for (const [texto, nombre] of [
    ['Rocu 7', 'ROKU'],
    ['Martini extra drai 1', 'MARTINI EXTRA DRY'],
    ['Liquor de cafe 2', 'LICOR DE CAFE'],
    ['Bombai Saphire 2', 'BOMBAY SAPPHIRE'],
  ]) {
    const r = emparejar(texto);
    assert.equal(r.productId, id(nombre), texto);
    assert.equal(r.via, 'aproximado', texto);
    assert.equal(r.confirmar, true, texto);
    assert.ok(r.motivos.includes('aproximado'), texto);
    assert.ok(r.confianza > 0 && r.confianza <= 0.8, texto);
  }
});

test('sin coincidencia razonable: productId null y candidatos cercanos', () => {
  const r = emparejar('Bombai Zafiro 2');
  assert.equal(r.productId, null);
  assert.equal(r.via, null);
  assert.equal(r.confirmar, true);
  assert.deepEqual(r.motivos, ['sin_coincidencia']);
  assert.ok(ids(r).includes(id('BOMBAY SAPPHIRE')));
  const nada = emparejar('Pacharán Zoco 2');
  assert.equal(nada.productId, null);
  assert.deepEqual(nada.motivos, ['sin_coincidencia']);
  assert.ok(nada.candidatos.length <= 5);
});

test('orden sin producto: sin_producto, sin confirmar', () => {
  for (const texto of ['ahora son 10', 'pausa', 'sigue']) {
    const r = emparejar(texto);
    assert.equal(r.productId, null, texto);
    assert.equal(r.via, null, texto);
    assert.deepEqual(r.motivos, ['sin_producto'], texto);
    assert.equal(r.confirmar, false, texto);
  }
});

test('candidatos: como mucho 5', () => {
  const r = emparejarProducto(una('Gin 3'), {
    productos: Array.from({ length: 12 }, (_, i) => producto(`GIN MARCA${i}`)),
  });
  assert.ok(r.candidatos.length <= 5);
  assert.equal(r.productId, null);
  assert.ok(r.motivos.includes('ambiguo'));
});

// --- alias ------------------------------------------------------------------

test('alias del usuario gana a la semilla y resuelve ambigüedades', () => {
  const alias = [{ texto: 'Johnnie', productId: id('JOHNNIE WALKER BLACK LABEL') }];
  const r = emparejar('Johnnie 3', { alias });
  assert.equal(r.productId, id('JOHNNIE WALKER BLACK LABEL'));
  assert.equal(r.via, 'alias');
  assert.equal(r.confirmar, false);
  const coca = emparejar('Coca 3', { alias: [{ texto: 'coca', productId: id('COCA COLA ZERO 35CL') }] });
  assert.equal(coca.productId, id('COCA COLA ZERO 35CL'));
  assert.equal(coca.via, 'alias');
  assert.equal(emparejar('Coca 3').via, 'semilla');
  assert.equal(emparejar('Coca 3').productId, id('COCA COLA 35CL'));
});

test('alias normalizado o no; alias a producto inexistente o inactivo se ignora', () => {
  assert.equal(emparejar('el negro 2', { alias: [{ texto: 'EL NEGRO', productId: id('JOHNNIE WALKER BLACK LABEL') }] }).via, 'alias');
  const productos = [...PRODUCTOS, producto('JOHNNIE WALKER GOLD', { activo: false })];
  for (const productId of ['NO-EXISTE', id('JOHNNIE WALKER GOLD')]) {
    const r = emparejar('Johnnie 3', { productos, alias: [{ texto: 'johnnie', productId }] });
    assert.equal(r.productId, null, productId);
    assert.ok(r.motivos.includes('ambiguo'), productId);
    assert.ok(!ids(r).includes(id('JOHNNIE WALKER GOLD')));
  }
});

test('productos inactivos nunca se devuelven (ni por nombre, ni por alias, ni como candidato)', () => {
  const productos = [producto('ROKU', { activo: false }), producto('ROKU GIN', { activo: false }), producto('BOMBAY SAPPHIRE')];
  const alias = [{ texto: 'roku', productId: id('ROKU') }];
  for (const texto of ['Roku 7', 'Rocu 7', 'Roku gin 2']) {
    const r = emparejarProducto(una(texto), { productos, alias });
    assert.equal(r.productId, null, texto);
    assert.ok(!ids(r).some((x) => x.startsWith('P-ROKU')), texto);
  }
});

test('semilla: la versión base gana a su variante; dos variantes es ambiguo', () => {
  const r = emparejarProducto(una('Jagger 2'), { productos: solo('JAGERMEISTER', 'JAGERMEISTER MANIFEST') });
  assert.equal(r.productId, id('JAGERMEISTER'));
  assert.equal(r.via, 'semilla');
  const amb = emparejarProducto(una('Seagrams 2'), { productos: solo("SEAGRAM'S GIN", "SEAGRAM'S 0,0") });
  assert.equal(amb.productId, null);
  assert.ok(amb.motivos.includes('ambiguo'));
});

test('ALIAS_SEMILLA: congelado, normalizado y sin textos repetidos', () => {
  assert.ok(Object.isFrozen(ALIAS_SEMILLA));
  assert.ok(ALIAS_SEMILLA.length >= 30 && ALIAS_SEMILLA.length <= 80);
  const vistos = new Set();
  for (const { texto, nombre } of ALIAS_SEMILLA) {
    assert.equal(normalizarTexto(texto), texto);
    assert.equal(normalizarTexto(nombre), nombre);
    assert.ok(!vistos.has(texto), texto);
    vistos.add(texto);
  }
});

// --- integración con el parser: frases reales del 2-nov ------------------------------

test('frases reales del 2-nov con parsearDictado + emparejarProducto', () => {
  const indice = prepararIndice(PRODUCTOS);
  const casos = [
    ['Larios 12 32', 'LARIOS 12', 32, false],
    ['Roku 7', 'ROKU', 7, false],
    ['Bombay 7', 'BOMBAY SAPPHIRE', 7, false],
    ['Puerto de Indias 00 3', 'PUERTO DE INDIAS 00', 3, false],
    ['818 4', '818 TEQUILA', 4, false],
    ['Licor de café 2 con 50', 'LICOR DE CAFE', 2.5, false],
    ['Martini Extra Dry 1', 'MARTINI EXTRA DRY', 1, false],
    ['Coca-Cola 12 cajas de 24 más 5', 'COCA COLA 35CL', 293, false],
    ['Johnnie 3', null, 3, true],
    ['Rocu 7', 'ROKU', 7, true],
  ];
  for (const [texto, nombre, total, confirmar] of casos) {
    const r = emparejarProducto(una(texto), { indice });
    assert.equal(r.productId, nombre && id(nombre), texto);
    assert.equal(r.lectura.cantidad.total, total, texto);
    assert.equal(r.confirmar, confirmar, texto);
  }
  assert.ok(emparejarProducto(una('Johnnie 3'), { indice }).motivos.includes('ambiguo'));
  assert.ok(emparejarProducto(una('Rocu 7'), { indice }).motivos.includes('aproximado'));
});

test('varias órdenes de una frase', () => {
  const indice = prepararIndice(PRODUCTOS);
  const { ordenes } = parsearDictado('Roku 7, 818 4 y Ron y Miel 3');
  assert.deepEqual(
    ordenes.map((o) => emparejarProducto(o, { indice }).nombre),
    ['ROKU', '818 TEQUILA', 'RON Y MIEL'],
  );
});

// --- rendimiento ------------------------------------------------------------

test('rendimiento: 1500 productos × 100 emparejamientos < 1 s', () => {
  let semillaRnd = 42;
  const rnd = () => {
    semillaRnd = (semillaRnd * 1103515245 + 12345) % 2147483648;
    return semillaRnd / 2147483648;
  };
  const letras = 'abcdefghijklmnopqrstuvwxyz';
  const palabra = () => Array.from({ length: 4 + Math.floor(rnd() * 6) }, () => letras[Math.floor(rnd() * 26)]).join('');
  const marcas = Array.from({ length: 300 }, palabra);
  const variantes = Array.from({ length: 60 }, palabra);
  const tamanos = ['70CL', '1L', '35CL', 'TERCIO', ''];
  const nombres = new Set();
  while (nombres.size < 1500) {
    nombres.add(`${marcas[Math.floor(rnd() * marcas.length)]} ${variantes[Math.floor(rnd() * variantes.length)]} ${tamanos[Math.floor(rnd() * 5)]}`.trim().toUpperCase());
  }
  const productos = [...nombres].map((nombre, i) => ({ productId: `S${i}`, nombre, familiaNombre: 'X', unidad: 'ud' }));
  const frases = Array.from({ length: 100 }, (_, i) => {
    const p = productos[Math.floor(rnd() * productos.length)].nombre.toLowerCase().split(' ');
    if (i % 4 === 0) return `${p.join(' ')} ${i}`;
    if (i % 4 === 1) return `${p[0]} ${i}`;
    if (i % 4 === 2) return `${p[0].slice(0, -1)}x ${p[1]} ${i}`;
    return `${palabra()} ${palabra()} ${i}`;
  });
  const ordenes = frases.map((f) => una(f));

  const inicio = performance.now();
  const indice = prepararIndice(productos);
  const resultados = ordenes.map((o) => emparejarProducto(o, { indice }));
  const ms = performance.now() - inicio;
  assert.equal(resultados.length, 100);
  assert.ok(ms < 1000, `tardó ${ms.toFixed(0)} ms`);
});

// --- vocabulario --------------------------------------------------------------

test('vocabularioTranscripcion: alias más usados + nombres, sin duplicados y limitado', () => {
  const productos = [...PRODUCTOS, producto('GORDONS', { activo: false, stock: 99 })];
  const alias = [
    { texto: 'el negro', productId: id('JOHNNIE WALKER BLACK LABEL'), usos: 3 },
    { texto: 'coca', productId: id('COCA COLA 35CL'), usos: 10 },
    { texto: 'Coca', productId: id('COCA COLA 35CL'), usos: 1 },
    { texto: 'roku', productId: id('ROKU'), usos: 50 },
    { texto: 'gordon', productId: id('GORDONS'), usos: 100 },
    { texto: 'fantasma', productId: 'NO-EXISTE', usos: 100 },
  ];
  const v = vocabularioTranscripcion(productos, alias);
  assert.deepEqual(v.slice(0, 4), ['roku', 'coca', 'el negro', 'LARIOS'], 'alias por usos y luego el nombre más corto; ROKU no se repite');
  assert.ok(!v.includes('ROKU') && !v.includes('Coca'));
  assert.equal(new Set(v.map(normalizarTexto)).size, v.length);
  assert.equal(v.length, NOMBRES.length + 2);
  assert.ok(!v.includes('gordon') && !v.includes('GORDONS') && !v.includes('fantasma'));
  assert.ok(v.every((t) => typeof t === 'string' && !/99/.test(t)));

  const corto = vocabularioTranscripcion(productos, alias, { max: 5 });
  assert.equal(corto.length, 5);
  assert.deepEqual(corto.slice(0, 2), ['roku', 'coca']);
  assert.equal(new Set(corto.map(normalizarTexto)).size, 5);
  assert.deepEqual(vocabularioTranscripcion(productos, alias, { max: 0 }), []);
});

// --- revisión: variante, envase y categoría no dichas confirman ------------------------

function con(nombres, texto, opciones = {}) {
  return emparejarProducto(una(texto), { productos: solo(...nombres), ...opciones });
}

function assertAmbiguo(r, nombres, texto) {
  assert.equal(r.productId, null, texto);
  assert.equal(r.confirmar, true, texto);
  assert.ok(r.motivos.includes('ambiguo'), texto);
  for (const n of nombres) assert.ok(ids(r).includes(id(n)), `${texto}: falta ${n}`);
}

test('envases distintos son variante: varios candidatos que difieren por envase → ambiguo', () => {
  const mahou = ['MAHOU BARRIL 30L', 'MAHOU 5 ESTRELLAS TERCIO', 'MAHOU CLASICA BOTELLIN'];
  assertAmbiguo(con(mahou, 'Mahou 6'), mahou, 'Mahou 6');
  const roederer = ['ROEDERER CRISTAL', 'ROEDERER BRUT PREMIER'];
  assertAmbiguo(con(roederer, 'Roederer 2'), roederer, 'Roederer 2');
  const moet = ['MOET CHANDON MAGNUM', 'MOET CHANDON IMPERIAL'];
  assertAmbiguo(con(moet, 'Moet 2'), moet, 'Moet 2');
  const heineken = ['HEINEKEN TERCIO', 'HEINEKEN BARRIL'];
  assertAmbiguo(con(heineken, 'Heineken 6'), heineken, 'Heineken 6');
  // Las tallas no distinguen.
  const coca = emparejar('Coca-Cola 3');
  assert.equal(coca.productId, id('COCA COLA 35CL'));
  assert.equal(coca.confirmar, false);
  assert.equal(con(['COCA COLA 1,5L', 'COCA COLA ZERO 1,5L'], 'Coca-Cola 3').productId, id('COCA COLA 1,5L'));
  assert.equal(con(['COCA COLA 70 CL', 'COCA COLA ZERO 70 CL'], 'Coca-Cola 3').productId, id('COCA COLA 70 CL'));
});

test('envase como único añadido del único candidato no confirma', () => {
  const r = con(['HEINEKEN TERCIO', 'ROKU'], 'Heineken 6');
  assert.equal(r.productId, id('HEINEKEN TERCIO'));
  assert.equal(r.confirmar, false);
});

test('número ante envase no es talla: «Estrella Galicia 6» con 1906 y ESPECIAL → ambiguo', () => {
  const eg = ['ESTRELLA GALICIA 1906 TERCIO', 'ESTRELLA GALICIA ESPECIAL TERCIO'];
  assertAmbiguo(con(eg, 'Estrella Galicia 6'), eg, 'Estrella Galicia 6');
});

test('«Amstel 4»: la normal gana a la que añade «00»', () => {
  const r = con(['AMSTEL 00 TERCIO', 'AMSTEL TERCIO'], 'Amstel 4');
  assert.equal(r.productId, id('AMSTEL TERCIO'));
  assert.equal(r.confirmar, false);
  assert.deepEqual(r.motivos, []);
});

test('sin semilla genérica «estrella»: «Estrella 6» con DAMM y GALICIA → ambiguo', () => {
  assert.ok(!ALIAS_SEMILLA.some((s) => s.texto === 'estrella' || s.texto === 'tonica'));
  const est = ['ESTRELLA DAMM TERCIO', 'ESTRELLA GALICIA TERCIO'];
  assertAmbiguo(con(est, 'Estrella 6'), est, 'Estrella 6');
});

test('único candidato que añade variante o número → variante_no_dicha', () => {
  const casos = [
    [[['LARIOS', { activo: false }], 'LARIOS 12'], 'Larios 3', 'LARIOS 12'],
    [['COCA COLA ZERO 35CL'], 'Coca cola 3', 'COCA COLA ZERO 35CL'],
    [['MAHOU SIN 0,0'], 'Mahou 6', 'MAHOU SIN 0,0'],
    [['BARCELO GRAN AÑEJO', 'BARCELO IMPERIAL'], 'Barceló añejo 3', 'BARCELO GRAN AÑEJO'],
    [['JOHNNIE WALKER RED LABEL'], 'Johnnie 2', 'JOHNNIE WALKER RED LABEL'],
  ];
  for (const [defs, texto, esperado] of casos) {
    const productos = defs.map((d) => (Array.isArray(d) ? producto(d[0], d[1]) : producto(d)));
    const r = emparejarProducto(una(texto), { productos });
    assert.equal(r.productId, id(esperado), texto);
    assert.equal(r.confirmar, true, texto);
    assert.ok(r.motivos.includes('variante_no_dicha'), texto);
    assert.ok(r.confianza <= 0.7, texto);
  }
  // Varios candidatos y gana el que no añade nada distintivo: sin confirmar.
  const r = con(['LARIOS', 'LARIOS 12'], 'Larios 3');
  assert.equal(r.productId, id('LARIOS'));
  assert.equal(r.confirmar, false);
  // Completar la marca sí vale.
  assert.equal(con(['BOMBAY SAPPHIRE'], 'Bombay 2').confirmar, false);
});

test('solo palabras de categoría → generico', () => {
  const ron = emparejar('Ron 2');
  assert.equal(ron.productId, id('RON Y MIEL'));
  assert.equal(ron.confirmar, true);
  assert.ok(ron.motivos.includes('generico'));
  const tonica = con(['TONICA SCHWEPPES', 'ROKU'], 'Tónica 6');
  assert.equal(tonica.productId, id('TONICA SCHWEPPES'));
  assert.equal(tonica.confirmar, true);
  assert.ok(tonica.motivos.includes('generico'));
  const fever = con(['SCHWEPPES', 'SCHWEPPES LIMON', 'FEVER TREE TONICA'], 'Tónica 6');
  assert.equal(fever.confirmar, true);
  assert.ok(fever.motivos.includes('generico'));
  // Nombre exacto o alias no son genéricos.
  assert.equal(emparejar('Ron y miel 2').confirmar, false);
  assert.equal(con(['TONICA'], 'Tónica 6').confirmar, false);
  assert.equal(emparejar('Ron 2', { alias: [{ texto: 'ron', productId: id('RON Y MIEL') }] }).confirmar, false);
});

test('semilla no anclada y única en la lista se aplica; al principio del nombre, también', () => {
  const r = con(["GIN SEAGRAM'S", 'ROKU'], 'Seagrams 2');
  assert.equal(r.productId, id("GIN SEAGRAM'S"));
  assert.equal(r.confirmar, false);
  assert.equal(r.motivos.includes('semilla_no_anclada'), false);
  const anclada = con(["SEAGRAM'S GIN", 'ROKU'], 'Seagrams 2');
  assert.equal(anclada.productId, id("SEAGRAM'S GIN"));
  assert.equal(anclada.confirmar, false);
});

test('textoProducto sin letras ni cifras → sin_coincidencia; null → sin_producto', () => {
  const cantidad = { total: 2, stockReal: 2, botellasAbiertas: 0 };
  for (const textoProducto of ['…', '🍾', ' - ']) {
    const r = emparejarProducto({ tipo: 'linea', textoProducto, cantidad, alternativas: [] }, { productos: PRODUCTOS });
    assert.equal(r.productId, null, textoProducto);
    assert.equal(r.confirmar, true, textoProducto);
    assert.deepEqual(r.motivos, ['sin_coincidencia'], textoProducto);
  }
  const nulo = emparejarProducto({ tipo: 'reemplazar', textoProducto: null, cantidad }, { productos: PRODUCTOS });
  assert.deepEqual(nulo.motivos, ['sin_producto']);
  assert.equal(nulo.confirmar, false);
});

test('vías: exacto, alias, semilla, palabras, aproximado', () => {
  assert.equal(emparejar('Roku 7').via, 'exacto');
  assert.equal(emparejar('Johnnie 3', { alias: [{ texto: 'johnnie', productId: id('JOHNNIE WALKER RED LABEL') }] }).via, 'alias');
  assert.equal(emparejar('Coca 3').via, 'semilla');
  assert.equal(emparejar('Bombay 3').via, 'palabras');
  assert.equal(emparejar('818 3').via, 'palabras');
  assert.equal(emparejar('Rocu 3').via, 'aproximado');
});

test('entradas nulas o no iterables no lanzan', () => {
  const o = una('Roku 7');
  for (const opciones of [null, undefined, {}, { productos: null }, { productos: 42 }, { productos: {} }, { productos: 'ROKU' }]) {
    const r = emparejarProducto(o, opciones);
    assert.equal(r.productId, null);
    assert.deepEqual(r.motivos, ['sin_coincidencia']);
  }
  assert.deepEqual(emparejarProducto(null, null).motivos, ['sin_producto']);
  assert.equal(prepararIndice(PRODUCTOS, null, null).productos.length, PRODUCTOS.length);
  assert.equal(prepararIndice(null, 7, { semilla: null }).productos.length, 0);
  assert.equal(emparejarProducto(o, { productos: PRODUCTOS, alias: { a: 1 }, semilla: 5 }).productId, id('ROKU'));
  assert.deepEqual(vocabularioTranscripcion(null, null, null), []);
  assert.deepEqual(vocabularioTranscripcion({}, 3), []);
});

test('productId se conserva tal cual (sin convertir); alias compara como texto', () => {
  const productos = [{ productId: 123, nombre: 'ROKU' }, { productId: ' 77 ', nombre: 'BOMBAY SAPPHIRE' }];
  const r = emparejarProducto(una('Roku 7'), { productos });
  assert.equal(r.productId, 123);
  assert.equal(r.candidatos[0].productId, 123);
  assert.equal(emparejarProducto(una('Bombay 7'), { productos }).productId, ' 77 ');
  const a = emparejarProducto(una('el ruso 2'), { productos, alias: [{ texto: 'el ruso', productId: '123' }] });
  assert.equal(a.productId, 123);
  assert.equal(a.via, 'alias');
  assert.deepEqual(vocabularioTranscripcion(productos, [{ texto: 'el ruso', productId: '123', usos: 1 }]), ['el ruso', 'ROKU', 'BOMBAY SAPPHIRE']);
});

test('normalizarAlias recorta a MAX_LONGITUD_ALIAS; normalizarTexto no', () => {
  assert.equal(MAX_LONGITUD_ALIAS, 80);
  const largo = `${'palabra '.repeat(20)}fin`;
  assert.ok(normalizarTexto(largo).length > 80);
  const alias = normalizarAlias(largo);
  assert.ok(alias.length <= 80);
  assert.equal(alias, alias.trim());
  assert.ok(normalizarTexto(largo).startsWith(alias));
  assert.equal(normalizarAlias('Coca-Cola'), 'coca cola');
  // Un alias largo casa con el mismo texto dicho aunque supere el límite.
  const r = emparejarProducto(una(`${largo} 2`), { productos: PRODUCTOS, alias: [{ texto: largo, productId: id('ROKU') }] });
  assert.equal(r.productId, id('ROKU'));
  assert.equal(r.via, 'alias');
});

test('Seagrams se aplica solo si la plantilla solo tiene BOT SEAGRAMS', () => {
  const plantilla = solo('BOT SEAGRAMS');
  const r = emparejarProducto(una('Seagrams 14'), { productos: plantilla, plantilla });
  assert.equal(r.productId, id('BOT SEAGRAMS'));
  assert.equal(r.cantidad?.total ?? r.lectura.cantidad.total, 14);
  assert.equal(r.confirmar, false);
  assert.equal(r.motivos.includes('aproximado'), false);
  assert.equal(r.motivos.includes('semilla_no_anclada'), false);
});

test('Seagrams queda ambiguo si la plantilla tiene dos', () => {
  const plantilla = solo('BOT SEAGRAMS', 'CHUPITO SEAGRAMS');
  const r = emparejarProducto(una('Seagrams 14'), { productos: plantilla, plantilla });
  assert.equal(r.productId, null);
  assert.equal(r.confirmar, true);
  assert.ok(r.motivos.includes('ambiguo'));
});

test('Bot Ballantines 14 queda ambiguo si la plantilla tiene varios Ballantines', () => {
  const plantilla = solo('BOT BALLANTINES', 'BALLANTINES 10', 'BALLANTINES 12');
  const r = emparejarProducto(una('Bot Ballantines 14'), { productos: plantilla, plantilla });
  assert.equal(r.productId, null);
  assert.equal(r.via, null);
  assert.equal(r.confirmar, true);
  assert.ok(r.motivos.includes('ambiguo'));
  assert.ok(r.motivos.includes('marca_ambigua'));
  assert.deepEqual(r.candidatos.map((c) => c.nombre).sort(), ['BALLANTINES 10', 'BALLANTINES 12', 'BOT BALLANTINES']);
});

test('Bot Ballantines 14 se resuelve si la plantilla solo tiene ese Ballantines', () => {
  const uno = solo('BOT BALLANTINES');
  const r = emparejarProducto(una('Bot Ballantines 14'), { productos: uno, plantilla: uno });
  assert.equal(r.productId, id('BOT BALLANTINES'));
  assert.equal(r.confirmar, false);
  assert.equal(r.motivos.includes('marca_ambigua'), false);
});

test('¿Es otro producto? solo sugiere candidatos que se parecen al texto', () => {
  const lista = [
    { productId: '10', nombre: 'BALLANTINES 10', puntuacion: 0.5 },
    { productId: '12', nombre: 'BALLANTINES 12', puntuacion: 0.5 },
    { productId: 'c', nombre: 'COCA COLA', puntuacion: 0.2 },
  ];
  const eco = filtrarCandidatosParecidos('Conteo de inventario de bar nombre de producto y cantidad', lista);
  assert.deepEqual(eco, []);
  const marca = filtrarCandidatosParecidos('Bot Ballantines 14', lista).map((c) => c.productId);
  assert.deepEqual(marca.sort(), ['10', '12']);
  const cerca = filtrarCandidatosParecidos('xyz', [{ productId: 'c', nombre: 'COCA COLA', puntuacion: 0.8 }]);
  assert.equal(cerca.length, 1);
  const lejos = filtrarCandidatosParecidos('xyz', [{ productId: 'c', nombre: 'COCA COLA', puntuacion: 0.2 }]);
  assert.deepEqual(lejos, []);
});

test('Ballantines 10, 14 señala el 10 aunque la plantilla tenga varios', () => {
  const plantilla = solo('BOT BALLANTINES', 'BALLANTINES 10', 'BALLANTINES 12');
  const r = emparejarProducto(una('Ballantines 10, 14'), { productos: plantilla, plantilla });
  assert.equal(r.productId, id('BALLANTINES 10'));
  assert.equal(r.motivos.includes('marca_ambigua'), false);
});
