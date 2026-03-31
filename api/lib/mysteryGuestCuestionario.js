/**
 * Misma estructura que app/lib/mysteryGuestCuestionario.ts (validación servidor).
 */
export const MG_CUESTIONARIO = [
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

export function mgTodosLosIdsPregunta() {
  const ids = [];
  for (const c of MG_CUESTIONARIO) {
    for (const p of c.preguntas) ids.push(p.id);
  }
  return ids;
}

export function computeMediasPorCategoria(respuestas) {
  const out = {};
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

export function computeMediaGlobalCategorias(medias) {
  const vs = Object.values(medias).filter((v) => v > 0);
  if (vs.length === 0) return 0;
  const m = vs.reduce((a, b) => a + b, 0) / vs.length;
  return Math.round(m * 10) / 10;
}
