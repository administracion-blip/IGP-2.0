/**
 * Mantenimiento + limpiezas del día para el briefing dia_a_dia.
 * Partes: incidencias/recurrentes en estado Reparacion completadas en `fecha`.
 * Limpiezas: registros hechas cuyo día (completado_at o fecha_programada) es `fecha`.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { formatId6 } from '../usuarioLocales.js';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
/** Ventana hacia atrás para limpiezas programadas antes y completadas en `fecha`. */
const VENTANA_LIMPIEZA_DIAS = 2;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fechaMenosDias(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function queryAll(params) {
  const items = [];
  let lastKey = null;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await docClient.send(new QueryCommand({
      ...params,
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    items.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey || null;
  } while (lastKey);
  return items;
}

async function queryPartesLocal(localId) {
  const lid = formatId6(localId);
  return queryAll({
    TableName: tables.mantenimiento,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `LOCAL#${lid}`, ':sk': 'INC#' },
  });
}

async function queryLimpiezasVentana(localId, fecha) {
  const lid = formatId6(localId);
  const minDate = fechaMenosDias(fecha, VENTANA_LIMPIEZA_DIAS);
  return queryAll({
    TableName: tables.limpiezaRegistros,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
    ExpressionAttributeValues: {
      ':pk': `LOCAL#${lid}`,
      ':lo': `FECHA#${minDate}`,
      ':hi': `FECHA#${fecha}#\uffff`,
    },
  });
}

function mapParte(item, local) {
  const fechaCompletada = item.FechaCompletada ?? item.fecha_completada ?? null;
  const estadoValoracion = item.EstadoValoracion ?? item.estado_valoracion ?? null;
  const origen = item.origen === 'recurrente' ? 'recurrente' : 'incidencia';
  const valoracionRaw = item.valoracion_total;
  return {
    id: String(item.id_incidencia ?? item.SK ?? ''),
    localId: local.localId,
    localNombre: local.nombre,
    titulo: String(item.titulo ?? '').trim() || '(sin título)',
    categoria: item.categoria != null ? String(item.categoria) : null,
    zona: item.zona != null ? String(item.zona) : null,
    origen,
    estado: 'Reparacion',
    fechaCompletada: fechaCompletada != null ? String(fechaCompletada) : '',
    estadoValoracion: estadoValoracion != null ? String(estadoValoracion) : null,
    valoracionTotal: valoracionRaw != null && valoracionRaw !== ''
      ? round2(valoracionRaw)
      : null,
  };
}

function mapLimpieza(item, local) {
  return {
    id: String(item.id_registro ?? item.SK ?? ''),
    localId: local.localId,
    localNombre: local.nombre,
    objetoNombre: item.objeto_nombre_snapshot != null
      ? String(item.objeto_nombre_snapshot)
      : (item.objeto_nombre != null ? String(item.objeto_nombre) : null),
    tareaNombre: item.tarea_nombre != null ? String(item.tarea_nombre) : null,
    ubicacion: item.ubicacion_snapshot != null
      ? String(item.ubicacion_snapshot)
      : (item.ubicacion != null ? String(item.ubicacion) : null),
    completadoAt: item.completado_at != null ? String(item.completado_at) : null,
    realizadoPorNombre: item.realizado_por_nombre != null
      ? String(item.realizado_por_nombre)
      : (item.completado_por_nombre != null ? String(item.completado_por_nombre) : null),
  };
}

function esLimpiezaDelDia(item, fecha) {
  if (String(item.estado) !== 'hecha') return false;
  const completadoDia = item.completado_at != null
    ? String(item.completado_at).slice(0, 10)
    : '';
  if (RE_FECHA.test(completadoDia) && completadoDia === fecha) return true;
  return String(item.fecha_programada || '').slice(0, 10) === fecha;
}

/**
 * @param {Array<{ localId: string, nombre: string }>} universo
 * @param {string} fecha YYYY-MM-DD
 */
export async function buildMantenimientoDia(universo, fecha) {
  const fechaIso = String(fecha || '').slice(0, 10);
  const empty = {
    fecha: fechaIso,
    resumen: { incidencias: 0, recurrentes: 0, limpiezas: 0, valoradas: 0 },
    partes: [],
    limpiezas: [],
  };
  if (!RE_FECHA.test(fechaIso) || !Array.isArray(universo) || universo.length === 0) {
    return empty;
  }

  const partes = [];
  const limpiezas = [];

  await Promise.all(
    universo.map(async (local) => {
      try {
        const items = await queryPartesLocal(local.localId);
        for (const it of items) {
          if (String(it.estado) !== 'Reparacion') continue;
          const fc = String(it.FechaCompletada ?? it.fecha_completada ?? '').slice(0, 10);
          if (fc !== fechaIso) continue;
          partes.push(mapParte(it, local));
        }
      } catch (err) {
        console.warn('[ia/mantenimientoDia] partes', local.localId, err.message || err);
      }

      try {
        const regs = await queryLimpiezasVentana(local.localId, fechaIso);
        for (const it of regs) {
          if (!esLimpiezaDelDia(it, fechaIso)) continue;
          limpiezas.push(mapLimpieza(it, local));
        }
      } catch (err) {
        console.warn('[ia/mantenimientoDia] limpiezas', local.localId, err.message || err);
      }
    }),
  );

  partes.sort((a, b) =>
    a.localNombre.localeCompare(b.localNombre, 'es', { sensitivity: 'base' })
    || String(a.fechaCompletada).localeCompare(String(b.fechaCompletada))
    || a.titulo.localeCompare(b.titulo, 'es', { sensitivity: 'base' }),
  );
  limpiezas.sort((a, b) =>
    a.localNombre.localeCompare(b.localNombre, 'es', { sensitivity: 'base' })
    || String(a.completadoAt || '').localeCompare(String(b.completadoAt || ''))
    || String(a.objetoNombre || '').localeCompare(String(b.objetoNombre || ''), 'es'),
  );

  const recurrentes = partes.filter((p) => p.origen === 'recurrente').length;
  const valoradas = partes.filter((p) => Boolean(p.estadoValoracion)).length;

  return {
    fecha: fechaIso,
    resumen: {
      incidencias: partes.length,
      recurrentes,
      limpiezas: limpiezas.length,
      valoradas,
    },
    partes,
    limpiezas,
  };
}
