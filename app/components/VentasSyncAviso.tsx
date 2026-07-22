import { useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch } from '../utils/api';
import { formatCreadoEn } from '../utils/formatFecha';

type VentasSyncMeta = {
  lastSync: string | null;
  stale: boolean;
  hoursSince: number | null;
};

function textoHoras(hours: number): string {
  if (hours < 1) return 'menos de 1 h';
  if (hours < 24) return `${hours} h`;
  const dias = Math.floor(hours / 24);
  const resto = hours % 24;
  if (resto === 0) return `${dias} día${dias === 1 ? '' : 's'}`;
  return `${dias} día${dias === 1 ? '' : 's'} y ${resto} h`;
}

export function VentasSyncAviso() {
  const [meta, setMeta] = useState<VentasSyncMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const cargar = useCallback(() => {
    setLoading(true);
    apiFetch('/api/campanas/ventas-sync')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setMeta({
          lastSync: d.lastSync ?? null,
          stale: Boolean(d.stale),
          hoursSince: d.hoursSince ?? null,
        });
      })
      .catch(() => {
        setMeta({ lastSync: null, stale: true, hoursSince: null });
      })
      .finally(() => setLoading(false));
  }, []);

  useFocusEffect(
    useCallback(() => {
      cargar();
    }, [cargar]),
  );

  if (loading) {
    return (
      <View style={styles.barInfo}>
        <MaterialIcons name="cloud-sync" size={15} color="#64748b" />
        <Text style={styles.textInfo}>Comprobando sync de ventas Ágora…</Text>
      </View>
    );
  }

  if (!meta) return null;

  if (meta.stale) {
    const detalle = meta.lastSync
      ? `Última sync: ${formatCreadoEn(meta.lastSync)}${meta.hoursSince != null ? ` (hace ${textoHoras(meta.hoursSince)})` : ''}.`
      : 'No hay ninguna sincronización registrada.';
    return (
      <View style={styles.barWarn}>
        <MaterialIcons name="warning-amber" size={16} color="#b45309" />
        <View style={styles.textWrap}>
          <Text style={styles.textWarnTitle}>Ventas Ágora posiblemente desactualizadas</Text>
          <Text style={styles.textWarnBody}>
            {detalle} Los incentivos pueden estar incompletos. Revise con administración antes de cerrar campañas.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.barInfo}>
      <MaterialIcons name="cloud-done" size={15} color="#0f766e" />
      <View style={styles.textWrap}>
        <Text style={styles.textInfo}>
          Ventas Ágora: última sync {formatCreadoEn(meta.lastSync)}
          {meta.hoursSince != null && meta.hoursSince < 48 ? ` (hace ${textoHoras(meta.hoursSince)})` : ''}.
        </Text>
        <Text style={styles.textHint}>Sync diario nocturno · resync semanal lunes madrugada (semana anterior).</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  barInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f0fdfa',
    borderWidth: 1,
    borderColor: '#99f6e4',
  },
  barWarn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
  },
  textWrap: { flex: 1, minWidth: 0, gap: 2 },
  textInfo: { fontSize: 11, color: '#0f766e', fontWeight: '600', lineHeight: 15 },
  textHint: { fontSize: 10, color: '#64748b', lineHeight: 14 },
  textWarnTitle: { fontSize: 11, color: '#92400e', fontWeight: '700', lineHeight: 15 },
  textWarnBody: { fontSize: 10, color: '#78350f', lineHeight: 14 },
});
