/**
 * Ingesta de movimientos bancarios.
 *
 * Lo que se prueba aquí es la lógica que no depende de AWS: el adaptador del
 * Norma 43 al movimiento canónico, la construcción del ítem que se guarda, la
 * detección de solapamiento y los contadores del resumen. La orquestación se
 * ejecuta contra un almacén simulado inyectado por `deps`, así que no hace falta
 * DynamoDB.
 *
 * No se monta el router con express a propósito: importar routers arrastra
 * workers que dejan el bucle de eventos vivo y `npm test` se queda colgado.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { parsearN43 } from '../lib/n43/index.js';
import {
  adaptarN43,
  contarMovimientos,
  FORMATO_N43,
  huellaMovimiento,
  rangoFechasMovimientos,
} from '../lib/banca/canonico.js';
import {
  construirItemMovimiento,
  detectarSolapamiento,
  ingestarExtracto,
} from '../lib/banca/ingesta.js';
import { pkCuenta, skMovimiento } from '../lib/banca/store.js';

const ENTIDAD = '2100';
const OFICINA = '0418';
const CUENTA = '0200051332';
const IBAN = 'ES9121000418450200051332';

/** Escribe tramos [desde, hasta, valor] (1-indexados, inclusive) sobre un registro de 80. */
function reg(...tramos) {
  const buf = Array(80).fill(' ');
  for (const [desde, hasta, valor] of tramos) {
    const largo = hasta - desde + 1;
    const v = String(valor).slice(0, largo).padEnd(largo, ' ');
    for (let i = 0; i < largo; i += 1) buf[desde - 1 + i] = v[i];
  }
  return buf.join('');
}

function num(valor, largo) {
  return String(valor).padStart(largo, '0');
}

function cabecera({ desde = '240101', hasta = '240131', saldoCentimos = 123456 } = {}) {
  return reg(
    [1, 2, '11'], [3, 6, ENTIDAD], [7, 10, OFICINA], [11, 20, CUENTA],
    [21, 26, desde], [27, 32, hasta], [33, 33, '2'],
    [34, 47, num(saldoCentimos, 14)], [48, 50, '978'], [51, 51, '3'],
    [52, 77, 'HOSTELERIA DEL SUR SL'],
  );
}

function movimiento({
  fechaOperacion = '240115',
  fechaValor = '240116',
  clave = '1',
  centimos = 4560,
  documento = '0000000001',
  referencia1 = 'REF1',
  referencia2 = 'REF2',
} = {}) {
  return reg(
    [1, 2, '22'], [3, 6, ENTIDAD], [7, 10, OFICINA], [11, 16, fechaOperacion], [17, 22, fechaValor],
    [23, 24, '03'], [25, 27, '001'], [28, 28, clave],
    [29, 42, num(centimos, 14)], [43, 52, documento], [53, 64, referencia1],
    [65, 80, referencia2],
  );
}

function complementario(texto1 = '', texto2 = '') {
  return reg([1, 2, '23'], [3, 4, '01'], [5, 42, texto1], [43, 80, texto2]);
}

function finalCuenta({
  apuntesDebe = 0,
  totalDebeCentimos = 0,
  apuntesHaber = 0,
  totalHaberCentimos = 0,
  saldoCentimos = 0,
} = {}) {
  return reg(
    [1, 2, '33'], [3, 6, ENTIDAD], [7, 10, OFICINA], [11, 20, CUENTA],
    [21, 25, num(apuntesDebe, 5)], [26, 39, num(totalDebeCentimos, 14)],
    [40, 44, num(apuntesHaber, 5)], [45, 58, num(totalHaberCentimos, 14)],
    [59, 59, '2'], [60, 73, num(saldoCentimos, 14)], [74, 76, '978'],
  );
}

function finFichero(registros) {
  return reg([1, 2, '88'], [3, 20, '9'.repeat(18)], [21, 26, num(registros, 6)]);
}

function fichero(registros) {
  return Buffer.from([...registros, finFichero(registros.length + 1)].join('\r\n'), 'latin1');
}

/** Enero: tres apuntes en tres días distintos, con registro 33 que cuadra. */
function ficheroEnero() {
  return fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    complementario('PAGO PROVEEDOR B12345678', 'FACTURA 2024/17'),
    movimiento({ clave: '2', centimos: 100000, fechaOperacion: '240120', fechaValor: '240120' }),
    movimiento({ clave: '1', centimos: 99, fechaOperacion: '240131', fechaValor: '240131' }),
    finalCuenta({
      apuntesDebe: 2,
      totalDebeCentimos: 4659,
      apuntesHaber: 1,
      totalHaberCentimos: 100000,
      saldoCentimos: 218797,
    }),
  ]);
}

/** Mismos tres apuntes de enero más uno de febrero: solapa con `ficheroEnero`. */
function ficheroEneroYFebrero() {
  return fichero([
    cabecera({ hasta: '240229' }),
    movimiento({ clave: '1', centimos: 4560 }),
    movimiento({ clave: '2', centimos: 100000, fechaOperacion: '240120', fechaValor: '240120' }),
    movimiento({ clave: '1', centimos: 99, fechaOperacion: '240131', fechaValor: '240131' }),
    movimiento({ clave: '2', centimos: 55000, fechaOperacion: '240215', fechaValor: '240215' }),
    finalCuenta({
      apuntesDebe: 2,
      totalDebeCentimos: 4659,
      apuntesHaber: 2,
      totalHaberCentimos: 155000,
      saldoCentimos: 768797,
    }),
  ]);
}

function extractoDe(buffer) {
  return adaptarN43(parsearN43(buffer));
}

/** Almacén simulado: las dos tablas en memoria, con la misma semántica condicional. */
function almacenFake({ cuentasMaestro = {} } = {}) {
  const movimientos = new Map();
  const ficheros = new Map();

  return {
    movimientos,
    ficheros,
    deps: {
      async getCuentaByIban(iban) {
        return cuentasMaestro[iban] || null;
      },
      async getFicheroCarga(hash) {
        return ficheros.get(String(hash)) || null;
      },
      async putFicheroCargaSiNueva(item) {
        if (ficheros.has(item.hashFichero)) {
          return { creado: false, existente: ficheros.get(item.hashFichero) };
        }
        ficheros.set(item.hashFichero, item);
        return { creado: true, existente: null };
      },
      async putFicheroCarga(item) {
        ficheros.set(item.hashFichero, item);
      },
      async movimientosEnRango(cuentaRef, desde, hasta) {
        const pk = pkCuenta(cuentaRef);
        return [...movimientos.values()].filter(
          (m) => m.PK === pk
            && (!desde || m.fechaOperacion >= desde)
            && (!hasta || m.fechaOperacion <= hasta),
        );
      },
      async escribirMovimientos(items) {
        let nuevos = 0;
        let duplicados = 0;
        for (const item of items || []) {
          const clave = `${item.PK}|${item.SK}`;
          if (movimientos.has(clave)) {
            duplicados += 1;
            continue;
          }
          movimientos.set(clave, item);
          nuevos += 1;
        }
        return { nuevos, duplicados };
      },
    },
  };
}

const MAESTRO_CON_CUENTA = {
  [IBAN]: { empresaId: '000007', empresaNombre: 'HOSTELERIA DEL SUR SL', iban: IBAN },
};

test('el adaptador convierte la salida del parser al movimiento canónico', () => {
  const parseado = parsearN43(ficheroEnero());
  const extracto = adaptarN43(parseado);

  assert.equal(extracto.formato, FORMATO_N43);
  assert.equal(extracto.hashFichero, parseado.hashFichero);
  assert.equal(extracto.errores.length, 0);
  assert.equal(extracto.cuentas.length, 1);
  assert.equal(contarMovimientos(extracto), 3);

  const cuenta = extracto.cuentas[0];
  assert.equal(cuenta.iban, IBAN);
  assert.equal(cuenta.cuentaRef, IBAN);
  assert.equal(cuenta.ibanValido, true);
  assert.equal(cuenta.titular, 'HOSTELERIA DEL SUR SL');
  assert.equal(cuenta.divisa, '978');
  assert.equal(cuenta.saldoInicial, 1234.56);
  assert.equal(cuenta.saldoFinal, 2187.97);
  assert.deepEqual(cuenta.descuadres, []);

  const [primero] = cuenta.movimientos;
  assert.equal(primero.fechaOperacion, '2024-01-15');
  assert.equal(primero.fechaValor, '2024-01-16');
  assert.equal(primero.importe, -45.6);
  assert.equal(primero.importeCentimos, -4560);
  assert.equal(primero.signo, 'D');
  assert.equal(primero.divisa, '978');
  assert.equal(primero.ordinal, 1);
  assert.equal(primero.numeroDocumento, '0000000001');
  assert.equal(primero.referencia1, 'REF1');
  assert.equal(primero.nif, 'B12345678');
  assert.match(primero.concepto, /PAGO PROVEEDOR/);
  assert.equal(primero.lineaOrigen, 2);

  // La huella la calcula el parser, pero tiene que salir la misma con la receta
  // pública del canónico: es lo que usarán los lectores de Excel y CSV.
  assert.equal(
    primero.movementHash,
    huellaMovimiento({
      cuenta: IBAN,
      fechaOperacion: '2024-01-15',
      importeCentimos: -4560,
      ordinal: 1,
    }),
  );

  assert.deepEqual(rangoFechasMovimientos(cuenta.movimientos), {
    desde: '2024-01-15',
    hasta: '2024-01-31',
  });
});

test('un movimiento cuya cuenta no está en el maestro se construye sin el atributo empresaId', () => {
  const extracto = extractoDe(ficheroEnero());
  const movimiento = extracto.cuentas[0].movimientos[0];
  const comun = {
    movimiento,
    hashFichero: extracto.hashFichero,
    nombreFichero: 'enero.q43',
    formato: extracto.formato,
    importadoEn: '2026-08-20T10:00:00.000Z',
    importadoPor: 'jj@igp.es',
  };

  const sinCuenta = construirItemMovimiento(comun);
  // Sin el atributo, DynamoDB no indexa el ítem en EmpresaId-FechaOperacion-index.
  // Escribir '' sí indexaría, y por eso no vale como "vacío".
  assert.equal('empresaId' in sinCuenta, false);
  assert.equal(sinCuenta.PK, `ACCOUNT#${IBAN}`);
  assert.equal(sinCuenta.SK, `TXN#2024-01-15#${movimiento.movementHash}`);
  assert.equal(sinCuenta.SK, skMovimiento('2024-01-15', movimiento.movementHash));
  assert.equal(sinCuenta.estadoConciliacion, 'pendiente');
  assert.equal(sinCuenta.formatoOrigen, FORMATO_N43);
  assert.equal(sinCuenta.hashFichero, extracto.hashFichero);
  assert.equal(sinCuenta.importe, -45.6);

  const conCuenta = construirItemMovimiento({ ...comun, empresaId: '000007', empresaNombre: 'HOSTELERIA DEL SUR SL' });
  assert.equal(conCuenta.empresaId, '000007');
  assert.equal(conCuenta.empresaNombre, 'HOSTELERIA DEL SUR SL');

  // Un empresaId en blanco no debe colarse como atributo presente.
  assert.equal('empresaId' in construirItemMovimiento({ ...comun, empresaId: '   ' }), false);
});

test('la primera carga escribe los movimientos y el resumen cuadra con lo escrito', async () => {
  const almacen = almacenFake({ cuentasMaestro: MAESTRO_CON_CUENTA });
  const extracto = extractoDe(ficheroEnero());

  const resultado = await ingestarExtracto(
    {
      extracto,
      nombreFichero: 'enero.q43',
      tamanoBytes: 480,
      usuario: 'jj@igp.es',
      guardarOriginal: async () => 'banca/ab/hash_enero.q43',
    },
    almacen.deps,
  );

  assert.equal(resultado.ok, true);
  assert.equal(resultado.yaCargado, false);
  const resumen = resultado.carga;
  assert.equal(resumen.estado, 'cargado');
  assert.equal(resumen.s3Key, 'banca/ab/hash_enero.q43');
  assert.equal(resumen.movimientosLeidos, 3);
  assert.equal(resumen.movimientosNuevos, 3);
  assert.equal(resumen.movimientosDuplicados, 0);
  assert.equal(resumen.lineasConError, 0);
  assert.equal(resumen.avisosTotal, 0);
  assert.equal(resumen.cuentas.length, 1);
  assert.equal(resumen.cuentas[0].empresaId, '000007');
  assert.equal(resumen.cuentas[0].pendienteAsignar, false);
  assert.equal(resumen.cuentas[0].nuevos, 3);
  assert.equal(resumen.cuentas[0].fechaDesde, '2024-01-15');
  assert.equal(resumen.cuentas[0].fechaHasta, '2024-01-31');
  assert.equal(resumen.importadoConSolapamiento, false);

  // Los contadores del resumen son exactamente lo que hay en la tabla.
  assert.equal(almacen.movimientos.size, 3);
  assert.equal(almacen.ficheros.size, 1);
  for (const item of almacen.movimientos.values()) {
    assert.equal(item.empresaId, '000007');
    assert.equal(item.estadoConciliacion, 'pendiente');
  }
});

test('sin cuenta en el maestro la carga queda pendiente_cuenta y los movimientos sin empresaId', async () => {
  const almacen = almacenFake();
  const extracto = extractoDe(ficheroEnero());

  const resultado = await ingestarExtracto(
    { extracto, nombreFichero: 'enero.q43', usuario: 'jj@igp.es' },
    almacen.deps,
  );

  assert.equal(resultado.carga.estado, 'pendiente_cuenta');
  assert.equal(resultado.carga.cuentas[0].pendienteAsignar, true);
  assert.equal(resultado.carga.cuentas[0].empresaId, '');
  assert.equal(resultado.carga.movimientosNuevos, 3);
  for (const item of almacen.movimientos.values()) {
    assert.equal('empresaId' in item, false);
  }
});

test('reimportar el mismo fichero no reprocesa ni crea nada', async () => {
  const almacen = almacenFake({ cuentasMaestro: MAESTRO_CON_CUENTA });
  const entrada = { extracto: extractoDe(ficheroEnero()), nombreFichero: 'enero.q43', usuario: 'jj@igp.es' };

  const primera = await ingestarExtracto(entrada, almacen.deps);
  assert.equal(primera.yaCargado, false);

  let subidasS3 = 0;
  const segunda = await ingestarExtracto(
    {
      ...entrada,
      extracto: extractoDe(ficheroEnero()),
      guardarOriginal: async () => {
        subidasS3 += 1;
        return 'no-deberia-subirse';
      },
    },
    almacen.deps,
  );

  assert.equal(segunda.ok, true);
  assert.equal(segunda.yaCargado, true);
  assert.equal(subidasS3, 0);
  assert.equal(almacen.movimientos.size, 3);
  assert.equal(almacen.ficheros.size, 1);
  // Se devuelve el resumen guardado la primera vez, no uno recalculado.
  assert.deepEqual(segunda.carga, primera.carga);
});

test('una carga que se corta a mitad se reanuda y no se acusa de solaparse consigo misma', async () => {
  // Escribir los apuntes antes de registrar la carga dejaba movimientos
  // huérfanos: al reintentar, el fichero se encontraba a sí mismo en el rango y
  // el usuario recibía un aviso de solapamiento que no podía interpretar.
  const almacen = almacenFake({ cuentasMaestro: MAESTRO_CON_CUENTA });
  const entrada = { extracto: extractoDe(ficheroEnero()), nombreFichero: 'enero.q43', usuario: 'jj@igp.es' };

  const depsQueFallan = {
    ...almacen.deps,
    async escribirMovimientos(items) {
      // Escribe la mitad y se cae, como haría un timeout de Dynamo.
      await almacen.deps.escribirMovimientos(items.slice(0, 1));
      throw new Error('Dynamo no responde');
    },
  };
  await assert.rejects(() => ingestarExtracto(entrada, depsQueFallan), /Dynamo no responde/);

  // La reserva ya está puesta y los apuntes escritos no quedan sin dueño.
  assert.equal(almacen.ficheros.size, 1);
  assert.equal([...almacen.ficheros.values()][0].estado, 'en_curso');
  assert.equal(almacen.movimientos.size, 1);

  let subidasS3 = 0;
  const reintento = await ingestarExtracto(
    {
      ...entrada,
      extracto: extractoDe(ficheroEnero()),
      guardarOriginal: async () => {
        subidasS3 += 1;
        return 'banca/ab/hash_enero.q43';
      },
    },
    almacen.deps,
  );

  assert.equal(reintento.ok, true);
  assert.equal(reintento.yaCargado, false);
  assert.equal(reintento.carga.estado, 'cargado');
  assert.equal(subidasS3, 1);
  // Los tres apuntes acaban guardados una sola vez: el ya escrito sale duplicado.
  assert.equal(almacen.movimientos.size, 3);
  assert.equal(reintento.carga.movimientosNuevos, 2);
  assert.equal(reintento.carga.movimientosDuplicados, 1);
  assert.equal(almacen.ficheros.size, 1);
});

test('detectarSolapamiento: marca lo que pisa el rango y deja pasar lo que no', () => {
  const existentes = [
    { fechaOperacion: '2024-01-15', hashFichero: 'h1', nombreFichero: 'enero.q43' },
    { fechaOperacion: '2024-01-31', hashFichero: 'h1', nombreFichero: 'enero.q43' },
  ];

  const pisa = detectarSolapamiento({
    cuentaRef: IBAN,
    iban: IBAN,
    desde: '2024-01-20',
    hasta: '2024-02-29',
    movimientosExistentes: existentes,
  });
  assert.equal(pisa.solapa, true);
  assert.equal(pisa.movimientosExistentes, 1);
  assert.deepEqual(pisa.cargas, [{ hashFichero: 'h1', nombreFichero: 'enero.q43', movimientos: 1 }]);

  const noPisa = detectarSolapamiento({
    cuentaRef: IBAN,
    iban: IBAN,
    desde: '2024-02-01',
    hasta: '2024-02-29',
    movimientosExistentes: existentes,
  });
  assert.equal(noPisa.solapa, false);
  assert.equal(noPisa.movimientosExistentes, 0);
  assert.deepEqual(noPisa.cargas, []);
});

test('un fichero que solapa se rechaza sin escribir, y con confirmar cuenta los duplicados', async () => {
  const almacen = almacenFake({ cuentasMaestro: MAESTRO_CON_CUENTA });
  await ingestarExtracto(
    { extracto: extractoDe(ficheroEnero()), nombreFichero: 'enero.q43' },
    almacen.deps,
  );
  assert.equal(almacen.movimientos.size, 3);

  const solapado = extractoDe(ficheroEneroYFebrero());
  const rechazo = await ingestarExtracto(
    { extracto: solapado, nombreFichero: 'enero-febrero.q43' },
    almacen.deps,
  );

  assert.equal(rechazo.ok, false);
  assert.equal(rechazo.code, 'SOLAPAMIENTO');
  assert.equal(rechazo.solapamientos.length, 1);
  assert.equal(rechazo.solapamientos[0].iban, IBAN);
  assert.equal(rechazo.solapamientos[0].desde, '2024-01-15');
  assert.equal(rechazo.solapamientos[0].hasta, '2024-02-15');
  assert.equal(rechazo.solapamientos[0].movimientosExistentes, 3);
  assert.equal(rechazo.solapamientos[0].cargas[0].nombreFichero, 'enero.q43');
  // No se ha tocado nada: ni movimientos ni registro de carga.
  assert.equal(almacen.movimientos.size, 3);
  assert.equal(almacen.ficheros.size, 1);

  const confirmado = await ingestarExtracto(
    { extracto: solapado, nombreFichero: 'enero-febrero.q43', confirmar: true },
    almacen.deps,
  );

  assert.equal(confirmado.ok, true);
  assert.equal(confirmado.carga.importadoConSolapamiento, true);
  assert.equal(confirmado.carga.movimientosLeidos, 4);
  assert.equal(confirmado.carga.movimientosNuevos, 1);
  assert.equal(confirmado.carga.movimientosDuplicados, 3);
  assert.equal(almacen.movimientos.size, 4);
  assert.equal(almacen.ficheros.size, 2);
});

test('el resumen reparte los contadores por cuenta cuando el fichero trae varias', async () => {
  const almacen = almacenFake({ cuentasMaestro: MAESTRO_CON_CUENTA });
  const dosCuentas = fichero([
    cabecera(),
    movimiento({ clave: '1', centimos: 4560 }),
    finalCuenta({ apuntesDebe: 1, totalDebeCentimos: 4560, saldoCentimos: 118896 }),
    reg(
      [1, 2, '11'], [3, 6, '0049'], [7, 10, '1500'], [11, 20, '0001234567'],
      [21, 26, '240101'], [27, 32, '240131'], [33, 33, '2'],
      [34, 47, num(500000, 14)], [48, 50, '978'], [51, 51, '3'], [52, 77, 'OTRA SOCIEDAD SL'],
    ),
    reg(
      [1, 2, '22'], [3, 6, '0049'], [7, 10, '1500'], [11, 16, '240110'], [17, 22, '240110'],
      [23, 24, '03'], [25, 27, '001'], [28, 28, '2'], [29, 42, num(20000, 14)],
    ),
    reg(
      [1, 2, '33'], [3, 6, '0049'], [7, 10, '1500'], [11, 20, '0001234567'],
      [21, 25, num(0, 5)], [26, 39, num(0, 14)], [40, 44, num(1, 5)], [45, 58, num(20000, 14)],
      [59, 59, '2'], [60, 73, num(520000, 14)], [74, 76, '978'],
    ),
  ]);

  const resultado = await ingestarExtracto(
    { extracto: extractoDe(dosCuentas), nombreFichero: 'dos-cuentas.q43' },
    almacen.deps,
  );

  const resumen = resultado.carga;
  assert.equal(resumen.cuentas.length, 2);
  assert.equal(resumen.movimientosNuevos, 2);
  assert.equal(
    resumen.movimientosNuevos,
    resumen.cuentas.reduce((acc, c) => acc + c.nuevos, 0),
  );
  assert.equal(resumen.cuentas[0].empresaId, '000007');
  assert.equal(resumen.cuentas[0].pendienteAsignar, false);
  assert.equal(resumen.cuentas[1].pendienteAsignar, true);
  // Basta una cuenta sin dar de alta para que la carga quede pendiente.
  assert.equal(resumen.estado, 'pendiente_cuenta');
  assert.equal(almacen.movimientos.size, 2);
});
