import { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { buildConceptoRemesaFacturaRecibida } from '../lib/conceptoRemesa';
import { copyToClipboard } from '../utils/clipboard';

type Props = {
  numeroFacturaProveedor?: string | null;
  numeroFactura?: string | null;
  proveedorNombre?: string | null;
  observaciones?: string | null;
  compact?: boolean;
};

export function CampoConceptoRemesaFacturaRecibida({
  numeroFacturaProveedor,
  numeroFactura,
  proveedorNombre,
  observaciones,
  compact = false,
}: Props) {
  const concepto = useMemo(
    () =>
      buildConceptoRemesaFacturaRecibida({
        numeroFacturaProveedor,
        numeroFactura,
        proveedorNombre,
        observaciones,
      }),
    [numeroFacturaProveedor, numeroFactura, proveedorNombre, observaciones],
  );

  const [copiado, setCopiado] = useState(false);

  const onCopiar = useCallback(async () => {
    if (!concepto) return;
    const ok = await copyToClipboard(concepto);
    if (!ok) return;
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }, [concepto]);

  return (
    <View style={compact ? styles.wrapCompact : styles.wrap}>
      <Text style={[styles.label, compact && styles.labelCompact]}>concepto</Text>
      <Pressable
        onPress={onCopiar}
        disabled={!concepto}
        style={({ pressed }) => [
          styles.campo,
          compact && styles.campoCompact,
          !concepto && styles.campoDisabled,
          pressed && concepto && styles.campoPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Copiar concepto remesa al portapapeles"
      >
        <Text style={[styles.valor, compact && styles.valorCompact]} selectable numberOfLines={4}>
          {concepto || '—'}
        </Text>
        <MaterialIcons
          name="content-copy"
          size={compact ? 16 : 18}
          color={!concepto ? '#cbd5e1' : copiado ? '#16a34a' : '#0ea5e9'}
        />
      </Pressable>
      {copiado ? (
        <Text style={[styles.hintCopiado, compact && styles.hintCopiadoCompact]}>Copiado al portapapeles</Text>
      ) : (
        <Text style={[styles.hint, compact && styles.hintCompact]}>
          {concepto ? 'Pulsa para copiar · máx. 140 caracteres (remesa)' : 'Escribe Observaciones o completa nº proveedor y proveedor'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  wrapCompact: { marginBottom: 8 },
  label: { fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: '500' },
  labelCompact: { fontSize: 11, marginBottom: 2 },
  campo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  campoCompact: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
  },
  campoDisabled: { backgroundColor: '#f1f5f9' },
  campoPressed: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  valor: {
    flex: 1,
    fontSize: 13,
    color: '#0f172a',
    lineHeight: 18,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  valorCompact: { fontSize: 11, lineHeight: 16 },
  hint: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
  hintCompact: { fontSize: 10, marginTop: 2 },
  hintCopiado: { fontSize: 11, color: '#16a34a', marginTop: 4, fontWeight: '600' },
  hintCopiadoCompact: { fontSize: 10, marginTop: 2 },
});
