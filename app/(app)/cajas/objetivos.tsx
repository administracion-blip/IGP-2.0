import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Local = { id_Locales?: string; nombre?: string; Nombre?: string; agoraCode?: string; AgoraCode?: string };
type FestivoReg = { PK?: string; FechaComparativa?: string; Festivo?: boolean; NombreFestivo?: string };

type FilaObjetivo = {
  Fecha: string;
  FechaComparacion: string;
  Festivo: boolean;
  NombreFestivo: string;
  TotalFacturadoReal: number;
  TotalFacturadoComparativa: number;
  Desvio: number;
  DesvioPct: number | null;
};

function fechaComparacion(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00');
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function formatMoneda(n: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatPct(n: number | null): string {
  if (n == null) return '—';
  return (n * 100).toFixed(1) + '%';
}

function colorDesvio(valor: number | null): { color: string } {
  if (valor == null) return { color: '#64748b' };
  return { color: valor < 0 ? '#dc2626' : '#059669' };
}

function formatPctTicker(n: number | null): string {
  if (n == null) return '—';
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function estiloTicker(valor: number | null): { backgroundColor: string; color: string } {
  if (valor == null) return { backgroundColor: '#f1f5f9', color: '#64748b' };
  return valor < 0
    ? { backgroundColor: 'rgba(220, 38, 38, 0.12)', color: '#b91c1c' }
    : { backgroundColor: 'rgba(5, 150, 105, 0.12)', color: '#047857' };
}

function diaSemana(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00');
  const dias = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  return dias[d.getDay()] ?? '';
}

function diaVirtual(fecha: string, fechaComparacion: string): string {
  return `${diaSemana(fecha)}/${diaSemana(fechaComparacion)}`;
}

function mesEnCurso(): { inicio: string; fin: string } {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, '0');
  const ultimoDia = new Date(y, hoy.getMonth() + 1, 0).getDate();
  return {
    inicio: `${y}-${m}-01`,
    fin: `${y}-${m}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

function nombreMesYAnio(): string {
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const hoy = new Date();
  return `${meses[hoy.getMonth()]} ${hoy.getFullYear()}`;
}

type LocalObjetivo = {
  local: Local;
  sumReal: number;
  sumComp: number;
  desvioPct: number | null;
};

export default function ObjetivosScreen() {
  const router = useRouter();
  const [fechaInicio, setFechaInicio] = useState(() => mesEnCurso().inicio);
  const [fechaFin, setFechaFin] = useState(() => mesEnCurso().fin);
  const [localSeleccionado, setLocalSeleccionado] = useState<Local | null>(null);
  const [locales, setLocales] = useState<Local[]>([]);
  const [loadingLocales, setLoadingLocales] = useState(true);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registros, setRegistros] = useState<FilaObjetivo[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [localesObjetivos, setLocalesObjetivos] = useState<LocalObjetivo[]>([]);
  const [loadingLocalesObjetivos, setLoadingLocalesObjetivos] = useState(false);

  const cargarLocales = useCallback(() => {
    setLoadingLocales(true);
    fetch(`${API_URL}/api/locales`)
      .then((res) => res.json())
      .then((data: { locales?: Local[] }) => {
        const list = Array.isArray(data.locales) ? data.locales : [];
        setLocales(list.filter((l) => (l.agoraCode ?? l.AgoraCode ?? '').toString().trim()));
      })
      .catch((e) => setError(e.message || 'Error al cargar locales'))
      .finally(() => setLoadingLocales(false));
  }, []);

  useEffect(() => {
    cargarLocales();
  }, [cargarLocales]);

  const cargarLocalesObjetivos = useCallback(async () => {
    if (locales.length === 0) return;
    setLoadingLocalesObjetivos(true);
    const { inicio: fechaInicioMes, fin: fechaFinMes } = mesEnCurso();
    try {
      const festivosRes = await fetch(`${API_URL}/api/gestion-festivos`);
      const festivosData = await festivosRes.json();
      const festivosList: FestivoReg[] = Array.isArray(festivosData.registros) ? festivosData.registros : [];
      const festivosByFecha = Object.fromEntries(
        festivosList
          .filter((f) => f.PK || f.FechaComparativa)
          .map((f) => [String(f.PK ?? f.FechaComparativa ?? '').slice(0, 10), f])
      );
      const d = new Date(fechaInicioMes + 'T12:00:00');
      const end = new Date(fechaFinMes + 'T12:00:00');
      let minComp = '';
      let maxComp = '';
      const fechaToComp: Record<string, string> = {};
      while (d <= end) {
        const fecha = d.toISOString().slice(0, 10);
        const festivo = festivosByFecha[fecha];
        const fechaComp = festivo?.FechaComparativa && /^\d{4}-\d{2}-\d{2}$/.test(String(festivo.FechaComparativa).slice(0, 10))
          ? String(festivo.FechaComparativa).slice(0, 10)
          : fechaComparacion(fecha);
        fechaToComp[fecha] = fechaComp;
        if (!minComp || fechaComp < minComp) minComp = fechaComp;
        if (!maxComp || fechaComp > maxComp) maxComp = fechaComp;
        d.setDate(d.getDate() + 1);
      }
      const resultados: LocalObjetivo[] = await Promise.all(
        locales.map(async (loc) => {
          const workplaceId = (loc.agoraCode ?? loc.AgoraCode ?? '').toString().trim();
          if (!workplaceId) return { local: loc, sumReal: 0, sumComp: 0, desvioPct: null };
          try {
            const [totalsRealRes, totalsCompRes] = await Promise.all([
              fetch(`${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${fechaInicioMes}&dateTo=${fechaFinMes}`),
              fetch(`${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${minComp}&dateTo=${maxComp}`),
            ]);
            const totalsRealData = await totalsRealRes.json();
            const totalsCompData = await totalsCompRes.json();
            const totalsReal: Record<string, number> = totalsRealData.totals ?? {};
            const totalsComp: Record<string, number> = totalsCompData.totals ?? {};
            const d2 = new Date(fechaInicioMes + 'T12:00:00');
            const end2 = new Date(fechaFinMes + 'T12:00:00');
            let sumReal = 0;
            let sumComp = 0;
            while (d2 <= end2) {
              const fecha = d2.toISOString().slice(0, 10);
              const fechaComp = fechaToComp[fecha];
              sumReal += totalsReal[fecha] ?? 0;
              sumComp += totalsComp[fechaComp] ?? 0;
              d2.setDate(d2.getDate() + 1);
            }
            const desvioPct = sumComp === 0 ? null : sumReal / sumComp - 1;
            return { local: loc, sumReal, sumComp, desvioPct };
          } catch {
            return { local: loc, sumReal: 0, sumComp: 0, desvioPct: null };
          }
        })
      );
      setLocalesObjetivos(resultados);
    } catch {
      setLocalesObjetivos([]);
    } finally {
      setLoadingLocalesObjetivos(false);
    }
  }, [locales]);

  useEffect(() => {
    cargarLocalesObjetivos();
  }, [cargarLocalesObjetivos]);

  const generar = useCallback(async () => {
    const workplaceId = (localSeleccionado?.agoraCode ?? localSeleccionado?.AgoraCode ?? '').toString().trim();
    if (!workplaceId) {
      setError('Selecciona un local');
      return;
    }
    if (!fechaInicio || !fechaFin || !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaFin)) {
      setError('Indica rango de fechas (YYYY-MM-DD)');
      return;
    }
    if (fechaInicio > fechaFin) {
      setError('Fecha inicio debe ser <= fecha fin');
      return;
    }
    setError(null);
    setGenerando(true);
    try {
      const [totalsRealRes, festivosRes] = await Promise.all([
        fetch(`${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${fechaInicio}&dateTo=${fechaFin}`),
        fetch(`${API_URL}/api/gestion-festivos`),
      ]);
      const totalsRealData = await totalsRealRes.json();
      const festivosData = await festivosRes.json();
      const totalsReal: Record<string, number> = totalsRealData.totals ?? {};
      const festivosList: FestivoReg[] = Array.isArray(festivosData.registros) ? festivosData.registros : [];
      const festivosByFecha = Object.fromEntries(
        festivosList
          .filter((f) => f.PK || f.FechaComparativa)
          .map((f) => [String(f.PK ?? f.FechaComparativa ?? '').slice(0, 10), f])
      );

      // Calcular FechaComparacion desde tabla comparativa (o año anterior si no existe)
      let minComp = '';
      let maxComp = '';
      const d = new Date(fechaInicio + 'T12:00:00');
      const end = new Date(fechaFin + 'T12:00:00');
      const fechaToComp: Record<string, string> = {};
      while (d <= end) {
        const fecha = d.toISOString().slice(0, 10);
        const festivo = festivosByFecha[fecha];
        const fechaComp = festivo?.FechaComparativa && /^\d{4}-\d{2}-\d{2}$/.test(String(festivo.FechaComparativa).slice(0, 10))
          ? String(festivo.FechaComparativa).slice(0, 10)
          : fechaComparacion(fecha);
        fechaToComp[fecha] = fechaComp;
        if (!minComp || fechaComp < minComp) minComp = fechaComp;
        if (!maxComp || fechaComp > maxComp) maxComp = fechaComp;
        d.setDate(d.getDate() + 1);
      }

      const totalsCompRes = await fetch(
        `${API_URL}/api/agora/closeouts/totals-by-local-range?workplaceId=${encodeURIComponent(workplaceId)}&dateFrom=${minComp}&dateTo=${maxComp}`
      );
      const totalsCompData = await totalsCompRes.json();
      const totalsComp: Record<string, number> = totalsCompData.totals ?? {};

      const filas: FilaObjetivo[] = [];
      const d2 = new Date(fechaInicio + 'T12:00:00');
      const end2 = new Date(fechaFin + 'T12:00:00');
      while (d2 <= end2) {
        const fecha = d2.toISOString().slice(0, 10);
        const fechaComp = fechaToComp[fecha];
        const real = totalsReal[fecha] ?? 0;
        // TotalFacturadoComparativa = facturación Igp_SalesCloseouts para este local en FechaComparacion
        const comp = totalsComp[fechaComp] ?? 0;
        const festivo = festivosByFecha[fecha];
        const esFestivo = String(festivo?.Festivo).toLowerCase() === 'true';
        const nombreFestivo = String(festivo?.NombreFestivo ?? '').trim();
        const desvio = real - comp;
        const desvioPct = comp === 0 ? null : real / comp - 1;
        filas.push({
          Fecha: fecha,
          FechaComparacion: fechaComp,
          Festivo: esFestivo,
          NombreFestivo: nombreFestivo,
          TotalFacturadoReal: real,
          TotalFacturadoComparativa: comp,
          Desvio: desvio,
          DesvioPct: desvioPct,
        });
        d2.setDate(d2.getDate() + 1);
      }
      setRegistros(filas);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al generar');
      setRegistros([]);
    } finally {
      setGenerando(false);
    }
  }, [fechaInicio, fechaFin, localSeleccionado]);

  const nombreLocal = localSeleccionado ? (localSeleccionado.nombre ?? localSeleccionado.Nombre ?? localSeleccionado.agoraCode ?? localSeleccionado.AgoraCode ?? '—') : 'Seleccionar local';

  const sumReal = registros.reduce((a, r) => a + r.TotalFacturadoReal, 0);
  const sumComp = registros.reduce((a, r) => a + r.TotalFacturadoComparativa, 0);
  const sumDesvio = registros.reduce((a, r) => a + r.Desvio, 0);
  const desvioPctTotal = sumComp === 0 ? null : sumReal / sumComp - 1;
  const tickerEstilo = estiloTicker(desvioPctTotal);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Objetivos</Text>
      </View>

      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainScrollContent}
        showsVerticalScrollIndicator
      >
      <View style={styles.mainRow}>
        <View style={styles.leftColumn}>
          <View style={styles.widget}>
        <Text style={styles.widgetTitle}>Generar comparativa</Text>
        <View style={styles.formRow}>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Fecha inicio</Text>
            <TextInput
              style={styles.formInput}
              value={fechaInicio}
              onChangeText={setFechaInicio}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#94a3b8"
            />
          </View>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Fecha fin</Text>
            <TextInput
              style={styles.formInput}
              value={fechaFin}
              onChangeText={setFechaFin}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#94a3b8"
            />
          </View>
        </View>
        <View style={styles.formRow}>
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Local</Text>
            <TouchableOpacity
              style={styles.dropdown}
              onPress={() => setDropdownOpen((v) => !v)}
            >
              <Text style={styles.dropdownText} numberOfLines={1} ellipsizeMode="tail">
                {loadingLocales ? 'Cargando…' : nombreLocal}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={16} color="#64748b" style={styles.dropdownIcon} />
            </TouchableOpacity>
            {dropdownOpen && (
              <Modal visible transparent animationType="fade">
                <Pressable style={styles.dropdownOverlay} onPress={() => setDropdownOpen(false)}>
                  <View style={styles.dropdownList}>
                    {locales.length > 0 ? (
                      <ScrollView style={styles.dropdownListScroll} nestedScrollEnabled showsVerticalScrollIndicator>
                        {locales.map((loc) => {
                          const code = (loc.agoraCode ?? loc.AgoraCode ?? '').toString().trim();
                          const nom = (loc.nombre ?? loc.Nombre ?? code).toString().trim();
                          return (
                            <TouchableOpacity
                              key={loc.id_Locales ?? code}
                              style={styles.dropdownItem}
                              onPress={() => {
                                setLocalSeleccionado(loc);
                                setDropdownOpen(false);
                              }}
                            >
                              <Text style={styles.dropdownItemText} numberOfLines={1} ellipsizeMode="tail">
                                {nom || code || '—'}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    ) : !loadingLocales ? (
                      <Text style={styles.dropdownEmpty}>No hay locales con AgoraCode</Text>
                    ) : null}
                  </View>
                </Pressable>
              </Modal>
            )}
          </View>
          <TouchableOpacity
              style={[styles.btnGenerar, generando && styles.btnGenerarDisabled]}
              onPress={generar}
              disabled={generando}
            >
              {generando ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <MaterialIcons name="play-arrow" size={16} color="#fff" />
              )}
              <Text style={styles.btnGenerarText}>Generar</Text>
            </TouchableOpacity>
        </View>
      </View>

          <View style={[styles.widget, styles.widgetLocales]}>
          <Text style={styles.widgetLocalesTitle}>{nombreMesYAnio()}</Text>
          {loadingLocalesObjetivos ? (
            <ActivityIndicator size="small" color="#64748b" style={styles.widgetLocalesLoader} />
          ) : (
            <ScrollView style={styles.localesListScroll} nestedScrollEnabled showsVerticalScrollIndicator>
              {[...localesObjetivos]
                .sort((a, b) => {
                  const nomA = (a.local.nombre ?? a.local.Nombre ?? a.local.agoraCode ?? a.local.AgoraCode ?? '—').toString().trim().toLowerCase();
                  const nomB = (b.local.nombre ?? b.local.Nombre ?? b.local.agoraCode ?? b.local.AgoraCode ?? '—').toString().trim().toLowerCase();
                  return nomA.localeCompare(nomB);
                })
                .map((item) => {
                const nom = (item.local.nombre ?? item.local.Nombre ?? item.local.agoraCode ?? item.local.AgoraCode ?? '—').toString().trim();
                const pct = item.sumComp === 0 ? 0 : Math.min(100, (item.sumReal / item.sumComp) * 100);
                const estilo = estiloTicker(item.desvioPct);
                return (
                  <View key={item.local.id_Locales ?? item.local.agoraCode ?? item.local.AgoraCode} style={styles.localesListItem}>
                    <View style={styles.localesListHeader}>
                      <Text style={styles.localesListNombre} numberOfLines={1}>
                        {nom} <Text style={styles.localesListPct}>({pct.toFixed(1)}%)</Text>
                      </Text>
                      <View style={[styles.tickerBadge, { backgroundColor: estilo.backgroundColor }]}>
                        {item.desvioPct != null && (
                          <MaterialIcons
                            name={item.desvioPct >= 0 ? 'trending-up' : 'trending-down'}
                            size={12}
                            color={estilo.color}
                          />
                        )}
                        <Text style={[styles.tickerText, { color: estilo.color, fontSize: 11 }]}>
                          {formatPctTicker(item.desvioPct)}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.localesListProgressTrack}>
                      <View
                        style={[
                          styles.localesListProgressFill,
                          { width: `${pct}%` },
                        ]}
                      />
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
          </View>
        </View>

        {registros.length > 0 && (
        <View style={styles.tableWrapper}>
          <ScrollView
            horizontal
            style={styles.tableScroll}
            contentContainerStyle={styles.tableScrollContent}
            showsHorizontalScrollIndicator
          >
            <View style={styles.tableWithProgress}>
              <View style={styles.progressSection}>
                <View style={styles.progressHeader}>
                  <Text style={styles.progressLabel}>
                    {formatMoneda(sumReal)} / {formatMoneda(sumComp)}
                  </Text>
                  <Text style={styles.progressPct}>
                    {sumComp === 0 ? '0%' : `${Math.min(100, (sumReal / sumComp) * 100).toFixed(1)}%`}
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${sumComp === 0 ? 0 : Math.min(100, (sumReal / sumComp) * 100)}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            <View style={styles.table}>
            <View style={styles.rowHeader}>
              <Text style={[styles.cellHeader, styles.cellDia]}>Día</Text>
              <Text style={[styles.cellHeader, styles.cellFecha]}>Fecha</Text>
              <Text style={[styles.cellHeader, styles.cellFecha]}>FechaComparacion</Text>
              <Text style={[styles.cellHeader, styles.cellFestivo]}>Festivo</Text>
              <Text style={[styles.cellHeader, styles.cellNombre]}>NombreFestivo</Text>
              <Text style={[styles.cellHeader, styles.cellMoneda]}>TotalFacturadoReal</Text>
              <Text style={[styles.cellHeader, styles.cellMoneda]}>TotalFacturadoComparativa</Text>
              <Text style={[styles.cellHeader, styles.cellMoneda]}>Desvio</Text>
              <Text style={[styles.cellHeader, styles.cellPct]}>DesvioPct</Text>
            </View>
            <View style={styles.rowSummary}>
              <Text style={[styles.cellSummary, styles.cellDia]}>
                {registros.length} {registros.length === 1 ? 'registro' : 'registros'}
              </Text>
              <Text style={[styles.cellSummary, styles.cellFecha]} />
              <Text style={[styles.cellSummary, styles.cellFecha]} />
              <Text style={[styles.cellSummary, styles.cellFestivo]} />
              <Text style={[styles.cellSummary, styles.cellNombre]} />
              <Text style={[styles.cellSummary, styles.cellMoneda]}>{formatMoneda(sumReal)}</Text>
              <Text style={[styles.cellSummary, styles.cellMoneda]}>{formatMoneda(sumComp)}</Text>
              <Text style={[styles.cellSummary, styles.cellMoneda, styles.cellBold, colorDesvio(sumDesvio)]}>
                {formatMoneda(sumDesvio)}
              </Text>
              <View style={[styles.cellPctWrapper, styles.cellPct]}>
                <View style={[styles.tickerBadge, { backgroundColor: tickerEstilo.backgroundColor }]}>
                  {desvioPctTotal != null && (
                    <MaterialIcons
                      name={desvioPctTotal >= 0 ? 'trending-up' : 'trending-down'}
                      size={14}
                      color={tickerEstilo.color}
                    />
                  )}
                  <Text style={[styles.tickerText, { color: tickerEstilo.color }]}>
                    {formatPctTicker(desvioPctTotal)}
                  </Text>
                </View>
              </View>
            </View>
            {registros.map((r, idx) => (
              <View key={idx} style={styles.row}>
                <Text style={[styles.cell, styles.cellDia]}>{diaVirtual(r.Fecha, r.FechaComparacion)}</Text>
                <Text style={[styles.cell, styles.cellFecha, styles.cellBold]} numberOfLines={1}>{r.Fecha}</Text>
                <Text style={[styles.cell, styles.cellFecha]} numberOfLines={1}>{r.FechaComparacion}</Text>
                <Text style={[styles.cell, styles.cellFestivo]}>{r.Festivo ? 'Sí' : 'No'}</Text>
                <Text style={[styles.cell, styles.cellNombre]} numberOfLines={1}>{r.NombreFestivo || '—'}</Text>
                <Text style={[styles.cell, styles.cellMoneda, styles.cellBold]}>{formatMoneda(r.TotalFacturadoReal)}</Text>
                <Text style={[styles.cell, styles.cellMoneda]}>{formatMoneda(r.TotalFacturadoComparativa)}</Text>
                <Text style={[styles.cell, styles.cellMoneda, styles.cellBold, colorDesvio(r.Desvio)]}>{formatMoneda(r.Desvio)}</Text>
                <Text style={[styles.cell, styles.cellPct, styles.cellBold, colorDesvio(r.DesvioPct)]}>{formatPct(r.DesvioPct)}</Text>
              </View>
            ))}
          </View>
            </View>
          </ScrollView>
        </View>
        )}
      </View>
      </ScrollView>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  mainScroll: { flex: 1 },
  mainScrollContent: { flexGrow: 1, paddingBottom: 20 },
  mainRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  leftColumn: { flexDirection: 'column', gap: 12, flexShrink: 0, minWidth: 220 },
  widget: {
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignSelf: 'flex-start',
  },
  tableWrapper: { flex: 1, minWidth: 0 },
  widgetTitle: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 4 },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end' },
  formGroup: { flex: 1, minWidth: 90, maxWidth: 180 },
  formLabel: { fontSize: 11, fontWeight: '500', color: '#64748b', marginBottom: 1 },
  formInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 3,
    fontSize: 12,
    color: '#334155',
  },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 3,
    minHeight: 24,
    overflow: 'hidden',
  },
  dropdownText: { fontSize: 12, color: '#334155', flex: 1, minWidth: 0 },
  dropdownIcon: { marginLeft: 2, flexShrink: 0 },
  dropdownOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  dropdownList: {
    backgroundColor: '#fff',
    borderRadius: 6,
    maxHeight: 240,
    minWidth: 200,
    maxWidth: 320,
    width: '100%',
    overflow: 'hidden',
  },
  dropdownListScroll: { maxHeight: 240 },
  dropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    overflow: 'hidden',
    minWidth: 0,
  },
  dropdownItemText: { fontSize: 12, color: '#334155' },
  dropdownEmpty: { padding: 12, fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  btnGenerar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#0ea5e9',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 5,
  },
  btnGenerarDisabled: { opacity: 0.7 },
  btnGenerarText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  widgetLocales: { alignSelf: 'stretch', minHeight: 120, marginTop: 12 },
  widgetLocalesTitle: { fontSize: 14, fontWeight: '700', color: '#334155', marginBottom: 10 },
  widgetLocalesLoader: { marginVertical: 20 },
  localesListScroll: { maxHeight: 480 },
  localesListItem: { marginBottom: 10 },
  localesListHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  localesListNombre: { fontSize: 12, fontWeight: '500', color: '#334155', flex: 1, marginRight: 8 },
  localesListPct: { fontSize: 11, color: '#64748b', fontWeight: '400' },
  localesListProgressTrack: {
    height: 8,
    backgroundColor: '#e2e8f0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  localesListProgressFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: '#0ea5e9',
  },
  tableWithProgress: { minWidth: 862 },
  progressSection: { marginBottom: 8 },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  progressLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  progressPct: { fontSize: 12, fontWeight: '700', color: '#334155' },
  progressTrack: {
    height: 14,
    backgroundColor: '#e2e8f0',
    borderRadius: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 6,
    backgroundColor: '#0ea5e9',
  },
  errorText: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  tableScroll: { flexGrow: 1 },
  tableScrollContent: { paddingBottom: 20 },
  table: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  rowHeader: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
  },
  cellHeader: { fontSize: 11, fontWeight: '600', color: '#334155', paddingVertical: 8, paddingHorizontal: 8 },
  rowSummary: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  cellSummary: { fontSize: 11, fontWeight: '600', color: '#334155', paddingVertical: 6, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  cell: { fontSize: 11, color: '#475569', paddingVertical: 6, paddingHorizontal: 8 },
  cellBold: { fontWeight: '700' },
  cellDia: { width: 72 },
  cellFecha: { width: 100 },
  cellFestivo: { width: 60 },
  cellNombre: { width: 120 },
  cellMoneda: { width: 110, textAlign: 'right' },
  cellPct: { width: 80, textAlign: 'right' },
  cellPctWrapper: { justifyContent: 'center', alignItems: 'flex-end', paddingVertical: 4 },
  tickerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: 'flex-end',
    gap: 4,
  },
  tickerText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
});
