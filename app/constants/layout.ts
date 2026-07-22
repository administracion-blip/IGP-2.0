/**

 * Tokens de layout y responsividad de la app. Usar SIEMPRE estos valores en

 * lugar de números mágicos para mantener coherencia entre pantallas y una

 * experiencia táctil cómoda en móvil/tablet.

 *

 * - BREAKPOINTS: umbrales ÚNICOS para decidir phone / tablet / desktop.

 *   No reinventar umbrales sueltos (768/900/1024…) en cada pantalla; usar el

 *   hook `useBreakpoint` (app/hooks/useBreakpoint.ts).

 * - Orientación: en móvil/tablet el layout debe reaccionar a vertical vs

 *   horizontal (ver helpers `isPortraitViewport`, `shouldStackPanels`, etc.).

 * - MIN_TOUCH: alto/ancho mínimo recomendado para zonas táctiles (Apple/Google).

 */



/** Umbrales de ancho de viewport (en px lógicos). */

export const BREAKPOINTS = {

  /** < phone: teléfono. phone..tablet: tablet. > tablet: escritorio. */

  phone: 768,

  tablet: 1024,

} as const;



/** Tamaño táctil mínimo cómodo para botones/filas pulsables en móvil. */

export const MIN_TOUCH = 44;



/** Escala de espaciado base (múltiplos de 4). */

export const SPACING = {

  xs: 4,

  sm: 8,

  md: 12,

  lg: 16,

  xl: 24,

} as const;



/**

 * Tipografía por densidad. `comodo` se usa en móvil para que el texto no quede

 * diminuto; `compacto` es el tamaño tradicional para escritorio/tablas densas.

 */

export const FONT = {

  comodo: { body: 14, label: 13, small: 12 },

  compacto: { body: 11, label: 11, small: 9 },

} as const;



/** Vertical: altura >= ancho (tablet/móvil en portrait). */

export function isPortraitViewport(width: number, height: number): boolean {

  return height >= width;

}



/** Horizontal: ancho > altura. */

export function isLandscapeViewport(width: number, height: number): boolean {

  return width > height;

}



/**

 * Columnas para grids de tarjetas (hubs, menús de módulo).

 * Vertical → 1 columna (legibilidad). Horizontal → 2 si cabe.

 */

export function hubGridColumns(width: number, height: number): number {

  if (width >= BREAKPOINTS.tablet) return 2;

  if (width < BREAKPOINTS.phone) {

    return isPortraitViewport(width, height) ? 1 : 2;

  }

  // Banda tablet (768–1023)

  return isPortraitViewport(width, height) ? 1 : 2;

}



/**

 * Apilar paneles (lista + detalle, tabla + panel lateral).

 * Escritorio: lado a lado. Móvil/tablet vertical: apilado.

 * Móvil horizontal / tablet horizontal: lado a lado si hay ancho.

 */

export function shouldStackPanels(width: number, height: number): boolean {

  if (width >= BREAKPOINTS.tablet) return false;

  if (width < BREAKPOINTS.phone) return isPortraitViewport(width, height);

  return isPortraitViewport(width, height);

}



/** Toolbar de filtros en varias columnas: apilar en móvil o tablet vertical. */

export function shouldStackToolbar(width: number, height: number): boolean {

  if (width >= BREAKPOINTS.tablet) return false;

  if (width < BREAKPOINTS.phone) return true;

  return isPortraitViewport(width, height);

}



/**

 * Modo "cómodo" en tablas: teléfono o tablet en vertical (filas/tipografía ampliadas).

 */

export function shouldUseComfortableTable(width: number, height: number): boolean {

  if (width < BREAKPOINTS.phone) return true;

  if (width < BREAKPOINTS.tablet && isPortraitViewport(width, height)) return true;

  return false;

}



/** Gap entre cards en grids de Ajustes (sincronizaciones, personalización). */
export const SETTINGS_CARD_GAP = 12;
export const SETTINGS_CARD_MIN = 260;
export const SETTINGS_CARD_MAX = 360;

/**
 * Ancho fijo de card en Ajustes para que todas las filas mantengan el mismo tamaño
 * (evita que la última fila se estire con flex:1).
 */
export function settingsCardWidth(
  viewportWidth: number,
  options?: { sidebarWidth?: number; horizontalPadding?: number },
): number | '100%' {
  const gap = SETTINGS_CARD_GAP;
  const minW = SETTINGS_CARD_MIN;
  const maxW = SETTINGS_CARD_MAX;
  const sidebarW = options?.sidebarWidth ?? 220;
  const hPad = options?.horizontalPadding ?? 64;

  if (viewportWidth < 500) return '100%';

  const available = Math.max(minW, viewportWidth - sidebarW - hPad);
  const cols = Math.max(1, Math.floor((available + gap) / (minW + gap)));
  return Math.min(maxW, Math.floor((available - (cols - 1) * gap) / cols));
}

/** Ancho de tarjeta en grid de hub según columnas (porcentaje aproximado con gap 10). */

export function hubCardWidthPercent(columns: number): `${number}%` {

  if (columns <= 1) return '100%';

  if (columns >= 3) return '31%';

  return '48%';

}

/** Ancho de varias tarjetas hub en la misma fila (alineado al borde de la última columna ocupada). */
export function hubCardSpanWidthPercent(spanCards: number, gridColumns: number): `${number}%` {
  const cols = Math.max(1, gridColumns);
  const span = Math.max(1, Math.min(spanCards, cols));
  if (cols >= 3 && span >= 3) return '95%';
  if (cols === 2 && span >= 2) return '97%';
  return hubCardWidthPercent(cols);
}



/** Columnas para tiles cuadrados en hubs operativos (planning del día, etc.). */

export function hubTileColumns(width: number, height: number): number {

  if (width >= BREAKPOINTS.tablet) return 4;

  if (width >= BREAKPOINTS.phone && isLandscapeViewport(width, height)) return 3;

  return 2;

}



/** Escala del ancho del tile respecto al ancho de columna (0.49 ≈ −30 % adicional sobre 0.7). */

export const HUB_TILE_SIZE_SCALE = 0.49;



/** Ancho del tile en px (cuadro compacto; el alto crece con título + descripción). */

export function hubTileSideSize(

  viewportWidth: number,

  viewportHeight: number,

  horizontalPadding = 20,

  gap = 10,

): number {

  const columns = hubTileColumns(viewportWidth, viewportHeight);

  const inner = viewportWidth - horizontalPadding;

  const fullSide = (inner - gap * (columns - 1)) / columns;

  return Math.floor(fullSide * HUB_TILE_SIZE_SCALE);

}


