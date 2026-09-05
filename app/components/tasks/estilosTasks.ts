/**
 * Estilos compartidos del módulo de dirección (modales de formulario, campos y
 * chips). Consumen `tasksUiTokens` (piloto de diseño); el resto del ERP no se
 * ve afectado.
 */
import { Platform, StyleSheet, type ViewStyle } from 'react-native';
import { MIN_TOUCH } from '../../constants/layout';
import {
  tasksColor,
  tasksIcono,
  tasksRadius,
  tasksSombraFlotante,
  tasksSpace,
  tasksTipo,
} from '../../constants/tasksUiTokens';

/** Cuerpo scrolleable: deja hueco para padding del overlay + header + footer. */
const maxAltoCuerpo: ViewStyle['maxHeight'] =
  Platform.OS === 'web' ? ('calc(100vh - 180px)' as ViewStyle['maxHeight']) : 420;

export const estilosModalTasks = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: tasksColor.overlay,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    padding: tasksSpace[5],
  },
  cardWrap: { width: '100%', maxWidth: 920 },
  cardWrapAncho: { maxWidth: '100%' },
  /** Confirmaciones y vistazos que no deben heredar el ancho de formulario. */
  cardWrapEstrecho: { maxWidth: 480 },
  card: {
    width: '100%',
    backgroundColor: tasksColor.superficie,
    borderRadius: tasksRadius.contenedor,
    ...tasksSombraFlotante,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: tasksSpace[5],
    paddingVertical: tasksSpace[4],
    borderBottomWidth: 1,
    borderBottomColor: tasksColor.bordeSutil,
  },
  title: {
    ...tasksTipo.tituloSeccion,
    fontSize: 18,
    lineHeight: 24,
  },
  close: {
    padding: tasksSpace[1],
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    paddingHorizontal: tasksSpace[5],
    paddingVertical: tasksSpace[4],
    maxHeight: maxAltoCuerpo,
  },
  error: {
    ...tasksTipo.micro,
    color: tasksColor.peligro,
    paddingHorizontal: tasksSpace[5],
    paddingBottom: tasksSpace[1],
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: tasksSpace[2],
    paddingHorizontal: tasksSpace[5],
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: tasksColor.bordeSutil,
  },
  btn: {
    paddingVertical: tasksSpace[2],
    paddingHorizontal: tasksSpace[4],
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    borderRadius: tasksRadius.control,
    backgroundColor: tasksColor.superficieHundida,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: tasksSpace[5] },
  btnText: {
    fontSize: 13,
    fontWeight: '500',
    color: tasksColor.textoSecundario,
  },
  btnPrimario: {
    backgroundColor: tasksColor.acento,
    borderColor: tasksColor.acento,
  },
  btnTextPrimario: {
    fontSize: 13,
    fontWeight: '600',
    color: tasksColor.textoInverso,
  },
  btnPeligro: {
    backgroundColor: tasksColor.aviso,
    borderColor: tasksColor.aviso,
  },
  btnTextPeligro: {
    fontSize: 13,
    fontWeight: '600',
    color: tasksColor.textoInverso,
  },
  confirmCard: {
    width: '90%',
    maxWidth: 420,
    backgroundColor: tasksColor.superficie,
    borderRadius: tasksRadius.contenedor,
    padding: tasksSpace[5],
    ...tasksSombraFlotante,
    gap: tasksSpace[3],
  },
  confirmIcono: { alignSelf: 'center' },
  confirmTitle: {
    ...tasksTipo.tituloSeccion,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  confirmText: {
    ...tasksTipo.cuerpo,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  confirmDestacado: {
    fontWeight: '600',
    color: tasksColor.textoPrimario,
  },
  confirmBotones: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginTop: tasksSpace[1],
  },
});

export const estilosFormTasks = StyleSheet.create({
  group: { marginBottom: 14 },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  groupFila: { flexDirection: 'row', gap: 10 },
  groupMitad: { flex: 1, minWidth: 0 },
  gridDos: { flexDirection: 'row', gap: tasksSpace[3], alignItems: 'stretch' },
  gridDosApilado: { flexDirection: 'column' },
  col: { flex: 1, minWidth: 0 },
  label: {
    ...tasksTipo.etiqueta,
    marginBottom: tasksSpace[1],
  },
  input: {
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: tasksSpace[2],
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    borderRadius: tasksRadius.control,
    backgroundColor: tasksColor.superficieHundida,
    color: tasksColor.textoPrimario,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  inputMultilinea: { minHeight: 80, textAlignVertical: 'top' },
  inputMultilineaMedia: { minHeight: 110, textAlignVertical: 'top' },
  inputMultilineaLarga: { minHeight: 140, textAlignVertical: 'top' },
  help: {
    ...tasksTipo.micro,
    marginTop: tasksSpace[1],
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 6,
  },
  avisoTexto: {
    flex: 1,
    ...tasksTipo.micro,
    color: tasksColor.aviso,
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: tasksSpace[3],
    paddingVertical: 7,
    borderRadius: tasksRadius.pildora,
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    backgroundColor: tasksColor.superficieHundida,
    minHeight: 34,
    justifyContent: 'center',
  },
  chipTactil: { minHeight: MIN_TOUCH, paddingHorizontal: tasksSpace[4] },
  chipActivo: {
    borderColor: tasksColor.acento,
    backgroundColor: tasksColor.acentoSuave,
  },
  chipTexto: {
    fontSize: 12,
    fontWeight: '500',
    color: tasksColor.textoSecundario,
  },
  chipTextoActivo: {
    color: tasksColor.acentoTexto,
    fontWeight: '600',
  },
});

/** Tamaño/color de iconos de UI del módulo (cerrar, chevron, etc.). */
export const tasksIconoUi = {
  size: tasksIcono.size,
  color: tasksIcono.color,
} as const;
