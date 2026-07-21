import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Animated,
  Easing,
  Modal,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch } from '../../utils/api';
import { formatEur } from '../../lib/mayoristaCalculos';
import { nombreOperacionVisible } from '../../lib/mayoristaReferencia';
import { formatFecha } from '../../utils/formatFecha';
import { SelectorDesplegable } from '../../components/SelectorDesplegable';
import { RangoFechas } from '../../components/RangoFechas';
import { PostitTooltip } from '../../components/PostitTooltip';
import { useAppDialog } from '../../components/AppDialog';

type Negociacion = {
  id: string;
  nombre?: string;
  cliente_id?: string;
  cliente_nombre?: string;
  fecha?: string;
  estado?: string;
  venta_total?: number;
  beneficio_neto?: number;
  semaforo?: string;
};

type Cliente = { id: string; nombre: string; cif?: string; alias?: string };

type SerieMes = { mes: number; venta_total: number; beneficio_neto: number };
type OperacionCliente = {
  id: string;
  proveedor_nombre: string;
  fecha: string;
  importe: number;
  beneficio: number;
  nombre?: string;
};

type TopCliente = {
  cliente_id: string;
  cliente_nombre: string;
  importe: number;
  beneficio_neto: number;
  num_operaciones: number;
  ultima_operacion: string;
  operaciones: OperacionCliente[];
};

type Resumen = {
  kpis: { venta_total: number; beneficio_neto: number; coste_total: number; aportacion_total: number; margen_pct: number; num_operaciones: number };
  serie_mensual: SerieMes[];
  top_clientes: TopCliente[];
};

type Metrica = 'pvp' | 'beneficio';

const IS_WEB = Platform.OS === 'web';

const ESTADO_LABEL: Record<string, string> = {
  borrador: 'Borrador',
  confirmada: 'Confirmada',
  facturada: 'Facturada',
};

const ESTADO_COLOR: Record<string, string> = {
  borrador: '#64748b',
  confirmada: '#16a34a',
  facturada: '#0ea5e9',
};

const CHIP_ESTADO_PASTEL: Record<string, { bg: string; bgSel: string; border: string; borderSel: string; text: string }> = {
  '': { bg: '#f8fafc', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  borrador: { bg: '#f1f5f9', bgSel: '#e2e8f0', border: '#e2e8f0', borderSel: '#cbd5e1', text: '#475569' },
  confirmada: { bg: '#dcfce7', bgSel: '#bbf7d0', border: '#bbf7d0', borderSel: '#86efac', text: '#166534' },
  facturada: { bg: '#e0f2fe', bgSel: '#bae6fd', border: '#bae6fd', borderSel: '#7dd3fc', text: '#075985' },
};

const ESTADOS_CHIP = ['', 'borrador', 'confirmada', 'facturada'];
const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MESES_INICIAL = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const KPI_AYUDAS: Record<string, string> = {
  'Mercancía (PVP)': 'Importe total de venta al cliente (PVP × cantidad) de las operaciones filtradas.',
  'Benef. neto': 'Suma del beneficio neto (PVP − PMR) de las operaciones filtradas.',
  Aportación: 'Suma del dinero aportado por acuerdos comerciales en las operaciones filtradas.',
  Margen: 'Porcentaje de beneficio neto sobre el importe total de venta (beneficio ÷ mercancía).',
  'Operac.': 'Número de operaciones mayoristas que cumplen los filtros actuales.',
};

function semColor(s?: string) {
  if (s === 'verde') return '#16a34a';
  if (s === 'ambar') return '#d97706';
  return '#dc2626';
}

function beneficioBadgeColors(val: number) {
  if (val > 0) return { bg: '#dcfce7', border: '#86efac', text: '#166534' };
  if (val < 0) return { bg: '#fee2e2', border: '#fca5a5', text: '#991b1b' };
  return { bg: '#fef9c3', border: '#fde047', text: '#854d0e' };
}

/** Barra animada nativa (fallback sin SVG). Anima su altura al cambiar el valor. */
function BarraNativa({ valor, maxValor, alto, color }: { valor: number; maxValor: number; alto: number; color: string }) {
  const h = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const destino = maxValor > 0 ? Math.max(2, (valor / maxValor) * alto) : 2;
    Animated.timing(h, {
      toValue: destino,
      duration: 450,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [valor, maxValor, alto, h]);
  return <Animated.View style={{ height: h, backgroundColor: color, borderTopLeftRadius: 4, borderTopRightRadius: 4, width: '70%' }} />;
}

function GraficaMeses({ serie, metrica, compact }: { serie: SerieMes[]; metrica: Metrica; compact: boolean }) {
  const valores = serie.map((s) => (metrica === 'pvp' ? s.venta_total : s.beneficio_neto));
  const maxValor = Math.max(1, ...valores.map((v) => Math.abs(v)));
  const color = metrica === 'pvp' ? '#0ea5e9' : '#16a34a';
  const alto = compact ? 120 : 150;
  const labels = compact ? MESES_INICIAL : MESES_CORTO;

  if (IS_WEB) {
    const n = 12;
    const gap = 6;
    const vbW = 360;
    const bw = (vbW - gap * (n - 1)) / n;
    return (
      <View style={styles.chartWrap}>
        <svg width="100%" height={alto} viewBox={`0 0 ${vbW} ${alto}`} preserveAspectRatio="none">
          {valores.map((v, i) => {
            const h = Math.max(2, (Math.abs(v) / maxValor) * (alto - 4));
            const x = i * (bw + gap);
            const y = alto - h;
            const fill = v < 0 ? '#dc2626' : color;
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width={bw}
                height={h}
                rx={3}
                fill={fill}
                style={{ transition: 'height 450ms cubic-bezier(0.22,1,0.36,1), y 450ms cubic-bezier(0.22,1,0.36,1), fill 300ms ease' }}
              />
            );
          })}
        </svg>
        <View style={styles.chartLabels}>
          {labels.map((l, i) => (
            <Text key={i} style={styles.chartLabel}>{l}</Text>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.chartWrap}>
      <View style={[styles.chartBarsNative, { height: alto }]}>
        {valores.map((v, i) => (
          <View key={i} style={styles.chartBarCol}>
            <BarraNativa valor={Math.abs(v)} maxValor={maxValor} alto={alto - 4} color={v < 0 ? '#dc2626' : color} />
          </View>
        ))}
      </View>
      <View style={styles.chartLabels}>
        {labels.map((l, i) => (
          <Text key={i} style={styles.chartLabel}>{l}</Text>
        ))}
      </View>
    </View>
  );
}

function KpiCard({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  const card = (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
  if (!hint) return card;
  return (
    <PostitTooltip text={hint} style={styles.kpiCardWrap}>
      {card}
    </PostitTooltip>
  );
}

export default function MayoristaIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels, isDesktop } = useBreakpoint();
  const { aviso, confirmar: confirmarDialog, dialog } = useAppDialog();
  const puedeVer = hasPermiso('mayorista.ver');
  const puedeCrear = hasPermiso('mayorista.crear');
  const puedeEditar = hasPermiso('mayorista.editar');
  const puedeBorrar = hasPermiso('mayorista.borrar');

  const [items, setItems] = useState<Negociacion[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hoy = new Date();
  const [anio, setAnio] = useState(hoy.getFullYear());
  const [mesesSel, setMesesSel] = useState<number[]>([hoy.getMonth() + 1]);
  const [clienteSel, setClienteSel] = useState('');
  const [estadoSel, setEstadoSel] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [metrica, setMetrica] = useState<Metrica>('pvp');

  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [loadingResumen, setLoadingResumen] = useState(false);
  const [clienteOpsModal, setClienteOpsModal] = useState<TopCliente | null>(null);

  const cargarLista = useCallback(() => {
    if (!puedeVer) return;
    setLoading(true);
    setError(null);
    apiFetch('/api/mayorista/negociaciones')
      .then((r) => r.json())
      .then((d: { negociaciones?: Negociacion[]; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setItems(d.negociaciones || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [puedeVer]);

  const cargarClientes = useCallback(() => {
    if (!puedeVer) return;
    apiFetch('/api/mayorista/clientes')
      .then((r) => r.json())
      .then((d: { clientes?: Cliente[] }) => setClientes(d.clientes || []))
      .catch(() => { /* silencioso */ });
  }, [puedeVer]);

  const queryFiltros = useMemo(() => {
    const p = new URLSearchParams();
    p.set('anio', String(anio));
    if (mesesSel.length) p.set('meses', mesesSel.join(','));
    if (clienteSel) p.set('cliente_id', clienteSel);
    if (estadoSel) p.set('estado', estadoSel);
    if (desde) p.set('fechaDesde', desde);
    if (hasta) p.set('fechaHasta', hasta);
    return p.toString();
  }, [anio, mesesSel, clienteSel, estadoSel, desde, hasta]);

  const cargarResumen = useCallback(() => {
    if (!puedeVer) return;
    setLoadingResumen(true);
    apiFetch(`/api/mayorista/negociaciones/resumen?${queryFiltros}`)
      .then((r) => r.json())
      .then((d: Resumen & { error?: string }) => {
        if (d.error) return;
        setResumen(d);
      })
      .catch(() => { /* silencioso */ })
      .finally(() => setLoadingResumen(false));
  }, [puedeVer, queryFiltros]);

  const refrescarTodo = useCallback(() => {
    cargarLista();
    cargarResumen();
  }, [cargarLista, cargarResumen]);

  useFocusEffect(useCallback(() => { refrescarTodo(); }, [refrescarTodo]));
  useEffect(() => { cargarClientes(); }, [cargarClientes]);
  useEffect(() => { cargarResumen(); }, [cargarResumen]);

  const listaFiltrada = useMemo(() => {
    return items.filter((n) => {
      const f = String(n.fecha || '').slice(0, 10);
      if (!f) return false;
      if (estadoSel && n.estado !== estadoSel) return false;
      if (clienteSel && String(n.cliente_id || '') !== clienteSel) return false;
      if (Number(f.slice(0, 4)) !== anio) return false;
      if (mesesSel.length && !mesesSel.includes(Number(f.slice(5, 7)))) return false;
      if (desde && f < desde) return false;
      if (hasta && f > hasta) return false;
      return true;
    });
  }, [items, estadoSel, clienteSel, anio, mesesSel, desde, hasta]);

  /** Conteos por estado respetando el resto de filtros (sin el chip de estado). */
  const conteoPorEstado = useMemo(() => {
    const base = items.filter((n) => {
      const f = String(n.fecha || '').slice(0, 10);
      if (!f) return false;
      if (clienteSel && String(n.cliente_id || '') !== clienteSel) return false;
      if (Number(f.slice(0, 4)) !== anio) return false;
      if (mesesSel.length && !mesesSel.includes(Number(f.slice(5, 7)))) return false;
      if (desde && f < desde) return false;
      if (hasta && f > hasta) return false;
      return true;
    });
    const counts: Record<string, number> = { '': base.length, borrador: 0, confirmada: 0, facturada: 0 };
    for (const n of base) {
      const e = String(n.estado || 'borrador');
      counts[e] = (counts[e] || 0) + 1;
    }
    return counts;
  }, [items, clienteSel, anio, mesesSel, desde, hasta]);

  const clientesOpts = useMemo(
    () => [
      { id: '', titulo: 'Todos los clientes', icono: 'groups' as const },
      ...clientes.map((c) => ({
        id: c.id,
        titulo: c.nombre || c.id,
        subtitulo: c.cif ? `CIF ${c.cif}` : undefined,
        icono: 'business' as const,
      })),
    ],
    [clientes],
  );

  const toggleMes = (m: number) => {
    setMesesSel((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m].sort((a, b) => a - b)));
  };

  const crear = () => {
    if (!puedeCrear) {
      aviso('No tienes permiso para crear operaciones.');
      return;
    }
    router.push('/mayorista/nuevo' as never);
  };

  const pedirBorrar = async (n: Negociacion) => {
    if (n.estado !== 'borrador') return;
    const ok = await confirmarDialog(
      'Borrar borrador',
      `¿Seguro que quieres eliminar «${n.nombre || n.id}»? Esta acción no se puede deshacer.`,
      { confirmLabel: 'Eliminar', destructive: true },
    );
    if (ok) void ejecutarBorrar(n);
  };

  const ejecutarBorrar = async (n: Negociacion) => {
    try {
      const r = await apiFetch(`/api/mayorista/negociaciones/${n.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) { aviso(d.error || 'No se pudo borrar'); return; }
      refrescarTodo();
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'Error de conexión');
    }
  };

  const pedirFacturar = async (n: Negociacion) => {
    if (n.estado !== 'confirmada' || !puedeEditar) return;
    const ok = await confirmarDialog(
      'Marcar como facturada',
      `¿Marcar «${n.nombre || n.id}» como facturada?`,
      { confirmLabel: 'Facturar' },
    );
    if (!ok) return;
    try {
      const r = await apiFetch(`/api/mayorista/negociaciones/${n.id}/facturar`, { method: 'POST', body: '{}' });
      const d = await r.json();
      if (!r.ok) { aviso(d.error || 'No se pudo facturar'); return; }
      refrescarTodo();
      aviso('Operación marcada como facturada');
    } catch (e) {
      aviso(e instanceof Error ? e.message : 'Error de conexión');
    }
  };

  if (!puedeVer) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock-outline" size={28} color="#94a3b8" />
        <Text style={styles.emptyText}>No tienes permiso para ver operaciones mayoristas.</Text>
      </View>
    );
  }

  const kpis = resumen?.kpis;
  const serie = resumen?.serie_mensual ?? MESES_CORTO.map((_, i) => ({ mes: i + 1, venta_total: 0, beneficio_neto: 0 }));
  const topClientes = resumen?.top_clientes ?? [];

  const panelLista = (
    <View style={[styles.panelLista, !shouldStackPanels && styles.panelListaBorder]}>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#0ea5e9" /></View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {listaFiltrada.length === 0 ? (
            <View style={styles.emptyWrap}>
              <MaterialIcons name="storefront" size={40} color="#cbd5e1" />
              <Text style={styles.emptyText}>No hay operaciones con estos filtros.</Text>
            </View>
          ) : listaFiltrada.map((n) => {
            const ec = ESTADO_COLOR[n.estado || 'borrador'] || '#64748b';
            return (
              <TouchableOpacity
                key={n.id}
                activeOpacity={0.7}
                onPress={() => router.push(`/mayorista/${n.id}` as never)}
                style={styles.card}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardTitleWrap}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{nombreOperacionVisible(n)}</Text>
                    <View style={[styles.badge, { backgroundColor: ec + '18', borderColor: ec }]}>
                      <Text style={[styles.badgeText, { color: ec }]}>{ESTADO_LABEL[n.estado || ''] || n.estado}</Text>
                    </View>
                    {n.semaforo ? <View style={[styles.dotSem, { backgroundColor: semColor(n.semaforo) }]} /> : null}
                  </View>
                  <View style={styles.cardActions}>
                    {puedeEditar && n.estado === 'confirmada' ? (
                      <TouchableOpacity
                        onPress={(e) => {
                          if (Platform.OS === 'web' && e && 'stopPropagation' in e) {
                            (e as unknown as { stopPropagation: () => void }).stopPropagation();
                          }
                          void pedirFacturar(n);
                        }}
                        style={styles.cardActionBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityLabel="Marcar como facturada"
                      >
                        <MaterialIcons name="receipt-long" size={18} color="#0ea5e9" />
                      </TouchableOpacity>
                    ) : null}
                    {puedeBorrar && n.estado === 'borrador' ? (
                      <TouchableOpacity
                        onPress={(e) => {
                          if (Platform.OS === 'web' && e && 'stopPropagation' in e) {
                            (e as unknown as { stopPropagation: () => void }).stopPropagation();
                          }
                          void pedirBorrar(n);
                        }}
                        style={styles.cardActionBtn}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityLabel="Borrar borrador"
                      >
                        <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
                <View style={styles.cardBody}>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Fecha</Text>
                    <Text style={styles.cardFieldValue}>{formatFecha(n.fecha)}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Cliente</Text>
                    <Text style={styles.cardFieldValue} numberOfLines={1}>{n.cliente_nombre || '—'}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Venta</Text>
                    <Text style={styles.cardFieldValue}>{formatEur(n.venta_total)}</Text>
                  </View>
                  <View style={styles.cardField}>
                    <Text style={styles.cardFieldLabel}>Benef. neto</Text>
                    <Text style={[styles.cardFieldValue, { fontWeight: '700', color: (n.beneficio_neto ?? 0) >= 0 ? '#16a34a' : '#dc2626' }]}>
                      {formatEur(n.beneficio_neto)}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );

  const panelKpi = (
    <View style={styles.panelKpi}>
      <View style={styles.kpiRow}>
        <KpiCard label="Mercancía (PVP)" value={formatEur(kpis?.venta_total)} color="#0369a1" hint={KPI_AYUDAS['Mercancía (PVP)']} />
        <KpiCard label="Benef. neto" value={formatEur(kpis?.beneficio_neto)} color={(kpis?.beneficio_neto ?? 0) >= 0 ? '#16a34a' : '#dc2626'} hint={KPI_AYUDAS['Benef. neto']} />
        <KpiCard label="Aportación" value={formatEur(kpis?.aportacion_total)} color="#7c3aed" hint={KPI_AYUDAS.Aportación} />
        <KpiCard label="Margen" value={`${(kpis?.margen_pct ?? 0).toFixed(1)}%`} hint={KPI_AYUDAS.Margen} />
        <KpiCard label="Operac." value={String(kpis?.num_operaciones ?? 0)} hint={KPI_AYUDAS['Operac.']} />
      </View>

      <View style={styles.chartHeader}>
        <Text style={styles.sectionTitle}>Evolución mensual</Text>
        <View style={styles.metricaToggle}>
          <TouchableOpacity
            style={[styles.metricaBtn, metrica === 'pvp' && styles.metricaBtnActivePvp]}
            onPress={() => setMetrica('pvp')}
          >
            <Text style={[styles.metricaBtnText, metrica === 'pvp' && styles.metricaBtnTextActive]}>PVP</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.metricaBtn, metrica === 'beneficio' && styles.metricaBtnActiveBenef]}
            onPress={() => setMetrica('beneficio')}
          >
            <Text style={[styles.metricaBtnText, metrica === 'beneficio' && styles.metricaBtnTextActive]}>Benef. neto</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loadingResumen ? (
        <View style={styles.chartLoading}><ActivityIndicator size="small" color="#0ea5e9" /></View>
      ) : (
        <GraficaMeses serie={serie} metrica={metrica} compact={!isDesktop} />
      )}

      <Text style={styles.sectionTitle}>Top 5 clientes</Text>
      <View style={styles.topWrap}>
        {topClientes.length === 0 ? (
          <Text style={styles.topEmpty}>Sin datos de clientes.</Text>
        ) : topClientes.map((c, i) => {
          const max = topClientes[0]?.importe || 1;
          const pct = Math.max(4, (c.importe / max) * 100);
          const benefBadge = beneficioBadgeColors(c.beneficio_neto ?? 0);
          return (
            <View key={`${c.cliente_id || c.cliente_nombre}-${i}`} style={styles.topCard}>
              <View style={styles.topRow}>
                <Text style={styles.topRank}>{i + 1}</Text>
                <View style={styles.topBarWrap}>
                  <View style={styles.topBarBg}>
                    <View style={[styles.topBarFill, { width: `${pct}%` }]} />
                  </View>
                  <Text style={styles.topName} numberOfLines={1}>{c.cliente_nombre}</Text>
                  <View style={styles.topMetaRow}>
                    <View style={[styles.topBenefBadge, { backgroundColor: benefBadge.bg, borderColor: benefBadge.border }]}>
                      <Text style={[styles.topBenefBadgeText, { color: benefBadge.text }]}>
                        {formatEur(c.beneficio_neto)}
                      </Text>
                    </View>
                    <Text style={styles.topMeta} numberOfLines={1}>
                      {c.num_operaciones} op.
                      {c.ultima_operacion ? ` · últ. ${formatFecha(c.ultima_operacion)}` : ''}
                    </Text>
                  </View>
                </View>
                <Text style={styles.topValue}>{formatEur(c.importe)}</Text>
                <TouchableOpacity
                  style={styles.topOpsBtn}
                  onPress={() => setClienteOpsModal(c)}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  accessibilityLabel={`Ver operaciones de ${c.cliente_nombre}`}
                >
                  <MaterialIcons name="list-alt" size={18} color="#0ea5e9" />
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Operaciones mayoristas</Text>
        {puedeCrear ? (
          <TouchableOpacity style={styles.createBtn} onPress={crear}>
            <MaterialIcons name="add" size={16} color="#fff" />
            <Text style={styles.createBtnText}>Nueva</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Toolbar filtros */}
      <View style={styles.toolbar}>
        <View style={styles.filtroFila}>
          <View style={styles.clienteSelWrap}>
            <SelectorDesplegable
              compact
              placeholder="Cliente…"
              icono="business"
              tituloLista="Filtrar por cliente"
              buscador
              buscadorPlaceholder="Nombre o CIF…"
              valorId={clienteSel}
              opciones={clientesOpts}
              onSeleccionar={setClienteSel}
            />
          </View>
          <View style={styles.anioStepper}>
            <TouchableOpacity onPress={() => setAnio((a) => a - 1)} style={styles.anioBtn}>
              <MaterialIcons name="chevron-left" size={18} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.anioText}>{anio}</Text>
            <TouchableOpacity onPress={() => setAnio((a) => a + 1)} style={styles.anioBtn}>
              <MaterialIcons name="chevron-right" size={18} color="#334155" />
            </TouchableOpacity>
          </View>
          <RangoFechas desdeIso={desde} hastaIso={hasta} onChangeDesde={setDesde} onChangeHasta={setHasta} cellWidth={120} />
        </View>

        <View style={styles.mesesRow}>
          {MESES_CORTO.map((m, i) => {
            const num = i + 1;
            const sel = mesesSel.includes(num);
            return (
              <TouchableOpacity
                key={num}
                style={[styles.mesChip, sel && styles.mesChipSel]}
                onPress={() => toggleMes(num)}
                activeOpacity={0.7}
              >
                <Text style={[styles.mesChipText, sel && styles.mesChipTextSel]}>{m}</Text>
              </TouchableOpacity>
            );
          })}
          {mesesSel.length ? (
            <TouchableOpacity style={styles.mesClear} onPress={() => setMesesSel([])}>
              <Text style={styles.mesClearText}>Año completo</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.mesHint}>Año completo</Text>
          )}
        </View>

        <View style={styles.chipRowEstado}>
          {ESTADOS_CHIP.map((e) => {
            const pastel = CHIP_ESTADO_PASTEL[e] ?? CHIP_ESTADO_PASTEL[''];
            const sel = estadoSel === e;
            const n = conteoPorEstado[e] ?? 0;
            return (
              <TouchableOpacity
                key={e || 'todos'}
                style={[styles.estadoChip, { backgroundColor: sel ? pastel.bgSel : pastel.bg, borderColor: sel ? pastel.borderSel : pastel.border }]}
                onPress={() => setEstadoSel(e)}
                activeOpacity={0.75}
              >
                <Text style={[styles.estadoChipText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                  {e === '' ? 'Todos' : ESTADO_LABEL[e]}
                </Text>
                <View style={[styles.estadoChipCount, sel && styles.estadoChipCountSel]}>
                  <Text style={[styles.estadoChipCountText, { color: pastel.text }, sel && styles.estadoChipTextSel]}>
                    {n}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {error ? (
        <View style={styles.errorBar}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
        {panelLista}
        <View style={[styles.panelKpiWrap, shouldStackPanels && styles.panelKpiWrapStack]}>
          {panelKpi}
        </View>
      </View>

      {dialog}

      <Modal
        visible={clienteOpsModal != null}
        transparent
        animationType="fade"
        onRequestClose={() => setClienteOpsModal(null)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setClienteOpsModal(null)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.modalTitle} numberOfLines={2}>
                  Operaciones — {clienteOpsModal?.cliente_nombre || '—'}
                </Text>
                {clienteOpsModal ? (
                  <Text style={styles.modalSub}>
                    {clienteOpsModal.num_operaciones} op. · {formatEur(clienteOpsModal.importe)} venta · {formatEur(clienteOpsModal.beneficio_neto)} benef.
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={() => setClienteOpsModal(null)} style={styles.modalCloseBtn}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalTableScroll} nestedScrollEnabled>
              <View style={styles.modalTableHeader}>
                <Text style={[styles.modalTh, styles.modalColProv]}>Proveedor</Text>
                <Text style={[styles.modalTh, styles.modalColFecha]}>Fecha</Text>
                <Text style={[styles.modalTh, styles.modalColNum]}>Importe</Text>
                <Text style={[styles.modalTh, styles.modalColNum]}>Benef.</Text>
              </View>
              {(clienteOpsModal?.operaciones ?? []).length === 0 ? (
                <Text style={styles.topEmpty}>Sin operaciones en el periodo.</Text>
              ) : (clienteOpsModal?.operaciones ?? []).map((op) => (
                <TouchableOpacity
                  key={op.id}
                  style={styles.modalTableRow}
                  onPress={() => {
                    setClienteOpsModal(null);
                    if (op.id) router.push(`/mayorista/${op.id}` as never);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.modalTd, styles.modalColProv]} numberOfLines={2}>{op.proveedor_nombre || '—'}</Text>
                  <Text style={[styles.modalTd, styles.modalColFecha]}>{formatFecha(op.fecha)}</Text>
                  <Text style={[styles.modalTd, styles.modalColNum]}>{formatEur(op.importe)}</Text>
                  <Text style={[styles.modalTd, styles.modalColNum, { color: op.beneficio >= 0 ? '#16a34a' : '#dc2626' }]}>
                    {formatEur(op.beneficio)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    gap: 12,
  },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  createBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  toolbar: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  filtroFila: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  clienteSelWrap: { minWidth: 200, flexShrink: 1, zIndex: 10 },
  anioStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 2,
    height: 32,
  },
  anioBtn: { paddingHorizontal: 2, paddingVertical: 4 },
  anioText: { fontSize: 13, fontWeight: '700', color: '#0f172a', minWidth: 44, textAlign: 'center' },

  mesesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignItems: 'center' },
  mesChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  mesChipSel: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  mesChipText: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  mesChipTextSel: { color: '#075985' },
  mesClear: { paddingHorizontal: 8, paddingVertical: 3 },
  mesClearText: { fontSize: 11, color: '#0ea5e9', fontWeight: '600' },
  mesHint: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic', paddingHorizontal: 6 },

  chipRowEstado: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  estadoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  estadoChipText: { fontSize: 11, fontWeight: '600' },
  estadoChipTextSel: { fontWeight: '800' },
  estadoChipCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(15,23,42,0.06)',
    alignItems: 'center',
  },
  estadoChipCountSel: { backgroundColor: 'rgba(15,23,42,0.10)' },
  estadoChipCountText: { fontSize: 10, fontWeight: '700' },

  errorBar: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontSize: 12, color: '#dc2626' },

  split: { flex: 1, flexDirection: 'row', minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  panelLista: { flex: 1, minWidth: 0 },
  panelListaBorder: { borderRightWidth: 1, borderRightColor: '#e2e8f0' },
  panelKpiWrap: { flex: 1, minWidth: 0, backgroundColor: '#fff' },
  panelKpiWrapStack: { flex: undefined, borderTopWidth: 1, borderTopColor: '#e2e8f0' },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 10, paddingBottom: 24 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyText: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
  center: { padding: 40, alignItems: 'center', gap: 8 },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  dotSem: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  cardActionBtn: { padding: 6 },
  cardBody: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, paddingVertical: 7, gap: 8 },
  cardField: { minWidth: 84, marginRight: 8 },
  cardFieldLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 1 },
  cardFieldValue: { fontSize: 13, color: '#334155' },

  panelKpi: { flex: 1, padding: 12, gap: 10 },
  kpiRow: { flexDirection: 'row', gap: 6 },
  kpiCardWrap: { flex: 1, minWidth: 0 },
  kpiCard: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  kpiLabel: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, fontWeight: '800', color: '#0f172a', marginTop: 2 },

  chartHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  metricaToggle: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderRadius: 8, padding: 2, gap: 2 },
  metricaBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  metricaBtnActivePvp: { backgroundColor: '#e0f2fe' },
  metricaBtnActiveBenef: { backgroundColor: '#dcfce7' },
  metricaBtnText: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  metricaBtnTextActive: { color: '#0f172a', fontWeight: '800' },

  chartWrap: { gap: 4 },
  chartLoading: { height: 150, alignItems: 'center', justifyContent: 'center' },
  chartBarsNative: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  chartBarCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  chartLabels: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 },
  chartLabel: { flex: 1, textAlign: 'center', fontSize: 8, color: '#94a3b8' },

  topWrap: { gap: 8 },
  topCard: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  topEmpty: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  topRank: { width: 16, fontSize: 12, fontWeight: '800', color: '#94a3b8', textAlign: 'center', marginTop: 2 },
  topBarWrap: { flex: 1, minWidth: 0 },
  topBarBg: { height: 6, backgroundColor: '#f1f5f9', borderRadius: 3, overflow: 'hidden', marginBottom: 2 },
  topBarFill: { height: 6, backgroundColor: '#0ea5e9', borderRadius: 3 },
  topName: { fontSize: 12, fontWeight: '600', color: '#334155' },
  topMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  topBenefBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
  },
  topBenefBadgeText: { fontSize: 11, fontWeight: '700' },
  topMeta: { fontSize: 11, color: '#64748b', flexShrink: 1 },
  topValue: { fontSize: 11, fontWeight: '700', color: '#0f172a', flexShrink: 0, marginTop: 2, maxWidth: 72, textAlign: 'right' },
  topOpsBtn: { padding: 4, marginTop: 0 },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '100%',
    maxWidth: 560,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  modalSub: { fontSize: 12, color: '#64748b', marginTop: 4 },
  modalCloseBtn: { padding: 4 },
  modalTableScroll: { maxHeight: 360 },
  modalTableHeader: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTableRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f1f5f9',
  },
  modalTh: { fontSize: 10, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  modalTd: { fontSize: 12, color: '#334155' },
  modalColProv: { flex: 2, minWidth: 0, paddingRight: 6 },
  modalColFecha: { width: 72, flexShrink: 0 },
  modalColNum: { width: 72, flexShrink: 0, textAlign: 'right' },
});
