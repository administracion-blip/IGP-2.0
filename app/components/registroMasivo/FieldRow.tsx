import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { confColor } from '../../lib/registroMasivo';

/**
 * Fila label + input de texto para el formulario del registro masivo.
 * Si se proporciona `conf` (nivel de confianza OCR), se pinta un dot del
 * color correspondiente junto al label.
 */
export function FieldRow({
  label,
  value,
  conf,
  onChange,
  numeric,
  placeholder,
}: {
  label: string;
  value: string;
  conf?: string;
  onChange: (v: string) => void;
  numeric?: boolean;
  placeholder?: string;
}) {
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldLabelWrap}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {conf && <View style={[styles.confDot, { backgroundColor: confColor(conf) }]} />}
      </View>
      <TextInput
        style={[styles.fieldInput, numeric && { textAlign: 'right' as const }]}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
      />
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
});
