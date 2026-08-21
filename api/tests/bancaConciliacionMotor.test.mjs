/**
 * Motor de sugerencias de conciliación bancaria.
 *
 * El motor es puro —recibe movimientos y facturas ya cargados— así que aquí no
 * hay dobles de Dynamo ni de S3: se comprueba el criterio de emparejamiento en
 * sí, que es lo único que decide si la pantalla es útil o un generador de ruido.
 *
 * No se monta express a propósito: importar routers arrastra workers que dejan
 * el bucle de eventos vivo y `npm test` se queda colgado.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buscarCombinaciones,
  sugerirConciliaciones,
  sugerirParaMovimiento,
} from '../lib/banca/conciliacion/motor.js';
import { euroACentimos, saldoPendienteCentimos } from '../lib/banca/conciliacion/estado.js';
import { normalizarConcepto } from '../lib/n43/concepto.js';

const SOCIEDAD = '000007';
const IBAN = 'ES9121000418450200051332';
const FECHA_MOV = '2026-07-14';

/**
 * Movimiento tal y como lo guarda la ingesta: el concepto pasa por
 * `normalizarConcepto`, igual que en la importación real, para no probar contra
 * un concepto "de laboratorio" más limpio que el de un extracto de verdad.
 */
function movimiento({
  concepto = '',
  centimos = -48400,
  empresaId = SOCIEDAD,
  empresaNombre = 'HOSTELERIA DEL SUR SL',
  fechaOperacion = FECHA_MOV,
  fechaValor = fechaOperacion,
  formatoOrigen = 'n43',
  nombreFichero = 'extracto-julio.n43',
  referencia1 = '',
  referencia2 = '',
  numeroDocumento = '',
  conciliadoCentimos = 0,
  estadoConciliacion = 'pendiente',
  sugerenciasDescartadas,
  movementHash = 'h1',
} = {}) {
  const normalizado = normalizarConcepto(concepto);
  return {
    movementHash,
    cuentaRef: IBAN,
    iban: IBAN,
    ...(empresaId ? { empresaId, empresaNombre } : {}),
    fechaOperacion,
    fechaValor,
    formatoOrigen,
    nombreFichero,
    importe: centimos / 100,
    importeCentimos: centimos,
    signo: centimos < 0 ? 'D' : 'H',
    concepto: normalizado.conceptoTexto,
    conceptoNormalizado: normalizado.conceptoNormalizado,
    nif: normalizado.nif,
    referencia1,
    referencia2,
    numeroDocumento,
    estadoConciliacion,
    conciliadoCentimos,
    ...(sugerenciasDescartadas ? { sugerenciasDescartadas } : {}),
  };
}

/**
 * Factura de gasto: `emisor_*` es NUESTRA sociedad (la pagadora) y `empresa_*`
 * el proveedor. No es intuitivo, pero es el modelo real.
 */
function gasto({
  id,
  saldo = 484,
  estado = 'pendiente_pago',
  emisor_id = SOCIEDAD,
  empresa_nombre = 'COCTEMATIAS SL',
  empresa_cif = 'B12345678',
  numero_factura_proveedor = '',
  serie = '',
  numero = 0,
  fecha_emision = '2026-06-30',
  fecha_vencimiento = '2026-07-15',
} = {}) {
  return {
    id_factura: id,
    tipo: 'IN',
    estado,
    emisor_id,
    emisor_nombre: 'HOSTELERIA DEL SUR SL',
    emisor_cif: 'B00000007',
    empresa_id: '000099',
    empresa_nombre,
    empresa_cif,
    numero_factura_proveedor,
    serie,
    numero,
    fecha_emision,
    fecha_vencimiento,
    total_factura: saldo,
    total_cobrado: 0,
    saldo_pendiente: saldo,
  };
}

/** Factura de venta: `emisor_*` sigue siendo nuestra sociedad; `empresa_*` es el cliente. */
function venta({
  id,
  saldo = 484,
  estado = 'emitida',
  emisor_id = SOCIEDAD,
  empresa_nombre = 'CLIENTE GRANDE SL',
  empresa_cif = 'B87654321',
  numero_factura = '',
  serie = '',
  numero = 0,
  fecha_emision = '2026-06-30',
  fecha_vencimiento = '2026-07-15',
} = {}) {
  return {
    id_factura: id,
    tipo: 'OUT',
    estado,
    emisor_id,
    emisor_nombre: 'HOSTELERIA DEL SUR SL',
    emisor_cif: 'B00000007',
    empresa_id: '000123',
    empresa_nombre,
    empresa_cif,
    numero_factura,
    serie,
    numero,
    fecha_emision,
    fecha_vencimiento,
    total_factura: saldo,
    total_cobrado: 0,
    saldo_pendiente: saldo,
  };
}

function sugerir(mov, facturas, opciones) {
  return sugerirParaMovimiento({ movimiento: mov, facturas, opciones }).sugerencias;
}

function ids(sugerencia) {
  return sugerencia.facturas.map((f) => f.id_factura).sort();
}

// ─── Filtros previos ───

test('el signo separa gastos de ventas: una factura de gasto no casa con un abono', () => {
  const gastoF = gasto({ id: 'F-IN' });
  const ventaF = venta({ id: 'F-OUT' });

  const cargo = sugerir(movimiento({ centimos: -48400 }), [gastoF, ventaF]);
  assert.deepEqual(cargo.map((s) => ids(s)[0]), ['F-IN']);

  const abono = sugerir(movimiento({ centimos: 48400 }), [gastoF, ventaF]);
  assert.deepEqual(abono.map((s) => ids(s)[0]), ['F-OUT']);
});

test('la sociedad del grupo se cruza con emisor_id, y la contraparte con empresa_*', () => {
  // La factura correcta: la pagamos desde la sociedad 000007 (emisor) a un
  // proveedor externo (empresa). La trampa: otra factura donde 000007 aparece
  // como `empresa_id` —ahí somos la contraparte, no la pagadora—.
  const correcta = gasto({ id: 'F-OK', emisor_id: SOCIEDAD });
  const trampa = {
    ...gasto({ id: 'F-TRAMPA', emisor_id: '000099' }),
    empresa_id: SOCIEDAD,
    empresa_nombre: 'HOSTELERIA DEL SUR SL',
    empresa_cif: 'B00000007',
  };

  const gastos = sugerir(movimiento({ centimos: -48400 }), [correcta, trampa]);
  assert.deepEqual(gastos.map((s) => ids(s)[0]), ['F-OK']);

  // Mismo criterio en ventas: cobramos una factura emitida por 000007.
  const ventaCorrecta = venta({ id: 'V-OK', emisor_id: SOCIEDAD });
  const ventaTrampa = {
    ...venta({ id: 'V-TRAMPA', emisor_id: '000099' }),
    empresa_id: SOCIEDAD,
    empresa_nombre: 'HOSTELERIA DEL SUR SL',
    empresa_cif: 'B00000007',
  };
  const ventas = sugerir(movimiento({ centimos: 48400 }), [ventaCorrecta, ventaTrampa]);
  assert.deepEqual(ventas.map((s) => ids(s)[0]), ['V-OK']);
});

test('los id de empresa casan con y sin ceros a la izquierda', () => {
  const conCeros = gasto({ id: 'F-CEROS', emisor_id: '000007' });
  const sinCeros = gasto({ id: 'F-SIN', emisor_id: '7' });
  const otra = gasto({ id: 'F-OTRA', emisor_id: '70' });

  const desdeEscueto = sugerir(movimiento({ empresaId: '7' }), [conCeros, sinCeros, otra]);
  assert.deepEqual([...new Set(desdeEscueto.flatMap(ids))].sort(), ['F-CEROS', 'F-SIN']);

  const desdeRelleno = sugerir(movimiento({ empresaId: '000007' }), [conCeros, sinCeros, otra]);
  assert.deepEqual([...new Set(desdeRelleno.flatMap(ids))].sort(), ['F-CEROS', 'F-SIN']);
});

test('solo entran facturas con saldo y en estado conciliable', () => {
  const facturas = [
    gasto({ id: 'F-BORRADOR', estado: 'borrador' }),
    gasto({ id: 'F-ANULADA', estado: 'anulada' }),
    gasto({ id: 'F-PAGADA', estado: 'pagada' }),
    gasto({ id: 'F-SIN-SALDO', saldo: 0 }),
    // `pendiente_revision` entra a propósito: es decisión de negocio.
    gasto({ id: 'F-REVISION', estado: 'pendiente_revision' }),
    gasto({ id: 'F-VENCIDA', estado: 'vencida' }),
  ];
  const salida = sugerir(movimiento(), facturas);
  assert.deepEqual([...new Set(salida.flatMap(ids))].sort(), ['F-REVISION', 'F-VENCIDA']);
  assert.equal(salida.every((s) => s.facturas[0].pendienteRevision === (ids(s)[0] === 'F-REVISION')), true);
});

test('una factura emitida después del movimiento queda fuera de la ventana', () => {
  const futura = gasto({ id: 'F-FUTURA', fecha_emision: '2026-08-20' });
  const antigua = gasto({ id: 'F-ANTIGUA', fecha_emision: '2024-01-10', fecha_vencimiento: '2024-02-10' });
  const dentro = gasto({ id: 'F-DENTRO' });

  const salida = sugerir(movimiento(), [futura, antigua, dentro]);
  assert.deepEqual([...new Set(salida.flatMap(ids))], ['F-DENTRO']);
});

// ─── Tipos de sugerencia ───

test('importe exacto: una sola factura que agota el movimiento es sugerencia exacta', () => {
  const [sugerencia] = sugerir(movimiento({ concepto: 'ADEUDO COCTEMATIAS SL B12345678' }), [gasto({ id: 'F1' })]);
  assert.equal(sugerencia.tipo, 'exacta');
  assert.equal(sugerencia.nivel, 'alta');
  assert.equal(sugerencia.asignadoCentimos, 48400);
  assert.equal(sugerencia.restoMovimientoCentimos, 0);
  assert.equal(sugerencia.facturas[0].restoFacturaCentimos, 0);
  assert.equal(sugerencia.senales.importeExacto, true);
  assert.equal(sugerencia.senales.cif, true);
  assert.ok(sugerencia.motivos.some((m) => /CIF/.test(m)));
});

test('si el movimiento es menor que el saldo, la sugerencia es un pago parcial de la factura', () => {
  const factura = gasto({ id: 'F1', saldo: 1000 });
  const [sugerencia] = sugerir(movimiento({ centimos: -40000, concepto: 'COCTEMATIAS SL B12345678' }), [factura]);
  assert.equal(sugerencia.tipo, 'parcial');
  assert.equal(sugerencia.asignadoCentimos, 40000);
  assert.equal(sugerencia.facturas[0].restoFacturaCentimos, 60000);
  assert.equal(sugerencia.senales.importeExacto, false);
});

test('combinación de 2, 3 y 4 facturas de la misma contraparte que suman el movimiento', () => {
  const casos = [
    { saldos: [100, 384], total: 48400 },
    { saldos: [100, 84, 300], total: 48400 },
    { saldos: [100, 84, 200, 100], total: 48400 },
  ];

  for (const caso of casos) {
    const facturas = caso.saldos.map((saldo, i) => gasto({ id: `F${i + 1}`, saldo }));
    // Se añade una factura de otro proveedor con un saldo que "encajaría": no
    // debe entrar en la combinación, porque no es la misma contraparte.
    facturas.push(gasto({ id: 'F-OTRO', saldo: 10, empresa_cif: 'B55555555', empresa_nombre: 'OTRO PROVEEDOR SL' }));

    const salida = sugerir(
      movimiento({ centimos: -caso.total, concepto: 'COCTEMATIAS SL B12345678' }),
      facturas,
    );
    const combinacion = salida.find((s) => s.tipo === 'combinacion');
    assert.ok(combinacion, `sin combinación para ${caso.saldos.join('+')}`);
    assert.deepEqual(ids(combinacion), caso.saldos.map((_, i) => `F${i + 1}`).sort());
    assert.equal(combinacion.asignadoCentimos, caso.total);
    assert.equal(combinacion.senales.importeExacto, true);
    assert.equal(
      combinacion.facturas.reduce((acc, f) => acc + f.asignadoCentimos, 0),
      caso.total,
    );
  }
});

test('la combinación no se dispara con muchas candidatas: el tope recorta y es determinista', () => {
  // 200 facturas de la misma contraparte. La única pareja que suma el objetivo
  // son las dos más pequeñas, que quedan fuera del tope de 60 candidatas
  // (el recorte es por saldo descendente).
  const facturas = [];
  for (let i = 0; i < 200; i += 1) facturas.push(gasto({ id: `F${i}`, saldo: 1000 + i }));
  const objetivo = euroACentimos(1000) + euroACentimos(1001);

  const inicio = process.hrtime.bigint();
  const conTope = sugerir(movimiento({ centimos: -objetivo, concepto: 'COCTEMATIAS SL' }), facturas);
  const msTope = Number(process.hrtime.bigint() - inicio) / 1e6;

  assert.equal(conTope.filter((s) => s.tipo === 'combinacion').length, 0);
  assert.ok(msTope < 2000, `el barrido acotado tardó ${msTope} ms`);

  // Con el tope ampliado, la misma combinación sí aparece: no se pierde por un
  // fallo de la búsqueda, sino por el recorte defensivo.
  const sinTope = sugerir(
    movimiento({ centimos: -objetivo, concepto: 'COCTEMATIAS SL' }),
    facturas,
    { maxCandidatasCombinacion: 200 },
  );
  const combinacion = sinTope.find((s) => s.tipo === 'combinacion');
  assert.ok(combinacion);
  assert.deepEqual(ids(combinacion), ['F0', 'F1']);
});

test('buscarCombinaciones trabaja en enteros y no repite el mismo subconjunto', () => {
  assert.deepEqual(buscarCombinaciones([100, 200, 300], 300, { maxResultados: 5 }), [[0, 1]]);
  assert.deepEqual(buscarCombinaciones([100, 200, 300], 600, { maxResultados: 5 }), [[0, 1, 2]]);
  // 2 elementos como máximo: el subconjunto de 3 no debe salir.
  assert.deepEqual(buscarCombinaciones([100, 200, 300], 600, { maxElementos: 2 }), []);
  assert.deepEqual(buscarCombinaciones([100], 100), []);
  assert.deepEqual(buscarCombinaciones([100, 200], 0), []);
});

// ─── Señales ───

test('el número de factura dentro del concepto es la señal más fuerte', () => {
  // Referencia tal y como aparece en un extracto real de BBVA.
  const mov = movimiento({ concepto: 'TRANSFERENCIA A FAVOR DE 2026FM53 BD417B83 COCTEMAT', centimos: -12345 });
  const conNumero = gasto({
    id: 'F-NUM',
    saldo: 999,
    numero_factura_proveedor: '2026-FM53',
    empresa_cif: '',
    empresa_nombre: 'PROVEEDOR ANONIMO ZZ',
  });
  const sinNumero = gasto({
    id: 'F-OTRA',
    saldo: 123.45,
    empresa_cif: '',
    empresa_nombre: 'PROVEEDOR ANONIMO ZZ',
  });

  const salida = sugerir(mov, [conNumero, sinNumero]);
  assert.equal(salida[0].facturas[0].id_factura, 'F-NUM', 'el número de factura debe ganar al importe exacto');
  assert.equal(salida[0].senales.numeroFactura, true);
  assert.equal(salida[0].senales.referencia, '2026FM53');
  assert.ok(salida[0].puntuacion > salida[1].puntuacion);
});

test('serie y número forman referencia; un número corto suelto no casa', () => {
  const conSerie = gasto({ id: 'F-SERIE', serie: '2026F', numero: 40, empresa_cif: '', empresa_nombre: 'PROVEEDOR ZZ' });
  const [sugerencia] = sugerir(
    movimiento({ concepto: 'ADEUDO 2026F40 d7f4b76c', centimos: -48400 }),
    [conSerie],
  );
  assert.equal(sugerencia.senales.referencia, '2026F40');

  // Solo el número, sin serie: "40" es demasiado corto para casar por sí mismo.
  const soloNumero = gasto({ id: 'F-NUM-CORTO', numero_factura_proveedor: '40', empresa_cif: '', empresa_nombre: 'PROVEEDOR ZZ' });
  const [corta] = sugerir(movimiento({ concepto: 'ADEUDO 40 REF 12', centimos: -48400 }), [soloNumero]);
  assert.equal(corta.senales.numeroFactura, false);
});

test('el CIF casa por el campo nif del extracto y también desde el concepto', () => {
  const factura = gasto({ id: 'F-CIF', empresa_cif: 'B-12.345.678', empresa_nombre: 'PROVEEDOR ZZ' });

  const [porNif] = sugerir(movimiento({ concepto: 'ADEUDO DOMICILIADO B12345678 CUOTA' }), [factura]);
  assert.equal(porNif.senales.cif, true);
  assert.equal(porNif.senales.cifCoincidente, 'B12345678');
  assert.equal(porNif.nivel, 'alta');

  const [sinCif] = sugerir(movimiento({ concepto: 'ADEUDO DOMICILIADO CUOTA MENSUAL' }), [factura]);
  assert.equal(sinCif.senales.cif, false);
  assert.equal(sinCif.nivel, 'baja');
});

test('el nombre casa por varias palabras o por una larga truncada, no por una corta', () => {
  // El extracto recorta el nombre del contrario: "COCTEMAT" por "COCTEMATIAS".
  // Tras ignorar la operativa del extracto, la marca del movimiento es COCTEMAT
  // y casa bidireccional con la marca de la factura.
  const truncado = gasto({ id: 'F-TRUNC', empresa_cif: '', empresa_nombre: 'COCTEMATIAS SL' });
  const [porPrefijo] = sugerir(movimiento({ concepto: 'TRANSFERENCIA A FAVOR DE COCTEMAT' }), [truncado]);
  assert.equal(porPrefijo.senales.nombre, true);
  assert.equal(porPrefijo.nivel, 'media', 'importe exacto + nombre = confianza media');

  // Una sola palabra corta no identifica a nadie.
  const corto = gasto({ id: 'F-CORTO', empresa_cif: '', empresa_nombre: 'BARS SL' });
  const [porPalabraCorta] = sugerir(movimiento({ concepto: 'ADEUDO BARS CUOTA' }), [corto]);
  assert.equal(porPalabraCorta.senales.nombre, false);
  assert.equal(porPalabraCorta.nivel, 'baja');

  // Dos tokens que casan (marca + segundo): reconocimiento bidireccional claro.
  const dosPalabras = gasto({ id: 'F-DOS', empresa_cif: '', empresa_nombre: 'ACMEHOSTELIA HOSTELERIA SL' });
  const [porDos] = sugerir(movimiento({ concepto: 'ADEUDO ACMEHOSTELIA HOSTELERI' }), [dosPalabras]);
  assert.deepEqual(porDos.senales.tokensNombre, ['ACMEHOSTELIA', 'HOSTELERIA']);
  assert.equal(porDos.senales.nombre, true);

  // Las formas societarias no cuentan como coincidencia.
  const soloForma = gasto({ id: 'F-FORMA', empresa_cif: '', empresa_nombre: 'ZZZZ SOCIEDAD LIMITADA' });
  const [porForma] = sugerir(movimiento({ concepto: 'ADEUDO SOCIEDAD LIMITADA CUOTA' }), [soloForma]);
  assert.equal(porForma.senales.nombre, false);
});

test('no confunde DISTRIBUTION/DISTRIBUCION entre proveedores distintos (COMINPORT)', () => {
  // Caso real: el prefijo suelto DISTRIBU dentro de DISTRIBUCION daba media
  // con importe exacto entre dos empresas que no tienen nada que ver.
  const factura = gasto({
    id: 'F-RBD',
    empresa_cif: '',
    empresa_nombre: 'RESTAURANT BOOKING & DISTRIBUTION SERVICES SL',
  });
  const salida = sugerir(
    movimiento({ concepto: 'TRANSFERENCIAS COMINPORT DISTRIBUCION SL' }),
    [factura],
  );
  const propuesta = salida.find((s) => ids(s)[0] === 'F-RBD');
  assert.ok(propuesta, 'sigue habiendo sugerencia por importe, pero sin señal de nombre');
  assert.equal(propuesta.senales.nombre, false);
  assert.deepEqual(propuesta.senales.tokensNombre, []);
  assert.notEqual(propuesta.nivel, 'media', 'solo el importe no debe subir a media por un genérico');
});

test('un movimiento sin empresaId se sigue sugiriendo, pero con menos confianza', () => {
  const factura = gasto({ id: 'F1', empresa_cif: 'B12345678' });
  const concepto = 'ADEUDO COCTEMATIAS SL B12345678';

  const [conSociedad] = sugerir(movimiento({ concepto }), [factura]);
  const [sinSociedad] = sugerir(movimiento({ concepto, empresaId: '' }), [factura]);

  assert.ok(sinSociedad, 'el movimiento sin sociedad debe seguir generando sugerencia');
  assert.equal(sinSociedad.senales.sinEmpresa, true);
  assert.ok(sinSociedad.puntuacion < conSociedad.puntuacion);
  assert.equal(conSociedad.nivel, 'alta');
  assert.equal(sinSociedad.nivel, 'media', 'sin poder comprobar la sociedad se baja un nivel');
  assert.ok(sinSociedad.motivos.some((m) => /IBAN/.test(m)));

  // Sin sociedad no se filtra por emisor: casa aunque la factura sea de otra.
  const deOtra = gasto({ id: 'F-OTRA-SOC', emisor_id: '000123' });
  const salida = sugerir(movimiento({ concepto, empresaId: '' }), [deOtra]);
  assert.equal(salida.length, 1);
});

// ─── Ruido y decisiones del usuario ───

test('las reglas de exclusión descartan el ruido antes de puntuar', () => {
  const factura = gasto({ id: 'F1' });
  const ruidosos = [
    'TRASPASO ENTRE CUENTAS DEL GRUPO',
    'COMERCIA GLOBAL PAYMENTS ENT.PAGO',
    'MANTENIMIENTO TPV JULIO',
    'COMISION DE MANTENIMIENTO',
    'NOMINA JULIO 2026',
  ];

  for (const concepto of ruidosos) {
    const entrada = sugerirParaMovimiento({ movimiento: movimiento({ concepto }), facturas: [factura] });
    assert.equal(entrada.excluido, true, `no se excluyó: ${concepto}`);
    assert.ok(entrada.patronExclusion, `sin patrón para: ${concepto}`);
    assert.equal(entrada.sugerencias.length, 0);
  }

  // Con la lista de patrones vacía, el mismo movimiento sí se puntúa: la lista
  // es configurable, no una verdad grabada en el motor.
  const sinReglas = sugerirParaMovimiento({
    movimiento: movimiento({ concepto: 'TRASPASO ENTRE CUENTAS DEL GRUPO' }),
    facturas: [factura],
    opciones: { patronesExclusion: [] },
  });
  assert.equal(sinReglas.excluido, false);
  assert.equal(sinReglas.sugerencias.length, 1);
});

test('una sugerencia descartada a mano no vuelve a proponerse', () => {
  const facturas = [gasto({ id: 'F1' }), gasto({ id: 'F2' })];
  const antes = sugerir(movimiento(), facturas);
  assert.deepEqual([...new Set(antes.flatMap(ids))].sort(), ['F1', 'F2']);

  const despues = sugerir(movimiento({ sugerenciasDescartadas: ['F1'] }), facturas);
  assert.deepEqual([...new Set(despues.flatMap(ids))], ['F2']);
});

test('un movimiento ignorado no genera sugerencias', () => {
  const entrada = sugerirParaMovimiento({
    movimiento: movimiento({ estadoConciliacion: 'ignorado' }),
    facturas: [gasto({ id: 'F1' })],
  });
  assert.equal(entrada.ignorado, true);
  assert.equal(entrada.sugerencias.length, 0);
});

test('un movimiento parcialmente conciliado solo se sugiere por el importe que queda libre', () => {
  const mov = movimiento({
    centimos: -100000,
    conciliadoCentimos: 60000,
    estadoConciliacion: 'parcial',
    concepto: 'ADEUDO COCTEMATIAS SL B12345678',
  });
  const exacta = gasto({ id: 'F-RESTO', saldo: 400 });
  const porElTotal = gasto({ id: 'F-TOTAL', saldo: 1000 });

  const salida = sugerir(mov, [exacta, porElTotal]);
  const porResto = salida.find((s) => ids(s)[0] === 'F-RESTO');
  assert.equal(porResto.tipo, 'exacta', '400 € es el importe libre: cuadra exactamente');
  assert.equal(porResto.conciliableCentimos, 40000);
  assert.equal(porResto.asignadoCentimos, 40000);

  const porTotal = salida.find((s) => ids(s)[0] === 'F-TOTAL');
  assert.equal(porTotal.tipo, 'parcial');
  assert.equal(porTotal.asignadoCentimos, 40000, 'no se puede asignar más de lo que queda libre');

  // Ya conciliado del todo: ni una sugerencia.
  const cerrado = movimiento({
    centimos: -100000,
    conciliadoCentimos: 100000,
    estadoConciliacion: 'conciliado',
    concepto: 'ADEUDO COCTEMATIAS SL B12345678',
  });
  assert.equal(sugerir(cerrado, [exacta, porElTotal]).length, 0);
});

// ─── Céntimos enteros ───

test('todo se compara en céntimos: los importes con decimales sueltos no fallan', () => {
  // 0.1 + 0.2 !== 0.3 en coma flotante; en céntimos, 10 + 20 === 30 siempre.
  const facturas = [
    gasto({ id: 'F1', saldo: 0.1 }),
    gasto({ id: 'F2', saldo: 0.2 }),
    gasto({ id: 'F3', saldo: 0.3 }),
  ];
  assert.equal(facturas.reduce((acc, f) => acc + f.saldo_pendiente, 0) === 0.6, false);
  assert.equal(facturas.reduce((acc, f) => acc + saldoPendienteCentimos(f), 0), 60);

  const combinacion = sugerir(
    movimiento({ centimos: -60, concepto: 'COCTEMATIAS SL B12345678' }),
    facturas,
  ).find((s) => s.tipo === 'combinacion');
  assert.ok(combinacion, 'la suma exacta en céntimos debe encontrarse');
  assert.equal(combinacion.asignadoCentimos, 60);

  // Un importe con más decimales de la cuenta se redondea a céntimo, no se trunca.
  const conRedondeo = gasto({ id: 'F-R', saldo: 1234.565 });
  assert.equal(saldoPendienteCentimos(conRedondeo), 123457);
  const [sugerencia] = sugerir(movimiento({ centimos: -123457 }), [conRedondeo]);
  assert.equal(sugerencia.tipo, 'exacta');
});

// ─── Barrido completo ───

test('el barrido indexa por movimiento y por factura, y respeta los topes', () => {
  const facturas = [
    gasto({ id: 'F1', empresa_cif: 'B12345678' }),
    gasto({ id: 'F2', empresa_cif: 'B12345678' }),
    gasto({ id: 'F3', empresa_cif: 'B12345678' }),
    gasto({ id: 'F-BORRADOR', estado: 'borrador' }),
  ];
  const movimientos = [
    movimiento({ movementHash: 'm1', concepto: 'ADEUDO COCTEMATIAS SL B12345678' }),
    movimiento({ movementHash: 'm2', concepto: 'TRASPASO ENTRE CUENTAS' }),
    movimiento({ movementHash: 'm3', centimos: -999999, concepto: 'ADEUDO OTRA COSA' }),
  ];

  const salida = sugerirConciliaciones({ movimientos, facturas, opciones: { maxSugerenciasPorMovimiento: 2 } });

  assert.equal(salida.totales.movimientos, 3);
  assert.equal(salida.totales.facturasElegibles, 3, 'el borrador no es elegible');
  assert.equal(salida.totales.movimientosExcluidos, 1);
  assert.equal(salida.totales.movimientosConSugerencias, 1);

  const m1 = salida.porMovimiento.find((m) => m.movementHash === 'm1');
  assert.equal(m1.sugerencias.length, 2, 'tope por movimiento');
  assert.equal(m1.candidatas, 3);

  const porFactura = salida.porFactura.find((f) => f.id_factura === 'F1');
  assert.ok(porFactura);
  assert.equal(porFactura.mejorNivel, 'alta');
  assert.ok(porFactura.sugerencias.every((s) => s.facturas.some((f) => f.id_factura === 'F1')));
  assert.equal(salida.porFactura.some((f) => f.id_factura === 'F-BORRADOR'), false);
});

test('cada sugerencia describe el movimiento, también las de combinación', () => {
  // En `porFactura` las sugerencias viajan sin la entrada de `porMovimiento`, así
  // que si la sugerencia no describe el apunte la pantalla de facturas no puede
  // decir de qué es el importe.
  const mov = movimiento({
    concepto: 'TRANSFERENCIA A FAVOR DE 2026FM53 BD417B83 COCTEMAT',
    centimos: -60000,
    referencia1: 'REF-BBVA-1',
    referencia2: 'REF-BBVA-2',
    numeroDocumento: 'DOC-99',
    formatoOrigen: 'bbva_xlsx',
    nombreFichero: 'BBVA febrero26-julio26.xlsx',
  });
  const facturas = [gasto({ id: 'F1', saldo: 200 }), gasto({ id: 'F2', saldo: 400 })];

  const salida = sugerir(mov, facturas);
  const combinacion = salida.find((s) => s.tipo === 'combinacion');
  assert.ok(combinacion, 'debe haber una combinación que sume el movimiento');

  for (const sugerencia of salida) {
    const descripcion = sugerencia.movimiento;
    assert.ok(descripcion, `sugerencia ${sugerencia.tipo} sin descripción del movimiento`);
    assert.equal(descripcion.concepto, mov.concepto);
    assert.equal(descripcion.empresaNombre, 'HOSTELERIA DEL SUR SL');
    // El front decide qué enseñar con estos campos (`beneficiarioMovimiento`,
    // `conceptoCortoMovimiento`): los nombres son los del ítem de banca.
    assert.equal(descripcion.conceptoNormalizado, mov.conceptoNormalizado);
    assert.equal(descripcion.referencia1, 'REF-BBVA-1');
    assert.equal(descripcion.referencia2, 'REF-BBVA-2');
    assert.equal(descripcion.numeroDocumento, 'DOC-99');
    assert.equal(descripcion.formatoOrigen, 'bbva_xlsx');
    assert.equal(descripcion.nombreFichero, 'BBVA febrero26-julio26.xlsx');
    assert.equal(descripcion.empresaId, SOCIEDAD);
    assert.equal(descripcion.iban, IBAN);
    assert.equal(descripcion.fechaValor, FECHA_MOV);
    assert.equal(descripcion.estadoConciliacion, 'pendiente');
    // La identificación del movimiento sigue en el primer nivel: el objeto
    // anidado describe, no identifica.
    assert.equal(sugerencia.movementHash, 'h1');
    assert.equal(sugerencia.fechaOperacion, FECHA_MOV);
  }

  // Lo que falta llega como cadena vacía, no como undefined.
  const [pelado] = sugerir(
    movimiento({ concepto: 'ADEUDO COCTEMATIAS SL B12345678', empresaId: '', formatoOrigen: '', nombreFichero: '' }),
    [gasto({ id: 'F-SOLA' })],
  );
  assert.equal(pelado.movimiento.empresaId, '');
  assert.equal(pelado.movimiento.empresaNombre, '');
  assert.equal(pelado.movimiento.formatoOrigen, '');
  assert.equal(
    Object.values(pelado.movimiento).every((v) => typeof v === 'string'),
    true,
    'ningún campo puede llegar como undefined',
  );
});
