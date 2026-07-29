import { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { copyToClipboard } from '../utils/clipboard';

type Props = {
  idFactura: string;
  compact?: boolean;
};

/** Identificador interno de la factura (UUID en DynamoDB), con copia al portapapeles. */
export function CampoIdFactura({ idFactura, compact = false }: Props) {
  const [copiado, setCopiado] = useState(false);

  const onCopiar = useCallback(async () => {
    if (!idFactura.trim()) return;
    const ok = await copyToClipboard(idFactura);
    if (!ok) return;
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }, [idFactura]);

  if (!idFactura.trim()) return null;

  return (
    <View style={compact ? styles.wrapCompact : styles.wrap}>
      <Text style={[styles.label, compact && styles.labelCompact]}>ID</Text>
      <Pressable
        onPress={onCopiar}
        style={({ pressed }) => [
          styles.campo,
          compact && styles.campoCompact,
          pressed && styles.campoPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Copiar ID de factura al portapapeles"
      >
        <Text style={[styles.valor, compact && styles.valorCompact]} selectable numberOfLines={2}>
          {idFactura}
        </Text>
        <MaterialIcons name="content-copy" size={compact ? 16 : 18} color={copiado ? '#16a34a' : '#0ea5e9'} />
      </Pressable>
      {copiado ? (
        <Text style={[styles.hintCopiado, compact && styles.hintCopiadoCompact]}>Copiado al portapapeles</Text>
      ) : (
        <Text style={[styles.hint, compact && styles.hintCompact]}>Pulsa para copiar</Text>
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
    alignItems: 'center',
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
  campoPressed: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  valor: {
    flex: 1,
    fontSize: 13,
    color: '#0f172a',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  valorCompact: { fontSize: 11 },
  hint: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
  hintCompact: { fontSize: 10, marginTop: 2 },
  hintCopiado: { fontSize: 11, color: '#16a34a', marginTop: 4, fontWeight: '600' },
  hintCopiadoCompact: { fontSize: 10, marginTop: 2 },
});
