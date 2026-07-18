import { Platform, StyleSheet } from 'react-native';
import { colors, radius, shadowCard, SPACING, typography } from './theme';

/**
 * Patrón visual estándar para listados CRUD del ERP (Almacenes, Usuarios, maestros…).
 * - Tablas planas: sin sombra (boxShadow / elevation).
 * - Una sola línea de valor por celda salvo indicación explícita.
 */
export const ERP_ROW_HEIGHT = 36;

/** Estilos compartidos listados CRUD (patrón Facturación + tokens IGP). */
export const erpTableStyles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: SPACING.sm + 2,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: SPACING.md,
  },
  loadingText: {
    ...typography.cuerpo,
    color: colors.textSecondary,
  },
  errorText: {
    ...typography.cuerpo,
    color: colors.danger,
    textAlign: 'center',
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  backBtn: {
    padding: SPACING.xs,
    borderRadius: radius.sm,
  },
  title: {
    ...typography.titulo,
    flex: 1,
  },

  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
    gap: SPACING.md,
    flexWrap: 'wrap',
  },
  subtitle: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
    gap: SPACING.sm + 2,
    flexWrap: 'wrap',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs + 2,
  },
  toolbarBtnWrap: {
    position: 'relative',
  },
  toolbarBtn: {
    padding: SPACING.xs + 2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
  },
  toolbarBtnDisabled: {
    opacity: 0.5,
  },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    alignSelf: 'center',
    marginBottom: SPACING.xs,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: radius.sm,
    zIndex: 10,
  },
  tooltipText: {
    fontSize: 9,
    color: colors.bgSubtle,
    fontWeight: '400',
  },

  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs + 2,
    backgroundColor: colors.accent,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
    borderRadius: radius.md,
  },
  btnPrimaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.surface,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 140,
    maxWidth: 260,
    height: 32,
    backgroundColor: colors.bgSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.sm,
  },
  searchWrapFlex: {
    flex: 1,
    maxWidth: 260,
  },
  searchIcon: {
    marginRight: SPACING.xs + 2,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    color: colors.textPrimary,
    paddingVertical: 0,
  },

  scrollVertical: { flex: 1 },
  scrollVerticalContent: { flexGrow: 1, paddingBottom: SPACING.lg - 4 },
  scrollTable: { flexGrow: 0 },
  scrollTableContent: { flexGrow: 1 },

  table: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    direction: 'ltr',
    elevation: 0,
    shadowColor: 'transparent',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    ...(Platform.OS === 'web' ? ({ boxShadow: 'none' } as object) : {}),
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: colors.bgSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
    ...(Platform.OS === 'web' ? { display: 'flex' as const } : {}),
  },
  cellHeader: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.xs + 2,
    borderRightWidth: 1,
    borderRightColor: colors.borderStrong,
    position: 'relative',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  cellHeaderLast: {
    borderRightWidth: 0,
  },
  cellHeaderText: {
    ...typography.etiqueta,
    fontSize: 10,
    letterSpacing: 0.3,
    color: colors.textSecondary,
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 6,
    height: '100%',
    cursor: 'col-resize' as 'pointer',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: ERP_ROW_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
    backgroundColor: colors.surface,
    ...(Platform.OS === 'web' ? { display: 'flex' as const } : {}),
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowSelected: {
    backgroundColor: colors.accentMuted,
  },
  cell: {
    paddingVertical: SPACING.xs - 2,
    paddingHorizontal: SPACING.xs + 2,
    borderRightWidth: 1,
    borderRightColor: colors.borderStrong,
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  cellLast: {
    borderRightWidth: 0,
  },
  cellText: {
    fontSize: 10,
    color: colors.textSecondary,
    lineHeight: 13,
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : {}),
  },
  cellTextPrimary: {
    fontWeight: '600',
    color: colors.textPrimary,
  },
  cellTextRight: {
    textAlign: 'right' as const,
    alignSelf: 'stretch' as const,
  },
  cellCheckbox: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    borderRightWidth: 1,
    borderRightColor: colors.borderStrong,
    paddingVertical: SPACING.xs - 2,
  },
  toolbarBtnLabeled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs + 2,
    paddingVertical: SPACING.xs + 2,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
  },
  toolbarBtnLabeledText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  toolbarBtnLabeledActive: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary,
  },
  toolbarBtnLabeledTextActive: {
    color: colors.surface,
  },
  searchBuscarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.xs + 2,
    paddingHorizontal: SPACING.sm + 2,
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
  },
  searchBuscarBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.surface,
  },

  emptyRow: {
    padding: SPACING.xl,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  emptyText: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg - 4,
  },
  modalContent: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: SPACING.lg - 4,
    width: '100%',
    maxWidth: 400,
    ...shadowCard(),
  },
  modalTitle: {
    ...typography.subtitulo,
    marginBottom: SPACING.lg,
  },
  formRow: {
    marginBottom: SPACING.md,
  },
  formLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: SPACING.xs,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    minHeight: 40,
  },
  errorForm: {
    fontSize: 12,
    color: colors.danger,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.lg - 4,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm + 2,
    marginTop: SPACING.lg,
  },
  modalBtnCancel: {
    paddingVertical: SPACING.sm + 2,
    paddingHorizontal: SPACING.lg,
  },
  modalBtnCancelText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  modalBtnSave: {
    backgroundColor: colors.accent,
    paddingVertical: SPACING.sm + 2,
    paddingHorizontal: SPACING.lg - 4,
    borderRadius: radius.sm,
    minWidth: 100,
    alignItems: 'center',
  },
  modalBtnSaveText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.surface,
  },

  /** Modal ancho con cabecera, cuerpo scroll y pie (formularios complejos). */
  modalOverlayCenter: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.overlay,
  },
  modalContentWrap: {
    width: '100%',
    maxWidth: 420,
    padding: SPACING.xl,
    alignItems: 'center',
  },
  modalCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    overflow: 'hidden',
    ...shadowCard(),
  },
  modalCardWide: {
    maxWidth: 420,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg - 4,
    paddingVertical: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalHeaderTitle: {
    ...typography.subtitulo,
    fontSize: 18,
  },
  modalCloseBtn: {
    padding: SPACING.xs,
  },
  modalBodyRow: {
    flexDirection: 'row',
  },
  modalIdSide: {
    width: 56,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    alignItems: 'center',
  },
  modalIdLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 2,
  },
  modalIdValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  modalBodyScroll: {
    flex: 1,
    maxHeight: 400,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  formGroup: {
    marginBottom: SPACING.sm,
  },
  formInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  formInputText: {
    fontSize: 13,
    color: colors.textPrimary,
    flex: 1,
  },
  formInputPlaceholder: {
    color: colors.textMuted,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm + 2,
    paddingHorizontal: SPACING.lg - 4,
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dropdownWrap: {
    marginTop: SPACING.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
    maxHeight: 200,
  },
  dropdownSearch: {
    paddingVertical: SPACING.xs + 2,
    paddingHorizontal: SPACING.sm,
    fontSize: 11,
    color: colors.textPrimary,
    backgroundColor: colors.bgSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dropdownScroll: {
    maxHeight: 150,
  },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.xs + 1,
    paddingHorizontal: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
  },
  dropdownOptionText: {
    fontSize: 11,
    color: colors.textPrimary,
  },
  dropdownOptionSelected: {
    backgroundColor: colors.accentMuted,
  },
  dropdownVaciarOption: {
    backgroundColor: colors.bgSubtle,
    borderBottomColor: colors.border,
  },
  dropdownVaciarText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  dropdownCrearOption: {
    backgroundColor: colors.accentMuted,
    borderBottomColor: colors.border,
  },
  dropdownCrearText: {
    fontSize: 11,
    color: colors.accentPressed,
    fontWeight: '600',
  },
  localesChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs + 2,
  },
  localChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accentMuted,
    borderRadius: radius.pill,
    paddingVertical: 2,
    paddingLeft: SPACING.sm,
    paddingRight: SPACING.xs,
  },
  localChipText: {
    fontSize: 11,
    color: colors.accentPressed,
    fontWeight: '500',
    maxWidth: 120,
  },
  localChipRemove: {
    padding: 2,
    marginLeft: 2,
  },
});
