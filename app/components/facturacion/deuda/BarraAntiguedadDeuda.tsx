import { View, Text, StyleSheet } from 'react-native';
import { formatMoneda } from '../../../utils/facturacion';
import { TRAMOS_ANTIGUEDAD } from '../../../lib/deudaProveedores';
import type { AntiguedadDeuda } from '../../../types/deudaProveedores';

type Props = {
  antiguedad: AntiguedadDeuda;
  /** Facturas pendientes sin fecha de vencimiento (solo en el resumen global). */
  numSinVencimiento?: number;
  /** Variante pequeña para la cabecera del detalle: barra fina y leyenda compacta. */
  mini?: boolean;
  titulo?: string;
};

export function BarraAntiguedadDeuda({ antiguedad, numSinVencimiento, mini, titulo }: Props) {
  const tramos = TRAMOS_ANTIGUEDAD.map((t) => ({ ...t, valor: Math.max(0, Number(antiguedad[t.campo]) || 0) }));
  const total = tramos.reduce((acc, t) => acc + t.valor, 0);

  return (
    <View style={[styles.wrap, mini && styles.wrapMini]}>
      {titulo ? (
        <View style={styles.cabecera}>
          <Text style={styles.titulo}>{titulo}</Text>
          <Text style={styles.total}>{formatMoneda(total)}</Text>
        </View>
      ) : null}
      <View style={[styles.barra, mini && styles.barraMini]}>
        {total > 0 ? (
          tramos
            .filter((t) => t.valor > 0)
            .map((t) => (
              <View
                key={t.tramo}
                style={{ flexGrow: t.valor, flexBasis: 0, backgroundColor: t.color }}
                accessibilityLabel={`${t.label}: ${formatMoneda(t.valor)}`}
              />
            ))
        ) : (
          <View style={styles.barraVacia} />
        )}
      </View>
      <View style={styles.leyenda}>
        {tramos.map((t) => (
          <View key={t.tramo} style={styles.leyendaItem}>
            <View style={[styles.punto, { backgroundColor: t.color }]} />
            <Text style={[styles.leyendaTexto, mini && styles.leyendaTextoMini]}>
              {t.label}
              <Text style={styles.leyendaValor}> {formatMoneda(t.valor)}</Text>
            </Text>
          </View>
        ))}
      </View>
      {numSinVencimiento ? (
        <Text style={styles.nota}>
          {numSinVencimiento} factura{numSinVencimiento === 1 ? '' : 's'} sin fecha de vencimiento (cuentan como no vencidas)
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    gap: 8,
  },
  wrapMini: { padding: 0, borderWidth: 0, backgroundColor: 'transparent', gap: 6 },
  cabecera: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  titulo: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  total: { fontSize: 12, fontWeight: '700', color: '#64748b' },
  barra: {
    flexDirection: 'row',
    height: 12,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
    gap: 2,
  },
  barraMini: { height: 8 },
  barraVacia: { flex: 1, backgroundColor: '#f1f5f9' },
  leyenda: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4 },
  leyendaItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  punto: { width: 8, height: 8, borderRadius: 4 },
  leyendaTexto: { fontSize: 12, color: '#64748b' },
  leyendaTextoMini: { fontSize: 12 },
  leyendaValor: { fontWeight: '700', color: '#0f172a' },
  nota: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
});
