/**
 * Cuestionario Mystery Guest: categorías, preguntas valorables 1–5 (estrellas),
 * medias por grupo y cálculo de media global entre categorías.
 */

export type PreguntaMG = { id: string; texto: string };

export type CategoriaMG = {
  id: string;
  nombre: string;
  preguntas: PreguntaMG[];
};

export const MG_CUESTIONARIO: CategoriaMG[] = [
  {
    id: 'servicio',
    nombre: 'Servicio',
    preguntas: [
      { id: 'srv_atencion', texto: 'Atención recibida' },
      { id: 'srv_espera', texto: 'Tiempo de espera' },
      { id: 'srv_uniformidad', texto: 'Uniformidad' },
      { id: 'srv_posicion_personal', texto: 'Posición del personal' },
      { id: 'srv_despedida', texto: 'Despedida' },
    ],
  },
  {
    id: 'producto',
    nombre: 'Producto',
    preguntas: [
      { id: 'prd_calidad', texto: 'Calidad del producto' },
      { id: 'prd_variedad', texto: 'Variedad de la oferta' },
      { id: 'prd_sabor', texto: 'Sabor' },
    ],
  },
  {
    id: 'limpieza',
    nombre: 'Limpieza',
    preguntas: [
      { id: 'limp_general', texto: 'Limpieza general' },
      { id: 'limp_orden_mobiliario', texto: 'Orden y mobiliario' },
      { id: 'limp_espacios', texto: 'Baños y espacios comunes' },
    ],
  },
  {
    id: 'ambiente',
    nombre: 'Ambiente',
    preguntas: [
      { id: 'amb_decoracion', texto: 'Ambiente y decoración' },
      { id: 'amb_musica', texto: 'Música' },
      { id: 'amb_iluminacion', texto: 'Iluminación' },
      { id: 'amb_confort', texto: 'Temperatura y confort' },
    ],
  },
];

export function mgTodosLosIdsPregunta(): string[] {
  const ids: string[] = [];
  for (const c of MG_CUESTIONARIO) {
    for (const p of c.preguntas) ids.push(p.id);
  }
  return ids;
}

export function mgEstadoInicialRespuestas(valor = 3): Record<string, number> {
  const r: Record<string, number> = {};
  for (const id of mgTodosLosIdsPregunta()) r[id] = valor;
  return r;
}

/** Media aritmética por categoría (1 decimal). */
export function mgMediasPorCategoria(respuestas: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cat of MG_CUESTIONARIO) {
    const vals = cat.preguntas.map((p) => respuestas[p.id]).filter((n) => typeof n === 'number' && n >= 1 && n <= 5);
    if (vals.length === 0) {
      out[cat.id] = 0;
      continue;
    }
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    out[cat.id] = Math.round(m * 10) / 10;
  }
  return out;
}

/** Media de las medias por categoría (sobre 5). */
export function mgMediaGlobalCategorias(medias: Record<string, number>): number {
  const vs = Object.values(medias).filter((v) => v > 0);
  if (vs.length === 0) return 0;
  const m = vs.reduce((a, b) => a + b, 0) / vs.length;
  return Math.round(m * 10) / 10;
}
