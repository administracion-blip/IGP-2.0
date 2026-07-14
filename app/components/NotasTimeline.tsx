import { StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { NotaLinea } from '../lib/acuerdoNotas';
import { NOTAS_CONTENIDO_FONT_SIZE } from '../lib/acuerdoNotas';

const FECHA_STYLE = {
  fontSize: NOTAS_CONTENIDO_FONT_SIZE + 1,
  color: '#2563eb',
  fontWeight: '700' as const,
  fontStyle: 'italic' as const,
};

type Props = {
  items: NotaLinea[];
  emptyLabel?: string;
};

/**
 * Timeline vertical de notas de acuerdo (más reciente arriba).
 */
export function NotasTimeline({ items, emptyLabel = 'Aún no hay notas en este acuerdo.' }: Props) {
  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <MaterialIcons name="history" size={36} color="#cbd5e1" />
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {items.map((item, index) => {
        const isFirst = index === 0;
        const isLast = index === items.length - 1;
        return (
          <View key={item.id} style={styles.row}>
            <View style={styles.railCol}>
              <View style={[styles.dot, isFirst ? styles.dotActive : styles.dotMuted]} />
              {!isLast ? <View style={styles.line} /> : null}
            </View>
            <View style={[styles.card, isFirst && styles.cardActive]}>
              {item.fecha ? (
                <Text style={FECHA_STYLE}>{item.fecha}</Text>
              ) : (
                <Text style={styles.sinFecha}>Sin fecha</Text>
              )}
              <Text style={styles.texto}>{item.texto || '—'}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  railCol: { width: 22, alignItems: 'center', alignSelf: 'stretch' },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 6,
    borderWidth: 2,
    borderColor: '#fff',
  },
  dotActive: { backgroundColor: '#6366f1' },
  dotMuted: { backgroundColor: '#cbd5e1' },
  line: {
    flex: 1,
    width: 2,
    backgroundColor: '#e2e8f0',
    marginTop: 2,
    minHeight: 24,
  },
  card: {
    flex: 1,
    marginLeft: 8,
    marginBottom: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardActive: {
    backgroundColor: '#eef2ff',
    borderColor: '#c7d2fe',
  },
  sinFecha: { fontSize: NOTAS_CONTENIDO_FONT_SIZE, color: '#94a3b8', fontStyle: 'italic', fontWeight: '600' },
  texto: { fontSize: NOTAS_CONTENIDO_FONT_SIZE + 2, color: '#334155', marginTop: 4, lineHeight: 18 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, gap: 10 },
  emptyText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
});
