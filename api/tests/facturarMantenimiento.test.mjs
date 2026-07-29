/**
 * Regresión de la facturación de mantenimiento.
 *
 * No pretende cubrir todo ese dominio: existe porque la facturación de ventas
 * internas obligó a tocar el motor compartido (`facturacionPeriodica.js`) y hay
 * que demostrar que lo que ya funcionaba sigue funcionando igual. Cubre lo que
 * los cambios podían romper: la lectura de ajustes (ahora con nombre de campo de
 * serie configurable), los datos fiscales de las sociedades (ahora compartidos)
 * y el recorrido completo de generar una factura.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

const {
  montarEscenario,
  tables,
  empresa,
  local,
  serie,
  PERIODO,
  PERIODO_SIGUIENTE,
  PERIODO_EN_CURSO,
  dia,
  ultimoDia,
} = await import('./escenarioFacturacion.mjs');

const {
  previsualizarFacturacionMantenimiento,
  generarFacturacionMantenimiento,
  leerAjustesFacturacion,
  ID_EMPRESA_EMISORA_DEFECTO,
  SERIE_DEFECTO,
} = await import('../lib/facturacion/facturarMantenimiento.js');

const EMISORA = '000359';
const RECEPTORA = '000002';

function baseMantenimiento(db, { ajustes } = {}) {
  db.sembrar(tables.empresas, empresa(EMISORA, 'Demanda y Servicios'));
  db.sembrar(tables.empresas, empresa(RECEPTORA, 'Norte'));
  db.sembrar(tables.locales, local('000010', 'Bar Norte', RECEPTORA));
  db.sembrar(tables.facturasSeries, serie('FMANT'));
  db.sembrar(tables.ajustes, {
    PK: 'mantenimiento',
    SK: 'facturacion',
    id_empresa_emisora: EMISORA,
    serie: 'FMANT',
    dia_generacion: 1,
    hora: '06:00',
    condiciones_pago: '',
    Enabled: false,
    ...ajustes,
  });
  return db;
}

function parte(sk, campos = {}) {
  return {
    PK: 'LOCAL#000010',
    SK: sk,
    local_id: '000010',
    id_incidencia: sk.replace('INC#', ''),
    titulo: 'Cambiar grifo',
    EstadoValoracion: 'Valorado',
    fecha_programada: dia(PERIODO, 10),
    fecha_valoracion: dia(PERIODO, 12),
    valoracion_rev: 1,
    valoracion_total: 121,
    valoracion_lineas: [{ articulo: 'Grifo', cantidad: 1, precio: 100, tipo_iva: 21 }],
    ...campos,
  };
}

test('la configuración sigue leyéndose del campo "serie" pese al campo configurable', async () => {
  baseMantenimiento(montarEscenario());
  const ajustes = await leerAjustesFacturacion();
  assert.equal(ajustes.serie, 'FMANT');
  assert.equal(ajustes.id_empresa_emisora, EMISORA);
  assert.equal(ajustes.enabled, false);
});

test('sin ítem de configuración se usan los valores por defecto', async () => {
  const db = montarEscenario();
  db.sembrar(tables.empresas, empresa(EMISORA, 'Demanda y Servicios'));
  const ajustes = await leerAjustesFacturacion();
  assert.equal(ajustes.serie, SERIE_DEFECTO);
  assert.equal(ajustes.id_empresa_emisora, ID_EMPRESA_EMISORA_DEFECTO);
  assert.equal(ajustes.enabled, false, 'la generación automática nunca nace activada');
});

test('genera la factura de la sociedad del local con sus datos fiscales completos', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1'));

  const r = await generarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(r.ok, true);
  assert.equal(r.total_facturas, 1);
  assert.equal(r.total_partes, 1);
  assert.equal(r.facturas[0].id_empresa, RECEPTORA);
  assert.equal(r.facturas[0].total, 121);

  const [factura] = db.listar(tables.facturas);
  assert.equal(factura.estado, 'borrador');
  assert.equal(factura.fecha_emision, ultimoDia(PERIODO));
  assert.equal(factura.emisor_id, EMISORA);
  // Los datos fiscales los aporta ahora el helper compartido del motor: si se
  // perdieran, la factura saldría sin domicilio y nadie lo detectaría.
  assert.equal(factura.emisor_cif, `B${EMISORA}000`);
  assert.equal(factura.emisor_municipio, 'Madrid');
  assert.equal(factura.empresa_cif, `B${RECEPTORA}000`);
  assert.equal(factura.empresa_direccion, 'Calle Norte 1');

  const marcado = db.obtener(tables.mantenimiento, { PK: 'LOCAL#000010', SK: 'INC#1' });
  assert.equal(marcado.factura_mantenimiento_id, factura.id_factura);
  assert.equal(marcado.factura_mantenimiento_periodo, PERIODO);
});

test('no vuelve a facturar un parte ya facturado', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1'));

  await generarFacturacionMantenimiento({ periodo: PERIODO });
  const segunda = await generarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(segunda.total_facturas, 0);
  assert.equal(db.listar(tables.facturas).length, 1);
});

test('la previsualización no escribe nada', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1'));

  const r = await previsualizarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.total_partes, 1);
  assert.equal(db.listar(tables.facturas).length, 0);
  assert.equal(db.obtener(tables.mantenimiento, { PK: 'LOCAL#000010', SK: 'INC#1' }).factura_mantenimiento_id, undefined);
});

test('un local de la propia sociedad emisora se cierra sin factura', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.locales, local('000010', 'Bar Central', EMISORA));
  db.sembrar(tables.mantenimiento, parte('INC#1'));

  const r = await generarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.cerrados_sin_factura.length, 1);
  const cerrado = db.obtener(tables.mantenimiento, { PK: 'LOCAL#000010', SK: 'INC#1' });
  assert.equal(cerrado.factura_mantenimiento_cierre, 'sociedad_emisora');
  assert.equal(cerrado.factura_mantenimiento_id, undefined);
});

test('un parte valorado después del corte entra en el periodo siguiente', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1', { fecha_valoracion: dia(PERIODO_SIGUIENTE, 2) }));

  const suyo = await previsualizarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(suyo.total_facturas, 0);
  const siguiente = await previsualizarFacturacionMantenimiento({ periodo: PERIODO_SIGUIENTE });
  assert.equal(siguiente.total_facturas, 1);
});

test('el mantenimiento tampoco factura el mes en curso', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1', { fecha_valoracion: dia(PERIODO_EN_CURSO, 2) }));

  const r = await generarFacturacionMantenimiento({ periodo: PERIODO_EN_CURSO });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /periodos cerrados/);
  const parteGuardado = db.obtener(tables.mantenimiento, { PK: 'LOCAL#000010', SK: 'INC#1' });
  assert.equal(parteGuardado.factura_mantenimiento_id, undefined, 'no reclama nada del mes en marcha');
});

test('un periodo cerrado que se factura entero sí deja marcador', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1'));

  const r = await generarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(r.total_facturas, 1);
  assert.equal(r.parcial ?? false, false);
  assert.equal(db.obtener(tables.ajustes, { PK: 'mantenimiento', SK: 'facturacion' }).ultimo_periodo_generado, PERIODO);
});

test('si la factura de mantenimiento no se puede escribir, el periodo queda abierto', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1'));
  db.interceptar('PutCommand', tables.facturas, () => {
    throw Object.assign(new Error('Throughput exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    });
  });

  const r = await generarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(r.total_facturas, 0);
  assert.equal(r.parcial, true);
  assert.equal(r.motivo_incompleto, 'errores_de_escritura');
  const ajuste = db.obtener(tables.ajustes, { PK: 'mantenimiento', SK: 'facturacion' });
  assert.equal(ajuste.ultimo_periodo_generado ?? '', '');
  const parteGuardado = db.obtener(tables.mantenimiento, { PK: 'LOCAL#000010', SK: 'INC#1' });
  assert.equal(parteGuardado.factura_mantenimiento_id, undefined, 'el parte queda libre');
});

test('los dos dominios tienen cerrojos independientes y no se estorban', async () => {
  const db = baseMantenimiento(montarEscenario());
  db.sembrar(tables.mantenimiento, parte('INC#1'));
  await generarFacturacionMantenimiento({ periodo: PERIODO });
  assert.equal(db.obtener(tables.ajustes, { PK: 'mantenimiento', SK: 'facturacion_lock' }), null);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion_lock' }), null);
});
