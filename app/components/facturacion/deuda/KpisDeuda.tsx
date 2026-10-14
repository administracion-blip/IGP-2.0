import type { ComponentProps } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatMoneda } from '../../../utils/facturacion';
import type { KpisDeudaProveedores } from '../../../types/deudaProveedores';

type IconName = ComponentProps<typeof MaterialIcons>['name'];

type Props = {
  kpis: KpisDeudaProveedores;
  /** 2 columnas en teléfono vertical, 4 en el resto. */
  columnas: 2 | 4;
};

type Tarjeta = {
  id: string;
  label: string;
  valor: number;
  icono: IconName;
  color: string;
  bg: string;
  pie?: string;
};

export function KpisDeuda({ kpis, columnas }: Props) {
  const tarjetas: Tarjeta[] = [
    {
      id: 'facturado',
      label: 'Facturado',
      valor: kpis.facturado,
      icono: 'receipt-long',
      color: '#0f172a',
      bg: '#f1f5f9',
      pie: `${kpis.numFacturas} factura${kpis.numFacturas === 1 ? '' : 's'} · ${kpis.numProveedores} proveedor${kpis.numProveedores === 1 ? '' : 'es'}`,
    },
    {
      id: 'pagado',
      label: 'Pagado',
      valor: kpis.pagado,
      icono: 'check-circle-outline',
      color: '#16a34a',
      bg: '#dcfce7',
      pie: kpis.facturado > 0 ? `${Math.round((kpis.pagado / kpis.facturado) * 100)} % del facturado` : undefined,
    },
    {
      id: 'pendiente',
      label: 'Pendiente',
      valor: kpis.pendiente,
      icono: 'hourglass-empty',
      color: '#d97706',
      bg: '#fef3c7',
      pie: kpis.pendienteAnterior > 0.005 ? `+ ${formatMoneda(kpis.pendienteAnterior)} anterior al periodo` : undefined,
    },
    {
      id: 'vencido',
      label: 'Vencido',
      valor: kpis.vencido,
      icono: 'error-outline',
      color: '#dc2626',
      bg: '#fee2e2',
      pie: kpis.vencidoAnterior > 0.005 ? `+ ${formatMoneda(kpis.vencidoAnterior)} anterior al periodo` : undefined,
    },
  ];

  return (
    <View style={styles.grid}>
      {tarjetas.map((t) => (
        <View key={t.id} style={[styles.card, columnas === 2 ? styles.card2 : styles.card4]}>
          <View style={styles.cabecera}>
            <View style={[styles.icono, { backgroundColor: t.bg }]}>
              <MaterialIcons name={t.icono} size={16} color={t.color} />
            </View>
            <Text style={styles.label}>{t.label}</Text>
          </View>
          <Text style={[styles.valor, { color: t.color }]} numberOfLines={1}>
            {formatMoneda(t.valor)}
          </Text>
          {t.pie ? (
            <Text style={styles.pie} numberOfLines={1}>{t.pie}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
    ...(Platform.OS === 'web' ? ({ boxShadow: '0 1px 2px rgba(15,23,42,0.04)' } as object) : {}),
  },
  card4: { flexGrow: 1, flexBasis: 0, minWidth: 160 },
  card2: { flexGrow: 1, flexBasis: '46%' as const },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  icono: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  valor: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  pie: { fontSize: 12, color: '#64748b' },
});
