import { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatMoneda } from '../../../utils/facturacion';
import { formatFecha } from '../../../utils/formatFecha';
import {
  COLOR_ESTADO_DEUDA,
  COLOR_INTRAGRUPO,
  ETIQUETA_ESTADO_DEUDA,
  textoNetoIntragrupo,
} from '../../../lib/deudaProveedores';
import { MIN_TOUCH } from '../../../constants/layout';
import type { ProveedorDeuda } from '../../../types/deudaProveedores';

type Props = {
  proveedor: ProveedorDeuda;
  seleccionada: boolean;
  comodo: boolean;
  onPress: (clave: string) => void;
};

function TarjetaProveedorDeudaBase({ proveedor: p, seleccionada, comodo, onPress }: Props) {
  const estilo = COLOR_ESTADO_DEUDA[p.estado] ?? COLOR_ESTADO_DEUDA.pendiente;
  const pct = Math.max(0, Math.min(100, Number(p.pctPagado) || 0));
  const pendienteAnterior = Number(p.anterior?.pendiente) || 0;
  const neto = p.intragrupo ? textoNetoIntragrupo(p.intragrupo.leDebemos, p.intragrupo.nosDebe) : null;

  return (
    <TouchableOpacity
      style={[styles.card, comodo && styles.cardComodo, seleccionada && styles.cardSel]}
      onPress={() => onPress(p.clave)}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityState={{ selected: seleccionada }}
      accessibilityLabel={`Proveedor ${p.nombre}`}
    >
      <View style={styles.filaTitulo}>
        <View style={styles.tituloWrap}>
          <Text style={styles.nombre} numberOfLines={1}>{p.nombre || '—'}</Text>
          {p.cif ? <Text style={styles.cif} numberOfLines={1}>{p.cif}</Text> : null}
        </View>
        <View style={styles.badges}>
          {p.intragrupo ? (
            <View style={[styles.badge, styles.badgeIntragrupo]}>
              <Text style={[styles.badgeTexto, { color: COLOR_INTRAGRUPO }]}>Intragrupo</Text>
            </View>
          ) : null}
          {p.saldoAFavor ? (
            <View style={[styles.badge, styles.badgeFavor]}>
              <Text style={[styles.badgeTexto, { color: '#0369a1' }]}>Saldo a favor</Text>
            </View>
          ) : null}
          <View style={[styles.badge, { backgroundColor: estilo.bg, borderColor: estilo.border }]}>
            <Text style={[styles.badgeTexto, { color: estilo.color }]}>{ETIQUETA_ESTADO_DEUDA[p.estado] ?? p.estado}</Text>
          </View>
        </View>
      </View>

      <View style={styles.cifras}>
        <View style={styles.cifra}>
          <Text style={styles.cifraLabel}>Facturado</Text>
          <Text style={styles.cifraValor} numberOfLines={1}>{formatMoneda(p.facturado)}</Text>
        </View>
        <View style={styles.cifra}>
          <Text style={styles.cifraLabel}>Pagado</Text>
          <Text style={[styles.cifraValor, { color: '#16a34a' }]} numberOfLines={1}>{formatMoneda(p.pagado)}</Text>
        </View>
        <View style={styles.cifra}>
          <Text style={styles.cifraLabel}>Pendiente</Text>
          <Text
            style={[styles.cifraValor, { color: p.pendiente > 0.005 ? estilo.color : '#0f172a' }]}
            numberOfLines={1}
          >
            {formatMoneda(p.pendiente)}
          </Text>
        </View>
      </View>

      <View style={styles.progresoFila}>
        <View style={styles.progreso}>
          <View style={[styles.progresoRelleno, { width: `${pct}%`, backgroundColor: pct >= 99.5 ? '#16a34a' : '#0ea5e9' }]} />
        </View>
        <Text style={styles.progresoTexto}>{Math.round(pct)} % pagado</Text>
      </View>

      {p.vencido > 0.005 ? (
        <Text style={styles.lineaVencido} numberOfLines={1}>
          Vencido {formatMoneda(p.vencido)}
          {p.vencimientoMasAntiguo ? ` · desde ${formatFecha(p.vencimientoMasAntiguo.slice(0, 10))}` : ''}
        </Text>
      ) : null}

      {pendienteAnterior > 0.005 ? (
        <View style={styles.lineaAnterior}>
          <MaterialIcons name="history" size={14} color="#b45309" />
          <Text style={styles.lineaAnteriorTexto} numberOfLines={1}>
            Pendiente anterior al periodo: {formatMoneda(pendienteAnterior)}
          </Text>
        </View>
      ) : null}

      {p.intragrupo && neto ? (
        <View style={styles.intragrupo}>
          <Text style={styles.intragrupoTexto}>
            Le debemos {formatMoneda(p.intragrupo.leDebemos)} · Nos debe {formatMoneda(p.intragrupo.nosDebe)}
            {p.intragrupo.nosDebeParcial ? ' (parcial)' : ''}
          </Text>
          <Text style={styles.intragrupoNeto}>
            Neto: {neto.importe === 0 ? 'cuadrado' : `${neto.texto} ${formatMoneda(neto.importe)}`}
          </Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

export const TarjetaProveedorDeuda = memo(TarjetaProveedorDeudaBase);

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    gap: 8,
  },
  cardComodo: { minHeight: MIN_TOUCH, padding: 14 },
  cardSel: { borderColor: '#0ea5e9', borderWidth: 1.5, backgroundColor: '#f0f9ff' },
  filaTitulo: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tituloWrap: { flex: 1, minWidth: 0 },
  nombre: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  cif: { fontSize: 12, color: '#94a3b8', marginTop: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 4, maxWidth: '60%' },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  badgeIntragrupo: { backgroundColor: '#ede9fe', borderColor: '#ddd6fe' },
  badgeFavor: { backgroundColor: '#e0f2fe', borderColor: '#bae6fd' },
  badgeTexto: { fontSize: 11, fontWeight: '700' },
  cifras: { flexDirection: 'row', gap: 8 },
  cifra: { flex: 1, minWidth: 0 },
  cifraLabel: { fontSize: 11, color: '#64748b', fontWeight: '600' },
  cifraValor: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  progresoFila: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progreso: { flex: 1, height: 6, borderRadius: 999, backgroundColor: '#f1f5f9', overflow: 'hidden' },
  progresoRelleno: { height: '100%', borderRadius: 999 },
  progresoTexto: { fontSize: 11, color: '#64748b', fontWeight: '600', minWidth: 72, textAlign: 'right' },
  lineaVencido: { fontSize: 12, color: '#dc2626', fontWeight: '600' },
  lineaAnterior: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  lineaAnteriorTexto: { flex: 1, fontSize: 12, color: '#b45309', fontWeight: '600' },
  intragrupo: {
    backgroundColor: '#f5f3ff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ede9fe',
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 2,
  },
  intragrupoTexto: { fontSize: 12, color: '#5b21b6' },
  intragrupoNeto: { fontSize: 12, fontWeight: '700', color: COLOR_INTRAGRUPO },
});
