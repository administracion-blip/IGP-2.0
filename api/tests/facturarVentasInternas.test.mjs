/**
 * Pruebas de la facturación mensual de ventas internas.
 *
 * Lo que se comprueba aquí no es que el código "funcione": es que un pedido no
 * se facture dos veces, que no se facture a la sociedad equivocada y que nada
 * con datos insuficientes se cuele en un documento fiscal. Todo lo que no puede
 * facturarse tiene que salir en `excluidos` con su motivo, porque un pedido que
 * desaparece en silencio es dinero que nadie cobra.
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
  serie,
  ajustesCompras,
  EMPRESA_CENTRAL,
  EMPRESA_NORTE,
  EMPRESA_SUR,
  PERIODO,
  PERIODO_ANTERIOR,
  PERIODO_SIGUIENTE,
  PERIODO_EN_CURSO,
  dia,
  instante,
  ultimoDia,
} = await import('./escenarioFacturacion.mjs');

const {
  previsualizarFacturacionVentasInternas,
  generarFacturacionVentasInternas,
} = await import('../lib/facturacion/facturarVentasInternas.js');

/**
 * Grupo con Almacén General (sociedad central) y dos locales de sociedades
 * distintas, uno de ellos con almacén propio.
 */
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
  db.sembrar(tables.ajustes, ajustesCompras(ajustes));
  return db;
}

/** Pedido con sus líneas, para no repetir dos sembrados en cada prueba. */
function sembrarPedido(db, id, campos, lineas = [{}]) {
  db.sembrar(tables.pedidos, pedido(id, campos));
  lineas.forEach((l, i) => db.sembrar(tables.pedidosLineas, lineaPedido(id, i + 1, l)));
}

test('factura la mercancía del Almacén General al local, con el desglose por tipo de IVA', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [
    { ProductId: 'P1', TotalLinea: 100 },
    { ProductId: 'P2', TotalLinea: 200 },
  ]);

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.ok, true);
  assert.equal(r.total_facturas, 1);

  const [f] = r.facturas;
  assert.equal(f.id_empresa_emisora, EMPRESA_CENTRAL, 'emite la sociedad del Almacén General');
  assert.equal(f.id_empresa, EMPRESA_NORTE, 'recibe la sociedad del local');
  assert.equal(f.base, 300);
  // 100 al 10 % + 200 al 21 % = 10 + 42
  assert.equal(f.iva, 52);
  assert.equal(f.total, 352);
  assert.deepEqual(
    f.impuestos.map((i) => [i.tipo_iva, i.base, i.cuota]),
    [
      [10, 100, 10],
      [21, 200, 42],
    ]
  );

  const [factura] = db.listar(tables.facturas);
  assert.equal(factura.estado, 'borrador');
  assert.equal(factura.fecha_emision, ultimoDia(PERIODO), 'se emite el último día del periodo');
  assert.equal(factura.fecha_operacion, ultimoDia(PERIODO));
  assert.equal(factura.numero_factura ?? '', '', 'el borrador nace sin numeración');
  assert.equal(factura.ventas_internas_periodo, PERIODO);
  assert.equal(db.listar(tables.facturasLineas).length, 2);

  const marcado = db.obtener(tables.pedidos, { Id: 'PED-1' });
  assert.equal(marcado.factura_ventas_id, factura.id_factura);
  assert.equal(marcado.factura_ventas_periodo, PERIODO);
  assert.equal(marcado.factura_ventas_id_empresa, EMPRESA_CENTRAL);
  assert.equal(marcado.factura_ventas_numero, undefined, 'el número se reserva al emitir, no al generar');
});

test('cuando sirve el almacén de un local, emite la sociedad de ese local', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-NORTE', LocalId: '000020' });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.facturas[0].id_empresa_emisora, EMPRESA_NORTE);
  assert.equal(r.facturas[0].id_empresa, EMPRESA_SUR);
  assert.equal(r.facturas[0].origenes[0].origen_nombre, 'Bar Norte');
});

test('no factura los movimientos dentro de la misma sociedad', async () => {
  const db = baseGrupo(montarEscenario());
  // El almacén del Bar Norte sirve al propio Bar Norte.
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-NORTE', LocalId: '000010' });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.no_facturables.misma_sociedad, 1);
  assert.equal(r.excluidos.length, 0, 'no es una anomalía: no debe ensuciar el informe');
});

test('excluye las devoluciones en vez de facturarlas en negativo', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { Tipo: 'Devolucion' });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.no_facturables.devoluciones, 1);
  assert.equal(r.excluidos[0].motivo, 'devolucion');
});

test('el IVA sale del maestro de productos cuando el pedido no lo trae', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [{ ProductId: 'P2', TotalLinea: 100, VatRate: 0 }]);

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.facturas[0].impuestos[0].tipo_iva, 21, 'un VatRate de 0 significa "sin dato", no "0 %"');
  assert.equal(r.lineas_iva_desde_producto, 1);
});

test('el IVA del pedido manda sobre el del maestro y se guarda como fracción', async () => {
  const db = baseGrupo(montarEscenario());
  // El producto está al 21 % en el maestro, pero la línea se cerró al 4 %.
  sembrarPedido(db, 'PED-1', {}, [{ ProductId: 'P2', TotalLinea: 100, VatRate: 0.04 }]);

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.facturas[0].impuestos[0].tipo_iva, 4);
  assert.equal(r.facturas[0].iva, 4);
});

test('un IVA que no se puede determinar excluye el pedido, no inventa un 21 %', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.agoraProducts, { PK: 'GLOBAL', SK: 'P-SIN-IVA' });
  sembrarPedido(db, 'PED-1', {}, [{ ProductId: 'P-SIN-IVA', TotalLinea: 100 }]);
  sembrarPedido(db, 'PED-2', {}, [{ ProductId: 'P1', TotalLinea: 50 }]);

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1, 'el pedido sano sí se factura');
  assert.equal(r.facturas[0].base, 50);
  const excluido = r.excluidos.find((e) => e.pedido_id === 'PED-1');
  assert.equal(excluido.motivo, 'iva_no_resuelto');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id, undefined);
});

test('sin sociedad del Almacén General configurada no factura y lo explica', async () => {
  const db = baseGrupo(montarEscenario(), { ajustes: { id_empresa_almacen_general: '' } });
  sembrarPedido(db, 'PED-1', {});

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos[0].motivo, 'emisora_almacen_general_sin_configurar');
  assert.match(r.excluidos[0].motivo_texto, /Almacén General/);
});

test('un almacén que reclaman dos locales no se atribuye a ninguno', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.locales, local('000030', 'Bar Este', EMPRESA_SUR, ['Almacen Norte']));
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-NORTE', LocalId: '000020' });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos[0].motivo, 'almacen_no_atribuible');
  assert.match(r.excluidos[0].detalle, /2 locales/);
});

test('la sociedad del receptor es la congelada al completar, no la actual del maestro', async () => {
  const db = baseGrupo(montarEscenario());
  // El local se traspasó a la sociedad Sur después de servirse la mercancía.
  db.sembrar(tables.locales, local('000010', 'Bar Norte', EMPRESA_SUR, ['Almacen Norte']));
  sembrarPedido(db, 'PED-1', { factura_id_empresa_local: EMPRESA_NORTE });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.facturas[0].id_empresa, EMPRESA_NORTE);
});

test('una sociedad sin CIF no recibe factura y se dice por qué', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.empresas, { id_empresa: EMPRESA_NORTE, nombre: 'Norte' });
  sembrarPedido(db, 'PED-1', {});

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos[0].motivo, 'sociedad_sin_datos_fiscales');
  assert.match(r.excluidos[0].detalle, /CIF/);
});

test('un pedido completado sin fecha de completado se fecha por la del pedido', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.pedidos, {
    Id: 'PED-1',
    Estado: 'Completado',
    Tipo: 'Pedido',
    Fecha: dia(PERIODO, 5),
    LocalId: '000010',
    AlmacenOrigenId: 'ALM-GEN',
  });
  db.sembrar(tables.pedidosLineas, lineaPedido('PED-1', 1));

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.facturas[0].locales[0].pedidos[0].fecha, dia(PERIODO, 5));
});

test('solo entra lo completado dentro del periodo, y lo anterior sin facturar se avisa', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-DENTRO', { CompletadoEn: instante(PERIODO, 15, '09:00:00') });
  sembrarPedido(db, 'PED-DESPUES', { CompletadoEn: instante(PERIODO_SIGUIENTE, 1, '09:00:00') });
  sembrarPedido(db, 'PED-ANTES', { CompletadoEn: instante(PERIODO_ANTERIOR, 20, '09:00:00') });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.pedidos_revisados, 1);
  assert.equal(r.facturas[0].num_pedidos, 1);
  assert.deepEqual(r.pendientes_periodos_anteriores, [{ periodo: PERIODO_ANTERIOR, pedidos: 1 }]);
});

test('generar dos veces el mismo periodo no vuelve a facturar los mismos pedidos', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {});

  const primera = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(primera.total_facturas, 1);

  const segunda = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(segunda.total_facturas, 0, 'la marca del pedido es lo que impide el duplicado');
  assert.equal(db.listar(tables.facturas).length, 1);
});

test('un pedido cuyas líneas cambian entre el plan y el reclamo se descarta', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {});
  sembrarPedido(db, 'PED-2', {});
  // Alguien edita las líneas de PED-1 justo antes del reclamo: el contador sube.
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(tables.pedidos, pedido('PED-1', { lineas_rev: 2 }));
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.descartados.length, 1);
  assert.equal(r.descartados[0].pedido_id, 'PED-1');
  assert.equal(r.descartados[0].motivo, 'concurrencia');
  assert.equal(r.total_facturas, 1);
  assert.equal(r.facturas[0].num_pedidos, 1, 'la factura se rehace solo con lo reclamado');
  assert.equal(r.facturas[0].base, 100);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id, undefined);
});

/**
 * Las cuatro pruebas siguientes cubren la carrera que el contador de líneas no
 * ve: el `PUT` de pedidos puede corregir a quién se entregó o desde dónde se
 * sirvió un pedido **ya completado** sin tocar `CompletadoEn` ni `lineas_rev`, y
 * mientras no haya marca de factura devuelve 200 con razón. Si el reclamo no
 * condiciona sobre esos campos, la factura sale contra la sociedad equivocada.
 */

test('un pedido cuyo local cambia entre el plan y el reclamo se descarta', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { LocalId: '000010', factura_id_empresa_local: EMPRESA_NORTE });
  sembrarPedido(db, 'PED-2', { LocalId: '000020' });
  // Un encargado corrige el local de PED-1 a uno de otra sociedad. Su PUT
  // recongela la sociedad del local, como hace `pedidos.js` al completar.
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(
      tables.pedidos,
      pedido('PED-1', { LocalId: '000020', factura_id_empresa_local: EMPRESA_SUR })
    );
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.descartados.length, 1, 'sin condicionar el local, la factura saldría contra Norte');
  assert.equal(r.descartados[0].pedido_id, 'PED-1');
  assert.equal(r.descartados[0].motivo, 'concurrencia');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id, undefined);
  // La única factura escrita es la del pedido que nadie tocó.
  assert.equal(r.total_facturas, 1);
  assert.equal(r.facturas[0].id_empresa, EMPRESA_SUR);
  assert.equal(r.facturas[0].num_pedidos, 1);
});

test('un pedido cuyo almacén de origen cambia entre el plan y el reclamo se descarta', async () => {
  const db = baseGrupo(montarEscenario());
  // Sirve el Almacén General (emite la Central) y pasa a servirlo el almacén
  // propio del local Norte (emitiría Norte, que además se factura a sí misma).
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-GEN' });
  sembrarPedido(db, 'PED-2', { LocalId: '000020' });
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(tables.pedidos, pedido('PED-1', { AlmacenOrigenId: 'ALM-NORTE' }));
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.descartados.length, 1, 'el almacén decide la sociedad emisora');
  assert.equal(r.descartados[0].pedido_id, 'PED-1');
  assert.equal(r.descartados[0].motivo, 'concurrencia');
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id, undefined);
});

test('un pedido al que le aparece la sociedad congelada del local se descarta', async () => {
  const db = baseGrupo(montarEscenario());
  // Sin congelar: la receptora sale del maestro de locales. Si el PUT la congela
  // entre el plan y el reclamo, pasa a mandar ella y puede no ser la misma.
  sembrarPedido(db, 'PED-1', {});
  sembrarPedido(db, 'PED-2', { LocalId: '000020' });
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(tables.pedidos, pedido('PED-1', { factura_id_empresa_local: EMPRESA_SUR }));
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.descartados.length, 1, 'el campo ausente que aparece también cambia la factura');
  assert.equal(r.descartados[0].pedido_id, 'PED-1');
  assert.equal(r.descartados[0].motivo, 'concurrencia');
});

test('el reclamo condiciona sobre todos los campos que definen la factura', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { factura_id_empresa_local: EMPRESA_NORTE });
  let condicion = '';
  db.interceptar('UpdateCommand', tables.pedidos, (entrada) => {
    condicion = entrada.ConditionExpression;
  });

  await generarFacturacionVentasInternas({ periodo: PERIODO });

  // Esta prueba mira la expresión enviada, no solo el efecto: es la que nombra el
  // campo concreto que falta si alguien lo quita de la lista, en vez de dejar un
  // descarte que no se produce y una factura mal emitida en silencio.
  for (const campo of [
    'Estado',
    'CompletadoEn',
    'lineas_rev',
    'LocalId',
    'AlmacenOrigenId',
    'factura_id_empresa_local',
    'Tipo',
  ]) {
    assert.match(condicion, new RegExp(`\\b${campo}\\b`), `falta ${campo} en la condición del reclamo`);
  }
});

test('un cambio que no afecta a la factura no descarta el pedido', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {});
  // El almacén de destino no interviene en emisora, receptora, importes ni
  // sentido del documento: condicionarlo solo perdería facturación.
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(tables.pedidos, pedido('PED-1', { AlmacenDestinoId: 'ALM-OTRO', Notas: 'revisado' }));
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.descartados.length, 0);
  assert.equal(r.total_facturas, 1);
  assert.equal(r.parcial ?? false, false, 'y el periodo se cierra con normalidad');
});

test('un pedido marcado con una factura que ya no existe se libera y se vuelve a facturar', async () => {
  const db = baseGrupo(montarEscenario());
  const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  sembrarPedido(db, 'PED-1', {
    factura_ventas_id: 'FACTURA-QUE-NO-ESTA',
    factura_ventas_periodo: PERIODO,
    factura_ventas_fecha: hace2h,
    factura_ventas_ejecucion: 'ejecucion-anterior',
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.pedidos_liberados.length, 1);
  assert.equal(r.pedidos_liberados[0].pedido_id, 'PED-1');
  assert.equal(r.total_facturas, 1, 'liberado en el barrido, entra en la misma tanda');
  assert.notEqual(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id, 'FACTURA-QUE-NO-ESTA');
});

test('un pedido marcado con una factura que sí existe no se toca', async () => {
  const db = baseGrupo(montarEscenario());
  const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  db.sembrar(tables.facturas, { id_factura: 'FACTURA-VIVA', estado: 'emitida' });
  sembrarPedido(db, 'PED-1', {
    factura_ventas_id: 'FACTURA-VIVA',
    factura_ventas_periodo: PERIODO,
    factura_ventas_fecha: hace2h,
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.pedidos_liberados.length, 0);
  assert.equal(r.total_facturas, 0);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id, 'FACTURA-VIVA');
});

test('una factura por par de sociedades, agrupando los pedidos de varios locales', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.locales, local('000021', 'Bar Sur 2', EMPRESA_SUR));
  sembrarPedido(db, 'PED-1', { LocalId: '000020' });
  sembrarPedido(db, 'PED-2', { LocalId: '000021' });
  sembrarPedido(db, 'PED-3', { LocalId: '000010' });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 2, 'Central→Sur y Central→Norte');
  const aSur = r.facturas.find((f) => f.id_empresa === EMPRESA_SUR);
  assert.equal(aSur.num_pedidos, 2);
  assert.equal(aSur.base, 200);
  assert.equal(aSur.num_lineas, 2, 'una línea fiscal por cada pedido/albarán');
  assert.deepEqual(
    aSur.locales.map((l) => l.local_nombre),
    ['Bar Sur', 'Bar Sur 2'],
    'el desglose por local viaja en el detalle, no en las líneas fiscales'
  );
});

test('cada línea fiscal refleja el producto, el pedido y el local del albarán', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { LocalId: '000020' }, [
    { ProductId: 'P1', ProductoNombre: 'Aceite oliva', Cantidad: 3, TotalLinea: 30 },
  ]);

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  const [linea] = db.listar(tables.facturasLineas);
  assert.match(linea.descripcion, /Aceite oliva/);
  assert.match(linea.descripcion, /PED-1/);
  assert.match(linea.descripcion, /Bar Sur/);
  assert.equal(linea.cantidad, 3);
  assert.equal(linea.precio_unitario, 10);
  assert.equal(r.facturas[0].num_lineas, 1);
});

test('la base facturada cuadra con la suma en crudo de las líneas del pedido', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [
    { ProductId: 'P1', TotalLinea: 33.335 },
    { ProductId: 'P1', TotalLinea: 66.665 },
  ]);

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.facturas[0].base, 100.01, 'cada línea fiscal redondea por separado');
  assert.equal(r.facturas[0].base_informe, 100);
  assert.equal(r.facturas[0].descuadre_centimos, 1);
});

test('un descuadre de céntimos frente al informe se declara en vez de esconderse', async () => {
  const db = baseGrupo(montarEscenario());
  // Dos tipos de IVA: cada línea fiscal redondea por separado y la suma puede
  // separarse un céntimo del total en crudo que suma el informe de ventas.
  sembrarPedido(db, 'PED-1', {}, [
    { ProductId: 'P1', TotalLinea: 10.005 },
    { ProductId: 'P2', TotalLinea: 10.005 },
  ]);

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.facturas[0].base, 20.02);
  assert.equal(r.facturas[0].base_informe, 20.01);
  assert.equal(r.facturas[0].descuadre_centimos, 1);
});

test('un periodo mal escrito se rechaza sin tocar nada', async () => {
  baseGrupo(montarEscenario());
  const r = await generarFacturacionVentasInternas({ periodo: '2026-13' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('una serie inexistente aborta antes de reclamar ningún pedido', async () => {
  const db = baseGrupo(montarEscenario(), { ajustes: { serie_ventas: 'NO-EXISTE' } });
  sembrarPedido(db, 'PED-1', {});

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id, undefined);
});

test('una serie de gastos no sirve para facturar ventas internas', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.facturasSeries, serie('FMI', { tipo: 'IN' }));
  sembrarPedido(db, 'PED-1', {});

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.match(r.error, /gasto/);
});

test('al generar se deja constancia del periodo y de la auditoría de la factura', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {});

  await generarFacturacionVentasInternas({ periodo: PERIODO, usuario_nombre: 'Prueba' });
  const ajuste = db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' });
  assert.equal(ajuste.ultimo_periodo_generado, PERIODO);
  assert.equal(JSON.parse(ajuste.ultima_generacion_resumen).facturas, 1);

  const auditoria = db.listar(tables.facturasAuditoria);
  assert.equal(auditoria.length, 1);
  const detalle = JSON.parse(auditoria[0].detalle);
  assert.equal(detalle.periodo, PERIODO);
  assert.equal(detalle.origen, 'ventas_internas_manual');
  assert.equal(detalle.id_empresa_emisora, EMPRESA_CENTRAL);
});

test('el cerrojo queda liberado al terminar, para que la tanda siguiente pueda entrar', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {});
  await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion_lock' }), null);
});

// ─── Solo periodos cerrados ───

test('no se puede facturar el mes en curso', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { CompletadoEn: instante(PERIODO_EN_CURSO, 1, '09:00:00') });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO_EN_CURSO });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /periodos cerrados/);
  assert.equal(
    db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id,
    undefined,
    'no congela los pedidos del mes en marcha'
  );
});

test('la previsualización del mes en curso permite consultar el avance parcial', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { CompletadoEn: instante(PERIODO_EN_CURSO, 1, '09:00:00') });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO_EN_CURSO });
  assert.equal(r.ok, true);
  assert.equal(r.periodo, PERIODO_EN_CURSO);
});

// ─── Un fallo parcial no cierra el periodo ───

test('si una factura no se puede escribir, el periodo no se marca como generado', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {});
  // Throttling de DynamoDB al escribir la cabecera de la factura.
  db.interceptar('PutCommand', tables.facturas, () => {
    throw Object.assign(new Error('Throughput exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.ok, true, 'la tanda termina: el fallo es de un grupo, no del proceso');
  assert.equal(r.total_facturas, 0);
  assert.equal(r.errores.length, 1);
  assert.equal(r.parcial, true, 'el fallo parcial se declara en la respuesta');
  assert.equal(r.motivo_incompleto, 'errores_de_escritura');
  assert.equal(r.periodo_no_marcado, true);

  const ajuste = db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' });
  assert.equal(
    ajuste.ultimo_periodo_generado ?? '',
    '',
    'sin marcador, el trabajo programado vuelve a intentar el periodo'
  );
  assert.equal(
    db.obtener(tables.pedidos, { Id: 'PED-1' }).factura_ventas_id,
    undefined,
    'el pedido queda libre para la tanda siguiente'
  );
});

test('reintentar tras un fallo parcial factura lo que quedó fuera y ya cierra el periodo', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { LocalId: '000010' });
  sembrarPedido(db, 'PED-2', { LocalId: '000020' });
  // Solo el primer grupo falla: el gatillo se consume en la primera coincidencia.
  db.interceptar('PutCommand', tables.facturas, () => {
    throw Object.assign(new Error('Throughput exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
  });

  const primera = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(primera.total_facturas, 1, 'el otro par de sociedades sí se factura');
  assert.equal(primera.parcial, true);

  const segunda = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(segunda.total_facturas, 1, 'el reintento recoge solo lo que faltaba');
  assert.equal(segunda.parcial ?? false, false);
  assert.equal(db.listar(tables.facturas).length, 2, 'y no duplica la que sí se escribió');
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' }).ultimo_periodo_generado, PERIODO);
});

test('un pedido descartado por concurrencia deja el periodo sin cerrar', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {});
  sembrarPedido(db, 'PED-2', {});
  db.interceptar('UpdateCommand', tables.pedidos, () => {
    db.sembrar(tables.pedidos, pedido('PED-1', { lineas_rev: 2 }));
  });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.parcial, true, 'un pedido que debía facturarse y no se facturó deja el mes abierto');
  assert.equal(r.motivo_incompleto, 'elementos_descartados');
  const ajuste = db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' });
  assert.equal(ajuste.ultimo_periodo_generado ?? '', '');
});

test('los excluidos no dejan el periodo abierto: son datos, no fallos de la tanda', async () => {
  const db = baseGrupo(montarEscenario());
  // Un local sin sociedad asignada se excluye siempre: si eso bloqueara el
  // marcador, el periodo no se cerraría nunca y el trabajo lo reintentaría a diario.
  db.sembrar(tables.locales, local('000030', 'Bar Sin Sociedad', ''));
  sembrarPedido(db, 'PED-1', { LocalId: '000030' });
  sembrarPedido(db, 'PED-2', { LocalId: '000010' });

  const r = await generarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.excluidos.length, 1);
  assert.equal(r.parcial ?? false, false);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' }).ultimo_periodo_generado, PERIODO);
});

// ─── Atribución del almacén a su local ───

test('un almacén que el local declara con nombre parcial ya no se atribuye por parecido', async () => {
  const db = baseGrupo(montarEscenario());
  // El caso real: el maestro tiene "ALMACEN GENERAL NEPTUNO" y el local de la
  // distribuidora declara "Almacen General". Por inclusión se atribuía a esa
  // sociedad y la factura salía a nombre de quien no sirvió la mercancía.
  db.sembrar(tables.almacenes, almacen('ALM-NEPTUNO', 'ALMACEN GENERAL NEPTUNO'));
  db.sembrar(tables.locales, local('000040', 'Distribuidora', EMPRESA_SUR, ['Almacen General']));
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-NEPTUNO', LocalId: '000010' });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0, 'no se factura a nombre de una sociedad conjeturada');
  assert.equal(r.excluidos[0].motivo, 'almacen_no_atribuible');
  assert.match(r.excluidos[0].detalle, /Distribuidora/, 'pero se dice a quién se parecía');
  assert.match(r.excluidos[0].detalle, /no se atribuye por/);
});

test('un almacén cuyo nombre coincide exacto con el del local sí se atribuye', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-NORTE', LocalId: '000020' });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.facturas[0].id_empresa_emisora, EMPRESA_NORTE);
});

test('un almacén que nadie declara se excluye sin proponer ningún candidato', async () => {
  const db = baseGrupo(montarEscenario());
  db.sembrar(tables.almacenes, almacen('ALM-HUERFANO', 'Almacen Malagrana'));
  sembrarPedido(db, 'PED-1', { AlmacenOrigenId: 'ALM-HUERFANO' });

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.excluidos[0].motivo, 'almacen_no_atribuible');
  assert.doesNotMatch(r.excluidos[0].detalle, /se parece|encajaría/);
});

// ─── Líneas con importe imposible ───

test('una línea con importe negativo excluye el pedido en vez de facturar de menos', async () => {
  const db = baseGrupo(montarEscenario());
  // El sentido de un movimiento lo lleva el Tipo del pedido, no el signo de la
  // línea: ignorarla dejaba de cobrar mercancía realmente servida.
  sembrarPedido(db, 'PED-1', {}, [
    { ProductId: 'P1', TotalLinea: 100 },
    { ProductId: 'P1', TotalLinea: -30 },
  ]);

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.excluidos[0].motivo, 'linea_importe_negativo');
  assert.match(r.excluidos[0].detalle, /TotalLinea negativo/);
});

test('una línea a cero se sigue ignorando sin excluir el pedido', async () => {
  const db = baseGrupo(montarEscenario());
  sembrarPedido(db, 'PED-1', {}, [
    { ProductId: 'P1', TotalLinea: 100 },
    { ProductId: 'P1', TotalLinea: 0 },
  ]);

  const r = await previsualizarFacturacionVentasInternas({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.facturas[0].base, 100);
});
