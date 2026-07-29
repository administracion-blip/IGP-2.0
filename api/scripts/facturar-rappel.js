#!/usr/bin/env node
/**
 * Ensayo de la liquidación mensual del rappel como abono.
 *
 * Sin `--apply` no escribe nada: imprime qué se abonaría, con el detalle por par
 * de sociedades, el desglose por almacén de origen y por local de destino, y la
 * lista de excluidos con su motivo. Todos los importes salen en negativo, que es
 * lo que hace de esto un abono y no una factura.
 *
 * Uso (desde la carpeta api):
 *   node scripts/facturar-rappel.js                   → simulación del mes anterior
 *   node scripts/facturar-rappel.js 2026-06           → simulación de un periodo
 *   node scripts/facturar-rappel.js --periodo=2026-06 → igual, con nombre
 *   node scripts/facturar-rappel.js 2026-06 --apply   → genera los abonos en borrador
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
  previsualizarFacturacionRappel,
  generarFacturacionRappel,
  leerAjustesRappel,
  periodoAnterior,
} = await import('../lib/facturacion/facturarRappel.js');
const { avisoTandaIncompleta } = await import('../lib/facturacion/facturacionPeriodica.js');

// Proceso que crea documentos fiscales sobre datos reales: solo escribe con
// --apply explícito.
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

/**
 * Los excluidos se agrupan por motivo: un maestro incompleto genera decenas de
 * líneas idénticas y una lista plana escondería los motivos con un solo caso,
 * que suelen ser los interesantes.
 */
function imprimirExcluidos(excluidos) {
  if (!excluidos || excluidos.length === 0) return;
  const porMotivo = new Map();
  for (const e of excluidos) {
    const grupo = porMotivo.get(e.motivo) || { texto: e.motivo_texto, casos: [], pedidos: 0 };
    grupo.casos.push(e);
    grupo.pedidos += Number(e.pedidos ?? 1);
    porMotivo.set(e.motivo, grupo);
  }
  console.log(`\nEXCLUIDOS (${excluidos.length} caso(s)):`);
  for (const [motivo, grupo] of [...porMotivo.entries()].sort((a, b) => b[1].pedidos - a[1].pedidos)) {
    console.log(`\n  ${grupo.texto} [${motivo}] — ${grupo.pedidos} pedido(s):`);
    for (const e of grupo.casos.slice(0, 15)) {
      const quien = [
        e.pedido_id && `pedido ${e.pedido_id}`,
        e.fecha && `del ${e.fecha}`,
        e.empresa_emisora_nombre && `abona ${e.empresa_emisora_nombre} (${e.id_empresa_emisora ?? '—'})`,
        e.empresa_nombre && `recibe ${e.empresa_nombre} (${e.id_empresa ?? '—'})`,
        e.local_nombre && `local ${e.local_nombre}`,
      ]
        .filter(Boolean)
        .join(' · ');
      console.log(`    - ${quien || '(sin identificar)'}${e.detalle ? ` — ${e.detalle}` : ''}`);
    }
    if (grupo.casos.length > 15) console.log(`    … y ${grupo.casos.length - 15} caso(s) más`);
  }
}

function imprimirContexto(r) {
  if (r.no_facturables?.sin_importe) {
    console.log(`Pedidos sin rappel que abonar (lo normal, no es una anomalía): ${r.no_facturables.sin_importe}`);
  }
  if (r.no_facturables?.misma_sociedad) {
    console.log(
      `Movimientos dentro de la misma sociedad (no generan abono): ${r.no_facturables.misma_sociedad} pedido(s)`,
    );
  }
  if (r.lineas_iva_desde_producto) {
    console.log(`Líneas cuyo IVA se ha tomado del maestro de productos: ${r.lineas_iva_desde_producto}`);
  }
  if (r.lineas_sin_importe) {
    console.log(`Líneas de pedido sin rappel, ignoradas: ${r.lineas_sin_importe}`);
  }
  if (r.pendientes_periodos_anteriores?.length > 0) {
    const total = r.pendientes_periodos_anteriores.reduce((s, p) => s + p.pedidos, 0);
    console.log(
      `\nATENCIÓN: hay ${total} pedido(s) completados y sin abonar de periodos anteriores.` +
        ' Solo entran volviendo a generar su periodo:',
    );
    for (const p of r.pendientes_periodos_anteriores) {
      console.log(`  - ${p.periodo}: ${p.pedidos} pedido(s)`);
    }
  }
}

function imprimirDesglose(f) {
  for (const imp of f.impuestos || []) {
    console.log(`      IVA ${imp.tipo_iva}% — base ${eur(imp.base)} · cuota ${eur(imp.cuota)}`);
  }
  for (const o of f.origenes || []) {
    console.log(`    · abona ${o.origen_nombre} — ${o.num_pedidos} pedido(s) · ${eur(o.base)}`);
  }
  for (const loc of f.locales || []) {
    const devoluciones = loc.pedidos.filter((p) => p.tipo === 'Devolucion').length;
    const nota = devoluciones > 0 ? ` (${devoluciones} devolución/es que restan)` : '';
    console.log(`    · recibe ${loc.local_nombre} — ${loc.pedidos.length} pedido(s)${nota} · ${eur(loc.base)}`);
  }
}

async function main() {
  console.log('Región AWS:', await regionResuelta());
  console.log('Tablas:', tables.pedidos, '→', tables.facturas, '/', tables.facturasLineas);
  const ajustes = await leerAjustesRappel();
  console.log(
    'Configuración:',
    `serie ${ajustes.serie} · sociedad del Almacén General ${ajustes.id_empresa_almacen_general || '(SIN CONFIGURAR)'} ·`,
    `día ${ajustes.dia_generacion} a las ${ajustes.hora} ·`,
    ajustes.enabled ? 'automática ACTIVADA' : 'automática desactivada',
  );
  if (ajustes.ultimo_periodo_generado) {
    console.log('Último periodo de rappel generado:', ajustes.ultimo_periodo_generado);
  }
  console.log('Periodo:', periodo || `${periodoAnterior()} (mes anterior, por defecto)`);
  console.log('Dirección del abono: lo emite la sociedad que sirvió la mercancía y lo recibe la del local.');
  console.log(
    apply
      ? 'Modo --apply: se crearán los abonos en estado borrador.\n'
      : 'Modo simulación (por defecto): no se escribirá nada. Usa --apply para generar.\n',
  );

  if (!apply) {
    const r = await previsualizarFacturacionRappel({ periodo });
    if (!r.ok) {
      console.error('No se puede abonar el rappel:', r.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Pedidos completados en el periodo (${r.inicio_seleccion} a antes de ${r.corte_seleccion}): ${r.pedidos_revisados}`);
    console.log(`Fecha de emisión y operación: ${r.fecha_emision} · serie ${r.serie}`);
    imprimirContexto(r);
    console.log(
      `\nAbonos que se crearían: ${r.total_facturas} · ${r.total_pedidos} pedido(s) · ${eur(r.total_importe)}`,
    );
    for (const f of r.abonos) {
      console.log(`\n  ${f.empresa_emisora_nombre} (${f.id_empresa_emisora}) abona a ${f.empresa_nombre} (${f.id_empresa})`);
      console.log(
        `    ${f.num_pedidos} pedido(s) · base ${eur(f.base)} · IVA ${eur(f.iva)} · total ${eur(f.total)}`,
      );
      if (f.descuadre_centimos) {
        console.log(
          `    Descuadre de redondeo frente al informe de rappel: ${f.descuadre_centimos} céntimo(s) (informe ${eur(f.base_informe)})`,
        );
      }
      if (f.aviso) console.log(`    AVISO: ${f.aviso}`);
      imprimirDesglose(f);
    }
    imprimirExcluidos(r.excluidos);
    console.log('\n===== Informe =====');
    console.log('Abonos:', r.total_facturas);
    console.log('Pedidos a abonar:', r.total_pedidos);
    console.log('Importe total:', eur(r.total_importe));
    console.log('Excluidos:', r.excluidos.length);
    if (r.total_facturas === 0) {
      console.log('\nNo hay rappel pendiente de abonar en este periodo. No es un error.');
    } else {
      console.log('\nVuelve a lanzarlo con --apply para crear los abonos en borrador.');
    }
    return;
  }

  const r = await generarFacturacionRappel({
    periodo,
    usuario_nombre: 'Script facturar-rappel',
    origen: 'script',
  });
  if (!r.ok) {
    console.error('No se ha generado nada:', r.error);
    process.exitCode = 1;
    return;
  }
  console.log(`Ejecución ${r.ejecucion}`);
  console.log(`Abonos creados: ${r.total_facturas} · ${r.total_pedidos} pedido(s) · ${eur(r.total_importe)}`);
  imprimirContexto(r);
  for (const f of r.abonos) {
    console.log(
      `\n  [${f.id_factura}] ${f.empresa_emisora_nombre} (${f.id_empresa_emisora}) abona a ${f.empresa_nombre} (${f.id_empresa})`,
    );
    console.log(
      `    ${f.serie} · ${f.estado} · emisión ${f.fecha_emision} · ${f.num_pedidos} pedido(s) · ${f.num_lineas} línea(s) · ${eur(f.total)}`,
    );
    if (f.descuadre_centimos) {
      console.log(
        `    Descuadre de redondeo frente al informe de rappel: ${f.descuadre_centimos} céntimo(s) (informe ${eur(f.base_informe)})`,
      );
    }
    if (f.aviso) console.log(`    AVISO: ${f.aviso}`);
    imprimirDesglose(f);
  }
  if (r.pedidos_liberados.length > 0) {
    console.log(`\nPedidos liberados por el barrido (su abono ya no existe): ${r.pedidos_liberados.length}`);
    for (const p of r.pedidos_liberados) {
      console.log(`  - pedido ${p.pedido_id} — abono ${p.factura_rappel_id} (${p.periodo})`);
    }
  }
  if (r.descartados.length > 0) {
    console.log(`\nDescartados por concurrencia (${r.descartados.length}):`);
    for (const d of r.descartados) {
      console.log(`  - pedido ${d.pedido_id} · ${d.local_nombre || d.local_id}: ${d.motivo_texto}`);
    }
  }
  imprimirExcluidos(r.excluidos);
  if (r.errores.length > 0) {
    console.log(`\nERRORES (${r.errores.length}):`);
    for (const e of r.errores) {
      console.log(`  - ${e.empresa_emisora_nombre} → ${e.empresa_nombre}: ${e.error}`);
    }
  }
  console.log('\n===== Informe =====');
  console.log('Abonos creados (borrador):', r.total_facturas);
  console.log('Pedidos abonados:', r.total_pedidos);
  console.log('Importe total:', eur(r.total_importe));
  console.log('Descartados por concurrencia:', r.descartados.length);
  console.log('Excluidos:', r.excluidos.length);
  const aviso = avisoTandaIncompleta(r, 'abono');
  if (aviso) {
    console.log(aviso);
    process.exitCode = 1;
  }
  console.log('\nLos abonos quedan en borrador: revísalos y emítelos desde Facturación.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
