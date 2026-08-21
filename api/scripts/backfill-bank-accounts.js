#!/usr/bin/env node
/**
 * Backfill de cuentas bancarias (fase *expand*): pasa `Iban` e `IbanAlternativo`
 * de `igp_Empresas` a la tabla `Igp_BankAccounts` (una fila por cuenta) y deja
 * el IBAN principal apuntado en `igp_Empresas.IbanPredeterminado`.
 *
 * No borra ni vacía los campos viejos: siguen existiendo y funcionando. El
 * `Iban` se reescribe con el mismo valor del puntero (escritura dual) para que
 * todo lo que aún lee `Iban` siga viendo lo correcto.
 *
 * Es idempotente: si la cuenta ya existe para esa misma empresa, la salta.
 * Los casos dudosos (IBAN inválido, alternativo repetido, empresa sin IBAN,
 * mismo IBAN en dos empresas) NO se crean: se listan al final para arreglarlos
 * a mano en el maestro.
 *
 * Uso (desde la carpeta api):
 *   node scripts/backfill-bank-accounts.js            → simulación (no escribe)
 *   node scripts/backfill-bank-accounts.js --apply    → aplica los cambios
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Cargar variables de entorno antes de importar dinámicamente módulos del API
// que se resuelven al evaluarse (db.js lee AWS_REGION y los nombres de tabla).
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const { client, docClient, tables } = await import('../lib/db.js');
const { validarIban, normalizarIban, limpiarIban } = await import('../lib/remesas/iban.js');
const {
  normalizeCif,
  getCifFromEmpresaItem,
  getIdEmpresaFromItem,
  getNombreFromEmpresaItem,
} = await import('../lib/empresaCif.js');
const { ibanPredeterminadoDeEmpresa } = await import('../lib/empresaIban.js');
const { bancoDesdeIban, crearCuenta, getCuentaByIban } = await import('../lib/dynamo/bankAccounts.js');
const { formatId6 } = await import('../lib/usuarioLocales.js');

// Migración sobre datos reales: solo escribe con --apply explícito.
const apply = process.argv.includes('--apply');
const CREADO_POR = 'backfill';

async function scanAll(TableName) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

/** Región que usará el cliente de verdad (env, perfil de AWS o metadata). */
async function regionResuelta() {
  try {
    return await client.config.region();
  } catch {
    return process.env.AWS_REGION || '(desconocida)';
  }
}

function etiqueta(empresa) {
  return `${empresa.id || '(sin id)'} ${empresa.nombre || '(sin nombre)'}`;
}

async function main() {
  console.log('Región AWS:', await regionResuelta());
  console.log('Tablas:', tables.empresas, '→', tables.bankAccounts);
  console.log(apply
    ? 'Modo --apply: se escribirán los cambios.\n'
    : 'Modo simulación (por defecto): no se escribirá nada. Usa --apply para aplicar.\n');

  const items = await scanAll(tables.empresas);
  const empresas = items.map((item) => ({
    item,
    id: getIdEmpresaFromItem(item),
    nombre: getNombreFromEmpresaItem(item),
    cif: normalizeCif(getCifFromEmpresaItem(item)),
    // El puntero manda si ya existe (re-ejecuciones); si no, el Iban de siempre.
    principal: ibanPredeterminadoDeEmpresa(item),
    iban: limpiarIban(item.Iban ?? item.iban ?? ''),
    punteroActual: limpiarIban(item.IbanPredeterminado ?? ''),
    alternativo: limpiarIban(item.IbanAlternativo ?? item.ibanAlternativo ?? ''),
    // Valor tal cual está en el maestro, para avisar de lo que se ha limpiado.
    ibanCrudo: normalizarIban(item.Iban ?? item.iban ?? ''),
    alternativoCrudo: normalizarIban(item.IbanAlternativo ?? item.ibanAlternativo ?? ''),
  }));

  const cuarentena = {
    sinId: [],
    sinIban: [],
    invalidos: [],
    alternativoIgual: [],
    colisiones: [],
    ocupadoPorOtra: [],
    divergencias: [],
  };
  // IBAN que solo estaban mal escritos (guiones, prefijo "IBAN"…) y sí son válidos.
  const corregidos = [];

  // 1ª pasada: normalizar, validar y decidir qué cuentas tocaría crear.
  const planes = [];
  for (const empresa of empresas) {
    if (!empresa.id) {
      cuarentena.sinId.push({ empresa, motivo: 'la empresa no tiene id_empresa en el maestro' });
      continue;
    }
    if (!empresa.principal && !empresa.alternativo) {
      cuarentena.sinIban.push({ empresa, motivo: 'no tiene ningún IBAN' });
      continue;
    }
    if (!empresa.principal) {
      cuarentena.sinIban.push({
        empresa,
        motivo: `no tiene Iban principal, solo IbanAlternativo (${empresa.alternativo})`,
      });
      continue;
    }

    // El puntero y el campo viejo apuntan a cuentas distintas y las dos son
    // válidas: alguien editó `Iban` a mano después del primer volcado. Escribir
    // el puntero devolvería el IBAN antiguo, así que no se toca nada.
    if (
      empresa.punteroActual
      && empresa.iban
      && empresa.punteroActual !== empresa.iban
      && validarIban(empresa.punteroActual).valido
      && validarIban(empresa.iban).valido
    ) {
      cuarentena.divergencias.push({ empresa });
      continue;
    }

    const vPrincipal = validarIban(empresa.principal);
    if (!vPrincipal.valido) {
      cuarentena.invalidos.push({
        empresa,
        campo: 'Iban',
        iban: empresa.principal,
        motivo: vPrincipal.motivo,
      });
      continue;
    }
    if (empresa.ibanCrudo && empresa.ibanCrudo !== empresa.iban) {
      corregidos.push({ empresa, campo: 'Iban', crudo: empresa.ibanCrudo, limpio: empresa.iban });
    }
    if (empresa.alternativoCrudo && empresa.alternativoCrudo !== empresa.alternativo) {
      corregidos.push({
        empresa,
        campo: 'IbanAlternativo',
        crudo: empresa.alternativoCrudo,
        limpio: empresa.alternativo,
      });
    }

    const secundarias = [];
    if (empresa.alternativo) {
      if (empresa.alternativo === vPrincipal.iban) {
        cuarentena.alternativoIgual.push({ empresa, iban: empresa.alternativo });
      } else {
        const vAlt = validarIban(empresa.alternativo);
        if (!vAlt.valido) {
          cuarentena.invalidos.push({
            empresa,
            campo: 'IbanAlternativo',
            iban: empresa.alternativo,
            motivo: vAlt.motivo,
          });
        } else {
          secundarias.push(vAlt.iban);
        }
      }
    }
    // Si alguien movió el puntero a mano y `Iban` quedó con otro valor válido,
    // esa cuenta también existe de verdad: no se pierde.
    if (empresa.iban && empresa.iban !== vPrincipal.iban && !secundarias.includes(empresa.iban)) {
      const vIban = validarIban(empresa.iban);
      if (vIban.valido) secundarias.push(vIban.iban);
    }

    planes.push({ empresa, principal: vPrincipal.iban, secundarias });
  }

  // 2ª pasada: colisiones de PK entre empresas distintas (mismo IBAN en dos empresas).
  const porIban = new Map();
  for (const plan of planes) {
    for (const iban of [plan.principal, ...plan.secundarias]) {
      const lista = porIban.get(iban) || [];
      if (!lista.some((e) => formatId6(e.id) === formatId6(plan.empresa.id))) lista.push(plan.empresa);
      porIban.set(iban, lista);
    }
  }
  const ibansEnColision = new Set();
  for (const [iban, lista] of porIban) {
    if (lista.length > 1) {
      ibansEnColision.add(iban);
      cuarentena.colisiones.push({ iban, empresas: lista });
    }
  }

  // 3ª pasada: comparar con lo que ya hay en la tabla y crear lo que falte.
  let creadas = 0;
  let reactivadas = 0;
  let yaExistentes = 0;
  let punteros = 0;
  let errores = 0;

  for (const plan of planes) {
    const { empresa } = plan;
    const objetivos = [
      { iban: plan.principal, principal: true },
      ...plan.secundarias.map((iban) => ({ iban, principal: false })),
    ];
    let principalDisponible = true;

    for (const objetivo of objetivos) {
      if (ibansEnColision.has(objetivo.iban)) {
        if (objetivo.principal) principalDisponible = false;
        continue;
      }

      const existente = await getCuentaByIban(objetivo.iban);
      if (existente) {
        if (formatId6(existente.empresaId) !== formatId6(empresa.id)) {
          cuarentena.ocupadoPorOtra.push({
            empresa,
            iban: objetivo.iban,
            empresaIdExistente: String(existente.empresaId ?? ''),
            empresaNombreExistente: String(existente.empresaNombre ?? ''),
          });
          if (objetivo.principal) principalDisponible = false;
          continue;
        }
        yaExistentes++;
        continue;
      }

      const banco = bancoDesdeIban(objetivo.iban);
      if (!apply) {
        console.log(`  [simulación] ${etiqueta(empresa)} → ${objetivo.iban}`
          + `${objetivo.principal ? ' (predeterminada)' : ''}`
          + `${banco.bancoNombre ? ` — ${banco.bancoNombre}` : ''}`);
        creadas++;
        continue;
      }

      const resultado = await crearCuenta({
        iban: objetivo.iban,
        empresaId: empresa.id,
        empresaCif: empresa.cif,
        empresaNombre: empresa.nombre,
        bancoCodigo: banco.bancoCodigo,
        bancoNombre: banco.bancoNombre,
        notas: '',
        usuario: CREADO_POR,
      });
      if (resultado.ok) {
        if (resultado.reactivada) reactivadas++;
        else creadas++;
        console.log(`  [creada] ${etiqueta(empresa)} → ${objetivo.iban}`
          + `${objetivo.principal ? ' (predeterminada)' : ''}`);
      } else if (resultado.code === 'CUENTA_YA_EXISTE') {
        yaExistentes++;
      } else if (resultado.code === 'IBAN_DUPLICADO') {
        cuarentena.ocupadoPorOtra.push({
          empresa,
          iban: objetivo.iban,
          empresaIdExistente: resultado.empresaId || '',
          empresaNombreExistente: resultado.empresaNombre || '',
        });
        if (objetivo.principal) principalDisponible = false;
      } else {
        errores++;
        if (objetivo.principal) principalDisponible = false;
        console.log(`  [error] ${etiqueta(empresa)} → ${objetivo.iban}: ${resultado.motivo || resultado.code}`);
      }
    }

    // Escritura dual del puntero: IbanPredeterminado + el campo viejo Iban.
    if (!principalDisponible) continue;
    if (empresa.punteroActual === plan.principal && empresa.iban === plan.principal) continue;
    if (!apply) {
      punteros++;
      console.log(`  [simulación] ${etiqueta(empresa)} → IbanPredeterminado = ${plan.principal}`);
      continue;
    }
    try {
      await docClient.send(new UpdateCommand({
        TableName: tables.empresas,
        // Valor literal del ítem: los id_empresa del maestro no están
        // normalizados igual y formatId6() crearía una empresa huérfana.
        Key: { id_empresa: empresa.id },
        UpdateExpression: 'SET IbanPredeterminado = :iban, Iban = :iban',
        ConditionExpression: 'attribute_exists(id_empresa)',
        ExpressionAttributeValues: { ':iban': plan.principal },
      }));
      punteros++;
    } catch (err) {
      errores++;
      const motivo = err?.name === 'ConditionalCheckFailedException'
        ? 'la empresa ya no existe (borrada durante el backfill)'
        : (err?.message || err);
      console.log(`  [error] ${etiqueta(empresa)}: no se pudo fijar el puntero — ${motivo}`);
    }
  }

  console.log('\n===== Informe =====');
  console.log('Empresas revisadas:', empresas.length);
  console.log(apply ? 'Cuentas creadas:' : 'Cuentas a crear:', creadas);
  if (reactivadas) console.log('Cuentas reactivadas:', reactivadas);
  console.log('Cuentas ya existentes (omitidas):', yaExistentes);
  console.log(apply ? 'Punteros IbanPredeterminado escritos:' : 'Punteros IbanPredeterminado a escribir:', punteros);
  if (errores) console.log('Errores al escribir:', errores);

  if (corregidos.length > 0) {
    console.log(`\nIBAN MAL ESCRITO EN EL MAESTRO — se limpian y se migran (${corregidos.length}):`);
    for (const c of corregidos) {
      console.log(`  - ${etiqueta(c.empresa)} — ${c.campo} "${c.crudo}" → ${c.limpio}`);
    }
  }

  if (cuarentena.invalidos.length > 0) {
    console.log(`\nIBAN INVÁLIDO — no se crean (${cuarentena.invalidos.length}):`);
    for (const c of cuarentena.invalidos) {
      console.log(`  - ${etiqueta(c.empresa)} — ${c.campo} "${c.iban}": ${c.motivo}`);
    }
  }

  if (cuarentena.alternativoIgual.length > 0) {
    console.log(`\nALTERNATIVO REPETIDO — IbanAlternativo idéntico al principal (${cuarentena.alternativoIgual.length}):`);
    for (const c of cuarentena.alternativoIgual) {
      console.log(`  - ${etiqueta(c.empresa)} — ${c.iban}`);
    }
  }

  if (cuarentena.sinIban.length > 0) {
    console.log(`\nSIN IBAN — la empresa no tiene cuenta que migrar (${cuarentena.sinIban.length}):`);
    for (const c of cuarentena.sinIban) {
      console.log(`  - ${etiqueta(c.empresa)} — ${c.motivo}`);
    }
  }

  if (cuarentena.colisiones.length > 0) {
    console.log(`\nIBAN REPETIDO EN VARIAS EMPRESAS — colisión de clave, no se crea (${cuarentena.colisiones.length}):`);
    for (const c of cuarentena.colisiones) {
      const quienes = c.empresas.map((e) => etiqueta(e)).join(' | ');
      console.log(`  - ${c.iban} → ${quienes}`);
    }
  }

  if (cuarentena.ocupadoPorOtra.length > 0) {
    console.log(`\nIBAN YA DADO DE ALTA EN OTRA EMPRESA — no se toca (${cuarentena.ocupadoPorOtra.length}):`);
    for (const c of cuarentena.ocupadoPorOtra) {
      const duenyo = `${c.empresaIdExistente || '(sin id)'} ${c.empresaNombreExistente || '(sin nombre)'}`;
      console.log(`  - ${etiqueta(c.empresa)} — ${c.iban} ya pertenece a ${duenyo}`);
    }
  }

  if (cuarentena.divergencias.length > 0) {
    console.log(`\nPUNTERO Y CAMPO Iban DISTINTOS — se editó el IBAN a mano, no se toca (${cuarentena.divergencias.length}):`);
    for (const c of cuarentena.divergencias) {
      console.log(`  - ${etiqueta(c.empresa)} — IbanPredeterminado ${c.empresa.punteroActual} · Iban ${c.empresa.iban}`);
    }
  }

  if (cuarentena.sinId.length > 0) {
    console.log(`\nEMPRESA SIN id_empresa — no se puede migrar (${cuarentena.sinId.length}):`);
    for (const c of cuarentena.sinId) {
      console.log(`  - ${c.empresa.nombre || '(sin nombre)'} — ${c.motivo}`);
    }
  }

  const pendientes = cuarentena.invalidos.length
    + cuarentena.alternativoIgual.length
    + cuarentena.sinIban.length
    + cuarentena.colisiones.length
    + cuarentena.ocupadoPorOtra.length
    + cuarentena.divergencias.length
    + cuarentena.sinId.length;
  if (pendientes > 0) {
    console.log(`\nHay ${pendientes} caso(s) en cuarentena que hay que revisar a mano en el maestro de empresas.`);
  } else {
    console.log(apply
      ? '\nTodas las empresas quedan con sus cuentas migradas.'
      : '\nTodas las empresas se pueden migrar. Vuelve a lanzarlo con --apply para escribirlas.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
