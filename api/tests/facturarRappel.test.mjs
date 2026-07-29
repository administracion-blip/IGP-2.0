/**
 * Pruebas de la liquidación mensual del rappel como abono.
 *
 * Lo que se comprueba aquí es lo que hace de un abono un documento correcto y no
 * una factura con el signo cambiado: que lo emite quien sirvió, que sale en
 * negativo, que va al tipo de IVA de la mercancía que lo generó, que un rappel de
 * cero no produce documento, que una devolución resta en vez de sumar y que la
 * marca del rappel es independiente de la de la venta.
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
  EMPRESA_SUR,
  PERIODO,
  PERIODO_ANTERIOR,
  PERIODO_EN_CURSO,
  dia,
  instante,
  ultimoDia,
} = await import('./escenarioFacturacion.mjs');

const {
  previsualizarFacturacionRappel,
  generarFacturacionRappel,
} = await import('../lib/facturacion/facturarRappel.js');

const { generarFacturacionVentasInternas } = await import('../lib/facturacion/facturarVentasInternas.js');

function baseGrupo(db, { ajustes = {} } = {}) {
  db.sembrar(tables.empresas, empresa(EMPRESA_CENTRAL, 'Central'));
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte'));
  db.sembrar(tables.empresas, empresa(EMPRESA_SUR, 'Sur'));
  db.sembrar(tables.almacenes, almacen('ALM-GEN', 'ALMACEN GENERAL'));
  db.sembrar(tables.almacenes, almacen('ALM-NORTE', 'Almacen Norte'));
  db.sembrar(tables.locales, local('000010', 'Bar Norte', EMPRESA_NORTE, ['Almacen Norte']));
  db.sembrar(tables.locales, local('000020', 'Bar Sur', EMPRESA_SUR));
  db.sembrar(tables.agoraProducts, producto('P1', 10));
  db.sembrar(tables.agoraProducts, producto('P2', 21));
  db.sembrar(tables.facturasSeries, serie('FMI'));
  db.sembrar(tables.facturasSeries, serie('FRAPPEL'));
  db.sembrar(tables.ajustes, ajustesCompras(ajustes));
  return db;
}

function sembrarPedido(db, id, campos, lineas = [{}]) {
  db.sembrar(tables.pedidos, pedido(id, campos));
  lineas.forEach((l, i) => db.sembrar(tables.pedidosLineas, lineaPedido(id, i + 1, l)));
}

// ─── Dirección, signo e IVA ───

test('el abono lo emite quien sirvió la mercancía y va en negativo', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ ProductId: 'P1', TotalLinea: 100, TotalRappel: 12 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.ok, true);
  assert.equal(r.total_facturas, 1);

  const [a] = r.abonos;
  assert.equal(a.id_empresa_emisora, EMPRESA_CENTRAL, 'emite la sociedad del Almacén General, la que sirvió');
  assert.equal(a.id_empresa, EMPRESA_NORTE, 'recibe la sociedad del local, la que compró');
  assert.equal(a.es_abono, true);
  assert.equal(a.base, -12);
  assert.equal(a.iva, -1.2, 'la cuota también se rectifica en negativo');
  assert.equal(a.total, -13.2);

  const [factura] = db.listar(tables.facturas);
  assert.equal(factura.serie, 'FRAPPEL');
  assert.equal(factura.estado, 'borrador');
  assert.equal(factura.emisor_id, EMPRESA_CENTRAL);
  assert.equal(factura.empresa_id, EMPRESA_NORTE);
  assert.equal(factura.total_factura, -13.2);
  assert.equal(factura.saldo_pendiente, -13.2);
  assert.equal(factura.fecha_emision, ultimoDia(PERIODO), 'se emite el último día del periodo liquidado');
  assert.equal(factura.rappel_periodo, PERIODO);

  const [linea] = db.listar(tables.facturasLineas);
  assert.equal(linea.cantidad, 1, 'el signo lo lleva el precio, no la cantidad');
  assert.equal(linea.precio_unitario, -12);
  assert.equal(linea.tipo_iva, 10);
});

test('el documento se marca como abono y como rectificativa por diferencias sin factura concreta', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 5 }]);

  await generarFacturacionRappel({ periodo: PERIODO });
  const [factura] = db.listar(tables.facturas);
  assert.equal(factura.es_abono, true);
  assert.equal(factura.es_rectificativa, true, 'para VERI*FACTU un abono es una rectificativa');
  assert.equal(factura.rectificativa_tipo, 'diferencias');
  assert.equal(factura.factura_rectificada_id, '', 'no rectifica una factura, rectifica un periodo');
  assert.match(factura.motivo_rectificacion, new RegExp(PERIODO));
  assert.match(factura.motivo_rectificacion, /80\.1\.2/);
});

test('el rappel va al tipo de IVA de la mercancía que lo generó', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [
    { ProductId: 'P1', TotalLinea: 100, TotalRappel: 10 },
    { ProductId: 'P2', TotalLinea: 200, TotalRappel: 20 },
  ]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.deepEqual(
    r.abonos[0].impuestos.map((i) => [i.tipo_iva, i.base, i.cuota]),
    [
      [10, -10, -1],
      [21, -20, -4.2],
    ],
    'un rappel de producto al 10 % no puede abonarse al 21 %'
  );
  assert.equal(r.abonos[0].total, -35.2);
});

test('el IVA del rappel sale del pedido cuando la línea lo trae, igual que en ventas', async () => {
  const db = baseGrupo(montarEscenario());
  // El maestro dice 10 % pero la línea del pedido dice 4 % (guardado como fracción).
  sembrarPedido(db, 'PED-1', {}, [{ ProductId: 'P1', TotalRappel: 10, VatRate: 0.04 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.deepEqual(r.abonos[0].impuestos.map((i) => i.tipo_iva), [4]);
});

test('un IVA que no se puede determinar excluye el pedido en vez de inventar un tipo', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ ProductId: 'SIN-MAESTRO', TotalRappel: 10 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos.length, 1);
  assert.equal(r.excluidos[0].motivo, 'iva_no_resuelto');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

// ─── Rappel de cero ───

test('un pedido sin rappel no genera abono ni se denuncia como anomalía', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalLinea: 100 }]);
  sembrarPedido(db, 'PED-2', {}, [{ TotalLinea: 100, TotalRappel: 0 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0, 'ninguna sociedad recibe un abono vacío');
  assert.equal(r.excluidos.length, 0, 'no tener rappel es lo normal, no un error que reportar');
  assert.equal(r.no_facturables.sin_importe, 2);
  assert.equal(db.listar(tables.facturas).length, 0);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('una sociedad cuyo rappel neto del mes es cero no recibe documento', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 30 }]);
  sembrarPedido(db, 'PED-2', { Tipo: 'Devolucion' }, [{ TotalRappel: 30 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(db.listar(tables.facturas).length, 0);
  assert.equal(r.excluidos.filter((e) => e.motivo === 'factura_total_cero').length, 1);
  assert.equal(
    db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id,
    undefined,
    'los pedidos quedan libres si el documento no se llega a escribir'
  );
});

// ─── Devoluciones ───

test('una devolución resta del abono el rappel que generó la compra', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 50 }]);
  sembrarPedido(db, 'PED-2', { Tipo: 'Devolucion' }, [{ TotalRappel: 20 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.abonos[0].base, -30, 'se abona el rappel neto, no el bruto');
  assert.equal(r.abonos[0].num_pedidos, 2, 'la devolución entra en el abono, no se excluye');
  assert.equal(r.no_facturables.devoluciones ?? 0, 0);
});

test('si las devoluciones superan a las compras no se emite un abono en positivo', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 10 }]);
  sembrarPedido(db, 'PED-2', { Tipo: 'Devolucion' }, [{ TotalRappel: 40 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(db.listar(tables.facturas).length, 0);
  const excluido = r.excluidos.find((e) => e.motivo === 'validacion_emision');
  assert.ok(excluido, 'el par de sociedades se excluye y se explica');
  assert.match(excluido.detalle, /negativo/);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('un pedido que pasa a ser devolución entre el plan y el reclamo se descarta', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 40 }]);
  sembrarPedido(db, 'PED-2', {}, [{ TotalRappel: 10 }]);
  // `Tipo` decide el signo con el que el pedido entra en el abono: como compra
  // resta 40 del rappel a devolver y como devolución lo suma. Cambiarlo tras el
  // plan dejaría un abono cuyo importe no se corresponde con los pedidos que
  // dice liquidar, y nada más en la cabecera se mueve al cambiarlo.
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(tables.pedidos, pedido('PED-1', { Tipo: 'Devolucion' }));
  });

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.descartados.length, 1);
  assert.equal(r.descartados[0].pedido_id, 'PED-1');
  assert.equal(r.descartados[0].motivo, 'concurrencia');
  assert.equal(r.total_facturas, 1);
  assert.equal(r.abonos[0].base, -10, 'el abono se rehace solo con lo reclamado');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

// ─── Independencia de la marca de ventas ───

test('la marca del rappel es independiente de la de ventas y no se estorban', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalLinea: 100, TotalRappel: 12 }]);

  const venta = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(venta.total_facturas, 1);
  const abono = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(abono.total_facturas, 1, 'el rappel se abona aunque la venta ya esté facturada');

  const p = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(p.factura_ventas_id, venta.facturas[0].id_factura);
  assert.equal(p.factura_rappel_id, abono.abonos[0].id_factura);
  assert.notEqual(p.factura_ventas_id, p.factura_rappel_id, 'son dos documentos distintos');
  assert.equal(p.factura_ventas_periodo, PERIODO);
  assert.equal(p.factura_rappel_periodo, PERIODO);
});

test('un pedido con la venta sin facturar puede tener el rappel abonado', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  await generarFacturacionRappel({ periodo: PERIODO });
  const p = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.ok(p.factura_rappel_id);
  assert.equal(p.factura_ventas_id, undefined);
});

test('los marcadores de periodo de venta y rappel son distintos campos del mismo ajuste', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  await generarFacturacionRappel({ periodo: PERIODO });
  const ajuste = db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' });
  assert.equal(ajuste.ultimo_periodo_generado_rappel, PERIODO);
  assert.equal(
    ajuste.ultimo_periodo_generado,
    undefined,
    'abonar el rappel no puede dar por facturada la venta del mismo mes'
  );
  assert.equal(JSON.parse(ajuste.ultima_generacion_resumen_rappel).facturas, 1);
});

test('los cerrojos de venta y rappel son independientes', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);
  db.sembrar(tables.ajustes, {
    PK: 'compras',
    SK: 'facturacion_lock',
    ejecucion: 'otra',
    expira_en: new Date(Date.now() + 600000).toISOString(),
  });

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.ok, true, 'el cerrojo de las ventas no bloquea el abono del rappel');
  assert.equal(r.total_facturas, 1);
});

// ─── Agrupación, idempotencia y concurrencia ───

test('un abono por par de sociedades, agrupando los pedidos de varios locales', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.locales, local('000021', 'Bar Sur 2', EMPRESA_SUR));
  sembrarPedido(db, 'PED-1', { LocalId: '000020' }, [{ TotalRappel: 10 }]);
  sembrarPedido(db, 'PED-2', { LocalId: '000021' }, [{ TotalRappel: 15 }]);
  sembrarPedido(db, 'PED-3', { LocalId: '000010' }, [{ TotalRappel: 7 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 2, 'Central→Sur y Central→Norte');
  const aSur = r.abonos.find((f) => f.id_empresa === EMPRESA_SUR);
  assert.equal(aSur.num_pedidos, 2);
  assert.equal(aSur.base, -25);
  assert.equal(aSur.num_lineas, 2, 'una línea fiscal por cada pedido/albarán');
});

test('cuando sirve el almacén de un local, abona la sociedad de ese local', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-NORTE', LocalId: '000020' }, [{ TotalRappel: 9 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.abonos[0].id_empresa_emisora, EMPRESA_NORTE);
  assert.equal(r.abonos[0].id_empresa, EMPRESA_SUR);
});

test('no abona los movimientos dentro de la misma sociedad', async () => {
  const db = baseGrupo(montarEscenario(), { ajustes: { id_empresa_almacen_general: EMPRESA_NORTE } });
  sembrarPedido(db, 'PED-1', { LocalId: '000010' }, [{ TotalRappel: 10 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.no_facturables.misma_sociedad, 1);
});

test('generar dos veces el mismo periodo no vuelve a abonar los mismos pedidos', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const primera = await generarFacturacionRappel({ periodo: PERIODO });
  const segunda = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(primera.total_facturas, 1);
  assert.equal(segunda.total_facturas, 0);
  assert.equal(db.listar(tables.facturas).length, 1);
});

test('un pedido cuyas líneas cambian entre el plan y el reclamo se descarta', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 10 }]);
  sembrarPedido(db, 'PED-2', { LocalId: '000010' }, [{ TotalRappel: 20 }]);
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(tables.pedidos, pedido('PED-1', { lineas_rev: 2 }));
  });

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.descartados.length, 1);
  assert.equal(r.descartados[0].pedido_id, 'PED-1');
  assert.equal(r.abonos[0].base, -20, 'el abono se rehace solo con lo reclamado');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('un pedido marcado con un abono que ya no existe se libera y se vuelve a abonar', async () => {
  const db = baseGrupo(montarEscenario());
  const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  sembrarPedido(
    db,
    'PED-1',
    {
      factura_rappel_id: 'ABONO-QUE-NO-ESTA',
      factura_rappel_periodo: PERIODO,
      factura_rappel_fecha: hace2h,
      factura_rappel_ejecucion: 'ejecucion-anterior',
    },
    [{ TotalRappel: 12 }]
  );

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.pedidos_liberados.length, 1);
  assert.equal(r.total_facturas, 1);
  assert.notEqual(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, 'ABONO-QUE-NO-ESTA');
});

test('el barrido del rappel no mira la marca de ventas', async () => {
  const db = baseGrupo(montarEscenario());
  const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  sembrarPedido(
    db,
    'PED-1',
    {
      factura_ventas_id: 'FACTURA-QUE-NO-ESTA',
      factura_ventas_periodo: PERIODO,
      factura_ventas_fecha: hace2h,
    },
    [{ TotalRappel: 12 }]
  );

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.pedidos_liberados.length, 0, 'no le toca reparar las marcas del otro flujo');
  assert.equal(
    db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id,
    'FACTURA-QUE-NO-ESTA',
    'la marca de ventas queda intacta'
  );
  assert.equal(r.total_facturas, 1, 'y el rappel se abona igual');
});

// ─── Selección, series y validaciones ───

test('solo entra lo completado dentro del periodo, y lo anterior sin abonar se avisa', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(
    db,
    'PED-VIEJO',
    { Fecha: dia(PERIODO_ANTERIOR, 8), CompletadoEn: instante(PERIODO_ANTERIOR, 9, '09:00:00') },
    [{ TotalRappel: 40 }]
  );
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const r = await previsualizarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.total_importe, -13.2);
  assert.deepEqual(r.pendientes_periodos_anteriores, [{ periodo: PERIODO_ANTERIOR, pedidos: 1 }]);
});

test('la previsualización no escribe nada', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const r = await previsualizarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(db.listar(tables.facturas).length, 0);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('la serie del rappel se lee de serie_rappel, no de serie_ventas', async () => {
  const db = baseGrupo(montarEscenario(), { ajustes: { serie_rappel: 'FRAPPEL2' } });
  db.sembrar(tables.facturasSeries, serie('FRAPPEL2'));
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.serie, 'FRAPPEL2');
  assert.equal(db.listar(tables.facturas)[0].serie, 'FRAPPEL2');
});

test('una serie de gastos no sirve para abonar el rappel', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.facturasSeries, serie('FRAPPEL', { tipo: 'IN' }));
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.match(r.error, /gasto/);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('una sociedad sin CIF no recibe abono y se dice por qué', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte', { cif: '' }));
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos[0].motivo, 'sociedad_sin_datos_fiscales');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('sin sociedad del Almacén General configurada no abona y lo explica', async () => {
  const db = baseGrupo(montarEscenario(), { ajustes: { id_empresa_almacen_general: '' } });
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos[0].motivo, 'emisora_almacen_general_sin_configurar');
});

test('la auditoría deja constancia de que el documento es un abono', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  await generarFacturacionRappel({ periodo: PERIODO, usuario_nombre: 'Prueba' });
  const auditoria = db.listar(tables.facturasAuditoria);
  assert.equal(auditoria.length, 1);
  const detalle = JSON.parse(auditoria[0].detalle);
  assert.equal(detalle.origen, 'rappel_manual');
  assert.equal(detalle.es_abono, true);
  assert.equal(detalle.periodo, PERIODO);
  assert.equal(detalle.total_factura, -13.2);
});

test('el cerrojo del rappel queda liberado al terminar', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);
  await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion_rappel_lock' }), null);
});

test('la base abonada cuadra con la suma en crudo de los rappels de las líneas', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [
    lineaConRappel('PED-1', 1, 3.335),
    lineaConRappel('PED-1', 2, 6.665),
  ]);

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.abonos[0].base, -9.99, 'cada línea fiscal redondea por separado');
  assert.equal(r.abonos[0].base_informe, -10);
  assert.equal(r.abonos[0].descuadre_centimos, 1);
});

// ─── Solo periodos cerrados y fallos parciales ───

test('no se puede abonar el rappel del mes en curso', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { CompletadoEn: instante(PERIODO_EN_CURSO, 1, '09:00:00') }, [{ TotalRappel: 12 }]);

  const r = await generarFacturacionRappel({ periodo: PERIODO_EN_CURSO });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /periodos cerrados/);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('si el abono no se puede escribir, el periodo del rappel queda abierto', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);
  db.interceptar('PutCommand', tables.facturas, () => {
    throw Object.assign(new Error('Throughput exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
  });

  const r = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.parcial, true);
  assert.equal(r.motivo_incompleto, 'errores_de_escritura');
  const ajuste = db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' });
  assert.equal(
    ajuste.ultimo_periodo_generado_rappel ?? '',
    '',
    'el marcador del rappel no avanza con el mes a medias'
  );
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_rappel_id, undefined);
});

test('un fallo del rappel no arrastra el marcador de las ventas', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }]);

  const venta = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(venta.total_facturas, 1);

  db.interceptar('PutCommand', tables.facturas, () => {
    throw Object.assign(new Error('Throughput exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
  });
  const abono = await generarFacturacionRappel({ periodo: PERIODO });
  assert.equal(abono.parcial, true);

  const ajuste = db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' });
  assert.equal(ajuste.ultimo_periodo_generado, PERIODO, 'la venta sí cerró su periodo');
  assert.equal(ajuste.ultimo_periodo_generado_rappel ?? '', '', 'y el rappel sigue pendiente');
});

test('una línea con rappel negativo excluye el pedido', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ TotalRappel: 12 }, { TotalRappel: -4 }]);

  const r = await previsualizarFacturacionRappel({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos[0].motivo, 'linea_importe_negativo');
  assert.match(r.excluidos[0].detalle, /TotalRappel negativo/);
});
