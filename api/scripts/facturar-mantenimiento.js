#!/usr/bin/env node
/**
 * Ensayo de la facturación mensual de reparaciones de mantenimiento.
 *
 * Sin `--apply` no escribe nada: imprime qué se facturaría, con el detalle por
 * sociedad y local y la lista de excluidos con su motivo. Es la red de seguridad
 * antes de tocar datos reales.
 *
 * Uso (desde la carpeta api):
 *   node scripts/facturar-mantenimiento.js                   → simulación del mes anterior
 *   node scripts/facturar-mantenimiento.js 2026-06           → simulación de un periodo
 *   node scripts/facturar-mantenimiento.js --periodo=2026-06 → igual, con nombre
 *   node scripts/facturar-mantenimiento.js 2026-06 --apply   → genera las facturas en borrador
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Cargar variables de entorno antes de importar dinámicamente módulos del API
// que se resuelven al evaluarse (db.js lee AWS_REGION y los nombres de tabla).
// Con `import` estático se aplicarían los valores por defecto (producción).
dotenv.config({ path: join(__dirname, '..', '.env.local') });
dotenv.config({ path: join(__dirname, '..', '.env') });

const { client, tables } = await import('../lib/db.js');
const {
  previsualizarFacturacionMantenimiento,
  generarFacturacionMantenimiento,
  leerAjustesFacturacion,
  periodoAnterior,
} = await import('../lib/facturacion/facturarMantenimiento.js');
const { avisoTandaIncompleta } = await import('../lib/facturacion/facturacionPeriodica.js');

// Proceso que crea facturas sobre datos reales: solo escribe con --apply explícito.
const apply = process.argv.includes('--apply');
const periodo = (() => {
  const conNombre = process.argv.find((a) => a.startsWith('--periodo='));
  if (conNombre) return conNombre.slice('--periodo='.length).trim();
  const suelto = process.argv.slice(2).find((a) => /^\d{4}-\d{2}$/.test(a));
  return suelto || '';
})();

function eur(n) {
  return `${Number(n ?? 0).toFixed(2)} €`;
}

/** Región que usará el cliente de verdad (env, perfil de AWS o metadata). */
async function regionResuelta() {
  try {
    return await client.config.region();
  } catch {
    return process.env.AWS_REGION || '(desconocida)';
  }
}

function imprimirExcluidos(excluidos) {
  if (!excluidos || excluidos.length === 0) return;
  console.log(`\nEXCLUIDOS (${excluidos.length}):`);
  for (const e of excluidos) {
    const quien = [
      e.empresa_nombre && `sociedad ${e.empresa_nombre} (${e.id_empresa ?? '—'})`,
      e.local_nombre && `local ${e.local_nombre} (${e.local_id ?? '—'})`,
      !e.local_nombre && e.local_id && `local ${e.local_id}`,
      e.titulo && `parte "${e.titulo}"`,
    ]
      .filter(Boolean)
      .join(' · ');
    const partes = e.partes ? ` — ${e.partes} parte(s)` : '';
    console.log(`  - ${quien || '(sin identificar)'}${partes}: ${e.motivo_texto}${e.detalle ? ` — ${e.detalle}` : ''}`);
  }
}

function imprimirSociedad(s) {
  console.log(`\n  ${s.nombre} (${s.id_empresa}) — CIF ${s.cif}`);
  console.log(`    ${s.num_partes} parte(s) · base ${eur(s.base)} · IVA ${eur(s.iva)} · total ${eur(s.total)}`);
  if (s.descuadre_centimos) {
    console.log(
      `    Descuadre de redondeo frente a las valoraciones: ${s.descuadre_centimos} céntimo(s) (valoraciones ${eur(s.total_valoraciones)})`,
    );
  }
  if (s.aviso) console.log(`    AVISO: ${s.aviso}`);
  for (const loc of s.locales || []) {
    console.log(`    · ${loc.local_nombre} (${loc.local_id}) — ${loc.partes.length} parte(s) · ${eur(loc.total)}`);
    for (const p of loc.partes) {
      const titulo = p.titulo ? ` ${p.titulo}` : '';
      console.log(`        ${p.fecha || 'sin fecha'} ·${titulo} — ${p.lineas} línea(s) · ${eur(p.total)}`);
    }
  }
}

async function main() {
  console.log('Región AWS:', await regionResuelta());
  console.log('Tablas:', tables.mantenimiento, '→', tables.facturas, '/', tables.facturasLineas);
  const ajustes = await leerAjustesFacturacion();
  console.log(
    'Configuración:',
    `serie ${ajustes.serie} · emisora ${ajustes.id_empresa_emisora} · día ${ajustes.dia_generacion} a las ${ajustes.hora} ·`,
    ajustes.enabled ? 'automática ACTIVADA' : 'automática desactivada',
  );
  if (ajustes.ultimo_periodo_generado) {
    console.log('Último periodo generado:', ajustes.ultimo_periodo_generado);
  }
  console.log('Periodo:', periodo || `${periodoAnterior()} (mes anterior, por defecto)`);
  console.log(
    apply
      ? 'Modo --apply: se crearán las facturas en estado borrador.\n'
      : 'Modo simulación (por defecto): no se escribirá nada. Usa --apply para generar.\n',
  );

  if (!apply) {
    const r = await previsualizarFacturacionMantenimiento({ periodo });
    if (!r.ok) {
      console.error('No se puede facturar:', r.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Corte de valoración: anterior a ${r.corte_valoracion}`);
    console.log(`Fecha de emisión y operación: ${r.fecha_emision}`);
    console.log(`Emisora: ${r.emisora.nombre} (${r.emisora.id_empresa}) — CIF ${r.emisora.cif}`);
    console.log(`\nFacturas que se crearían: ${r.total_facturas} · ${r.total_partes} parte(s) · ${eur(r.total_importe)}`);
    for (const s of r.sociedades) imprimirSociedad(s);
    imprimirExcluidos(r.excluidos);
    console.log('\n===== Informe =====');
    console.log('Facturas:', r.total_facturas);
    console.log('Partes a facturar:', r.total_partes);
    console.log('Importe total:', eur(r.total_importe));
    console.log('Excluidos:', r.excluidos.length);
    if (r.total_facturas === 0) {
      console.log('\nNo hay reparaciones pendientes de facturar en este periodo. No es un error.');
    } else {
      console.log('\nVuelve a lanzarlo con --apply para crear las facturas en borrador.');
    }
    return;
  }

  const r = await generarFacturacionMantenimiento({
    periodo,
    usuario_nombre: 'Script facturar-mantenimiento',
    origen: 'script',
  });
  if (!r.ok) {
    console.error('No se ha generado nada:', r.error);
    process.exitCode = 1;
    return;
  }
  console.log(`Ejecución ${r.ejecucion}`);
  console.log(`Facturas creadas: ${r.total_facturas} · ${r.total_partes} parte(s) · ${eur(r.total_importe)}`);
  for (const f of r.facturas) {
    console.log(`\n  [${f.id_factura}] ${f.empresa_nombre} (${f.id_empresa}) — CIF ${f.empresa_cif}`);
    console.log(
      `    ${f.serie} · ${f.estado} · emisión ${f.fecha_emision} · ${f.num_partes} parte(s) · ${f.num_lineas} línea(s) · ${eur(f.total)}`,
    );
    if (f.aviso) console.log(`    AVISO: ${f.aviso}`);
    for (const loc of f.locales || []) {
      console.log(`    · ${loc.local_nombre} — ${loc.partes.length} parte(s) · ${eur(loc.total)}`);
    }
  }
  if (r.partes_liberados.length > 0) {
    console.log(`\nPartes liberados por el barrido (su factura ya no existe): ${r.partes_liberados.length}`);
    for (const p of r.partes_liberados) {
      console.log(`  - ${p.local_nombre} · ${p.titulo} — factura ${p.factura_mantenimiento_id} (${p.periodo})`);
    }
  }
  if (r.descartados.length > 0) {
    console.log(`\nDescartados por concurrencia (${r.descartados.length}):`);
    for (const d of r.descartados) {
      console.log(`  - ${d.local_nombre} · ${d.titulo || d.sk}: ${d.motivo_texto}`);
    }
  }
  if (r.cerrados_sin_factura?.length > 0) {
    console.log(`\nCerrados sin factura (${r.cerrados_sin_factura.length}) — dejan de aparecer como pendientes:`);
    for (const c of r.cerrados_sin_factura) {
      console.log(`  - ${c.local_nombre} · ${c.titulo || c.sk}: ${c.motivo_texto}`);
    }
  }
  imprimirExcluidos(r.excluidos);
  if (r.errores.length > 0) {
    console.log(`\nERRORES (${r.errores.length}):`);
    for (const e of r.errores) console.log(`  - ${e.empresa_nombre} (${e.id_empresa}): ${e.error}`);
  }
  console.log('\n===== Informe =====');
  console.log('Facturas creadas (borrador):', r.total_facturas);
  console.log('Partes facturados:', r.total_partes);
  console.log('Importe total:', eur(r.total_importe));
  console.log('Descartados por concurrencia:', r.descartados.length);
  console.log('Cerrados sin factura:', r.cerrados_sin_factura?.length ?? 0);
  console.log('Excluidos:', r.excluidos.length);
  const aviso = avisoTandaIncompleta(r, 'factura');
  if (aviso) {
    console.log(aviso);
    process.exitCode = 1;
  }
  console.log('\nLas facturas quedan en borrador: revísalas y emítelas desde Facturación.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
