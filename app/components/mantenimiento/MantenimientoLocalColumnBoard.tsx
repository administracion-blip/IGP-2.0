import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';

export type MantenimientoBoardColumn<T> = {
  key: string;
  title: string;
  count: number;
  urgentCount?: number;
  items: T[];
};

type Props<T> = {
  columns: MantenimientoBoardColumn<T>[];
  mode: 'board' | 'accordion';
  /** Columnas visibles en modo board (p. ej. 6 escritorio, 4 pantalla media). */
  boardCols?: number;
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
  renderCard: (item: T, index: number) => React.ReactNode;
  getItemKey: (item: T, index: number) => string;
  summary?: { locales: number; total: number; itemSingular?: string; itemPlural?: string };
  /** Ancho de cada columna en modo board (px). */
  columnWidthPx?: number;
};

const COL_GAP = 8;
const COL_MIN_WIDTH = 200;
const COL_MAX_WIDTH = 248;

export function MantenimientoLocalColumnBoard<T>({
  columns,
  mode,
  boardCols = 6,
  expandedKeys,
  onToggleExpand,
  renderCard,
  getItemKey,
  summary,
  columnWidthPx,
}: Props<T>) {
  const colWidth = columnWidthPx ?? COL_MAX_WIDTH;

  if (columns.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {summary ? (
        <Text style={styles.summary}>
          {summary.locales} {summary.locales === 1 ? 'local' : 'locales'} · {summary.total}{' '}
          {summary.total === 1
            ? (summary.itemSingular ?? 'reparación')
            : (summary.itemPlural ?? 'reparaciones')}
        </Text>
      ) : null}

      {mode === 'board' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.boardScroll}
        >
          {columns.map((col) => (
            <View
              key={col.key}
              style={[
                styles.column,
                {
                  width: colWidth,
                  minWidth: COL_MIN_WIDTH,
                  maxWidth: COL_MAX_WIDTH,
                },
              ]}
            >
              <ColumnHeader title={col.title} count={col.count} urgentCount={col.urgentCount} />
              <View style={styles.columnCards}>
                {col.items.map((item, idx) => (
                  <View key={getItemKey(item, idx)} style={styles.itemWrap}>
                    {renderCard(item, idx)}
                  </View>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.accordion}>
          {columns.map((col) => {
            const expanded = expandedKeys.has(col.key);
            return (
              <View key={col.key} style={styles.accordionSection}>
                <TouchableOpacity
                  style={[styles.accordionHeader, expanded && styles.accordionHeaderExpanded]}
                  onPress={() => onToggleExpand(col.key)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons
                    name={expanded ? 'expand-more' : 'chevron-right'}
                    size={22}
                    color="#64748b"
                  />
                  <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>{col.count}</Text>
                  </View>
                  <Text style={styles.accordionTitle} numberOfLines={1}>
                    {col.title}
                  </Text>
                  {col.urgentCount != null && col.urgentCount > 0 ? (
                    <View style={styles.urgentChip}>
                      <Text style={styles.urgentChipText}>
                        {col.urgentCount} urgente{col.urgentCount === 1 ? '' : 's'}
                      </Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
                {expanded ? (
                  <View style={styles.accordionBody}>
                    {col.items.map((item, idx) => (
                      <View key={getItemKey(item, idx)} style={styles.itemWrap}>
                        {renderCard(item, idx)}
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function ColumnHeader({
  title,
  count,
  urgentCount,
}: {
  title: string;
  count: number;
  urgentCount?: number;
}) {
  return (
    <View style={styles.columnHeader}>
      <View style={styles.columnHeaderRow}>
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{count}</Text>
        </View>
        <Text style={styles.columnTitle} numberOfLines={2}>
          {title}
        </Text>
      </View>
      {urgentCount != null && urgentCount > 0 ? (
        <View style={styles.urgentChip}>
          <Text style={styles.urgentChipText}>{urgentCount} urg.</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 10,
  },
  summary: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  boardScroll: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: COL_GAP,
    paddingBottom: 4,
  },
  column: {
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 8,
    alignSelf: 'flex-start',
  },
  columnHeader: {
    marginBottom: 6,
    gap: 4,
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  columnHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    minWidth: 0,
  },
  columnTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    minWidth: 0,
  },
  columnCards: {
    gap: 10,
  },
  itemWrap: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingVertical: 8,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  accordion: {
    gap: 8,
  },
  accordionSection: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    minHeight: MIN_TOUCH,
    backgroundColor: '#f8fafc',
  },
  accordionHeaderExpanded: {
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  accordionTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#334155',
    minWidth: 0,
  },
  accordionBody: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10,
    backgroundColor: '#f1f5f9',
  },
  countBadge: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 10,
    minWidth: 24,
    alignItems: 'center',
    flexShrink: 0,
  },
  countBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  urgentChip: {
    backgroundColor: '#fee2e2',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  urgentChipText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#dc2626',
  },
});
