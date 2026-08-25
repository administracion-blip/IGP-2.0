import { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { NotaLinea } from '../lib/acuerdoNotas';
import { NOTAS_CONTENIDO_FONT_SIZE } from '../lib/acuerdoNotas';

const FECHA_STYLE = {
  fontSize: NOTAS_CONTENIDO_FONT_SIZE + 1,
  color: '#2563eb',
  fontWeight: '700' as const,
  fontStyle: 'italic' as const,
};

/** Líneas visibles antes de pedir «Ver más». */
const PREVIEW_LINES = 3;

type Props = {
  items: NotaLinea[];
  emptyLabel?: string;
  /** Si se indica, muestra botón eliminar en cada nota. */
  onEliminar?: (ordenOriginal: number) => void;
  eliminando?: boolean;
};

function NotaCard({
  item,
  isFirst,
  onEliminar,
  eliminando,
}: {
  item: NotaLinea;
  isFirst: boolean;
  onEliminar?: (ordenOriginal: number) => void;
  eliminando?: boolean;
}) {
  const [expandida, setExpandida] = useState(false);
  const [overflowPorLayout, setOverflowPorLayout] = useState(false);
  const texto = item.texto || '—';
  const overflowPorLongitud = texto.length > 100 || texto.includes('\n');
  const puedeTruncar = overflowPorLayout || overflowPorLongitud;

  return (
    <View style={[styles.card, isFirst && styles.cardActive]}>
      <View style={styles.cardHead}>
        {item.fecha ? (
          <Text style={FECHA_STYLE}>{item.fecha}</Text>
        ) : (
          <Text style={styles.sinFecha}>Sin fecha</Text>
        )}
        {onEliminar ? (
          <TouchableOpacity
            onPress={() => onEliminar(item.ordenOriginal)}
            disabled={eliminando}
            style={styles.deleteBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Eliminar nota"
          >
            <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
          </TouchableOpacity>
        ) : null}
      </View>
      <Text
        style={styles.texto}
        numberOfLines={expandida || !puedeTruncar ? undefined : PREVIEW_LINES}
        onTextLayout={(e) => {
          if (expandida || overflowPorLayout) return;
          const lines = e.nativeEvent?.lines?.length ?? 0;
          if (lines > PREVIEW_LINES) setOverflowPorLayout(true);
        }}
      >
        {texto}
      </Text>
      {puedeTruncar ? (
        <TouchableOpacity
          onPress={() => setExpandida((v) => !v)}
          style={styles.verMasBtn}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={expandida ? 'Ver menos' : 'Ver más'}
        >
          <Text style={styles.verMasText}>{expandida ? 'Ver menos' : 'Ver más'}</Text>
          <MaterialIcons
            name={expandida ? 'expand-less' : 'expand-more'}
            size={16}
            color="#6366f1"
          />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/**
 * Timeline vertical de notas de acuerdo (más reciente arriba).
 */
export function NotasTimeline({
  items,
  emptyLabel = 'Aún no hay notas en este acuerdo.',
  onEliminar,
  eliminando,
}: Props) {
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
            <NotaCard
              item={item}
              isFirst={isFirst}
              onEliminar={onEliminar}
              eliminando={eliminando}
            />
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
    minWidth: 0,
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
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  deleteBtn: {
    padding: 2,
    borderRadius: 6,
  },
  sinFecha: {
    fontSize: NOTAS_CONTENIDO_FONT_SIZE,
    color: '#94a3b8',
    fontStyle: 'italic',
    fontWeight: '600',
  },
  texto: {
    fontSize: NOTAS_CONTENIDO_FONT_SIZE + 2,
    color: '#334155',
    marginTop: 4,
    lineHeight: 18,
    ...(Platform.OS === 'web' ? ({ whiteSpace: 'pre-wrap' } as object) : null),
  },
  verMasBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  verMasText: { fontSize: 12, fontWeight: '600', color: '#6366f1' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, gap: 10 },
  emptyText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
});
