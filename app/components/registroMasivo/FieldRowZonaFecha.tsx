import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { confColor } from '../../lib/registroMasivo';
import { InputFecha } from '../InputFecha';
import { isoDesdeValor } from '../../utils/fechaInput';
import { fechaToIso } from '../../utils/formatFecha';

function normalizarIsoFecha(val: string): string {
  const s = val?.trim() ?? '';
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const fromDmy = isoDesdeValor(s, 'dmy');
  if (fromDmy) return fromDmy;
  const iso = fechaToIso(s);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

/**
 * Fila label + InputFecha + botón zona OCR (registro masivo).
 * El borrador guarda `fecha_emision` en ISO yyyy-mm-dd.
 */
export function FieldRowZonaFecha({
  label,
  valueIso,
  conf,
  onChangeIso,
  onZona,
  zonaActiva,
}: {
  label: string;
  valueIso: string;
  conf?: string;
  onChangeIso: (iso: string) => void;
  onZona: () => void;
  zonaActiva?: boolean;
}) {
  const iso = normalizarIsoFecha(valueIso);

  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldLabelWrap}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {conf && <View style={[styles.confDot, { backgroundColor: confColor(conf) }]} />}
      </View>
      <View style={styles.fieldInputWrap}>
        <InputFecha valueIso={iso} onChangeIso={onChangeIso} style={styles.fieldInput} />
      </View>
      <TouchableOpacity
        onPress={onZona}
        style={[styles.zonaBtn, zonaActiva && styles.zonaBtnActive]}
        activeOpacity={0.7}
      >
        <MaterialIcons name="crop-free" size={14} color={zonaActiva ? '#fff' : '#0ea5e9'} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 280 },
  fieldLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 3, width: 110 },
  fieldLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  confDot: { width: 7, height: 7, borderRadius: 4 },
  fieldInputWrap: { flex: 1 },
  fieldInput: {
    flex: 1,
    fontSize: 12,
    color: '#334155',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#f8fafc',
    minHeight: 28,
  },
  zonaBtn: {
    width: 26,
    height: 26,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zonaBtnActive: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0369a1',
  },
});
