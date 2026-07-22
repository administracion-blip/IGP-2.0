import { Platform, StyleSheet } from 'react-native';

/** Ancho mínimo de columna (patrón listado facturas de gasto). */
export const ERP_LIST_MIN_COL_WIDTH = 40;

/**
 * Estilos de tabla tipo listado ERP (referencia: facturas de gasto).
 * Variante «wrap»: celdas con texto completo (sin recorte) y cabeceras hasta 2 líneas.
 */
export const erpListTableStyles = StyleSheet.create({
  tableOuter: { flex: 1, minWidth: 0, minHeight: 0, width: '100%' as unknown as number, alignSelf: 'stretch' as const },
  tableWrapper: { flex: 1, minHeight: 0, minWidth: 0, width: '100%' as unknown as number },
  scroll: { flex: 1, minWidth: 0, width: '100%' as unknown as number, alignSelf: 'stretch' as const },
  scrollTable: { flex: 1, minWidth: 0, width: '100%' as unknown as number },
  tableScrollLtr: { direction: 'ltr' },
  scrollContent: { paddingBottom: 20, minWidth: '100%' as unknown as number },
  table: {
    flex: 1,
    minWidth: '100%' as unknown as number,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
    direction: 'ltr',
  },
  tableBodyScroll: { flex: 1 },
  tableBodyContent: { paddingBottom: 20 },

  rowHeader: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    ...(Platform.OS === 'web' ? { display: 'flex' as const } : {}),
  },
  cellHeader: {
    minWidth: ERP_LIST_MIN_COL_WIDTH,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRightWidth: 1,
    borderRightColor: '#cbd5e1',
    position: 'relative' as const,
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  cellHeaderText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#334155',
    lineHeight: 12,
  },
  resizeHandle: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    width: 6,
    height: '100%' as unknown as number,
    cursor: 'col-resize' as 'pointer',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' ? { display: 'flex' as const } : {}),
  },
  rowSelected: { backgroundColor: '#e0f2fe' },
  cell: {
    minWidth: ERP_LIST_MIN_COL_WIDTH,
    paddingVertical: 4,
    paddingHorizontal: 5,
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  cellText: {
    fontSize: 10,
    color: '#475569',
    lineHeight: 13,
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : {}),
  },
  cellCheckbox: {
    width: 40,
    minWidth: 40,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    paddingVertical: 4,
  },
  cellEmpty: {
    flex: 1,
    paddingVertical: 24,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellEmptyText: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
});

/** Cabeceras: hasta 2 líneas; el texto largo hace wrap en lugar de truncarse a 1 línea. */
export const ERP_LIST_HEADER_TEXT_PROPS = { numberOfLines: 2 as const };
