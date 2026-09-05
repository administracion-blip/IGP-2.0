/**
 * Tokens semánticos del módulo de dirección (Proyectos / tareas / reuniones).
 *
 * Piloto de diseño: Proyectos usa esta capa; el resto del ERP sigue con hex
 * sueltos. El día que se valide, se pueden apuntar estos nombres a un theme
 * global sin reescribir pantallas.
 *
 * Reglas del piloto (asesoría UI 2026):
 * - Fondo casi blanco; separación por espacio y borde sutil, no por bandeja gris.
 * - Tipografía: solo los 6 estilos de `tipo` (prohibido inventar tamaños sueltos).
 * - Radios: 8 contenedores, 6 controles; píldora solo en chips/badges.
 * - Una sola sombra (elementos flotantes: modales, dropdowns, paneles).
 * - Color de acento saturado solo para foco/enlaces; superficies usan `acentoSuave`.
 */

import type { TextStyle, ViewStyle } from 'react-native';

// ─── Color ───────────────────────────────────────────────────────────────────

export const tasksColor = {
  /** Lienzo de pantalla del módulo. */
  fondoApp: '#f8fafc',
  /** Paneles, filas, cards en línea. */
  superficie: '#ffffff',
  /** Campos / zonas hundidas suaves. */
  superficieHundida: '#f8fafc',

  /** Separadores y contornos de tarjetas en línea (más suave que el ERP clásico). */
  bordeSutil: '#eef1f5',
  /** Contorno de controles con más presencia (inputs, botones secundarios). */
  bordeFuerte: '#e2e8f0',

  textoPrimario: '#0f172a',
  textoSecundario: '#475569',
  textoTerciario: '#94a3b8',
  textoInverso: '#ffffff',
  textoEnlace: '#0284c7',

  /** Foco, CTA primaria, selección. */
  acento: '#0ea5e9',
  /** Fondos tintados (chip activo, fila hover de acento). */
  acentoSuave: '#e0f2fe',
  acentoTexto: '#0369a1',

  exito: '#16a34a',
  exitoSuave: '#dcfce7',
  aviso: '#d97706',
  avisoSuave: '#fffbeb',
  peligro: '#dc2626',
  peligroSuave: '#fef2f2',

  /** Overlay de modales. */
  overlay: 'rgba(15, 23, 42, 0.45)',
} as const;

export type TasksColor = typeof tasksColor;

// ─── Tipografía (6 estilos; no añadir más sin decisión de diseño) ─────────────

type TipoToken = Pick<TextStyle, 'fontSize' | 'fontWeight' | 'lineHeight' | 'letterSpacing' | 'color'>;

export const tasksTipo = {
  /** Título de pantalla / hub. */
  tituloPantalla: {
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 30,
    color: tasksColor.textoPrimario,
  } satisfies TipoToken,
  /** Título de sección / bloque. */
  tituloSeccion: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
    color: tasksColor.textoPrimario,
  } satisfies TipoToken,
  /** Párrafos y cuerpo de lista. */
  cuerpo: {
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 20,
    color: tasksColor.textoSecundario,
  } satisfies TipoToken,
  /** Valores de dato (nombre en tabla, cifras de ficha). */
  dato: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
    color: tasksColor.textoPrimario,
  } satisfies TipoToken,
  /** Etiquetas de campo / cabeceras de columna. */
  etiqueta: {
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 16,
    letterSpacing: 0.2,
    color: tasksColor.textoTerciario,
  } satisfies TipoToken,
  /** Pie, ayuda, meta. */
  micro: {
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
    color: tasksColor.textoTerciario,
  } satisfies TipoToken,
} as const;

export type TasksTipo = typeof tasksTipo;

/** Para columnas numéricas, fechas y KPIs (RN Web / nativo moderno). */
export const tasksTabularNums = { fontVariant: ['tabular-nums'] } as const satisfies TextStyle;

// ─── Espacio (escala de 4) ────────────────────────────────────────────────────

export const tasksSpace = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
} as const;

export type TasksSpace = typeof tasksSpace;

// ─── Forma ───────────────────────────────────────────────────────────────────

export const tasksRadius = {
  /** Inputs, botones, chips de control. */
  control: 6,
  /** Cards, secciones, paneles. */
  contenedor: 8,
  /** Solo badges / pastillas. */
  pildora: 999,
} as const;

// ─── Elevación (un solo nivel) ───────────────────────────────────────────────

/** Modales, dropdowns, panel lateral flotante. Las cards en línea: solo borde. */
export const tasksSombraFlotante = {
  shadowColor: '#0f172a',
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.08,
  shadowRadius: 24,
  elevation: 8,
} as const satisfies ViewStyle;

// ─── Densidad de tabla (piloto) ──────────────────────────────────────────────

export const tasksTabla = {
  /** Altura de fila cómoda en web (cumple MIN_TOUCH en espíritu). */
  filaMinHeight: 46,
  /** Barra izquierda de selección. */
  seleccionBarra: 2,
} as const;

// ─── Iconografía ─────────────────────────────────────────────────────────────

export const tasksIcono = {
  size: 18,
  sizeSm: 16,
  color: tasksColor.textoTerciario,
} as const;

// ─── Atajo agrupado ──────────────────────────────────────────────────────────

export const tasksUi = {
  color: tasksColor,
  tipo: tasksTipo,
  space: tasksSpace,
  radius: tasksRadius,
  sombraFlotante: tasksSombraFlotante,
  tabla: tasksTabla,
  icono: tasksIcono,
  tabularNums: tasksTabularNums,
} as const;

export default tasksUi;
