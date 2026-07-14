import { View, Text, StyleSheet } from 'react-native';
import {
  REPORTE_COLORS,
  REPORTE_DOC_WIDTH,
  colorHexForKey,
  desvioColorKey,
  desvioEuro,
  formatEuro,
  formatPctDisplay,
  pctDesvio,
  subtotalZone,
  type ReporteObjetivosData,
  type ReporteVenue,
} from '../lib/objetivosReporteModel';

type Props = {
  data: ReporteObjetivosData;
};

function DivergingBar({ pct, width = 120 }: { pct: number | null; width?: number }) {
  const half = width / 2;
  const magnitude = pct == null ? 0 : Math.min(Math.abs(pct), 100) / 100;
  const segW = magnitude * half;
  const positive = (pct ?? 0) > 0;
  const negative = (pct ?? 0) < 0;
  return (
    <View style={[styles.barTrack, { width }]}>
      <View style={[styles.barCenter, { left: half - 0.5 }]} />
      {positive && segW > 0 ? (
        <View style={[styles.barSeg, { left: half, width: segW, backgroundColor: REPORTE_COLORS.green }]} />
      ) : null}
      {negative && segW > 0 ? (
        <View style={[styles.barSeg, { left: half - segW, width: segW, backgroundColor: REPORTE_COLORS.red }]} />
      ) : null}
    </View>
  );
}

function VenueRow({ venue }: { venue: ReporteVenue }) {
  const pct = pctDesvio(venue.facturado, venue.comparativa);
  const colorKey = desvioColorKey(venue.facturado, venue.comparativa);
  return (
    <View style={styles.venueRow}>
      <Text style={styles.venueName} numberOfLines={2}>{venue.name}</Text>
      <Text style={styles.venueNum}>{formatEuro(venue.facturado)}</Text>
      <Text style={[styles.venueNum, styles.venueNumMuted]}>{formatEuro(venue.comparativa)}</Text>
      <DivergingBar pct={pct} width={130} />
      <Text style={[styles.venuePct, { color: colorHexForKey(colorKey) }]}>{formatPctDisplay(pct)}</Text>
    </View>
  );
}

function ZoneBlock({ zone }: { zone: ReporteObjetivosData['zones'][number] }) {
  const sub = subtotalZone(zone);
  const subPct = pctDesvio(sub.facturado, sub.comparativa);
  const subColor = colorHexForKey(desvioColorKey(sub.facturado, sub.comparativa));
  return (
    <View style={styles.zoneBlock}>
      <View style={styles.zoneHeader}>
        <Text style={styles.zoneName}>{zone.name}</Text>
        {zone.hasSubtotal ? (
          <View style={styles.zoneSubtotal}>
            <Text style={styles.zoneSubFacturado}>{formatEuro(sub.facturado)}</Text>
            <Text style={[styles.zoneSubPct, { color: subColor }]}>{formatPctDisplay(subPct)}</Text>
          </View>
        ) : null}
      </View>
      {zone.venues.map((v, i) => (
        <VenueRow key={`${zone.name}-${v.name}-${i}`} venue={v} />
      ))}
    </View>
  );
}

function KpiCard({
  label,
  value,
  pct,
  highlight,
}: {
  label: string;
  value: string;
  pct?: string;
  highlight?: string;
}) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {pct ? (
        <View style={[styles.kpiChip, highlight ? { backgroundColor: `${highlight}18` } : null]}>
          <Text style={[styles.kpiChipText, highlight ? { color: highlight } : null]}>{pct}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function ReporteObjetivos({ data }: Props) {
  const desvioGlobal = desvioEuro(data.totales.facturado, data.totales.comparativa);
  const pctGlobal = pctDesvio(data.totales.facturado, data.totales.comparativa);
  const globalColor = colorHexForKey(desvioColorKey(data.totales.facturado, data.totales.comparativa));

  return (
    <View style={styles.pageWrap}>
      <View style={styles.document}>
        <Text style={styles.kicker}>INFORME · {data.kickerMes}</Text>
        <Text style={styles.title}>Objetivos por local</Text>
        <Text style={styles.subtitle}>
          Acumulado hasta {data.fechaHastaLabel} · {data.generadoLabel}
        </Text>

        <View style={styles.kpiRow}>
          <KpiCard label="Facturado" value={formatEuro(data.totales.facturado)} />
          <KpiCard label="Comparativa" value={formatEuro(data.totales.comparativa)} />
          <KpiCard
            label="Desvío global"
            value={formatEuro(desvioGlobal)}
            pct={formatPctDisplay(pctGlobal)}
            highlight={globalColor}
          />
        </View>

        {data.zones.map((zone) => (
          <ZoneBlock key={`${zone.name}-${zone.orden}`} zone={zone} />
        ))}

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>TOTAL</Text>
          <Text style={styles.totalNum}>{formatEuro(data.totales.facturado)}</Text>
          <Text style={[styles.totalNum, styles.venueNumMuted]}>{formatEuro(data.totales.comparativa)}</Text>
          <View style={{ width: 130 }} />
          <Text style={[styles.totalPct, { color: globalColor }]}>{formatPctDisplay(pctGlobal)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pageWrap: {
    backgroundColor: REPORTE_COLORS.pageBg,
    padding: 24,
    alignItems: 'center',
  },
  document: {
    width: REPORTE_DOC_WIDTH,
    maxWidth: '100%',
    backgroundColor: REPORTE_COLORS.cardBg,
    borderRadius: 8,
    padding: 52,
    borderWidth: 1,
    borderColor: REPORTE_COLORS.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  kicker: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: REPORTE_COLORS.accent,
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: REPORTE_COLORS.text,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: REPORTE_COLORS.muted,
    marginBottom: 28,
  },
  kpiRow: { flexDirection: 'row', gap: 12, marginBottom: 32 },
  kpiCard: {
    flex: 1,
    backgroundColor: REPORTE_COLORS.kpiBg,
    borderWidth: 1,
    borderColor: REPORTE_COLORS.border,
    borderRadius: 6,
    padding: 14,
    minHeight: 88,
  },
  kpiLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: REPORTE_COLORS.muted,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  kpiValue: { fontSize: 18, fontWeight: '800', color: REPORTE_COLORS.text },
  kpiChip: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: '#f1f5f9',
  },
  kpiChipText: { fontSize: 13, fontWeight: '800', color: REPORTE_COLORS.text },
  zoneBlock: { marginBottom: 20 },
  zoneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: REPORTE_COLORS.zoneHeaderBg,
    borderLeftWidth: 3,
    borderLeftColor: REPORTE_COLORS.accent,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 4,
    borderRadius: 4,
  },
  zoneName: { flex: 1, fontSize: 13, fontWeight: '800', color: REPORTE_COLORS.text, marginRight: 12 },
  zoneSubtotal: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  zoneSubFacturado: { fontSize: 13, fontWeight: '700', color: REPORTE_COLORS.text },
  zoneSubPct: { fontSize: 13, fontWeight: '800' },
  venueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  venueName: { flex: 2.2, fontSize: 13, fontWeight: '600', color: REPORTE_COLORS.text, minWidth: 0 },
  venueNum: { flex: 1, fontSize: 12, fontWeight: '700', color: REPORTE_COLORS.text, textAlign: 'right' },
  venueNumMuted: { color: REPORTE_COLORS.muted, fontWeight: '600' },
  venuePct: { width: 62, fontSize: 12, fontWeight: '800', textAlign: 'right' },
  barTrack: {
    height: 10,
    position: 'relative',
    backgroundColor: '#f1f5f9',
    borderRadius: 2,
    overflow: 'hidden',
  },
  barCenter: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: REPORTE_COLORS.border },
  barSeg: { position: 'absolute', top: 0, height: 10, borderRadius: 1 },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 2,
    borderTopColor: REPORTE_COLORS.text,
    gap: 8,
  },
  totalLabel: { flex: 2.2, fontSize: 14, fontWeight: '800', color: REPORTE_COLORS.text },
  totalNum: { flex: 1, fontSize: 13, fontWeight: '800', color: REPORTE_COLORS.text, textAlign: 'right' },
  totalPct: { width: 62, fontSize: 13, fontWeight: '800', textAlign: 'right' },
});
