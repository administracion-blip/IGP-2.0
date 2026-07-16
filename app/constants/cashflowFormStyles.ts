import { StyleSheet, type TextStyle } from 'react-native';

/** Estilo unificado de campos en formularios cashflow (SelectorDesplegable, InputFecha, TextInput, importe). */
export const cashflowCampoStyle: TextStyle = {
  backgroundColor: '#f8fafc',
  borderWidth: 1.5,
  borderColor: '#e2e8f0',
  borderRadius: 10,
  paddingHorizontal: 10,
  paddingVertical: 8,
  fontSize: 13,
  fontWeight: '600',
  color: '#1e293b',
  minHeight: 46,
};

export const cashflowCampoFechaStyle: TextStyle = {
  ...cashflowCampoStyle,
  paddingRight: 36,
};

export const cashflowFormStyles = StyleSheet.create({
  campo: cashflowCampoStyle,
  campoFecha: cashflowCampoFechaStyle,
});
