import React from 'react';
import { Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { confColor } from '../../lib/registroMasivo';
import { useRegistroMasivoField } from '../../hooks/useRegistroMasivoFocusChain';

const zonaBtnWebProps =
  Platform.OS === 'web' ? ({ focusable: false, tabIndex: -1 } as object) : {};

/**
 * Fila label + input + botón "selección de zona OCR".
 * Igual que `FieldRow` pero añade un botón al final para activar la captura
 * de un campo desde una zona dibujada sobre el preview del documento.
 */
export function FieldRowZona({
  label,
  value,
  conf,
  onChange,
  numeric,
  placeholder,
  onZona,
  zonaActiva,
  onBlur,
  focusFieldId,
}: {
  label: string;
  value: string;
  conf?: string;
  onChange: (v: string) => void;
  numeric?: boolean;
  placeholder?: string;
  onZona: () => void;
  zonaActiva?: boolean;
  onBlur?: () => void;
  focusFieldId?: string;
}) {
  const focus = useRegistroMasivoField(focusFieldId);

  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldLabelWrap}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {conf && <View style={[styles.confDot, { backgroundColor: confColor(conf) }]} />}
      </View>
      <TextInput
        ref={focus.ref}
        style={[styles.fieldInput, numeric && { textAlign: 'right' as const }]}
        value={value}
        onChangeText={onChange}
        onBlur={onBlur}
        onFocus={focus.onFocus}
        onKeyDown={focus.onKeyDown as never}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
      />
      <TouchableOpacity
        onPress={onZona}
        style={[styles.zonaBtn, zonaActiva && styles.zonaBtnActive]}
        activeOpacity={0.7}
        {...zonaBtnWebProps}
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
