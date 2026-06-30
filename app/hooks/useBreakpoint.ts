/**

 * Hook de responsividad centralizado. Devuelve el ancho actual, orientación y

 * banderas derivadas de los umbrales ÚNICOS definidos en `app/constants/layout.ts`.

 *

 * Úsalo en lugar de comparar `width` con números sueltos en cada pantalla:

 *

 *   const { isPhone, isTablet, isDesktop, shouldStackPanels } = useBreakpoint();

 *

 * - isPhone:   width < BREAKPOINTS.phone   (teléfono)

 * - isTablet:  phone <= width < tablet     (tablet)

 * - isDesktop: width >= BREAKPOINTS.tablet (escritorio/web ancho)

 * - isCompact: true en teléfono y tablet (cuando conviene apilar/compactar)

 * - isPortrait / isLandscape: orientación del viewport

 * - shouldStackPanels: apilar lista+detalle (móvil vertical, tablet vertical)

 * - hubGridColumns: 1 o 2 columnas para grids de tarjetas

 */

import { useWindowDimensions } from 'react-native';

import {

  BREAKPOINTS,

  hubGridColumns,

  isLandscapeViewport,

  isPortraitViewport,

  shouldStackPanels,

  shouldStackToolbar,

  shouldUseComfortableTable,

} from '../constants/layout';



export type Breakpoint = {

  width: number;

  height: number;

  isPhone: boolean;

  isTablet: boolean;

  isDesktop: boolean;

  /** true en teléfono + tablet: usar layout apilado / controles más grandes. */

  isCompact: boolean;

  /** Vertical: altura >= ancho. */

  isPortrait: boolean;

  /** Horizontal: ancho > altura. */

  isLandscape: boolean;

  /** Apilar lista + detalle / tabla + panel lateral. */

  shouldStackPanels: boolean;

  /** Apilar filtros de toolbar en varias filas. */

  shouldStackToolbar: boolean;

  /** Modo cómodo en tablas (filas/tipografía ampliadas). */

  shouldUseComfortableTable: boolean;

  /** Columnas para grids de tarjetas (1 o 2). */

  hubGridColumns: number;

};



export function useBreakpoint(): Breakpoint {

  const { width, height } = useWindowDimensions();

  const isPhone = width < BREAKPOINTS.phone;

  const isTablet = width >= BREAKPOINTS.phone && width < BREAKPOINTS.tablet;

  const isDesktop = width >= BREAKPOINTS.tablet;

  const isPortrait = isPortraitViewport(width, height);

  const isLandscape = isLandscapeViewport(width, height);

  return {

    width,

    height,

    isPhone,

    isTablet,

    isDesktop,

    isCompact: !isDesktop,

    isPortrait,

    isLandscape,

    shouldStackPanels: shouldStackPanels(width, height),

    shouldStackToolbar: shouldStackToolbar(width, height),

    shouldUseComfortableTable: shouldUseComfortableTable(width, height),

    hubGridColumns: hubGridColumns(width, height),

  };

}


