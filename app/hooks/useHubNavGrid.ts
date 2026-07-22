import { useBreakpoint } from './useBreakpoint';
import { hubCardSpanWidthPercent, hubCardWidthPercent } from '../constants/layout';

/** Grid de tarjetas hub: 1 col móvil, 2 tablet, 3 escritorio. */
export function useHubNavGrid() {
  const { hubGridColumns, isDesktop } = useBreakpoint();
  const gridColumns = isDesktop ? 3 : hubGridColumns;
  const cardWidth = hubCardWidthPercent(gridColumns);
  /** Ancho de una fila de 3 tarjetas (o fila completa en móvil/tablet). */
  const rowSpanWidth = hubCardSpanWidthPercent(gridColumns >= 3 ? 3 : gridColumns, gridColumns);
  return { cardWidth, compact: isDesktop, gridColumns, rowSpanWidth };
}