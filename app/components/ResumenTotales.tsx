import { View, Text, StyleSheet } from 'react-native';
import { formatMoneda } from '../utils/facturacion';

type DesgloseIva = { tipo_iva: number; base: number; iva: number };

type Props = {
  base_imponible: number;
  total_iva: number;
  total_retencion: number;
  total_factura: number;
  desglose_iva?: DesgloseIva[];
  total_cobrado?: number;
  saldo_pendiente?: number;
  compact?: boolean;
};

export function ResumenTotales({
  base_imponible,
  total_iva,
  total_retencion,
  total_factura,
  desglose_iva,
  total_cobrado,
  saldo_pendiente,
  compact,
}: Props) {
  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <Row label="Base imponible" value={base_imponible} />
      {desglose_iva && desglose_iva.length > 0 && desglose_iva.map((d) => (
        <Row key={d.tipo_iva} label={`IVA ${d.tipo_iva}% (s/ ${formatMoneda(d.base)})`} value={d.iva} />
      ))}
      {(!desglose_iva || desglose_iva.length === 0) && <Row label="IVA" value={total_iva} />}
      {total_retencion > 0 && <Row label="Retención" value={-total_retencion} negative />}
      <View style={styles.divider} />
      <Row label="TOTAL" value={total_factura} bold />
      {total_cobrado != null && total_cobrado > 0 && <Row label="Cobrado" value={total_cobrado} positive />}
      {saldo_pendiente != null && saldo_pendiente > 0 && <Row label="Pendiente" value={saldo_pendiente} warning />}
    </View>
  );
}

function Row({ label, value, bold, negative, positive, warning }: {
  label: string;
  value: number;
  bold?: boolean;
  negative?: boolean;
  positive?: boolean;
  warning?: boolean;
}) {
  const color = negative ? '#dc2626' : positive ? '#059669' : warning ? '#b45309' : '#334155';
  return (
    <View style={styles.row}>
      <Text style={[styles.label, bold && styles.labelBold]}>{label}</Text>
      <Text style={[styles.value, bold && styles.valueBold, { color }]}>{formatMoneda(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    gap: 4,
    minWidth: 240,
  },
  wrapCompact: {
    padding: 8,
    minWidth: 180,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  label: {
    fontSize: 12,
    color: '#64748b',
  },
  labelBold: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
  },
  value: {
    fontSize: 12,
    fontWeight: '500',
  },
  valueBold: {
    fontSize: 14,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 4,
  },
});
