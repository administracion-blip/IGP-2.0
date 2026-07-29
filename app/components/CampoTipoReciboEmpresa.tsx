import React, { useMemo } from 'react';
import { View, Text, TextInput, StyleSheet, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { SelectorDesplegable } from './SelectorDesplegable';
import {
  OPCIONES_TIPO_RECIBO_EMPRESA,
  parseTipoReciboEmpresa,
  serializarTipoReciboEmpresa,
} from '../utils/empresaTipoRecibo';
import type { FormaPagoClave } from '../utils/facturacion';

type Props = {
  value: string;
  onChange: (stored: string) => void;
  disabled?: boolean;
  compact?: boolean;
  inputStyle?: StyleProp<ViewStyle>;
  otroInputStyle?: StyleProp<TextStyle>;
};

/**
 * Selector de «Tipo de recibo» para el maestro igp_Empresas.
 * Persiste etiqueta legible (p. ej. «Transferencia») o texto libre si elige «Otro».
 */
export function CampoTipoReciboEmpresa({
  value,
  onChange,
  disabled = false,
  compact = false,
  inputStyle,
  otroInputStyle,
}: Props) {
  const parsed = useMemo(() => parseTipoReciboEmpresa(value), [value]);
  const claveSeleccionada: FormaPagoClave = value.trim() ? parsed.clave : 'transferencia';
  const esOtro = claveSeleccionada === 'otro';

  return (
    <View style={styles.wrap}>
      <SelectorDesplegable
        compact={compact}
        icono="payments"
        placeholder="Tipo de recibo…"
        tituloLista="Tipo de recibo"
        iconoLista="payments"
        opciones={OPCIONES_TIPO_RECIBO_EMPRESA}
        valorId={claveSeleccionada}
        disabled={disabled}
        onSeleccionar={(id) => {
          const clave = id as FormaPagoClave;
          onChange(serializarTipoReciboEmpresa(clave, clave === 'otro' ? parsed.otroTexto : ''));
        }}
        triggerStyle={[styles.trigger, inputStyle]}
      />
      {esOtro ? (
        <View style={styles.otroWrap}>
          <Text style={styles.otroLabel}>Especificar</Text>
          <TextInput
            style={[styles.otroInput, otroInputStyle]}
            value={parsed.otroTexto}
            onChangeText={(t) => onChange(serializarTipoReciboEmpresa('otro', t))}
            placeholder="Describe el método de pago…"
            placeholderTextColor="#94a3b8"
            editable={!disabled}
            autoCapitalize="sentences"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  trigger: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  otroWrap: { gap: 4 },
  otroLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  otroInput: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 13,
    color: '#334155',
  },
});
