/** Paleta fija para departamentos sin color en el maestro. */
export const COLORES_DEPARTAMENTO = [
  '#0ea5e9',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#db2777',
  '#0891b2',
  '#65a30d',
  '#ea580c',
  '#4f46e5',
  '#be123c',
] as const;

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Color estable por `departamento_id`. Sin id → gris. */
export function colorDepartamento(departamentoId?: string | null): string {
  const id = (departamentoId ?? '').trim();
  if (!id) return '#94a3b8';
  return COLORES_DEPARTAMENTO[hashId(id) % COLORES_DEPARTAMENTO.length];
}

/** Abreviatura corta para pastillas (máx. 4). */
export function abreviaturaDepartamento(nombre?: string | null): string {
  const t = (nombre ?? '').trim();
  if (!t) return '';
  const partes = t.split(/\s+/).filter(Boolean);
  if (partes.length >= 2) {
    return partes
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('');
  }
  return t.slice(0, 4).toUpperCase();
}
