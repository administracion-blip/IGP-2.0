/**
 * Coherencia entre las marcas de periodo que escriben los tres generadores y la
 * lista que las borra al copiar una factura.
 *
 * La copia de una factura (duplicar o rectificar) tiene que quedar sin marcas: si
 * hereda `rappel_periodo` o `ventas_internas_periodo`, la previsualización de la
 * facturación mensual la cuenta como "ya hay documento de este periodo entre estas
 * dos sociedades" y avisa de un duplicado que no existe.
 *
 * La prueba no comprueba el borrado (eso es una línea), sino lo que se rompe con
 * el tiempo: que la lista siga cubriendo todo lo que los generadores escriben. Un
 * campo nuevo en cualquiera de los tres dominios falla aquí en vez de colarse en
 * silencio en las copias.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

const {
  montarEscenario,
  tables,
  empresa,
  local,
  almacen,
  producto,
  pedido,
  lineaPedido,
  lineaConRappel,
  serie,
  ajustesCompras,
  EMPRESA_CENTRAL,
  EMPRESA_NORTE,
  PERIODO,
  dia,
  instante,
} = await import('./escenarioFacturacion.mjs');

const { CAMPOS_MARCA_FACTURACION_PERIODICA, limpiarMarcasFacturacionPeriodica } =
  await import('../lib/facturacion/marcasPeriodicas.js');

const { generarFacturacionVentasInternas } = await import('../lib/facturacion/facturarVentasInternas.js');
const { generarFacturacionRappel } = await import('../lib/facturacion/facturarRappel.js');
const { generarFacturacionMantenimiento } = await import('../lib/facturacion/facturarMantenimiento.js');

/** Prefijos de los campos que son marca de periodo, para reconocerlos en la factura. */
const DOMINIOS = ['mantenimiento_', 'ventas_internas_', 'rappel_'];

/** Marcas que la factura lleva escritas, sea cual sea el dominio que la generó. */
function marcasDe(factura) {
  return Object.keys(factura).filter((campo) => DOMINIOS.some((p) => campo.startsWith(p)));
}

/**
 * Afirma que todas las marcas de la factura están cubiertas por la lista y que,
 * tras limpiarla, no queda ninguna.
 */
function afirmarMarcasCubiertas(factura, dominio) {
  const marcas = marcasDe(factura);
  assert.ok(marcas.length > 0, `la factura de ${dominio} debería llevar marcas de periodo`);

  const sinCubrir = marcas.filter((campo) => !CAMPOS_MARCA_FACTURACION_PERIODICA.includes(campo));
  assert.deepEqual(
    sinCubrir,
    [],
    `${dominio} escribe marcas que la copia de factura no borra: ${sinCubrir.join(', ')}. ` +
      'Añádelas en lib/facturacion/marcasPeriodicas.js o heredarán a duplicados y rectificativas.'
  );

  const copia = { ...factura };
  limpiarMarcasFacturacionPeriodica(copia);
  assert.deepEqual(marcasDe(copia), [], `la copia de ${dominio} conserva marcas de periodo`);
}

function grupoCompras(db) {
  db.sembrar(tables.empresas, empresa(EMPRESA_CENTRAL, 'Central'));
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte'));
  db.sembrar(tables.almacenes, almacen('ALM-GEN', 'ALMACEN GENERAL'));
  db.sembrar(tables.locales, local('000010', 'Bar Norte', EMPRESA_NORTE));
  db.sembrar(tables.agoraProducts, producto('P1', 21));
  db.sembrar(tables.facturasSeries, serie('FMI'));
  db.sembrar(tables.facturasSeries, serie('FRAPPEL'));
  db.sembrar(tables.ajustes, ajustesCompras());
  return db;
}

test('las marcas de ventas internas están cubiertas por la limpieza de copias', async () => {
  const db = grupoCompras(montarEscenario());
  db.sembrar(tables.pedidos, pedido('PED-1', {
    Estado: 'Completado', LocalId: '000010', AlmacenOrigen: 'ALMACEN GENERAL', Fecha: dia(PERIODO, 5),
  }));
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', 'L1', { ProductId: 'P1', TotalLinea: 100 }));

  const res = await generarFacturacionVentasInternas({ periodo: PERIODO, ahora: instante(PERIODO) });
  assert.equal(res.ok, true);
  const facturas = db.listar(tables.facturas);
  assert.equal(facturas.length, 1);
  afirmarMarcasCubiertas(facturas[0], 'ventas internas');
});

test('las marcas del rappel están cubiertas por la limpieza de copias', async () => {
  const db = grupoCompras(montarEscenario());
  db.sembrar(tables.pedidos, pedido('PED-1', {
    Estado: 'Completado', LocalId: '000010', AlmacenOrigen: 'ALMACEN GENERAL', Fecha: dia(PERIODO, 5),
  }));
  db.sembrar(tables.pedidosLineas, lineaConRappel('PED-1', 'L1', 10, { ProductId: 'P1' }));

  const res = await generarFacturacionRappel({ periodo: PERIODO, ahora: instante(PERIODO) });
  assert.equal(res.ok, true);
  const facturas = db.listar(tables.facturas);
  assert.equal(facturas.length, 1);
  afirmarMarcasCubiertas(facturas[0], 'rappel');
});

test('las marcas de mantenimiento están cubiertas por la limpieza de copias', async () => {
  const db = montarEscenario();
  db.sembrar(tables.empresas, empresa('000359', 'Demanda y Servicios'));
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte'));
  db.sembrar(tables.locales, local('000010', 'Bar Norte', EMPRESA_NORTE));
  db.sembrar(tables.facturasSeries, serie('FMANT'));
  db.sembrar(tables.ajustes, {
    PK: 'mantenimiento', SK: 'facturacion',
    id_empresa_emisora: '000359', serie: 'FMANT', dia_generacion: 1, hora: '06:00', Enabled: false,
  });
  db.sembrar(tables.mantenimiento, {
    PK: 'LOCAL#000010', SK: 'INC#1', local_id: '000010', id_incidencia: '1',
    titulo: 'Cambiar grifo', EstadoValoracion: 'Valorado',
    fecha_programada: dia(PERIODO, 10), fecha_valoracion: dia(PERIODO, 12),
    valoracion_rev: 1, valoracion_total: 121,
    valoracion_lineas: [{ articulo: 'Grifo', cantidad: 1, precio: 100, tipo_iva: 21 }],
  });

  const res = await generarFacturacionMantenimiento({ periodo: PERIODO, ahora: instante(PERIODO) });
  assert.equal(res.ok, true);
  const facturas = db.listar(tables.facturas);
  assert.equal(facturas.length, 1);
  afirmarMarcasCubiertas(facturas[0], 'mantenimiento');
});
