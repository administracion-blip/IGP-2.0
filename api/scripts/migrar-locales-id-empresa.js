#!/usr/bin/env node
/**
 * Rellena `id_empresa` en igp_Locales cruzando `empresa` (nombre) con igp_Empresas.Nombre.
 *
 * El vínculo local → empresa se guardaba solo por nombre, que se rompe al renombrar
 * la empresa en el maestro. Esta migración añade el identificador sin tocar el nombre.
 * Nunca crea empresas: si el nombre no casa con exactamente una, deja el local intacto
 * y lo lista al final para arreglarlo a mano.
 *
 * Uso (desde la carpeta api):
 *   node scripts/migrar-locales-id-empresa.js              → simulación (no escribe)
 *   node scripts/migrar-locales-id-empresa.js --apply      → aplica los cambios
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Cargar variables de entorno antes de importar dinámicamente módulos del API
// que se resuelven al evaluarse (db.js lee AWS_REGION y los nombres de tabla).
// Con `import` estático se aplicarían los valores por defecto (producción).
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const { client, docClient, tables } = await import('../lib/db.js');
const { formatId6 } = await import('../lib/usuarioLocales.js');

// Migración sobre datos reales: solo escribe con --apply explícito.
const apply = process.argv.includes('--apply');

/**
 * Normaliza un nombre de empresa para comparar. Mismo criterio que los cruces por
 * nombre ya existentes (pedidos/abonos y arqueos reales) más eliminación de acentos,
 * porque los nombres del maestro están tecleados a mano.
 */
function normNombreEmpresa(val) {
  return String(val ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function scanAll(TableName, ProjectionExpression) {
  const items = [];
  let lastKey = null;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName,
      ...(ProjectionExpression && { ProjectionExpression }),
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

async function main() {
  console.log('Región AWS:', await regionResuelta());
  console.log('Tablas:', tables.locales, '→', tables.empresas);
  console.log(apply
    ? 'Modo --apply: se escribirán los cambios.\n'
    : 'Modo simulación (por defecto): no se escribirá nada. Usa --apply para aplicar.\n');

  const [locales, empresas] = await Promise.all([
    scanAll(tables.locales, 'id_Locales, nombre, empresa, id_empresa'),
    scanAll(tables.empresas, 'id_empresa, Nombre'),
  ]);

  // Un mismo nombre normalizado puede casar con varias empresas: en ese caso no se adivina.
  const empresasPorNombre = new Map();
  for (const e of empresas) {
    const nombre = String(e.Nombre ?? '').trim();
    // Mismo padding a 6 dígitos que escribe el router de locales: si el maestro
    // tiene un id sin rellenar ('7'), guardarlo tal cual rompería las
    // comparaciones estrictas con lo que guarda la pantalla ('000007').
    const idRaw = String(e.id_empresa ?? '').trim();
    const id = idRaw ? formatId6(idRaw) : '';
    if (!nombre || !id || id === '000000') continue;
    const clave = normNombreEmpresa(nombre);
    if (!clave) continue;
    const lista = empresasPorNombre.get(clave) || [];
    lista.push({ id, nombre });
    empresasPorNombre.set(clave, lista);
  }

  const yaTenian = [];
  const sinNombreEmpresa = [];
  const aResolver = [];
  const ambiguos = [];
  const sinCoincidencia = [];

  for (const loc of locales) {
    const idLocal = String(loc.id_Locales ?? '').trim();
    if (!idLocal) continue;
    const nombreLocal = String(loc.nombre ?? '').trim() || idLocal;
    const idEmpresaActual = String(loc.id_empresa ?? '').trim();
    const empresaNombre = String(loc.empresa ?? '').trim();

    if (idEmpresaActual) {
      yaTenian.push({ idLocal, nombreLocal, idEmpresa: idEmpresaActual });
      continue;
    }
    if (!empresaNombre) {
      sinNombreEmpresa.push({ idLocal, nombreLocal });
      continue;
    }

    const candidatas = empresasPorNombre.get(normNombreEmpresa(empresaNombre)) || [];
    if (candidatas.length === 1) {
      aResolver.push({ idLocal, nombreLocal, empresaNombre, idEmpresa: candidatas[0].id });
    } else if (candidatas.length > 1) {
      ambiguos.push({ idLocal, nombreLocal, empresaNombre, candidatas });
    } else {
      sinCoincidencia.push({ idLocal, nombreLocal, empresaNombre });
    }
  }

  console.log('Locales revisados:', locales.length);
  console.log('Empresas en el maestro:', empresas.length);
  console.log('Ya tenían id_empresa:', yaTenian.length);
  console.log('Resolubles por nombre:', aResolver.length);
  console.log('Sin resolver:', ambiguos.length + sinCoincidencia.length + sinNombreEmpresa.length);
  console.log('');

  for (const r of aResolver) {
    console.log(`  ${apply ? '[aplicar]' : '[simulación]'} ${r.idLocal} ${r.nombreLocal} — "${r.empresaNombre}" → id_empresa ${r.idEmpresa}`);
  }

  let escritos = 0;
  let fallidos = 0;
  if (apply && aResolver.length > 0) {
    console.log('');
    for (const r of aResolver) {
      try {
        await docClient.send(new UpdateCommand({
          TableName: tables.locales,
          Key: { id_Locales: r.idLocal },
          UpdateExpression: 'SET id_empresa = :v',
          // No pisar un valor puesto a mano entre el escaneo y la escritura, ni
          // recrear un local borrado en ese intervalo como ítem suelto.
          ConditionExpression: 'attribute_exists(id_Locales) AND (attribute_not_exists(id_empresa) OR id_empresa = :vacio)',
          ExpressionAttributeValues: { ':v': r.idEmpresa, ':vacio': '' },
        }));
        escritos++;
      } catch (err) {
        fallidos++;
        const motivo = err?.name === 'ConditionalCheckFailedException'
          ? 'cambió durante la migración: ya tiene id_empresa o el local se ha borrado'
          : (err?.message || err);
        console.log(`  [error] ${r.idLocal} ${r.nombreLocal}: ${motivo}`);
      }
    }
  }

  console.log('\n===== Informe =====');
  console.log('Ya tenían id_empresa:', yaTenian.length);
  if (apply) {
    console.log('Resueltos y escritos:', escritos);
    if (fallidos) console.log('Errores al escribir:', fallidos);
  } else {
    console.log('Resolubles (no escritos, faltó --apply):', aResolver.length);
  }

  if (ambiguos.length > 0) {
    console.log(`\nAMBIGUOS — el nombre casa con varias empresas del maestro, no se puede adivinar (${ambiguos.length}):`);
    for (const a of ambiguos) {
      const detalle = a.candidatas.map((c) => `${c.id} (${c.nombre})`).join(', ');
      console.log(`  - ${a.idLocal} ${a.nombreLocal} — empresa "${a.empresaNombre}" → ${detalle}`);
    }
  }

  if (sinCoincidencia.length > 0) {
    console.log(`\nSIN COINCIDENCIA — no hay empresa con ese nombre en el maestro (${sinCoincidencia.length}):`);
    for (const s of sinCoincidencia) {
      console.log(`  - ${s.idLocal} ${s.nombreLocal} — empresa "${s.empresaNombre}"`);
    }
  }

  if (sinNombreEmpresa.length > 0) {
    console.log(`\nSIN EMPRESA — el local no tiene ni nombre de empresa (${sinNombreEmpresa.length}):`);
    for (const s of sinNombreEmpresa) {
      console.log(`  - ${s.idLocal} ${s.nombreLocal}`);
    }
  }

  const pendientes = ambiguos.length + sinCoincidencia.length + sinNombreEmpresa.length;
  if (pendientes > 0) {
    console.log(`\nHay ${pendientes} local(es) que hay que revisar a mano en el maestro de locales.`);
  } else {
    console.log(apply
      ? '\nTodos los locales quedan con empresa resuelta.'
      : '\nTodos los locales se pueden resolver. Vuelve a lanzarlo con --apply para escribirlos.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
