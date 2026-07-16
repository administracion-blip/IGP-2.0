import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

/** Ancho lógico para captura PNG resumen WhatsApp (landscape, × pixelRatio en export). */
export const OBJETIVOS_SHARE_WIDTH = 720;
/** Listado visual en trozos (vertical estrecho). */
export const OBJETIVOS_SHARE_WIDTH_LISTADO = 390;

export type ObjetivosShareMode = 'resumen' | 'listado';

export type ObjetivosShareLocal = {
  key: string;
  nombre: string;
  sumRealHastaAyer: number;
  sumCompHastaAyer: number;
  desvioPctHastaAyer: number | null;
};

export type ObjetivosShareGrupo = {
  id: string;
  nombre: string;
  color: string;
  sumRealHastaAyer: number;
  sumCompHastaAyer: number;
  desvioPctHastaAyer: number | null;
  locales: ObjetivosShareLocal[];
};

export type ObjetivosShareExportProps = {
  mode: ObjetivosShareMode;
  tituloPeriodo: string;
  fechaHastaLabel: string;
  generadoLabel: string;
  totales: {
    sumRealHastaAyer: number;
    sumCompHastaAyer: number;
    desvioPctHastaAyer: number | null;
  };
  locales: ObjetivosShareLocal[];
  grupos: ObjetivosShareGrupo[];
  /** Listado: locales a mostrar en este trozo (si no se pasa, usa `locales`). */
  listadoLocalesChunk?: ObjetivosShareLocal[];
  /** Listado: agrupaciones en este trozo (normalmente solo en la primera). */
  listadoGruposChunk?: ObjetivosShareGrupo[];
  /** Listado: mostrar KPI global (primera parte). */
  listadoMostrarKpi?: boolean;
  listadoChunkLabel?: string;
};

function formatMoneda(n: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function formatPctTicker(n: number | null): string {
  if (n == null) return '—';
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function colorDesvio(valor: number): { color: string } {
  return { color: valor < 0 ? '#dc2626' : '#059669' };
}

function estiloTicker(valor: number | null): { backgroundColor: string; color: string } {
  if (valor == null) return { backgroundColor: '#f1f5f9', color: '#64748b' };
  return valor < 0
    ? { backgroundColor: 'rgba(220, 38, 38, 0.12)', color: '#b91c1c' }
    : { backgroundColor: 'rgba(5, 150, 105, 0.12)', color: '#047857' };
}

function nombreLocal(item: ObjetivosShareLocal): string {
  return item.nombre.trim() || '—';
}

/** Consecución % = real / comparativa × 100 (misma métrica que ObjetivoMensualCard). */
function pctConsecucion(loc: ObjetivosShareLocal): number | null {
  if (loc.desvioPctHastaAyer != null) return (loc.desvioPctHastaAyer + 1) * 100;
  if (loc.sumCompHastaAyer === 0) return null;
  return (loc.sumRealHastaAyer / loc.sumCompHastaAyer) * 100;
}

function colorConsecucion(pct: number): string {
  if (pct < 95) return '#dc2626';
  if (pct < 100) return '#d97706';
  return '#059669';
}

function formatPctConsecucion(pct: number | null): string {
  if (pct == null) return 'Sin datos';
  const s = Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace('.', ',');
  return `${s} %`;
}

function BadgeDesvioLocal({ desvioPct }: { desvioPct: number | null }) {
  const estilo = estiloTicker(desvioPct);
  return (
    <View style={[styles.consecDesvioBadge, { backgroundColor: estilo.backgroundColor }]}>
      {desvioPct != null ? (
        <MaterialIcons
          name={desvioPct >= 0 ? 'trending-up' : 'trending-down'}
          size={11}
          color={estilo.color}
        />
      ) : null}
      <Text style={[styles.consecDesvioBadgeText, { color: estilo.color }]} numberOfLines={1}>
        {formatPctTicker(desvioPct)}
      </Text>
    </View>
  );
}

function ConsecucionLocalTile({ loc }: { loc: ObjetivosShareLocal }) {
  const pct = pctConsecucion(loc);
  const tienePct = pct != null;
  const consecucionPositiva = tienePct && pct >= 100;
  const desvio = loc.sumRealHastaAyer - loc.sumCompHastaAyer;
  const barPct = tienePct ? Math.min(pct, 120) : 0;
  const barWidth = (barPct / 120) * 100;
  const barColor = tienePct ? colorConsecucion(pct) : '#cbd5e1';
  const pctInBarColor = !tienePct ? '#64748b' : barWidth >= 38 ? '#ffffff' : barColor;

  return (
    <View style={styles.consecTile}>
      <View style={styles.consecTileHeader}>
        <Text style={styles.consecTileNombre} numberOfLines={1}>{nombreLocal(loc)}</Text>
        <BadgeDesvioLocal desvioPct={loc.desvioPctHastaAyer} />
      </View>
      <View style={styles.consecTrack}>
        <View style={[styles.consecMark100, { left: `${(100 / 120) * 100}%` }]} />
        {tienePct ? (
          <View style={[styles.consecFill, { width: `${barWidth}%`, backgroundColor: barColor }]} />
        ) : null}
        <Text style={[styles.consecPctInBar, { color: pctInBarColor }]} numberOfLines={1}>
          {formatPctConsecucion(pct)}
        </Text>
      </View>
      {tienePct && !consecucionPositiva ? (
        <Text style={[styles.consecTileEuroDebajo, colorDesvio(desvio)]} numberOfLines={1}>
          {formatMoneda(desvio)}
        </Text>
      ) : null}
    </View>
  );
}

function ConsecucionLocalesGrid({ locales }: { locales: ObjetivosShareLocal[] }) {
  const ordenados = [...locales].sort((a, b) =>
    nombreLocal(a).localeCompare(nombreLocal(b), 'es', { sensitivity: 'base' }),
  );

  return (
    <View style={styles.consecGridWrap}>
      <Text style={styles.consecGridTitle}>Consecución por local</Text>
      <View style={styles.consecGrid}>
        {ordenados.map((loc) => (
          <View key={loc.key} style={styles.consecGridCell}>
            <ConsecucionLocalTile loc={loc} />
          </View>
        ))}
      </View>
    </View>
  );
}

function ShareHeader({
  tituloPeriodo,
  fechaHastaLabel,
  generadoLabel,
  chunkLabel,
}: {
  tituloPeriodo: string;
  fechaHastaLabel: string;
  generadoLabel: string;
  chunkLabel?: string;
}) {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>Objetivos — {tituloPeriodo}</Text>
      <Text style={styles.headerSub}>Acumulado hasta {fechaHastaLabel}</Text>
      {chunkLabel ? <Text style={styles.headerChunk}>{chunkLabel}</Text> : null}
      <Text style={styles.headerGen}>{generadoLabel}</Text>
    </View>
  );
}

function KpiGlobal({ totales }: { totales: ObjetivosShareExportProps['totales'] }) {
  const desvio = totales.sumRealHastaAyer - totales.sumCompHastaAyer;
  const estilo = estiloTicker(totales.desvioPctHastaAyer);
  return (
    <View style={styles.kpiBox}>
      <View style={styles.kpiRow}>
        <Text style={styles.kpiLabel}>Facturado</Text>
        <Text style={styles.kpiValue}>{formatMoneda(totales.sumRealHastaAyer)}</Text>
      </View>
      <View style={styles.kpiRow}>
        <Text style={styles.kpiLabel}>Comparativa</Text>
        <Text style={[styles.kpiValue, styles.kpiMuted]}>{formatMoneda(totales.sumCompHastaAyer)}</Text>
      </View>
      <View style={styles.kpiRow}>
        <Text style={styles.kpiLabel}>Desvío</Text>
        <Text style={[styles.kpiValue, colorDesvio(desvio)]}>{formatMoneda(desvio)}</Text>
      </View>
      <View style={[styles.kpiPctBadge, { backgroundColor: estilo.backgroundColor }]}>
        {totales.desvioPctHastaAyer != null && (
          <MaterialIcons
            name={totales.desvioPctHastaAyer >= 0 ? 'trending-up' : 'trending-down'}
            size={18}
            color={estilo.color}
          />
        )}
        <Text style={[styles.kpiPctText, { color: estilo.color }]}>
          {formatPctTicker(totales.desvioPctHastaAyer)}
        </Text>
      </View>
    </View>
  );
}

function TopLocalesColumn({
  titulo,
  items,
}: {
  titulo: string;
  items: ObjetivosShareLocal[];
}) {
  return (
    <View style={styles.topCol}>
      <Text style={styles.topColTitle}>{titulo}</Text>
      {items.length === 0 ? (
        <Text style={styles.topEmpty}>—</Text>
      ) : (
        items.map((loc) => {
          const estilo = estiloTicker(loc.desvioPctHastaAyer);
          return (
            <View key={loc.key} style={styles.topRow}>
              <Text style={styles.topNombre} numberOfLines={2}>{nombreLocal(loc)}</Text>
              <View style={[styles.topPctBadge, { backgroundColor: estilo.backgroundColor }]}>
                <Text style={[styles.topPctText, { color: estilo.color }]}>
                  {formatPctTicker(loc.desvioPctHastaAyer)}
                </Text>
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

function LocalCard({ loc }: { loc: ObjetivosShareLocal }) {
  const desvio = loc.sumRealHastaAyer - loc.sumCompHastaAyer;
  const estilo = estiloTicker(loc.desvioPctHastaAyer);
  return (
    <View style={styles.localCard}>
      <View style={styles.localCardHeader}>
        <Text style={styles.localNombre}>{nombreLocal(loc)}</Text>
        <View style={[styles.localPctBadge, { backgroundColor: estilo.backgroundColor }]}>
          {loc.desvioPctHastaAyer != null && (
            <MaterialIcons
              name={loc.desvioPctHastaAyer >= 0 ? 'trending-up' : 'trending-down'}
              size={14}
              color={estilo.color}
            />
          )}
          <Text style={[styles.localPctText, { color: estilo.color }]}>
            {formatPctTicker(loc.desvioPctHastaAyer)}
          </Text>
        </View>
      </View>
      <View style={styles.localValores}>
        <View style={styles.localValorRow}>
          <Text style={styles.localValorLabel}>Facturado</Text>
          <Text style={styles.localValorNum}>{formatMoneda(loc.sumRealHastaAyer)}</Text>
        </View>
        <View style={styles.localValorRow}>
          <Text style={styles.localValorLabel}>Comparativa</Text>
          <Text style={[styles.localValorNum, styles.kpiMuted]}>{formatMoneda(loc.sumCompHastaAyer)}</Text>
        </View>
        <View style={styles.localValorRow}>
          <Text style={styles.localValorLabel}>Desvío</Text>
          <Text style={[styles.localValorNum, colorDesvio(desvio)]}>{formatMoneda(desvio)}</Text>
        </View>
      </View>
    </View>
  );
}

function GrupoSection({ grupo }: { grupo: ObjetivosShareGrupo }) {
  const desvio = grupo.sumRealHastaAyer - grupo.sumCompHastaAyer;
  const estilo = estiloTicker(grupo.desvioPctHastaAyer);
  return (
    <View style={styles.grupoSection}>
      <View style={[styles.grupoHeader, { borderLeftColor: grupo.color }]}>
        <View style={styles.grupoHeaderTop}>
          <View style={[styles.grupoDot, { backgroundColor: grupo.color }]} />
          <Text style={styles.grupoNombre}>{grupo.nombre}</Text>
          <View style={[styles.localPctBadge, { backgroundColor: estilo.backgroundColor }]}>
            <Text style={[styles.localPctText, { color: estilo.color }]}>
              {formatPctTicker(grupo.desvioPctHastaAyer)}
            </Text>
          </View>
        </View>
        <View style={styles.grupoTotales}>
          <Text style={styles.grupoTotalText}>
            {formatMoneda(grupo.sumRealHastaAyer)} · desvío {formatMoneda(desvio)}
          </Text>
        </View>
      </View>
      {grupo.locales.map((loc) => (
        <LocalCard key={loc.key} loc={loc} />
      ))}
    </View>
  );
}

export const OBJETIVOS_LISTADO_CHUNK_SIZE = 10;

function ResumenExport(props: ObjetivosShareExportProps) {
  const conPct = props.locales.filter((l) => l.desvioPctHastaAyer != null);
  const sorted = [...conPct].sort(
    (a, b) => (b.desvioPctHastaAyer ?? 0) - (a.desvioPctHastaAyer ?? 0),
  );
  const topPositivos = sorted.filter((l) => (l.desvioPctHastaAyer ?? 0) > 0).slice(0, 5);
  const topNegativos = sorted.filter((l) => (l.desvioPctHastaAyer ?? 0) < 0).slice(-5).reverse();

  return (
    <>
      <ShareHeader
        tituloPeriodo={props.tituloPeriodo}
        fechaHastaLabel={props.fechaHastaLabel}
        generadoLabel={props.generadoLabel}
      />
      <View style={styles.resumenBody}>
        <View style={styles.resumenLeft}>
          <KpiGlobal totales={props.totales} />
          <View style={styles.topGrid}>
            <TopLocalesColumn titulo="Mejores" items={topPositivos} />
            <TopLocalesColumn titulo="Peores" items={topNegativos} />
          </View>
        </View>
        <View style={styles.resumenRight}>
          <ConsecucionLocalesGrid locales={props.locales} />
        </View>
      </View>
      <Text style={styles.footer}>IGP · {props.locales.length} locales</Text>
    </>
  );
}

function ListadoExport(props: ObjetivosShareExportProps) {
  const gruposVisibles = props.listadoGruposChunk ?? props.grupos;
  const localesVisibles = props.listadoLocalesChunk ?? props.locales;
  const mostrarKpi = props.listadoMostrarKpi !== false;

  return (
    <>
      <ShareHeader
        tituloPeriodo={props.tituloPeriodo}
        fechaHastaLabel={props.fechaHastaLabel}
        generadoLabel={props.generadoLabel}
        chunkLabel={props.listadoChunkLabel}
      />
      {mostrarKpi ? <KpiGlobal totales={props.totales} /> : null}
      {gruposVisibles.map((g) => (
        <GrupoSection key={g.id} grupo={g} />
      ))}
      {localesVisibles.length > 0 && (
        <View style={styles.sueltosSection}>
          {gruposVisibles.length > 0 ? (
            <Text style={styles.sueltosTitle}>Otros locales</Text>
          ) : null}
          {localesVisibles.map((loc) => (
            <LocalCard key={loc.key} loc={loc} />
          ))}
        </View>
      )}
      <Text style={styles.footer}>IGP · Objetivos</Text>
    </>
  );
}

export function ObjetivosShareExport(props: ObjetivosShareExportProps) {
  const ancho = props.mode === 'resumen' ? OBJETIVOS_SHARE_WIDTH : OBJETIVOS_SHARE_WIDTH_LISTADO;
  return (
    <View style={[styles.root, { width: ancho }]} collapsable={false}>
      {props.mode === 'resumen' ? <ResumenExport {...props} /> : <ListadoExport {...props} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  header: { marginBottom: 14 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#0f172a', marginBottom: 4 },
  headerSub: { fontSize: 13, fontWeight: '600', color: '#475569' },
  headerChunk: { fontSize: 12, fontWeight: '600', color: '#0ea5e9', marginTop: 4 },
  headerGen: { fontSize: 11, color: '#94a3b8', marginTop: 4 },
  resumenBody: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  resumenLeft: {
    width: 300,
    flexShrink: 0,
  },
  resumenRight: {
    flex: 1,
    minWidth: 0,
  },
  consecGridWrap: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 10,
  },
  consecGridTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#334155',
    marginBottom: 10,
  },
  consecGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  consecGridCell: {
    width: '48.5%',
    minWidth: 0,
  },
  consecTile: {
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 8,
    paddingVertical: 7,
    gap: 6,
  },
  consecTileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
  },
  consecTileNombre: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: '#1e293b',
    minWidth: 0,
  },
  consecDesvioBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    flexShrink: 0,
    marginLeft: 4,
  },
  consecDesvioBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  consecTileEuroDebajo: {
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'right',
    alignSelf: 'stretch',
    marginTop: -2,
  },
  consecTrack: {
    height: 16,
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
  },
  consecMark100: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    marginLeft: -0.5,
    backgroundColor: '#94a3b8',
    zIndex: 2,
  },
  consecFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 4,
  },
  consecPctInBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    fontSize: 9,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 16,
    zIndex: 3,
    paddingHorizontal: 4,
  },
  kpiBox: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 12,
    gap: 6,
  },
  kpiRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kpiLabel: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  kpiValue: { fontSize: 15, fontWeight: '800', color: '#1e293b' },
  kpiMuted: { color: '#64748b', fontWeight: '600' },
  kpiPctBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginTop: 4,
  },
  kpiPctText: { fontSize: 18, fontWeight: '800' },
  topGrid: { flexDirection: 'row', gap: 8, marginBottom: 0 },
  topCol: { flex: 1, minWidth: 0 },
  topColTitle: { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 8 },
  topEmpty: { fontSize: 13, color: '#94a3b8' },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  topNombre: { flex: 1, fontSize: 12, fontWeight: '600', color: '#334155' },
  topPctBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  topPctText: { fontSize: 13, fontWeight: '800' },
  grupoSection: { marginBottom: 12 },
  grupoHeader: {
    borderLeftWidth: 4,
    paddingLeft: 10,
    paddingVertical: 8,
    marginBottom: 8,
    backgroundColor: '#fafafa',
    borderRadius: 6,
  },
  grupoHeaderTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grupoDot: { width: 10, height: 10, borderRadius: 5 },
  grupoNombre: { flex: 1, fontSize: 15, fontWeight: '800', color: '#334155' },
  grupoTotales: { marginTop: 4, paddingLeft: 18 },
  grupoTotalText: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  sueltosSection: { marginTop: 4 },
  sueltosTitle: { fontSize: 14, fontWeight: '700', color: '#475569', marginBottom: 8 },
  localCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    marginBottom: 10,
  },
  localCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 10,
  },
  localNombre: { flex: 1, fontSize: 16, fontWeight: '700', color: '#1e293b' },
  localPctBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  localPctText: { fontSize: 14, fontWeight: '800' },
  localValores: { gap: 6 },
  localValorRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  localValorLabel: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  localValorNum: { fontSize: 15, fontWeight: '700', color: '#334155' },
  footer: { fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 8 },
});
