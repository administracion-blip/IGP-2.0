import { useMemo } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { formatMoneda, labelMetodoPagoDisplay } from '../utils/facturacion';
import { formatFechaPagoRow } from '../utils/formatFecha';

export type ModalDetallePagosTablaProps = {
  loading: boolean;
  loadingText: string;
  error: string | null;
  emptyText: string;
  pagos: Record<string, unknown>[];
  /** Etiqueta de la fila de totales (p. ej. «Total cobrado» / «Total pagado»). */
  totalLabel?: string;
};

/**
 * Tabla de pagos/cobros para modales (emitidas y recibidas): cabecera, filas y total.
 */
export function ModalDetallePagosTabla({
  loading,
  loadingText,
  error,
  emptyText,
  pagos,
  totalLabel = 'Total',
}: ModalDetallePagosTablaProps) {
  const totalImportes = useMemo(
    () => pagos.reduce((s, p) => s + Number(p.importe ?? 0), 0),
    [pagos],
  );

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.loadingText}>{loadingText}</Text>
      </View>
    );
  }

  if (error) {
    return <Text style={styles.errorText}>{error}</Text>;
  }

  if (pagos.length === 0) {
    return <Text style={styles.emptyText}>{emptyText}</Text>;
  }

  return (
    <View style={styles.tableOuter}>
      <View style={styles.tableHeader}>
        <Text style={[styles.th, styles.colFecha]}>Fecha</Text>
        <Text style={[styles.th, styles.colImporte]}>Importe</Text>
        <Text style={[styles.th, styles.colMetodo]}>Método</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
      >
        {pagos.map((p, idx) => {
          const rawFecha = p.fecha != null ? String(p.fecha) : '';
          const imp = Number(p.importe ?? 0);
          const metodoRaw = p.metodo_pago != null ? String(p.metodo_pago) : '';
          const ref = p.referencia != null ? String(p.referencia).trim() : '';
          const obs = p.observaciones != null ? String(p.observaciones).trim() : '';
          const hasExtra = Boolean(ref || obs);
          return (
            <View
              key={idx}
              style={[styles.dataBlock, idx % 2 === 1 && styles.dataBlockAlt]}
            >
              <View style={styles.dataRow}>
                <Text style={[styles.td, styles.colFecha]} numberOfLines={1}>
                  {formatFechaPagoRow(rawFecha)}
                </Text>
                <Text style={[styles.td, styles.tdImporte, styles.colImporte]} numberOfLines={1}>
                  {formatMoneda(imp)}
                </Text>
                <Text style={[styles.td, styles.colMetodo]} numberOfLines={2}>
                  {labelMetodoPagoDisplay(metodoRaw)}
                </Text>
              </View>
              {hasExtra ? (
                <View style={styles.extraRow}>
                  {ref ? (
                    <Text style={styles.extraText} numberOfLines={2}>
                      <Text style={styles.extraLabel}>Ref.: </Text>
                      {ref}
                    </Text>
                  ) : null}
                  {obs ? (
                    <Text style={styles.extraText} numberOfLines={3}>
                      {obs}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.totalRow}>
        <Text style={styles.totalLabelText}>{totalLabel}</Text>
        <Text style={styles.totalValue}>{formatMoneda(totalImportes)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 20,
  },
  loadingText: { fontSize: 13, color: '#64748b' },
  errorText: { fontSize: 12, color: '#dc2626', lineHeight: 18 },
  emptyText: {
    fontSize: 13,
    color: '#64748b',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 16,
  },

  tableOuter: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#fff',
    elevation: 2,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  th: {
    fontSize: 10,
    fontWeight: '700',
    color: '#475569',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  colFecha: { flex: 1.1, minWidth: 76 },
  colImporte: { flex: 0.95, minWidth: 80, textAlign: 'right' },
  colMetodo: { flex: 1.35, minWidth: 96, flexShrink: 1 },

  scroll: {
    maxHeight: 300,
  },
  scrollContent: {
    paddingBottom: 0,
  },
  dataBlock: {
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  dataBlockAlt: {
    backgroundColor: '#f8fafc',
  },
  dataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  td: {
    fontSize: 12,
    color: '#334155',
  },
  tdImporte: {
    fontWeight: '600',
    color: '#047857',
  },
  extraRow: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 0,
    gap: 4,
  },
  extraLabel: { fontWeight: '600', color: '#94a3b8', fontSize: 11 },
  extraText: { fontSize: 11, color: '#64748b', lineHeight: 16 },

  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#f1f5f9',
    borderTopWidth: 2,
    borderTopColor: '#cbd5e1',
  },
  totalLabelText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    letterSpacing: 0.2,
  },
  totalValue: {
    fontSize: 15,
    fontWeight: '800',
    color: '#047857',
  },
});
