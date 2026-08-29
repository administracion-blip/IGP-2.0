/**
 * Estilos compartidos del módulo de dirección (modales de formulario, campos y
 * chips). Son los mismos valores que usa `app/(app)/departamentos.tsx`: se
 * extraen aquí para que las fichas de proyecto y de tarea no los repitan y no
 * se desincronicen.
 */
import { Platform, StyleSheet, type ViewStyle } from 'react-native';
import { MIN_TOUCH } from '../../constants/layout';

/** Cuerpo scrolleable: deja hueco para padding del overlay + header + footer. */
const maxAltoCuerpo: ViewStyle['maxHeight'] =
  Platform.OS === 'web' ? ('calc(100vh - 180px)' as ViewStyle['maxHeight']) : 420;

export const estilosModalTasks = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', width: '100%', padding: 20 },
  cardWrap: { width: '100%', maxWidth: 920 },
  cardWrapAncho: { maxWidth: '100%' },
  /** Confirmaciones y vistazos que no deben heredar el ancho de formulario. */
  cardWrapEstrecho: { maxWidth: 480 },
  card: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: { fontSize: 18, fontWeight: '600', color: '#334155' },
  close: { padding: 4, minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 20, paddingVertical: 16, maxHeight: maxAltoCuerpo },
  error: { fontSize: 12, color: '#ef4444', paddingHorizontal: 20, paddingBottom: 4 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  btn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 20 },
  btnText: { fontSize: 13, fontWeight: '500', color: '#64748b' },
  btnPrimario: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  btnTextPrimario: { fontSize: 13, fontWeight: '600', color: '#ffffff' },
  btnPeligro: { backgroundColor: '#d97706', borderColor: '#d97706' },
  btnTextPeligro: { fontSize: 13, fontWeight: '600', color: '#ffffff' },
  confirmCard: {
    width: '90%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    gap: 12,
  },
  confirmIcono: { alignSelf: 'center' },
  confirmTitle: { fontSize: 16, fontWeight: '700', color: '#334155', textAlign: 'center' },
  confirmText: { fontSize: 13, color: '#475569', textAlign: 'center', lineHeight: 20 },
  confirmDestacado: { fontWeight: '700', color: '#334155' },
  confirmBotones: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginTop: 4 },
});

export const estilosFormTasks = StyleSheet.create({
  group: { marginBottom: 14 },
  groupRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  groupFila: { flexDirection: 'row', gap: 10 },
  groupMitad: { flex: 1, minWidth: 0 },
  gridDos: { flexDirection: 'row', gap: 12, alignItems: 'stretch' },
  gridDosApilado: { flexDirection: 'column' },
  col: { flex: 1, minWidth: 0 },
  label: { fontSize: 11, fontWeight: '500', color: '#475569', marginBottom: 4 },
  input: {
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    color: '#334155',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  inputMultilinea: { minHeight: 80, textAlignVertical: 'top' },
  inputMultilineaMedia: { minHeight: 110, textAlignVertical: 'top' },
  inputMultilineaLarga: { minHeight: 140, textAlignVertical: 'top' },
  help: { fontSize: 11, color: '#94a3b8', marginTop: 4, lineHeight: 16 },
  aviso: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  avisoTexto: { flex: 1, fontSize: 11, color: '#d97706', lineHeight: 16 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    minHeight: 34,
    justifyContent: 'center',
  },
  chipTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 16 },
  chipActivo: { borderColor: '#0ea5e9', backgroundColor: '#e0f2fe' },
  chipTexto: { fontSize: 12, fontWeight: '500', color: '#64748b' },
  chipTextoActivo: { color: '#0369a1', fontWeight: '700' },
});
