import { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatFecha } from '../utils/formatFecha';
import { formatMoneda } from '../utils/formatMoneda';
import type { DetalleVentasCampana, FiltroVentasCampana, LocalVentaCampana } from '../types/ventasCampana';

type Props = {
  loading: boolean;
  error: string | null;
  data: DetalleVentasCampana | null;
  localesMap: Record<string, string>;
  filtro?: FiltroVentasCampana;
  titulo?: string;
  embedded?: boolean;
};

function filtrarDetalle(data: DetalleVentasCampana | null, filtro?: FiltroVentasCampana): LocalVentaCampana[] {
  if (!data?.porLocal?.length) return [];
  const { productId, localId, agoraUserId, fecha } = filtro || {};

  return data.porLocal
    .filter((l) => !localId || l.localId === localId)
    .map((local) => {
      const porUsuario = local.porUsuario
        .filter((u) => !agoraUserId || u.agoraUserId === agoraUserId)
        .map((u) => {
          const lineas = u.lineas.filter((ln) => {
            if (productId && ln.productId !== productId) return false;
            if (fecha && ln.fecha !== fecha) return false;
            return true;
          });
          if (lineas.length === 0) return null;
          const totalUnidades = lineas.reduce((a, ln) => a + ln.unidades, 0);
          const totalImporte = Math.round(lineas.reduce((a, ln) => a + ln.importe, 0) * 100) / 100;
          const totalIncentivo = Math.round(lineas.reduce((a, ln) => a + ln.incentivo, 0) * 100) / 100;
          return {
            ...u,
            lineas: [...lineas].sort((a, b) => a.fecha.localeCompare(b.fecha)),
            totalUnidades,
            totalImporte,
            totalIncentivo,
          };
        })
        .filter(Boolean) as typeof local.porUsuario;

      if (porUsuario.length === 0) return null;
      return {
        ...local,
        porUsuario,
        totalUnidades: Math.round(porUsuario.reduce((a, u) => a + u.totalUnidades, 0) * 1000) / 1000,
        totalIncentivo: Math.round(porUsuario.reduce((a, u) => a + u.totalIncentivo, 0) * 100) / 100,
      };
    })
    .filter(Boolean) as LocalVentaCampana[];
}

export function VentasCampanaPanel({
  loading,
  error,
  data,
  localesMap,
  filtro,
  titulo,
  embedded = false,
}: Props) {
  const nombreLocal = useCallback(
    (id: string) => localesMap[id] || `Local ${id}`,
    [localesMap],
  );

  const porLocal = useMemo(() => filtrarDetalle(data, filtro), [data, filtro]);

  const totales = useMemo(() => ({
    unidades: porLocal.reduce((a, l) => a + l.totalUnidades, 0),
    incentivo: Math.round(porLocal.reduce((a, l) => a + l.totalIncentivo, 0) * 100) / 100,
  }), [porLocal]);

  const sinVentas = !loading && !error && porLocal.length === 0;

  return (
    <View style={[styles.wrap, embedded && styles.wrapEmbedded]}>
      <View style={styles.panelHeader}>
        <MaterialIcons name="receipt-long" size={16} color="#0ea5e9" />
        <Text style={styles.panelTitulo} numberOfLines={2}>
          {titulo || 'Detalle de ventas'}
        </Text>
      </View>

      {!loading && !error && !sinVentas ? (
        <View style={styles.totalesBar}>
          <Text style={styles.totalesText}>
            {totales.unidades.toLocaleString('es-ES')} uds · Incentivo {formatMoneda(totales.incentivo)}
          </Text>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {loading ? (
          <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
        ) : error ? (
          <View style={styles.center}>
            <MaterialIcons name="error-outline" size={28} color="#f87171" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : sinVentas ? (
          <View style={styles.center}>
            <MaterialIcons name="inbox" size={32} color="#cbd5e1" />
            <Text style={styles.vacioText}>
              {filtro ? 'Sin ventas para esta selección.' : 'Sin ventas registradas en el periodo.'}
            </Text>
          </View>
        ) : (
          porLocal.map((local) => (
            <View key={local.localId} style={styles.localBlock}>
              <View style={styles.localHeader}>
                <MaterialIcons name="store" size={16} color="#0369a1" />
                <Text style={styles.localTitulo}>{nombreLocal(local.localId)}</Text>
                <Text style={styles.localResumen}>
                  {local.totalUnidades.toLocaleString('es-ES')} uds · {formatMoneda(local.totalIncentivo)}
                </Text>
              </View>

              {local.porUsuario.map((u) => (
                <View key={u.agoraUserId} style={styles.userBlock}>
                  <View style={styles.userHeader}>
                    <MaterialIcons name="person" size={14} color="#64748b" />
                    <Text style={styles.userNombre} numberOfLines={1}>
                      {u.userName || `Usuario ${u.agoraUserId}`}
                    </Text>
                    <Text style={styles.userResumen}>
                      {u.totalUnidades.toLocaleString('es-ES')} uds · {formatMoneda(u.totalIncentivo)}
                    </Text>
                  </View>

                  <View style={styles.tabla}>
                    <View style={[styles.fila, styles.filaHead]}>
                      <Text style={[styles.celda, styles.colFecha, styles.headText]}>Fecha</Text>
                      <Text style={[styles.celda, styles.colProd, styles.headText]}>Producto</Text>
                      <Text style={[styles.celda, styles.colNum, styles.headText]}>Uds</Text>
                      <Text style={[styles.celda, styles.colNum, styles.headText]}>Incentivo</Text>
                    </View>
                    {u.lineas.map((l, i) => (
                      <View key={`${l.fecha}-${l.productId}-${i}`} style={styles.fila}>
                        <Text style={[styles.celda, styles.colFecha]}>{formatFecha(l.fecha)}</Text>
                        <Text style={[styles.celda, styles.colProd]} numberOfLines={1}>{l.productName}</Text>
                        <Text style={[styles.celda, styles.colNum]}>{l.unidades.toLocaleString('es-ES')}</Text>
                        <Text style={[styles.celda, styles.colNum]}>{formatMoneda(l.incentivo)}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    minHeight: 280,
  },
  wrapEmbedded: { borderRadius: 0, borderWidth: 0 },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  panelTitulo: { fontSize: 13, fontWeight: '700', color: '#334155', flex: 1 },
  totalesBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#f0f9ff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0f2fe',
  },
  totalesText: { fontSize: 12, fontWeight: '700', color: '#0369a1' },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, gap: 14, paddingBottom: 16 },
  center: { paddingVertical: 32, alignItems: 'center', gap: 10 },
  errorText: { fontSize: 13, color: '#dc2626', textAlign: 'center' },
  vacioText: { fontSize: 13, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', paddingHorizontal: 12 },

  localBlock: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    overflow: 'hidden',
  },
  localHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  localTitulo: { fontSize: 13, fontWeight: '800', color: '#0f172a', flex: 1, minWidth: 0 },
  localResumen: { fontSize: 11, fontWeight: '700', color: '#0369a1' },

  userBlock: { paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  userHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  userNombre: { fontSize: 12, fontWeight: '700', color: '#334155', flex: 1, minWidth: 0 },
  userResumen: { fontSize: 11, fontWeight: '600', color: '#16a34a' },

  tabla: { borderWidth: 1, borderColor: '#f1f5f9', borderRadius: 6, overflow: 'hidden' },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  filaHead: { backgroundColor: '#f8fafc' },
  celda: { fontSize: 11, color: '#334155' },
  headText: { fontWeight: '700', color: '#64748b', textTransform: 'uppercase', fontSize: 10 },
  colFecha: { width: 92 },
  colProd: { flex: 1, minWidth: 0, paddingRight: 6 },
  colNum: { width: 74, textAlign: 'right' },
});
