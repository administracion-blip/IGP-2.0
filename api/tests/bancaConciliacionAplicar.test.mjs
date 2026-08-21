/**
 * Aplicar y deshacer conciliaciones bancarias.
 *
 * Dos niveles, como en `bancaIngesta.test.mjs`:
 *
 * 1) La lógica pura —validación de asignaciones, estado resultante del
 *    movimiento, fusión de conciliaciones— sin nada montado.
 * 2) La orquestación (`aplicarConciliacion`, `deshacerConciliacion`) contra
 *    dobles inyectados por `deps`: así se prueban los fallos parciales y la
 *    idempotencia sin AWS y sin express.
 *
 * Al final hay un bloque que sí toca el doble en memoria de DynamoDB, solo para
 * fijar que el pago guarda la trazabilidad inversa hacia el movimiento.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  aplicarConciliacion,
  claveIdempotencia,
  descartarSugerenciaMovimiento,
  deshacerConciliacion,
  ignorarMovimiento,
} from '../lib/banca/conciliacion/aplicar.js';
import {
  derivarEstado,
  euroACentimos,
  fusionarConciliaciones,
  quitarConciliacion,
  validarAsignaciones,
} from '../lib/banca/conciliacion/estado.js';
import { facturaEmisorPermitido } from '../lib/usuarioLocales.js';

const IBAN = 'ES9121000418450200051332';
const HASH = 'huella-1';

function movimiento({ centimos = -48400, conciliadoCentimos = 0, estadoConciliacion = 'pendiente', conciliaciones } = {}) {
  return {
    PK: `ACCOUNT#${IBAN}`,
    SK: `TXN#2026-07-14#${HASH}`,
    movementHash: HASH,
    cuentaRef: IBAN,
    empresaId: '000007',
    fechaOperacion: '2026-07-14',
    importe: centimos / 100,
    importeCentimos: centimos,
    signo: centimos < 0 ? 'D' : 'H',
    concepto: 'ADEUDO COCTEMATIAS SL B12345678',
    conceptoNormalizado: 'COCTEMATIAS SL B12345678',
    nif: 'B12345678',
    referencia1: 'REF-1',
    estadoConciliacion,
    conciliadoCentimos,
    ...(conciliaciones ? { conciliaciones } : {}),
  };
}

function factura({ id = 'F1', saldo = 484, estado = 'pendiente_pago', tipo = 'IN' } = {}) {
  return {
    id_factura: id,
    tipo,
    estado,
    emisor_id: '000007',
    empresa_nombre: 'COCTEMATIAS SL',
    empresa_cif: 'B12345678',
    total_factura: saldo,
    total_cobrado: 0,
    saldo_pendiente: saldo,
  };
}

/** Error de DynamoDB cuando falla la `ConditionExpression`. */
function errorDeCondicion() {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
    $metadata: { httpStatusCode: 400 },
  });
}

/**
 * Dobles de las dependencias de entrada/salida. `registrarPago` imita lo que
 * importa de `registrarPagoFactura`: numera los pagos, respeta la clave de
 * idempotencia y recalcula el saldo.
 *
 * El almacén del movimiento aplica de verdad la condición sobre
 * `conciliadoCentimos`, como el `UpdateCommand` real: así la carrera se prueba
 * por su mecanismo y no por un contador de "falla la primera vez".
 *
 * @param {object} [opciones]
 * @param {Record<string, object>} [opciones.remesas] Remesa activa por id de factura.
 * @param {(intento: number, otroProceso: (conciliaciones: object[]) => void) => void} [opciones.alGuardar]
 *   Se llama antes de cada intento de escritura. Con `otroProceso` el test simula
 *   a alguien que escribe el movimiento justo en medio.
 */
function dobles({ mov, facturas = [], fallos = {}, remesas = {}, alGuardar } = {}) {
  const porId = new Map(facturas.map((f) => [f.id_factura, structuredClone(f)]));
  const pagos = [];
  const guardados = [];
  const conflictos = [];
  const intentos = { guardar: 0, estado: 0 };
  let actual = structuredClone(mov);

  function suma(conciliaciones) {
    return (conciliaciones || []).reduce((acc, c) => acc + Math.max(0, Math.trunc(Number(c.importeCentimos) || 0)), 0);
  }

  /** Escritura de otra sesión: deja el movimiento como lo dejaría ella. */
  function otroProceso(conciliaciones) {
    const total = suma(conciliaciones);
    actual = {
      ...actual,
      conciliaciones,
      conciliadoCentimos: total,
      estadoConciliacion: derivarEstado({ importeCentimos: actual.importeCentimos, asignadoCentimos: total }),
    };
  }

  function comprobarCondicion(esperadoCentimos) {
    if (esperadoCentimos == null) return;
    const guardado = Math.trunc(Number(actual.conciliadoCentimos) || 0);
    const esperado = Math.trunc(Number(esperadoCentimos) || 0);
    if (guardado !== esperado) {
      conflictos.push({ esperado, guardado });
      throw errorDeCondicion();
    }
  }

  return {
    pagos,
    guardados,
    conflictos,
    intentos,
    facturas: porId,
    otroProceso,
    get movimiento() {
      return actual;
    },
    deps: {
      async getMovimiento(cuentaRef, movementHash) {
        if (cuentaRef !== IBAN || movementHash !== HASH) return null;
        return structuredClone(actual);
      },
      async getFactura(id) {
        const f = porId.get(id);
        return f ? structuredClone(f) : null;
      },
      async buscarRemesaActiva(id) {
        return remesas[id] || null;
      },
      async registrarPago(opts) {
        const fallo = fallos[opts.id_factura];
        if (fallo) throw Object.assign(new Error(fallo.mensaje), fallo);

        const previo = pagos.find((p) => p.idempotency_key === opts.idempotencyKey);
        if (previo) {
          return { ok: true, pago: previo, factura: porId.get(opts.id_factura), idempotent: true };
        }
        const f = porId.get(opts.id_factura);
        const cobrado = Math.round(((f.total_cobrado || 0) + Number(opts.importe)) * 100) / 100;
        f.total_cobrado = cobrado;
        f.saldo_pendiente = Math.round((f.total_factura - cobrado) * 100) / 100;
        f.estado = f.saldo_pendiente <= 0 ? 'pagada' : 'parcialmente_pagada';

        const pago = {
          id_factura: opts.id_factura,
          id_pago: `P${String(pagos.filter((p) => p.id_factura === opts.id_factura).length + 1).padStart(3, '0')}`,
          fecha: opts.fecha,
          importe: Number(opts.importe),
          metodo_pago: opts.metodo_pago,
          referencia: opts.referencia,
          observaciones: opts.observaciones,
          idempotency_key: opts.idempotencyKey,
          banca_movement_hash: opts.banca_movement_hash,
          banca_cuenta_ref: opts.banca_cuenta_ref,
        };
        pagos.push(pago);
        return { ok: true, pago, factura: structuredClone(f) };
      },
      async eliminarPago({ id_factura, id_pago }) {
        const i = pagos.findIndex((p) => p.id_factura === id_factura && p.id_pago === id_pago);
        if (i < 0) throw Object.assign(new Error('Pago no encontrado'), { status: 404 });
        const [pago] = pagos.splice(i, 1);
        const f = porId.get(id_factura);
        const cobrado = Math.round(((f.total_cobrado || 0) - pago.importe) * 100) / 100;
        f.total_cobrado = Math.max(0, cobrado);
        f.saldo_pendiente = Math.round((f.total_factura - f.total_cobrado) * 100) / 100;
        f.estado = f.total_cobrado <= 0 ? 'pendiente_pago' : 'parcialmente_pagada';
        return { ok: true, factura: structuredClone(f), pago };
      },
      async guardarConciliacion({ conciliaciones, conciliadoCentimos, estadoConciliacion, esperadoCentimos }) {
        intentos.guardar += 1;
        if (alGuardar) alGuardar(intentos.guardar, otroProceso);
        comprobarCondicion(esperadoCentimos);
        guardados.push({ conciliaciones, conciliadoCentimos, estadoConciliacion });
        actual = { ...actual, conciliaciones, conciliadoCentimos, estadoConciliacion };
        return structuredClone(actual);
      },
      async guardarEstadoMovimiento({ estadoConciliacion, esperadoCentimos }) {
        intentos.estado += 1;
        if (alGuardar) alGuardar(intentos.estado, otroProceso);
        comprobarCondicion(esperadoCentimos);
        guardados.push({ estadoConciliacion });
        actual = { ...actual, estadoConciliacion };
        return structuredClone(actual);
      },
      async descartarSugerencia({ idFactura }) {
        const previas = actual.sugerenciasDescartadas || [];
        if (previas.includes(idFactura)) return { yaEstaba: true, descartadas: previas };
        const descartadas = [...previas, idFactura];
        actual = { ...actual, sugerenciasDescartadas: descartadas };
        return { yaEstaba: false, descartadas };
      },
    },
  };
}

const usuario = { id: 'U-1', nombre: 'Jefe' };

/**
 * Envuelve `getFactura` igual que el router: una factura de una sociedad a la que
 * el usuario no tiene acceso no existe para él.
 */
function conAlcance(deps, empresasPermitidas) {
  const permitidas = new Set(empresasPermitidas);
  return {
    ...deps,
    async getFactura(id) {
      const f = await deps.getFactura(id);
      return f && facturaEmisorPermitido(f, permitidas) ? f : null;
    },
  };
}

/** Factura de otra sociedad del grupo, fuera del alcance del usuario de prueba. */
function facturaAjena(campos = {}) {
  return { ...factura(campos), emisor_id: '000099' };
}

// ─── Lógica pura ───

test('el estado del movimiento se deriva de lo asignado', () => {
  assert.equal(derivarEstado({ importeCentimos: -48400, asignadoCentimos: 0 }), 'pendiente');
  assert.equal(derivarEstado({ importeCentimos: -48400, asignadoCentimos: 20000 }), 'parcial');
  assert.equal(derivarEstado({ importeCentimos: -48400, asignadoCentimos: 48400 }), 'conciliado');
  // El signo del movimiento no cambia el estado: se compara en valor absoluto.
  assert.equal(derivarEstado({ importeCentimos: 48400, asignadoCentimos: 48400 }), 'conciliado');
  // Un céntimo de resto se da por conciliado: es un redondeo, no una deuda.
  assert.equal(derivarEstado({ importeCentimos: -48400, asignadoCentimos: 48399 }), 'conciliado');
  assert.equal(derivarEstado({ importeCentimos: -48400, asignadoCentimos: 48398 }), 'parcial');
  // `ignorado` lo pone el usuario y manda sobre el cálculo.
  assert.equal(derivarEstado({ importeCentimos: -48400, asignadoCentimos: 0, ignorado: true }), 'ignorado');
});

test('la validación de asignaciones rechaza lo que no cuadra', () => {
  const mov = movimiento({ centimos: -48400 });
  const facturas = new Map([
    ['F1', factura({ id: 'F1', saldo: 484 })],
    ['F2', factura({ id: 'F2', saldo: 100 })],
    ['F-BORRADOR', factura({ id: 'F-BORRADOR', saldo: 500, estado: 'borrador' })],
  ]);

  const ok = validarAsignaciones({ movimiento: mov, asignaciones: [{ id_factura: 'F1', importe: 484 }], facturas });
  assert.equal(ok.ok, true);
  assert.equal(ok.sumaCentimos, 48400);
  assert.equal(ok.asignaciones[0].centimos, 48400);

  const codigos = (asignaciones) => validarAsignaciones({ movimiento: mov, asignaciones, facturas })
    .errores.map((e) => e.code);

  assert.deepEqual(codigos([]), ['SIN_ASIGNACIONES']);
  assert.deepEqual(codigos([{ id_factura: 'F-NO-EXISTE', importe: 10 }]), ['FACTURA_NO_ENCONTRADA']);
  assert.deepEqual(codigos([{ id_factura: 'F1', importe: 0 }]), ['IMPORTE_INVALIDO']);
  assert.deepEqual(codigos([{ id_factura: 'F1', importe: -5 }]), ['IMPORTE_INVALIDO']);
  assert.deepEqual(codigos([{ id_factura: 'F-BORRADOR', importe: 10 }]), ['ESTADO_NO_CONCILIABLE']);
  assert.deepEqual(codigos([{ id_factura: 'F2', importe: 200 }]), ['IMPORTE_SUPERA_SALDO']);
  assert.deepEqual(
    codigos([{ id_factura: 'F1', importe: 100 }, { id_factura: 'F1', importe: 100 }]),
    ['FACTURA_DUPLICADA'],
  );
  // La suma no puede pasarse del importe libre del movimiento.
  assert.deepEqual(
    codigos([{ id_factura: 'F1', importe: 484 }, { id_factura: 'F2', importe: 100 }]),
    ['SUMA_SUPERA_CONCILIABLE'],
  );

  // Sobre un movimiento a medias, el tope es lo que queda libre.
  const aMedias = movimiento({ centimos: -48400, conciliadoCentimos: 44000, estadoConciliacion: 'parcial' });
  const apurado = validarAsignaciones({
    movimiento: aMedias,
    asignaciones: [{ id_factura: 'F2', importe: 44 }],
    facturas,
  });
  assert.equal(apurado.conciliableCentimos, 4400);
  assert.equal(apurado.ok, true);
  assert.equal(
    validarAsignaciones({ movimiento: aMedias, asignaciones: [{ id_factura: 'F2', importe: 45 }], facturas })
      .errores.map((e) => e.code)[0],
    'SUMA_SUPERA_CONCILIABLE',
  );
});

test('la validación avisa (sin bloquear) de pendiente_revision', () => {
  const mov = movimiento({ centimos: -48400 });
  const facturas = new Map([['F1', factura({ id: 'F1', estado: 'pendiente_revision' })]]);
  const revision = validarAsignaciones({ movimiento: mov, asignaciones: [{ id_factura: 'F1', importe: 484 }], facturas });
  assert.equal(revision.ok, true, 'pendiente_revision se permite: es decisión de negocio');
  assert.deepEqual(revision.avisos.map((a) => a.code), ['FACTURA_PENDIENTE_REVISION']);
});

test('un abono no puede pagar una factura de gasto ni un cargo cobrar una de venta', () => {
  // Por la interfaz no se llega —el motor filtra por signo—, pero una llamada
  // directa al endpoint sí, y registrar ese pago mueve el saldo de la factura en
  // el sentido contrario al del dinero.
  const abono = movimiento({ centimos: 48400 });
  const gasto = new Map([['F1', factura({ id: 'F1', tipo: 'IN' })]]);
  const alRevés = validarAsignaciones({ movimiento: abono, asignaciones: [{ id_factura: 'F1', importe: 484 }], facturas: gasto });
  assert.equal(alRevés.ok, false);
  assert.deepEqual(alRevés.errores.map((e) => e.code), ['SIGNO_INCOMPATIBLE']);

  const cargo = movimiento({ centimos: -48400 });
  const venta = new Map([['F1', factura({ id: 'F1', tipo: 'OUT' })]]);
  const alRevésVenta = validarAsignaciones({ movimiento: cargo, asignaciones: [{ id_factura: 'F1', importe: 484 }], facturas: venta });
  assert.equal(alRevésVenta.ok, false);
  assert.deepEqual(alRevésVenta.errores.map((e) => e.code), ['SIGNO_INCOMPATIBLE']);

  // Y con el signo bueno pasa: la factura de venta se cobra con el abono.
  const bien = validarAsignaciones({ movimiento: abono, asignaciones: [{ id_factura: 'F1', importe: 484 }], facturas: venta });
  assert.equal(bien.ok, true);
});

test('las conciliaciones se fusionan por factura+pago y el total se recalcula del array', () => {
  const previas = [{ id_factura: 'F1', id_pago: 'P001', importeCentimos: 10000 }];
  const fusion = fusionarConciliaciones(previas, [
    // Reintento del mismo pago: no puede contar dos veces.
    { id_factura: 'F1', id_pago: 'P001', importeCentimos: 10000 },
    { id_factura: 'F2', id_pago: 'P001', importeCentimos: 5000 },
  ]);
  assert.equal(fusion.conciliaciones.length, 2);
  assert.equal(fusion.asignadoCentimos, 15000);
  assert.deepEqual(fusion.anadidas.map((a) => a.id_factura), ['F2']);

  const resto = quitarConciliacion(fusion.conciliaciones, { id_factura: 'F1', id_pago: 'P001' });
  assert.equal(resto.conciliaciones.length, 1);
  assert.equal(resto.asignadoCentimos, 5000);
  assert.equal(resto.quitadas.length, 1);
});

// ─── Orquestación ───

test('aplicar una asignación crea el pago, marca el movimiento y deja trazabilidad', async () => {
  const doble = dobles({ mov: movimiento(), facturas: [factura({ id: 'F1', saldo: 484 })] });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, true);
  assert.equal(resultado.code, 'OK');
  assert.equal(resultado.aplicadas.length, 1);
  assert.equal(resultado.fallidas.length, 0);
  assert.equal(resultado.aplicadas[0].id_pago, 'P001');
  assert.equal(resultado.aplicadas[0].estadoFactura, 'pagada');
  assert.equal(resultado.movimiento.estadoConciliacion, 'conciliado');
  assert.equal(resultado.movimiento.conciliadoCentimos, 48400);
  assert.equal(resultado.movimiento.libreCentimos, 0);

  const [pago] = doble.pagos;
  assert.equal(pago.idempotency_key, `banca:${HASH}:F1`);
  assert.equal(pago.idempotency_key, claveIdempotencia(HASH, 'F1'));
  assert.equal(pago.banca_movement_hash, HASH);
  assert.equal(pago.banca_cuenta_ref, IBAN);
  // Sin fecha en la petición se usa la del movimiento, no la de hoy.
  assert.equal(pago.fecha, '2026-07-14');
  assert.equal(pago.metodo_pago, 'transferencia');
  assert.match(pago.observaciones, /Conciliación bancaria 2026-07-14/);
});

test('aplicar dos veces el mismo movimiento a la misma factura no duplica nada', async () => {
  const doble = dobles({ mov: movimiento(), facturas: [factura({ id: 'F1', saldo: 484 })] });
  const peticion = {
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  };

  await aplicarConciliacion(peticion, doble.deps);
  const segunda = await aplicarConciliacion(peticion, doble.deps);

  assert.equal(segunda.ok, true);
  assert.equal(segunda.aplicadas[0].idempotente, true);
  assert.equal(doble.pagos.length, 1, 'no debe crearse un segundo pago');
  assert.equal(segunda.movimiento.conciliadoCentimos, 48400, 'el asignado no se duplica');
  assert.equal(segunda.movimiento.conciliaciones.length, 1);
});

test('un movimiento se puede repartir entre varias facturas y quedar parcial', async () => {
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F1', saldo: 400 }), factura({ id: 'F2', saldo: 300 })],
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 400 }, { id_factura: 'F2', importe: 300 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, true);
  assert.equal(resultado.aplicadas.length, 2);
  assert.equal(resultado.movimiento.estadoConciliacion, 'parcial');
  assert.equal(resultado.movimiento.conciliadoCentimos, 70000);
  assert.equal(resultado.movimiento.libreCentimos, 30000);

  // El resto se puede aplicar después: el tope es lo que quedaba libre.
  const resto = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F3', importe: 300 }],
    usuario,
  }, doble.deps);
  assert.equal(resto.code, 'VALIDACION');
  assert.deepEqual(resto.errores.map((e) => e.code), ['FACTURA_NO_ENCONTRADA']);
});

test('si una asignación falla se aplica el resto y se dice qué falló', async () => {
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F1', saldo: 400 }), factura({ id: 'F-REMESA', saldo: 600 })],
    fallos: {
      'F-REMESA': {
        status: 409,
        code: 'FACTURA_EN_REMESA',
        mensaje: 'Esta factura está en la remesa «Julio»',
        remesaActiva: { remesaId: 'REM-1', nombre: 'Julio', estado: 'Generada' },
      },
    },
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 400 }, { id_factura: 'F-REMESA', importe: 600 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, false);
  assert.equal(resultado.code, 'PARCIAL');
  assert.deepEqual(resultado.aplicadas.map((a) => a.id_factura), ['F1']);
  assert.equal(resultado.fallidas[0].code, 'FACTURA_EN_REMESA');
  assert.equal(resultado.fallidas[0].remesaActiva.remesaId, 'REM-1');
  // El movimiento queda con el estado de lo que SÍ se aplicó, no a medio camino.
  assert.equal(resultado.movimiento.estadoConciliacion, 'parcial');
  assert.equal(resultado.movimiento.conciliadoCentimos, 40000);
  assert.equal(doble.pagos.length, 1);
});

test('reintentar la misma petición tras un fallo parcial aplica solo lo que faltaba', async () => {
  const fallos = {
    'F-REMESA': { status: 409, code: 'FACTURA_EN_REMESA', mensaje: 'Esta factura está en la remesa «Julio»' },
  };
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F1', saldo: 400 }), factura({ id: 'F-REMESA', saldo: 600 })],
    fallos,
  });
  const peticion = {
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 400 }, { id_factura: 'F-REMESA', importe: 600 }],
    usuario,
  };

  const primera = await aplicarConciliacion(peticion, doble.deps);
  assert.equal(primera.code, 'PARCIAL');

  // Se saca la factura de la remesa y se reintenta la MISMA petición: la parte
  // ya aplicada no puede tumbar la validación (su factura ya no tiene saldo y su
  // importe ya no está libre en el movimiento).
  delete fallos['F-REMESA'];
  const segunda = await aplicarConciliacion(peticion, doble.deps);

  assert.equal(segunda.code, 'OK', JSON.stringify(segunda.errores || segunda.fallidas));
  assert.equal(segunda.aplicadas.length, 2);
  assert.equal(segunda.aplicadas.find((a) => a.id_factura === 'F1').idempotente, true);
  assert.equal(segunda.aplicadas.find((a) => a.id_factura === 'F-REMESA').idempotente, false);
  assert.equal(segunda.movimiento.estadoConciliacion, 'conciliado');
  assert.equal(segunda.movimiento.conciliadoCentimos, 100000);
  assert.equal(doble.pagos.length, 2, 'un pago por factura, sin duplicados');
});

test('cambiar el importe de una asignación ya aplicada avisa en vez de romper', async () => {
  const doble = dobles({ mov: movimiento({ centimos: -100000 }), facturas: [factura({ id: 'F1', saldo: 1000 })] });
  await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 400 }],
    usuario,
  }, doble.deps);

  const otroImporte = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 600 }],
    usuario,
  }, doble.deps);

  assert.equal(otroImporte.ok, true);
  assert.deepEqual(otroImporte.avisos.map((a) => a.code), ['ASIGNACION_YA_APLICADA']);
  assert.equal(otroImporte.movimiento.conciliadoCentimos, 40000, 'manda el importe ya aplicado');
  assert.equal(doble.pagos.length, 1);
});

test('si falla todo, el movimiento no se toca', async () => {
  const doble = dobles({
    mov: movimiento(),
    facturas: [factura({ id: 'F1', saldo: 484 })],
    fallos: { F1: { status: 409, code: 'FACTURA_EN_REMESA', mensaje: 'En remesa' } },
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.code, 'NADA_APLICADO');
  assert.equal(resultado.aplicadas.length, 0);
  assert.equal(doble.guardados.length, 0, 'no debe escribirse el movimiento');
  assert.equal(doble.movimiento.estadoConciliacion, 'pendiente');
});

test('no se puede conciliar un movimiento inexistente ni uno ignorado', async () => {
  const doble = dobles({ mov: movimiento({ estadoConciliacion: 'ignorado' }), facturas: [factura({})] });

  const ignorado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  }, doble.deps);
  assert.equal(ignorado.code, 'MOVIMIENTO_IGNORADO');

  const inexistente = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: 'otra-huella',
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  }, doble.deps);
  assert.equal(inexistente.code, 'MOVIMIENTO_NO_ENCONTRADO');
});

test('deshacer borra el pago y devuelve el importe al movimiento', async () => {
  const doble = dobles({ mov: movimiento(), facturas: [factura({ id: 'F1', saldo: 484 })] });
  await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  }, doble.deps);

  const resultado = await deshacerConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    id_factura: 'F1',
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, true);
  assert.equal(resultado.deshecha.id_pago, 'P001');
  assert.equal(doble.pagos.length, 0);
  assert.equal(resultado.movimiento.estadoConciliacion, 'pendiente');
  assert.equal(resultado.movimiento.conciliadoCentimos, 0);
  assert.equal(resultado.factura.estado, 'pendiente_pago');
  assert.equal(resultado.factura.saldo_pendiente, 484);

  // Deshacer lo que ya no está da un error claro, no un 500.
  const otraVez = await deshacerConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    id_factura: 'F1',
    usuario,
  }, doble.deps);
  assert.equal(otraVez.code, 'CONCILIACION_NO_ENCONTRADA');
});

test('ignorar y dejar de ignorar un movimiento', async () => {
  const doble = dobles({ mov: movimiento(), facturas: [factura({ id: 'F1', saldo: 484 })] });

  const ignorado = await ignorarMovimiento({ cuentaRef: IBAN, movementHash: HASH, usuario }, doble.deps);
  assert.equal(ignorado.movimiento.estadoConciliacion, 'ignorado');

  const revertido = await ignorarMovimiento(
    { cuentaRef: IBAN, movementHash: HASH, ignorar: false, usuario },
    doble.deps,
  );
  assert.equal(revertido.movimiento.estadoConciliacion, 'pendiente');

  // Con pagos aplicados no se deja ignorar: primero hay que deshacerlos.
  await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 200 }],
    usuario,
  }, doble.deps);
  const conPagos = await ignorarMovimiento({ cuentaRef: IBAN, movementHash: HASH, usuario }, doble.deps);
  assert.equal(conPagos.code, 'MOVIMIENTO_CON_CONCILIACIONES');
  assert.equal(conPagos.ok, false);

  // Y al dejar de ignorar, el estado se recalcula de lo asignado (no vuelve a
  // 'pendiente' a ciegas).
  const parcial = await ignorarMovimiento(
    { cuentaRef: IBAN, movementHash: HASH, ignorar: false, usuario },
    doble.deps,
  );
  assert.equal(parcial.movimiento.estadoConciliacion, 'parcial');
});

test('descartar una sugerencia es idempotente', async () => {
  const doble = dobles({ mov: movimiento(), facturas: [factura({ id: 'F1' })] });

  const primera = await descartarSugerenciaMovimiento(
    { cuentaRef: IBAN, movementHash: HASH, id_factura: 'F1', usuario },
    doble.deps,
  );
  assert.equal(primera.ok, true);
  assert.equal(primera.yaEstaba, false);
  assert.deepEqual(primera.sugerenciasDescartadas, ['F1']);

  const segunda = await descartarSugerenciaMovimiento(
    { cuentaRef: IBAN, movementHash: HASH, id_factura: 'F1', usuario },
    doble.deps,
  );
  assert.equal(segunda.yaEstaba, true);
  assert.deepEqual(segunda.sugerenciasDescartadas, ['F1']);

  const sinFactura = await descartarSugerenciaMovimiento(
    { cuentaRef: IBAN, movementHash: HASH, usuario },
    doble.deps,
  );
  assert.equal(sinFactura.code, 'VALIDACION');
});

// ─── Alcance por sociedad y bloqueo de remesas ───

test('una factura en una remesa activa no se concilia: falla solo ella', async () => {
  // El pago manual sí está bloqueado, pero conciliar llamaba a `registrarPagoFactura`
  // por debajo y se saltaba la comprobación: la remesa acababa pagando otra vez
  // una factura ya pagada, y la conciliación tampoco se podía deshacer porque el
  // borrado del pago está bloqueado mientras la remesa siga activa.
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F1', saldo: 400 }), factura({ id: 'F-REMESA', saldo: 600 })],
    remesas: { 'F-REMESA': { remesaId: 'REM-1', nombre: 'Julio', estado: 'Generada' } },
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 400 }, { id_factura: 'F-REMESA', importe: 600 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.code, 'PARCIAL');
  assert.deepEqual(resultado.aplicadas.map((a) => a.id_factura), ['F1']);
  assert.equal(resultado.fallidas.length, 1);
  assert.equal(resultado.fallidas[0].id_factura, 'F-REMESA');
  assert.equal(resultado.fallidas[0].code, 'FACTURA_EN_REMESA');
  assert.equal(resultado.fallidas[0].status, 409);
  assert.equal(resultado.fallidas[0].remesaActiva.remesaId, 'REM-1');
  assert.match(resultado.fallidas[0].mensaje, /Julio/);
  assert.equal(doble.pagos.length, 1, 'el pago de la factura en remesa no puede crearse');
  assert.equal(resultado.movimiento.conciliadoCentimos, 40000);
});

test('si la única factura está en una remesa activa no se aplica nada', async () => {
  const doble = dobles({
    mov: movimiento(),
    facturas: [factura({ id: 'F1', saldo: 484 })],
    remesas: { F1: { remesaId: 'REM-1', nombre: 'Julio', estado: 'Borrador' } },
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.code, 'NADA_APLICADO');
  assert.equal(doble.pagos.length, 0);
  assert.equal(doble.guardados.length, 0, 'el movimiento no se toca');
});

test('al aplicar, una factura de otra sociedad se comporta como una inexistente', async () => {
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F-MIA', saldo: 400 }), facturaAjena({ id: 'F-AJENA', saldo: 600 })],
  });
  const deps = conAlcance(doble.deps, ['000007']);

  const ajena = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F-AJENA', importe: 600 }],
    usuario,
  }, deps);

  assert.equal(ajena.code, 'VALIDACION');
  assert.deepEqual(ajena.errores.map((e) => e.code), ['FACTURA_NO_ENCONTRADA']);
  assert.equal(doble.pagos.length, 0, 'no puede registrarse el pago de una factura fuera de alcance');
  assert.equal(doble.guardados.length, 0);

  // La de su sociedad, en cambio, se aplica con normalidad.
  const propia = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F-MIA', importe: 400 }],
    usuario,
  }, deps);
  assert.equal(propia.code, 'OK');
  assert.equal(doble.pagos.length, 1);
});

test('al deshacer, una factura de otra sociedad se comporta como una inexistente', async () => {
  const doble = dobles({
    mov: movimiento({
      centimos: -60000,
      conciliadoCentimos: 60000,
      estadoConciliacion: 'conciliado',
      conciliaciones: [{ id_factura: 'F-AJENA', id_pago: 'P001', importeCentimos: 60000 }],
    }),
    facturas: [facturaAjena({ id: 'F-AJENA', saldo: 600 })],
  });
  doble.pagos.push({ id_factura: 'F-AJENA', id_pago: 'P001', importe: 600 });

  const peticion = { cuentaRef: IBAN, movementHash: HASH, id_factura: 'F-AJENA', usuario };

  const bloqueado = await deshacerConciliacion(peticion, conAlcance(doble.deps, ['000007']));
  assert.equal(bloqueado.ok, false);
  assert.equal(bloqueado.code, 'FACTURA_NO_ENCONTRADA');
  assert.equal(doble.pagos.length, 1, 'el pago no puede borrarse');
  assert.equal(doble.movimiento.conciliadoCentimos, 60000, 'ni el movimiento cambiar');

  // Quien sí tiene alcance sobre esa sociedad lo deshace.
  const permitido = await deshacerConciliacion(peticion, conAlcance(doble.deps, ['000099']));
  assert.equal(permitido.ok, true);
  assert.equal(doble.pagos.length, 0);
});

// ─── Carrera de dos personas conciliando el mismo apunte ───

test('si otro concilia el mismo movimiento en medio, no se pierde ninguna conciliación', async () => {
  // Las dos sesiones leyeron el movimiento de 1.000 € entero libre, así que las
  // dos validaciones pasaron y las dos crearon su pago (facturas distintas: la
  // clave de idempotencia no lo impide). Sin escritura condicional, la última
  // escritura pisaba el array de la otra y su conciliación desaparecía aunque su
  // pago siguiera vivo en la factura.
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F-B', saldo: 700 })],
    alGuardar(intento, otroProceso) {
      if (intento !== 1) return;
      otroProceso([{ id_factura: 'F-A', id_pago: 'P001', importeCentimos: 60000 }]);
    },
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F-B', importe: 700 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, true);
  assert.equal(doble.conflictos.length, 1, 'el primer intento debe chocar con la condición');
  assert.equal(doble.intentos.guardar, 2, 'y resolverse en el segundo');

  const guardadas = resultado.movimiento.conciliaciones.map((c) => c.id_factura).sort();
  assert.deepEqual(guardadas, ['F-A', 'F-B'], 'las dos conciliaciones tienen que estar');
  assert.equal(resultado.movimiento.conciliadoCentimos, 130000, 'el total es la suma real de las dos');
  assert.equal(doble.movimiento.conciliadoCentimos, 130000, 'y es lo que queda guardado');
  // Quedan 1.300 € aplicados sobre un movimiento de 1.000 €: es un exceso real,
  // creado por los dos pagos, que el motor no puede deshacer solo. Lo que importa
  // es que el movimiento lo dice, así que se ve y las dos se pueden deshacer.
  assert.equal(resultado.movimiento.estadoConciliacion, 'conciliado');
  // Y que se avise: el estado 'conciliado' y `libre: 0` son indistinguibles de
  // una conciliación perfecta, así que sin el aviso el exceso no se ve.
  const sobra = resultado.avisos.find((a) => a.code === 'MOVIMIENTO_SOBREASIGNADO');
  assert.ok(sobra, 'el exceso tiene que avisarse');
  assert.equal(sobra.excesoCentimos, 30000);
  assert.equal(sobra.exceso, 300);
});

test('una conciliación que cuadra no lleva aviso de sobreasignación', async () => {
  const doble = dobles({ mov: movimiento({ centimos: -100000 }), facturas: [factura({ id: 'F1', saldo: 1000 })] });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 1000 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.movimiento.estadoConciliacion, 'conciliado');
  assert.deepEqual(resultado.avisos, []);
});

test('el reintento no cuenta dos veces la conciliación que ya estaba guardada', async () => {
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F-A', saldo: 600 })],
    alGuardar(intento, otroProceso) {
      // La misma conciliación ya guardada por otra vía (una petición duplicada
      // que llegó primero): mismo factura+pago.
      if (intento !== 1) return;
      otroProceso([{ id_factura: 'F-A', id_pago: 'P001', importeCentimos: 60000 }]);
    },
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F-A', importe: 600 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, true);
  assert.equal(resultado.movimiento.conciliaciones.length, 1, 'no puede duplicarse la entrada');
  assert.equal(resultado.movimiento.conciliadoCentimos, 60000, 'ni contarse el importe dos veces');
  assert.equal(resultado.movimiento.estadoConciliacion, 'parcial');
});

test('si los reintentos se agotan se dice que el pago existe pero el movimiento no se cuadró', async () => {
  let ajeno = 10000;
  const doble = dobles({
    mov: movimiento({ centimos: -100000 }),
    facturas: [factura({ id: 'F-A', saldo: 600 })],
    // Alguien escribe antes de cada intento: la condición nunca se cumple.
    alGuardar(intento, otroProceso) {
      otroProceso([{ id_factura: `F-OTRA-${intento}`, id_pago: 'P001', importeCentimos: ajeno }]);
      ajeno += 10000;
    },
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F-A', importe: 600 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, false);
  assert.equal(resultado.code, 'CONFLICTO_MOVIMIENTO');
  assert.equal(resultado.intentos, 4, 'unos pocos intentos y se para');
  assert.equal(doble.guardados.length, 0, 'no se escribe un estado inventado');
  // El pago está creado: callarlo sería lo peor que se puede hacer aquí.
  assert.deepEqual(resultado.aplicadas.map((a) => a.id_factura), ['F-A']);
  assert.equal(doble.pagos.length, 1);
  assert.match(resultado.mensaje, /pagos se han registrado/i);
  // Y no se promete que reintentar lo arregle, porque no lo arregla: la factura
  // ya está pagada y la misma petición no pasa la validación. Lo que queda es
  // anotar el pago en el movimiento, y eso se reconstruye desde los pagos.
  assert.equal(/vuelve a intentarlo/i.test(resultado.mensaje), false);
});

test('dos personas deshaciendo a la vez: el movimiento acaba sin las dos', async () => {
  const doble = dobles({
    mov: movimiento({
      centimos: -100000,
      conciliadoCentimos: 100000,
      estadoConciliacion: 'conciliado',
      conciliaciones: [
        { id_factura: 'F-A', id_pago: 'P001', importeCentimos: 60000 },
        { id_factura: 'F-B', id_pago: 'P001', importeCentimos: 40000 },
      ],
    }),
    facturas: [factura({ id: 'F-B', saldo: 400 })],
    // La otra sesión deshace F-A justo antes de que nosotros escribamos.
    alGuardar(intento, otroProceso) {
      if (intento !== 1) return;
      otroProceso([{ id_factura: 'F-B', id_pago: 'P001', importeCentimos: 40000 }]);
    },
  });
  doble.pagos.push({ id_factura: 'F-B', id_pago: 'P001', importe: 400 });

  const resultado = await deshacerConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    id_factura: 'F-B',
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, true);
  assert.equal(doble.conflictos.length, 1);
  assert.equal(doble.intentos.guardar, 2);
  assert.deepEqual(resultado.movimiento.conciliaciones, [], 'ninguna de las dos puede sobrevivir a su pago');
  assert.equal(resultado.movimiento.conciliadoCentimos, 0);
  assert.equal(resultado.movimiento.estadoConciliacion, 'pendiente');
});

test('un fallo de escritura que no es una carrera no se disfraza de conflicto', async () => {
  const doble = dobles({ mov: movimiento(), facturas: [factura({ id: 'F1', saldo: 484 })] });
  const deps = {
    ...doble.deps,
    async guardarConciliacion() {
      throw Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException' });
    },
  };

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 484 }],
    usuario,
  }, deps);

  assert.equal(resultado.code, 'CONFLICTO_MOVIMIENTO');
  assert.equal(resultado.intentos, 1, 'un error que no es de condición no se reintenta');
  assert.equal(/otra persona/i.test(resultado.mensaje), false);
  assert.deepEqual(resultado.aplicadas.map((a) => a.id_factura), ['F1']);
});

test('deshacer con los reintentos agotados avisa de que el pago ya se borró', async () => {
  let ajeno = 60000;
  const doble = dobles({
    mov: movimiento({
      centimos: -100000,
      conciliadoCentimos: 60000,
      estadoConciliacion: 'parcial',
      conciliaciones: [{ id_factura: 'F-A', id_pago: 'P001', importeCentimos: 60000 }],
    }),
    facturas: [factura({ id: 'F-A', saldo: 600 })],
    alGuardar(intento, otroProceso) {
      ajeno += 10000;
      otroProceso([
        { id_factura: 'F-A', id_pago: 'P001', importeCentimos: 60000 },
        { id_factura: `F-OTRA-${intento}`, id_pago: 'P001', importeCentimos: ajeno },
      ]);
    },
  });
  doble.pagos.push({ id_factura: 'F-A', id_pago: 'P001', importe: 600 });

  const resultado = await deshacerConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    id_factura: 'F-A',
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, false);
  assert.equal(resultado.code, 'CONFLICTO_MOVIMIENTO');
  assert.equal(resultado.intentos, 4);
  assert.deepEqual(resultado.deshecha, { id_factura: 'F-A', id_pago: 'P001' });
  assert.equal(doble.pagos.length, 0, 'el pago sí se borró');
  assert.match(resultado.mensaje, /pago se ha eliminado/i);
});

test('ignorar un movimiento que acaba de recibir un pago no lo pisa', async () => {
  const doble = dobles({
    mov: movimiento(),
    facturas: [factura({ id: 'F1', saldo: 484 })],
    alGuardar(intento, otroProceso) {
      // Entre la comprobación de "no tiene pagos" y la escritura, entra uno.
      otroProceso([{ id_factura: 'F1', id_pago: 'P001', importeCentimos: 20000 }]);
    },
  });

  const resultado = await ignorarMovimiento({ cuentaRef: IBAN, movementHash: HASH, usuario }, doble.deps);

  assert.equal(resultado.ok, false);
  assert.equal(resultado.code, 'CONFLICTO_MOVIMIENTO');
  assert.equal(doble.intentos.estado, 1, 'aquí no se reintenta: la condición previa ya no vale');
  assert.notEqual(doble.movimiento.estadoConciliacion, 'ignorado');
});

// ─── Trazabilidad del pago (contra el doble en memoria de DynamoDB) ───

test('el pago guardado apunta al movimiento del que salió, y los demás pagos no cambian', async () => {
  const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
  const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');

  const db = montarEscenario();
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  const sembrar = (id) => db.sembrar(tables.facturas, {
    id_factura: id,
    tipo: 'IN',
    estado: 'pendiente_pago',
    total_factura: 484,
    total_cobrado: 0,
    saldo_pendiente: 484,
  });

  sembrar('FAC-BANCA');
  await registrarPagoFactura({
    id_factura: 'FAC-BANCA',
    fecha: '2026-07-14',
    importe: 484,
    metodo_pago: 'transferencia',
    usuario_id: 'U-1',
    idempotencyKey: claveIdempotencia(HASH, 'FAC-BANCA'),
    banca_movement_hash: HASH,
    banca_cuenta_ref: IBAN,
  });

  const pago = db.obtener(tables.facturasPagos, { id_factura: 'FAC-BANCA', id_pago: 'P001' });
  assert.equal(pago.banca_movement_hash, HASH);
  assert.equal(pago.banca_cuenta_ref, IBAN);
  assert.equal(pago.idempotency_key, `banca:${HASH}:FAC-BANCA`);
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-BANCA' }).estado, 'pagada');

  // Un pago que no viene del banco queda exactamente como antes: sin atributos
  // nuevos. Los pagos de remesas y los manuales no cambian de forma.
  sembrar('FAC-MANUAL');
  await registrarPagoFactura({
    id_factura: 'FAC-MANUAL',
    fecha: '2026-07-14',
    importe: 100,
    metodo_pago: 'transferencia',
    usuario_id: 'U-1',
  });
  const manual = db.obtener(tables.facturasPagos, { id_factura: 'FAC-MANUAL', id_pago: 'P001' });
  assert.equal('banca_movement_hash' in manual, false);
  assert.equal('banca_cuenta_ref' in manual, false);
});

test('deshacer desde banca reutiliza el borrado de pagos de facturación', async () => {
  const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
  const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
  const { eliminarPagoFactura } = await import('../lib/facturacion/eliminarPago.js');

  const db = montarEscenario();
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.sembrar(tables.facturas, {
    id_factura: 'FAC-DESHACER',
    tipo: 'IN',
    estado: 'pendiente_pago',
    total_factura: 484,
    total_cobrado: 0,
    saldo_pendiente: 484,
  });

  await registrarPagoFactura({
    id_factura: 'FAC-DESHACER',
    fecha: '2026-07-14',
    importe: 200,
    metodo_pago: 'transferencia',
    banca_movement_hash: HASH,
    banca_cuenta_ref: IBAN,
  });
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-DESHACER' }).estado, 'parcialmente_pagada');

  await eliminarPagoFactura({
    id_factura: 'FAC-DESHACER',
    id_pago: 'P001',
    usuario_id: 'U-1',
    detalleAuditoria: { origen: 'conciliacion_bancaria', movementHash: HASH },
  });

  const factura = db.obtener(tables.facturas, { id_factura: 'FAC-DESHACER' });
  assert.equal(factura.estado, 'pendiente_pago');
  assert.equal(factura.total_cobrado, 0);
  assert.equal(factura.saldo_pendiente, 484);
  assert.equal(db.obtener(tables.facturasPagos, { id_factura: 'FAC-DESHACER', id_pago: 'P001' }), null);

  // Una factura metida en una remesa activa no se puede tocar desde aquí.
  db.sembrar(tables.facturas, {
    id_factura: 'FAC-EN-REMESA',
    tipo: 'IN',
    estado: 'parcialmente_pagada',
    total_factura: 100,
    total_cobrado: 50,
    saldo_pendiente: 50,
  });
  db.sembrar(tables.facturasPagos, {
    id_factura: 'FAC-EN-REMESA',
    id_pago: 'P001',
    importe: 50,
    metodo_pago: 'transferencia',
  });
  db.sembrar(tables.remesas, {
    remesaId: 'REM-1',
    nombre: 'Julio',
    estado: 'Generada',
    lineas: [{ id_factura: 'FAC-EN-REMESA', importe: 50 }],
  });

  await assert.rejects(
    () => eliminarPagoFactura({ id_factura: 'FAC-EN-REMESA', id_pago: 'P001' }),
    (err) => err.code === 'FACTURA_EN_REMESA' && err.status === 409,
  );
});

test('dos conciliaciones del mismo cargo no pueden pagar dos veces la factura', async () => {
  const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
  const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');

  const db = montarEscenario();
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.sembrar(tables.facturas, {
    id_factura: 'FAC-DOBLE',
    tipo: 'IN',
    estado: 'pendiente_pago',
    total_factura: 1000,
    total_cobrado: 0,
    saldo_pendiente: 1000,
  });

  // Las dos conciliaciones leyeron la factura con los 1.000 € pendientes, así que
  // las dos llegan aquí con `importeMaximo: 1000`. Son movimientos distintos, o
  // sea claves de idempotencia distintas: la idempotencia no las separa. Lo único
  // que puede parar a la segunda es el saldo releído, y el tope que le pasan no
  // debe poder taparlo.
  const pagar = (hash) => registrarPagoFactura({
    id_factura: 'FAC-DOBLE',
    fecha: '2026-07-14',
    importe: 1000,
    metodo_pago: 'transferencia',
    importeMaximo: 1000,
    idempotencyKey: claveIdempotencia(hash, 'FAC-DOBLE'),
    banca_movement_hash: hash,
    banca_cuenta_ref: IBAN,
  });

  await pagar('mov-1');
  await assert.rejects(pagar('mov-2'), /supera el pendiente/);

  const factura = db.obtener(tables.facturas, { id_factura: 'FAC-DOBLE' });
  assert.equal(factura.total_cobrado, 1000, 'no se puede cobrar dos veces la misma factura');
  assert.equal(factura.saldo_pendiente, 0);
  assert.equal(
    db.obtener(tables.facturasPagos, { id_factura: 'FAC-DOBLE', id_pago: 'P002' }),
    null,
    'el segundo pago no puede existir',
  );
});

test('el id del pago no se reutiliza tras borrar uno anterior', async () => {
  const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
  const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
  const { eliminarPagoFactura } = await import('../lib/facturacion/eliminarPago.js');

  const db = montarEscenario();
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.sembrar(tables.facturas, {
    id_factura: 'FAC-IDS',
    tipo: 'IN',
    estado: 'pendiente_pago',
    total_factura: 300,
    total_cobrado: 0,
    saldo_pendiente: 300,
  });

  const pagar = (referencia) => registrarPagoFactura({
    id_factura: 'FAC-IDS',
    fecha: '2026-07-14',
    importe: 100,
    metodo_pago: 'transferencia',
    referencia,
  });

  const primero = await pagar('REF-1');
  const segundo = await pagar('REF-2');
  assert.equal(primero.pago.id_pago, 'P001');
  assert.equal(segundo.pago.id_pago, 'P002');

  // Se borra el primero: con el correlativo sacado de la longitud, el siguiente
  // pago volvía a llamarse P002 y su escritura pisaba el pago vivo.
  await eliminarPagoFactura({ id_factura: 'FAC-IDS', id_pago: 'P001' });
  const tercero = await pagar('REF-3');

  assert.equal(tercero.pago.id_pago, 'P003');
  assert.equal(db.obtener(tables.facturasPagos, { id_factura: 'FAC-IDS', id_pago: 'P002' }).referencia, 'REF-2');
  assert.equal(db.obtener(tables.facturasPagos, { id_factura: 'FAC-IDS', id_pago: 'P003' }).referencia, 'REF-3');
  assert.equal(db.obtener(tables.facturas, { id_factura: 'FAC-IDS' }).total_cobrado, 200);
});

test('un id de pago con otro formato no rompe el correlativo', async () => {
  const { siguienteIdPago } = await import('../lib/facturacion/registrarPago.js');

  assert.equal(siguienteIdPago([]), 'P001');
  assert.equal(siguienteIdPago([{ id_pago: 'P001' }, { id_pago: 'P002' }]), 'P003');
  // Solo cuentan los que siguen el formato: los demás no pueden colisionar con
  // `P{max+1}`, así que basta con que no rompan el cálculo.
  assert.equal(siguienteIdPago([{ id_pago: 'PAGO-ANTIGUO' }, { id_pago: 'P007' }]), 'P008');
  assert.equal(siguienteIdPago([{ id_pago: '' }, { id_pago: null }]), 'P001');
  // Y con más de 999 pagos el id crece en vez de truncarse.
  assert.equal(siguienteIdPago([{ id_pago: 'P999' }]), 'P1000');
});

test('el máximo correlativo siembra a quien reparte varios id de pago de golpe', async () => {
  // La compensación entre facturas asigna varios ids antes de escribir ninguno,
  // así que no puede llamar a `siguienteIdPago` una vez por pago: siembra su
  // contador con este máximo. Con la longitud, una factura a la que se le borró
  // un pago intermedio reutilizaría un id vivo y lo pisaría.
  const { ordinalMaximoIdPago } = await import('../lib/facturacion/registrarPago.js');

  assert.equal(ordinalMaximoIdPago([]), 0);
  assert.equal(ordinalMaximoIdPago([{ id_pago: 'P002' }]), 2, 'queda P001 borrado: el siguiente es P003');
  assert.equal(ordinalMaximoIdPago([{ id_pago: 'PAGO-ANTIGUO' }, { id_pago: 'P004' }]), 4);
  assert.equal(ordinalMaximoIdPago(undefined), 0);
});

test('los importes viajan en céntimos enteros de punta a punta', async () => {
  // 0.1 + 0.2 en euros no da 0.3; el reparto tiene que cuadrar igual.
  const doble = dobles({
    mov: movimiento({ centimos: -30 }),
    facturas: [factura({ id: 'F1', saldo: 0.1 }), factura({ id: 'F2', saldo: 0.2 })],
  });

  const resultado = await aplicarConciliacion({
    cuentaRef: IBAN,
    movementHash: HASH,
    asignaciones: [{ id_factura: 'F1', importe: 0.1 }, { id_factura: 'F2', importe: 0.2 }],
    usuario,
  }, doble.deps);

  assert.equal(resultado.ok, true);
  assert.equal(resultado.movimiento.conciliadoCentimos, 30);
  assert.equal(resultado.movimiento.estadoConciliacion, 'conciliado');
  assert.equal(euroACentimos(0.1) + euroACentimos(0.2), 30);

  // Y una asignación en céntimos también se acepta, sin pasar por euros.
  const enCentimos = validarAsignaciones({
    movimiento: movimiento({ centimos: -30 }),
    asignaciones: [{ id_factura: 'F1', importeCentimos: 10 }],
    facturas: new Map([['F1', factura({ id: 'F1', saldo: 0.1 })]]),
  });
  assert.equal(enCentimos.ok, true);
  assert.equal(enCentimos.sumaCentimos, 10);
});
