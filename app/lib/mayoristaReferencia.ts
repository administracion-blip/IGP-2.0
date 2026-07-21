import { formatFecha } from '../utils/formatFecha';

/** Referencia visible: `{0001} · {cliente} · {dd/mm/yyyy}`. */
export function buildNombreOperacion(
  numero: number | undefined,
  clienteNombre?: string,
  fechaIso?: string,
): string {
  const n = String(Number(numero) || 0).padStart(4, '0');
  const cli = String(clienteNombre || '').trim() || 'Sin cliente';
  const f = formatFecha(fechaIso?.slice(0, 10));
  return `${n} · ${cli} · ${f}`;
}

/** Título en listados: dd/mm/yyyy aunque el nombre guardado lleve ISO. */
export function nombreOperacionVisible(n: {
  nombre?: string;
  numero_operacion?: number;
  cliente_nombre?: string;
  fecha?: string;
}): string {
  const stored = String(n.nombre || '').trim();
  if (n.numero_operacion != null && n.fecha) {
    const auto = buildNombreOperacion(n.numero_operacion, n.cliente_nombre, n.fecha);
    if (!stored || stored === auto) return auto;
    const isoTail = stored.match(/^(\d{4} · .+ · )(\d{4}-\d{2}-\d{2})$/);
    if (isoTail) return `${isoTail[1]}${formatFecha(isoTail[2])}`;
  }
  return stored || 'Sin nombre';
}
