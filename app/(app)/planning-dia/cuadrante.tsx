/**
 * Cuadrante de personal — uno o varios locales y rango de fechas.
 *
 * Backend: GET /api/personal/cuadrante?local_ids=id1,id2&from=&to= (ISO)
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../../components/InputFecha';
import { SelectorRangoSemana } from '../../components/SelectorRangoSemana';
import { fechaJornadaNegocioIso } from '../../lib/jornadaNegocio';
import { apiFetch } from '../../utils/api';
import { useAuth } from '../../contexts/AuthContext';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../constants/theme';

type LocalItem = {
  id_Locales?: string;
  nombre?: string;
  factorial_location_id?: string;
};

type LocalResuelto = {
  local_id: string;
  nombre: string;
  factorial_location_id: string;
};

type Fila = {
  employee_id: string;
  nombre: string;
  planificado: { inicio: string | null; fin: string | null; minutos: number } | null;
  real: { inicio: string | null; fin: string | null; minutos: number } | null;
  desviacion_min: number;
  flags: string[];
  coste_bruto_cents: number;
  coste_empresa_cents: number;
  sin_contrato: boolean;
};

type DiaCuadrante = {
  fecha: string;
  totales: { coste_bruto_cents: number; coste_empresa_cents: number; minutos_planificados: number; minutos_reales: number };
  filas: Fila[];
};

type LocalCuadrante = {
  local_id: string;
  nombre: string;
  factorial_location_id: string;
  totales: { coste_bruto_cents: number; coste_empresa_cents: number; minutos_planificados: number; minutos_reales: number };
  dias: DiaCuadrante[];
};

type CuadranteResponse = {
  ok: true;
  local_ids?: string[];
  locales?: LocalResuelto[];
  from: string;
  to: string;
  totales: { coste_bruto_cents: number; coste_empresa_cents: number; minutos_planificados: number; minutos_reales: number };
  por_local: LocalCuadrante[];
};

function formatHora(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
}

function formatFecha(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatMin(min: number): string {
  if (!min) return '0 min';
  const sign = min < 0 ? '-' : '';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m} min`;
  return `${sign}${h}h ${String(m).padStart(2, '0')}m`;
}

function formatEur(cents: number): string {
  const eur = cents / 100;
  return eur.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/** Índice del bloque visual: filas consecutivas con el mismo employee_id cuentan como un grupo. */
function grupoEmpleadoIndex(filas: Fila[], idx: number): number {
  let g = 0;
  let i = 0;
  while (i < filas.length) {
    const eid = filas[i].employee_id;
    const start = i;
    while (i < filas.length && filas[i].employee_id === eid) i++;
    if (idx >= start && idx < i) return g;
    g++;
  }
  return 0;
}

function esPrimeraFilaEmpleado(filas: Fila[], idx: number): boolean {
  return idx === 0 || filas[idx - 1].employee_id !== filas[idx].employee_id;
}

/** Número de filas consecutivas del mismo empleado (turno partido / varios tramos). */
function tamanoGrupoEmpleado(filas: Fila[], idx: number): number {
  const eid = filas[idx].employee_id;
  let start = idx;
  while (start > 0 && filas[start - 1].employee_id === eid) start--;
  let end = idx;
  while (end < filas.length - 1 && filas[end + 1].employee_id === eid) end++;
  return end - start + 1;
}

/** 1 = primera fila del grupo, 2 = segundo tramo, etc. */
function indiceTramoEnGrupo(filas: Fila[], idx: number): number {
  let start = idx;
  const eid = filas[idx].employee_id;
  while (start > 0 && filas[start - 1].employee_id === eid) start--;
  return idx - start + 1;
}

const COL_WIDTHS = {
  empleado: 200,
  planInicio: 80,
  planFin: 80,
  planMin: 80,
  realInicio: 80,
  realFin: 80,
  realMin: 80,
  desv: 90,
  bruto: 100,
  empresa: 100,
  flags: 200,
};

const PLAN_GROUP_W = COL_WIDTHS.planInicio + COL_WIDTHS.planFin + COL_WIDTHS.planMin;
const REAL_GROUP_W = COL_WIDTHS.realInicio + COL_WIDTHS.realFin + COL_WIDTHS.realMin;

const DROPDOWN_Z = 10050;

export default function CuadrantePersonalScreen() {
  const router = useRouter();
  const { localPermitido } = useAuth();

  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [localesLoading, setLocalesLoading] = useState(true);
  const [localesError, setLocalesError] = useState<string | null>(null);

  const [selectedLocalIds, setSelectedLocalIds] = useState<string[]>([]);
  const [from, setFrom] = useState<string>(() => fechaJornadaNegocioIso());
  const [to, setTo] = useState<string>(() => fechaJornadaNegocioIso());
  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState('');

  const [data, setData] = useState<CuadranteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/locales')
      .then((res) => res.json())
      .then((res: { locales?: LocalItem[]; error?: string }) => {
        if (cancelled) return;
        if (res.error) setLocalesError(res.error);
        else setLocales(res.locales || []);
      })
      .catch((e) => {
        if (!cancelled) setLocalesError(e instanceof Error ? e.message : 'Error de conexión');
      })
      .finally(() => {
        if (!cancelled) setLocalesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const localesConFactorial = useMemo(
    () =>
      locales.filter(
        (l) =>
          l.factorial_location_id &&
          String(l.factorial_location_id).trim() !== '' &&
          localPermitido(String(l.nombre ?? '').trim()),
      ),
    [locales, localPermitido],
  );

  const localesFiltrados = useMemo(() => {
    const q = localSearch.trim().toLowerCase();
    const list = !q
      ? localesConFactorial
      : localesConFactorial.filter((l) => (l.nombre || '').toLowerCase().includes(q));
    return [...list].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '', 'es'));
  }, [localesConFactorial, localSearch]);

  const selectedSet = useMemo(() => new Set(selectedLocalIds), [selectedLocalIds]);

  const toggleLocal = (id: string) => {
    setSelectedLocalIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return [...s];
    });
  };

  const seleccionarTodosFiltrados = () => {
    setSelectedLocalIds((prev) => {
      const s = new Set(prev);
      for (const l of localesFiltrados) {
        if (l.id_Locales) s.add(l.id_Locales);
      }
      return [...s];
    });
  };

  const quitarSeleccionFiltrados = () => {
    const filtradosIds = new Set(localesFiltrados.map((l) => l.id_Locales).filter(Boolean) as string[]);
    setSelectedLocalIds((prev) => prev.filter((id) => !filtradosIds.has(id)));
  };

  const etiquetaLocalesSeleccionados = useMemo(() => {
    if (selectedLocalIds.length === 0) return 'Selecciona locales…';
    if (selectedLocalIds.length === 1) {
      const l = localesConFactorial.find((x) => x.id_Locales === selectedLocalIds[0]);
      return l?.nombre || selectedLocalIds[0];
    }
    return `${selectedLocalIds.length} locales seleccionados`;
  }, [selectedLocalIds, localesConFactorial]);

  const consultar = useCallback(async () => {
    if (selectedLocalIds.length === 0) {
      setError('Selecciona al menos un local');
      return;
    }
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoRe.test(from) || !isoRe.test(to)) {
      setError('Revisa las fechas (dd/mm/aaaa)');
      return;
    }
    if (from > to) {
      setError('La fecha "Desde" debe ser anterior o igual a "Hasta"');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const listParam = selectedLocalIds.map(encodeURIComponent).join(',');
      const qs = `local_ids=${listParam}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await apiFetch(`/api/personal/cuadrante?${qs}`);
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setError(json?.error || `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(json as CuadranteResponse);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedLocalIds, from, to]);

  const FlagChip = ({ flag }: { flag: string }) => {
    const cfg: Record<string, { label: string; bg: string; fg: string; icon: 'warning' | 'schedule' | 'event-busy' | 'logout' }> = {
      sin_planificado: { label: 'Sin turno', bg: statusColors.warning.bg, fg: statusColors.warning.text, icon: 'event-busy' },
      sin_real: { label: 'Sin fichaje', bg: statusColors.warning.bg, fg: statusColors.warning.text, icon: 'schedule' },
      tarde: { label: 'Tarde', bg: statusColors.danger.bg, fg: colors.danger, icon: 'warning' },
      salida_anticipada: { label: 'Salida ant.', bg: statusColors.warning.bg, fg: statusColors.warning.text, icon: 'logout' },
    };
    const c = cfg[flag] || { label: flag, bg: colors.border, fg: colors.textPrimary, icon: 'warning' as const };
    return (
      <View style={[styles.flagChip, { backgroundColor: c.bg }]}>
        <MaterialIcons name={c.icon} size={10} color={c.fg} />
        <Text style={[styles.flagChipText, { color: c.fg }]}>{c.label}</Text>
      </View>
    );
  };

  if (localesLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Cargando locales…</Text>
      </View>
    );
  }

  if (localesError) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color={colors.danger} />
        <Text style={styles.errorText}>{localesError}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Cuadrante de personal</Text>
          <Text style={styles.subtitle}>Turnos planificados vs fichajes reales (Factorial HR)</Text>
        </View>
      </View>

      {localesConFactorial.length === 0 ? (
        <View style={styles.warningBox}>
          <MaterialIcons name="info-outline" size={20} color={statusColors.warning.text} />
          <View style={{ flex: 1 }}>
            <Text style={styles.warningTitle}>Sin locales conectados a Factorial</Text>
            <Text style={styles.warningText}>
              Para usar el cuadrante configura &quot;Factorial location ID&quot; en al menos un local.
            </Text>
            <TouchableOpacity style={styles.warningBtn} onPress={() => router.push('/locales' as never)}>
              <MaterialIcons name="open-in-new" size={14} color={colors.accent} />
              <Text style={styles.warningBtnText}>Ir al módulo de Locales</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <>
          {localDropdownOpen && Platform.OS === 'web' && (
            <Pressable style={styles.dropdownBackdrop} onPress={() => setLocalDropdownOpen(false)} />
          )}

          <View style={[styles.filtersBlock, localDropdownOpen && styles.filtersBlockOnTop]}>
            <View style={[styles.filtersRow, localDropdownOpen && styles.filtersRowOnTop]}>
              <View style={[styles.filterField, styles.filterFieldLocals]}>
                <Text style={styles.filterLabel}>Locales</Text>
                <View style={styles.localPickerAnchor}>
                  <TouchableOpacity
                    style={[styles.formInput, styles.formInputRow]}
                    onPress={() => setLocalDropdownOpen((o) => !o)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.formInputText, selectedLocalIds.length === 0 && styles.formInputPlaceholder]}
                      numberOfLines={1}
                    >
                      {etiquetaLocalesSeleccionados}
                    </Text>
                    <MaterialIcons
                      name={localDropdownOpen ? 'expand-less' : 'expand-more'}
                      size={18}
                      color={colors.textMuted}
                    />
                  </TouchableOpacity>
                  {localDropdownOpen && (
                    <View style={styles.dropdownWrap}>
                    <TextInput
                      style={styles.dropdownSearch}
                      value={localSearch}
                      onChangeText={setLocalSearch}
                      placeholder="Buscar local…"
                      placeholderTextColor={colors.textMuted}
                    />
                    <View style={styles.dropdownBulkRow}>
                      <TouchableOpacity onPress={seleccionarTodosFiltrados} style={styles.dropdownBulkBtn}>
                        <MaterialIcons name="done-all" size={14} color={colors.accent} />
                        <Text style={styles.dropdownBulkText}>Todos (lista)</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={quitarSeleccionFiltrados} style={styles.dropdownBulkBtn}>
                        <MaterialIcons name="remove-done" size={14} color={colors.textMuted} />
                        <Text style={[styles.dropdownBulkText, { color: colors.textMuted }]}>Quitar lista</Text>
                      </TouchableOpacity>
                    </View>
                    <ScrollView style={styles.dropdownScroll} keyboardShouldPersistTaps="handled">
                      {localesFiltrados.length === 0 ? (
                        <View style={styles.dropdownOption}>
                          <Text style={styles.dropdownOptionText}>Sin resultados</Text>
                        </View>
                      ) : (
                        localesFiltrados.map((l, idx) => {
                          const id = l.id_Locales || '';
                          const on = id && selectedSet.has(id);
                          return (
                            <TouchableOpacity
                              key={id || `loc-${idx}`}
                              style={styles.dropdownOptionRow}
                              onPress={() => id && toggleLocal(id)}
                              activeOpacity={0.7}
                            >
                              <MaterialIcons
                                name={on ? 'check-box' : 'check-box-outline-blank'}
                                size={20}
                                color={on ? colors.accent : colors.textMuted}
                              />
                              <Text style={styles.dropdownOptionText} numberOfLines={1}>{l.nombre || '—'}</Text>
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </ScrollView>
                  </View>
                )}
                </View>
              </View>

              <View style={[styles.filterField, { minWidth: 132 }]}>
                <Text style={styles.filterLabel}>Desde</Text>
                <InputFecha style={styles.inputDmy} valueIso={from} onChangeIso={setFrom} />
              </View>

              <View style={[styles.filterField, { minWidth: 132 }]}>
                <Text style={styles.filterLabel}>Hasta</Text>
                <InputFecha style={styles.inputDmy} valueIso={to} onChangeIso={setTo} />
              </View>

              <TouchableOpacity
                style={[styles.consultarBtn, (loading || selectedLocalIds.length === 0) && styles.consultarBtnDisabled]}
                onPress={consultar}
                disabled={loading || selectedLocalIds.length === 0}
                activeOpacity={0.7}
              >
                {loading ? (
                  <ActivityIndicator size="small" color={colors.surface} />
                ) : (
                  <MaterialIcons name="search" size={16} color={colors.surface} />
                )}
                <Text style={styles.consultarBtnText}>{loading ? 'Consultando…' : 'Consultar'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.presetRow}>
              <SelectorRangoSemana from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
            </View>
          </View>

          {error ? (
            <View style={styles.errorBar}>
              <MaterialIcons name="error-outline" size={16} color={colors.danger} />
              <Text style={styles.errorBarText}>{error}</Text>
            </View>
          ) : null}

          {data && (
            <>
              <View style={styles.totalsBar}>
                <MaterialIcons name="functions" size={15} color="#0c4a6e" />
                <Text style={styles.totalsText}>
                  Total ({data.por_local?.length ?? 0} local{(data.por_local?.length ?? 0) !== 1 ? 'es' : ''}) ·{' '}
                  {formatFecha(data.from)} → {formatFecha(data.to)} ·{' '}
                  Plan: <Text style={styles.totalsStrong}>{formatMin(data.totales.minutos_planificados)}</Text> ·{' '}
                  Real: <Text style={styles.totalsStrong}>{formatMin(data.totales.minutos_reales)}</Text> ·{' '}
                  Bruto: <Text style={styles.totalsStrong}>{formatEur(data.totales.coste_bruto_cents)}</Text> ·{' '}
                  Empresa: <Text style={styles.totalsStrong}>{formatEur(data.totales.coste_empresa_cents)}</Text>
                </Text>
              </View>

              <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: SPACING.xl }}>
                {!data.por_local?.length ||
                data.por_local.every((b) => b.dias.every((d) => d.filas.length === 0)) ? (
                  <View style={styles.emptyWrap}>
                    <MaterialIcons name="event-available" size={40} color={colors.borderStrong} />
                    <Text style={styles.emptyText}>Sin turnos ni fichajes en el rango seleccionado.</Text>
                  </View>
                ) : (
                  data.por_local.map((block) => (
                    <View key={block.local_id} style={styles.localGroup}>
                      <View style={styles.localGroupHeader}>
                        <MaterialIcons name="storefront" size={18} color={statusColors.info.text} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.localGroupTitle}>{block.nombre}</Text>
                          <Text style={styles.localGroupMeta}>
                            Plan {formatMin(block.totales.minutos_planificados)} · Real {formatMin(block.totales.minutos_reales)}
                            {' · '}Bruto {formatEur(block.totales.coste_bruto_cents)} · Empresa {formatEur(block.totales.coste_empresa_cents)}
                          </Text>
                        </View>
                      </View>
                      {block.dias.map((dia) => (dia.filas.length === 0 ? null : (
                        <View key={`${block.local_id}-${dia.fecha}`} style={styles.diaBlock}>
                          <View style={styles.diaHeader}>
                            <MaterialIcons name="event" size={16} color={colors.accent} />
                            <Text style={styles.diaTitle}>{formatFecha(dia.fecha)}</Text>
                            <View style={styles.diaTotalsWrap}>
                              <Text style={styles.diaTotalsText}>
                                Plan {formatMin(dia.totales.minutos_planificados)} · Real {formatMin(dia.totales.minutos_reales)}
                                {' · '}
                                Bruto {formatEur(dia.totales.coste_bruto_cents)} · Empresa {formatEur(dia.totales.coste_empresa_cents)}
                              </Text>
                            </View>
                          </View>

                          <ScrollView horizontal showsHorizontalScrollIndicator>
                            <View>
                              <View style={styles.tableGroupHeader}>
                                <View style={[styles.cellGroupHeader, { width: COL_WIDTHS.empleado }]} />
                                <View style={[styles.cellGroupHeader, styles.cellGroupHeaderPlan, { width: PLAN_GROUP_W }]}>
                                  <Text style={styles.cellGroupHeaderText}>Planificado (cuadrante)</Text>
                                </View>
                                <View style={[styles.cellGroupHeader, styles.cellGroupHeaderReal, { width: REAL_GROUP_W }]}>
                                  <Text style={styles.cellGroupHeaderText}>Fichado (real)</Text>
                                </View>
                                <View style={[styles.cellGroupHeader, { width: COL_WIDTHS.desv }]} />
                                <View style={[styles.cellGroupHeader, { width: COL_WIDTHS.bruto }]} />
                                <View style={[styles.cellGroupHeader, { width: COL_WIDTHS.empresa }]} />
                                <View style={[styles.cellGroupHeader, { width: COL_WIDTHS.flags }]} />
                              </View>
                              <View style={styles.tableHeader}>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.empleado }]}><Text style={styles.cellHeaderText}>Empleado</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.planInicio }]}><Text style={styles.cellHeaderText}>Plan in.</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.planFin }]}><Text style={styles.cellHeaderText}>Plan fin</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.planMin }]}><Text style={styles.cellHeaderText}>Plan min</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.realInicio }]}><Text style={styles.cellHeaderText}>Real in.</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.realFin }]}><Text style={styles.cellHeaderText}>Real fin</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.realMin }]}><Text style={styles.cellHeaderText}>Real min</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.desv }]}><Text style={styles.cellHeaderText}>Desv.</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.bruto }]}><Text style={styles.cellHeaderText}>Bruto</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.empresa }]}><Text style={styles.cellHeaderText}>Empresa</Text></View>
                                <View style={[styles.cellHeader, { width: COL_WIDTHS.flags }]}><Text style={styles.cellHeaderText}>Estado</Text></View>
                              </View>

                              {dia.filas.map((f, idx) => {
                                const primera = esPrimeraFilaEmpleado(dia.filas, idx);
                                const nGrupo = tamanoGrupoEmpleado(dia.filas, idx);
                                const tramo = indiceTramoEnGrupo(dia.filas, idx);
                                const gIdx = grupoEmpleadoIndex(dia.filas, idx);
                                const rowBg = gIdx % 2 === 0 ? colors.surface : colors.bg;

                                return (
                                <View
                                  key={`${block.local_id}-${dia.fecha}-${f.employee_id}-${idx}`}
                                  style={[styles.row, { backgroundColor: rowBg }]}
                                >
                                  <View
                                    style={[
                                      styles.cell,
                                      styles.cellEmpleado,
                                      { width: COL_WIDTHS.empleado },
                                      !primera && styles.cellEmpleadoContinuacion,
                                    ]}
                                  >
                                    {primera ? (
                                      <>
                                        <Text style={styles.cellTextNombre} numberOfLines={1}>{f.nombre}</Text>
                                        {nGrupo > 1 && (
                                          <Text style={styles.cellMultitramo}>{nGrupo} tramos</Text>
                                        )}
                                        {f.sin_contrato && (
                                          <Text style={styles.cellSubtext}>sin contrato</Text>
                                        )}
                                      </>
                                    ) : (
                                      <Text style={styles.cellTextTramo}>Tramo {tramo}</Text>
                                    )}
                                  </View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.planInicio }]}><Text style={styles.cellText}>{formatHora(f.planificado?.inicio ?? null)}</Text></View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.planFin }]}><Text style={styles.cellText}>{formatHora(f.planificado?.fin ?? null)}</Text></View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.planMin }]}><Text style={styles.cellText}>{f.planificado ? formatMin(f.planificado.minutos) : '—'}</Text></View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.realInicio }]}><Text style={styles.cellText}>{formatHora(f.real?.inicio ?? null)}</Text></View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.realFin }]}><Text style={styles.cellText}>{formatHora(f.real?.fin ?? null)}</Text></View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.realMin }]}><Text style={styles.cellText}>{f.real ? formatMin(f.real.minutos) : '—'}</Text></View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.desv }]}>
                                    <Text
                                      style={[
                                        styles.cellText,
                                        f.desviacion_min > 0 && styles.desvPositiva,
                                        f.desviacion_min < 0 && styles.desvNegativa,
                                      ]}
                                    >
                                      {formatMin(f.desviacion_min)}
                                    </Text>
                                  </View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.bruto }]}><Text style={styles.cellText}>{formatEur(f.coste_bruto_cents)}</Text></View>
                                  <View style={[styles.cell, { width: COL_WIDTHS.empresa }]}><Text style={styles.cellText}>{formatEur(f.coste_empresa_cents)}</Text></View>
                                  <View style={[styles.cell, styles.cellEstado, { width: COL_WIDTHS.flags }]}>
                                    {f.flags.length === 0 ? (
                                      <View style={styles.flagChipOk}>
                                        <MaterialIcons name="check" size={10} color={colors.success} />
                                        <Text style={styles.flagChipOkText}>OK</Text>
                                      </View>
                                    ) : (
                                      f.flags.map((fl) => <FlagChip key={fl} flag={fl} />)
                                    )}
                                  </View>
                                </View>
                                );
                              })}
                            </View>
                          </ScrollView>
                        </View>
                      )))}
                    </View>
                  ))
                )}
              </ScrollView>
            </>
          )}
        </>
      )}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, textAlign: 'center' },

  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.md, gap: 10 },
  backBtn: {
    width: 36, height: 36, borderRadius: RADIO_MEDIO, backgroundColor: colors.navActive,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },

  warningBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: statusColors.warning.bg, borderWidth: 1, borderColor: '#fde68a',
    borderRadius: radius.md, padding: SPACING.lg, marginTop: SPACING.md,
  },
  warningTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: '#92400e', marginBottom: SPACING.xs },
  warningText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: '#92400e', marginBottom: 10 },
  warningBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    paddingVertical: 6, paddingHorizontal: SPACING.md, borderRadius: RADIO_MEDIO,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.accent,
  },
  warningBtnText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },

  dropdownBackdrop: {
    ...Platform.select({
      web: {
        position: 'fixed' as const,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: DROPDOWN_Z - 1,
      },
      default: {},
    }),
  },

  filtersBlock: {
    marginBottom: SPACING.sm,
    position: 'relative' as const,
    zIndex: 1,
    overflow: 'visible' as const,
  },
  filtersBlockOnTop: { zIndex: DROPDOWN_Z, ...(Platform.OS !== 'web' ? { elevation: 24 } : {}) },

  filtersRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: SPACING.md,
    overflow: 'visible' as const,
  },
  filtersRowOnTop: { position: 'relative' as const, zIndex: DROPDOWN_Z + 2 },
  presetRow: { marginTop: 10 },
  filterField: { flexShrink: 0 },
  filterFieldLocals: {
    minWidth: 260,
    flexGrow: 0,
    ...(Platform.OS === 'web' ? { maxWidth: 380 } : {}),
  },
  localPickerAnchor: {
    position: 'relative' as const,
  },
  filterLabel: { fontSize: fontSizes.badge, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textPrimary, marginBottom: SPACING.xs },

  formInput: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIO_MEDIO, paddingHorizontal: 10, paddingVertical: 6,
    fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, minHeight: 32,
  },
  formInputRow: { flexDirection: 'row', alignItems: 'center' },
  formInputText: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, flex: 1 },
  formInputPlaceholder: { color: colors.textMuted },

  inputDmy: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIO_MEDIO, paddingHorizontal: 10, paddingVertical: 6,
    fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, minHeight: 32,
  },

  dropdownWrap: {
    marginTop: SPACING.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    overflow: 'hidden',
    maxHeight: 300,
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    zIndex: DROPDOWN_Z + 1,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }
      : { elevation: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 16 }),
  },

  dropdownSearch: {
    paddingVertical: 6, paddingHorizontal: SPACING.sm, fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize,
    color: colors.textPrimary, backgroundColor: colors.bg,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  dropdownBulkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: 6,
    paddingHorizontal: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
    backgroundColor: colors.surface,
  },
  dropdownBulkBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  dropdownBulkText: { fontSize: typography.etiqueta.fontSize, color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  dropdownScroll: { maxHeight: 220 },
  dropdownOption: {
    paddingVertical: SPACING.sm, paddingHorizontal: 10,
    borderBottomWidth: 1, borderBottomColor: colors.navActive,
  },
  dropdownOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.navActive,
  },
  dropdownOptionText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textPrimary, flex: 1 },

  consultarBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: SPACING.sm, paddingHorizontal: 14,
    borderRadius: RADIO_MEDIO, backgroundColor: colors.accent,
    minHeight: 32,
  },
  consultarBtnDisabled: { opacity: 0.5 },
  consultarBtnText: { color: colors.surface, fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: statusColors.danger.bg, borderWidth: 1, borderColor: '#fecaca',
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADIO_MEDIO,
    marginBottom: SPACING.sm,
  },
  errorBarText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, flex: 1 },

  totalsBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.accentMuted, borderWidth: 1, borderColor: '#bae6fd',
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADIO_MEDIO,
    marginBottom: SPACING.sm, flexWrap: 'wrap',
  },
  totalsText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: '#0c4a6e', flex: 1 },
  totalsStrong: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },

  scroll: { flex: 1, position: 'relative' as const, zIndex: 0 },
  emptyWrap: { alignItems: 'center', paddingVertical: 40, gap: SPACING.sm },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },

  localGroup: {
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  localGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: colors.accentMuted,
    borderBottomWidth: 1,
    borderBottomColor: '#bae6fd',
  },
  localGroupTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: '#0c4a6e' },
  localGroupMeta: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: '#0c4a6e', marginTop: SPACING.xs, opacity: 0.9 },

  diaBlock: { marginBottom: 10, marginHorizontal: SPACING.sm, marginTop: 6, borderWidth: 1, borderColor: colors.border, borderRadius: RADIO_MEDIO, overflow: 'hidden', backgroundColor: colors.surface },
  diaHeader: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap',
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  diaTitle: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  diaTotalsWrap: { flex: 1, alignItems: 'flex-end' },
  diaTotalsText: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },

  tableGroupHeader: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.borderStrong },
  cellGroupHeader: {
    paddingVertical: SPACING.xs, paddingHorizontal: 6,
    borderRightWidth: 1, borderRightColor: colors.borderStrong,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#eef2f6',
  },
  cellGroupHeaderPlan: { backgroundColor: '#dbeafe' },
  cellGroupHeaderReal: { backgroundColor: statusColors.success.bg },
  cellGroupHeaderText: { fontSize: fontSizes.badge, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, textAlign: 'center' },

  tableHeader: { flexDirection: 'row', backgroundColor: colors.border, borderBottomWidth: 1, borderBottomColor: colors.borderStrong },
  cellHeader: {
    paddingVertical: SPACING.xs, paddingHorizontal: 6,
    borderRightWidth: 1, borderRightColor: colors.borderStrong,
    justifyContent: 'center',
  },
  cellHeaderText: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },

  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
  cell: {
    paddingVertical: 3, paddingHorizontal: 6,
    borderRightWidth: 1, borderRightColor: colors.border,
    justifyContent: 'center', alignItems: 'flex-start',
  },
  cellEmpleado: { justifyContent: 'flex-start' },
  cellEmpleadoContinuacion: {
    borderLeftWidth: 3,
    borderLeftColor: '#7dd3fc',
    paddingLeft: 5,
    backgroundColor: 'transparent',
  },
  cellText: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  cellTextNombre: { fontSize: fontSizes.badge, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  cellTextTramo: { fontFamily: fontFamily.regular, fontSize: fontSizes.badge, color: colors.textMuted, fontStyle: 'italic' },
  /** 9 px sube a 11 (suelo de etiqueta). */
  cellMultitramo: { fontSize: typography.etiqueta.fontSize, color: statusColors.info.text, marginTop: 2, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  /** 8 px sube a 11 (suelo de etiqueta). */
  cellSubtext: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: 2 },
  desvPositiva: { color: colors.danger, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  desvNegativa: { color: statusColors.warning.text, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },

  cellEstado: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 3,
    justifyContent: 'flex-start', alignItems: 'center',
  },
  flagChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, // 5 px; radius.sm es 6
  },
  /** 9 px sube a 11 (suelo de etiqueta). */
  flagChipText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  flagChipOk: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, // 5 px; radius.sm es 6
    backgroundColor: statusColors.success.bg,
  },
  /** 9 px sube a 11 (suelo de etiqueta). */
  flagChipOkText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.success },
});
