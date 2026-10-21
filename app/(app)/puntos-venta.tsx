import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  PanResponder,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import {
  ERP_LIST_HEADER_TEXT_PROPS,
  ERP_LIST_MIN_COL_WIDTH,
  erpListTableStyles,
} from '../constants/erpListTableStyles';
import { MIN_TOUCH } from '../constants/layout';
import { useBreakpoint } from '../hooks/useBreakpoint';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { SelectorDesplegable, type OpcionDesplegable } from '../components/SelectorDesplegable';
import { apiFetch, errorMessage } from '../utils/api';
import { formatId6 } from '../utils/idFormat';

const DEFAULT_COL_WIDTH = 100;
const MIN_COL_WIDTH = ERP_LIST_MIN_COL_WIDTH;
const MAX_COL_WIDTH = 280;
const PAGE_SIZE = 50;

/** Opción del selector para dejar el local sin centro de venta asignado. */
const OPCION_SIN_ASIGNAR = '__ninguno__';

type Pestana = 'tarifas' | 'tpv';

type PuntoVentaItem = {
  Id?: number | string;
  /** Algunas respuestas API usan minúscula */
  id?: number | string;
  Nombre?: string;
  Tipo?: string;
  Local?: string;
  Grupo?: string;
  Activo?: boolean;
};

type CentroVentaItem = {
  id?: string | number;
  nombre?: string;
  priceListId?: string | number | null;
};

type LocalItem = {
  id_Locales?: string | number;
  nombre?: string;
  Nombre?: string;
};

type TarifaLocal = {
  saleCenterId: string | null;
  priceListId: string | number | null;
};

const COLUMNAS: (keyof PuntoVentaItem)[] = ['Activo', 'Id', 'Nombre', 'Tipo', 'Local', 'Grupo'];

const COL_LABELS: Record<string, string> = {
  Activo: 'Activo',
  Id: 'ID',
  Nombre: 'Nombre',
  Tipo: 'Tipo',
  Local: 'Local',
  Grupo: 'Grupo',
};

const ACTIVO_COL_WIDTH = 40;

function getValorCelda(item: PuntoVentaItem, col: string): string {
  if (col === 'Activo') return '';
  const v = item[col as keyof PuntoVentaItem];
  if (v == null || v === '') return '—';
  return String(v);
}

function isActivo(item: PuntoVentaItem): boolean {
  return item.Activo !== false;
}

export default function PuntosVentaScreen() {
  const router = useRouter();
  const { localPermitido, hasPermiso } = useAuth();
  const puedeEditarTarifa = hasPermiso('puntos_venta.editar');
  const { shouldStackPanels, isPhone } = useBreakpoint();
  const [pestana, setPestana] = useState<Pestana>('tarifas');
  const [saleCenters, setSaleCenters] = useState<PuntoVentaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filtroLocalTarifa, setFiltroLocalTarifa] = useState('');
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const resizeStartWidth = useRef(0);
  const resizeCol = useRef<string | null>(null);

  // ── Tarifa de venta por local (centros de venta Ágora) ──
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [centros, setCentros] = useState<CentroVentaItem[]>([]);
  const [tarifas, setTarifas] = useState<Record<string, TarifaLocal>>({});
  const [loadingTarifas, setLoadingTarifas] = useState(true);
  const [errorTarifas, setErrorTarifas] = useState<string | null>(null);
  const [errorGuardarTarifa, setErrorGuardarTarifa] = useState<string | null>(null);
  const [guardandoLocalId, setGuardandoLocalId] = useState<string | null>(null);

  const refetch = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(null); }
    apiFetch('/api/agora/sale-centers')
      .then((res) => res.json())
      .then((data: { saleCenters?: PuntoVentaItem[]; error?: string }) => {
        if (data.error) {
          if (!silent) setError(data.error);
          setSaleCenters([]);
        } else {
          setSaleCenters(Array.isArray(data.saleCenters) ? data.saleCenters : []);
        }
      })
      .catch((e) => {
        if (!silent) setError(e.message || 'Error de conexión');
        setSaleCenters([]);
      })
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  const cargarTarifas = useCallback(async () => {
    setLoadingTarifas(true);
    setErrorTarifas(null);
    try {
      const [resLocales, resCentros, resAsignaciones] = await Promise.all([
        apiFetch('/api/locales'),
        apiFetch('/api/agora/centros-venta'),
        apiFetch('/api/agora/locales-tarifa'),
      ]);
      const dataLocales = (await resLocales.json().catch(() => ({}))) as { locales?: LocalItem[]; error?: string };
      const dataCentros = (await resCentros.json().catch(() => ({}))) as { centros?: CentroVentaItem[]; error?: string };
      const dataAsignaciones = (await resAsignaciones.json().catch(() => ({}))) as {
        items?: Array<{ localId?: string | number; saleCenterId?: string | number | null; priceListId?: string | number | null }>;
        error?: string;
      };
      const primerError = dataLocales.error || dataCentros.error || dataAsignaciones.error;
      if (primerError) throw new Error(primerError);

      setLocales(Array.isArray(dataLocales.locales) ? dataLocales.locales : []);
      setCentros(Array.isArray(dataCentros.centros) ? dataCentros.centros : []);
      const mapa: Record<string, TarifaLocal> = {};
      for (const item of dataAsignaciones.items || []) {
        const localIdCrudo = String(item?.localId ?? '').trim();
        if (!localIdCrudo) continue;
        mapa[formatId6(localIdCrudo)] = {
          saleCenterId: item?.saleCenterId != null ? String(item.saleCenterId) : null,
          priceListId: item?.priceListId ?? null,
        };
      }
      setTarifas(mapa);
    } catch (e) {
      setErrorTarifas(errorMessage(e, 'No se pudo cargar la configuración de tarifas'));
    } finally {
      setLoadingTarifas(false);
    }
  }, []);

  const syncAndRefetch = useCallback(() => {
    setSyncing(true);
    setSyncError(null);
    apiFetch('/api/agora/sale-centers/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean; error?: string }) => {
        if (data.ok) {
          refetch(true);
          void cargarTarifas();
        } else {
          setSyncError(data.error || 'Error al sincronizar puntos de venta');
        }
      })
      .catch((e) => {
        setSyncError(e?.message || 'Error de conexión al sincronizar');
      })
      .finally(() => setSyncing(false));
  }, [refetch, cargarTarifas]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Sync al abrir la pantalla (en segundo plano) para mantener datos actualizados
  useEffect(() => {
    if (!puedeEditarTarifa) return;
    apiFetch('/api/agora/sale-centers/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean }) => {
        if (data.ok) {
          refetch(true);
          void cargarTarifas();
        }
      })
      .catch(() => {});
  }, [refetch, cargarTarifas, puedeEditarTarifa]);

  useEffect(() => {
    cargarTarifas();
  }, [cargarTarifas]);

  const localesTarifa = useMemo(() => {
    return locales
      .map((l) => {
        const crudo = String(l.id_Locales ?? '').trim();
        return {
          id: crudo ? formatId6(crudo) : '',
          nombre: String(l.nombre ?? l.Nombre ?? '').trim(),
        };
      })
      .filter((l) => l.id && l.nombre && localPermitido(l.nombre))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [locales, localPermitido]);

  const localesTarifaFiltrados = useMemo(() => {
    const q = filtroLocalTarifa.trim().toLowerCase();
    if (!q) return localesTarifa;
    return localesTarifa.filter((l) => l.nombre.toLowerCase().includes(q));
  }, [localesTarifa, filtroLocalTarifa]);

  const opcionesCentros = useMemo<OpcionDesplegable[]>(() => {
    const lista = centros
      .map((c) => {
        const id = String(c.id ?? '').trim();
        const nombre = String(c.nombre ?? '').trim() || id;
        const tarifa = c.priceListId != null && String(c.priceListId) !== ''
          ? `Tarifa ${c.priceListId}`
          : 'Sin tarifa';
        return { id, titulo: nombre, subtitulo: tarifa };
      })
      .filter((o) => o.id)
      .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
    return [
      { id: OPCION_SIN_ASIGNAR, titulo: 'Sin asignar', subtitulo: 'Quitar la asignación del local' },
      ...lista,
    ];
  }, [centros]);

  const asignarCentroVenta = useCallback((localIdCrudo: string, opcionId: string) => {
    if (!puedeEditarTarifa) return;
    const localId = formatId6(localIdCrudo);
    const saleCenterId = opcionId === OPCION_SIN_ASIGNAR ? null : opcionId;
    const centro = saleCenterId ? centros.find((c) => String(c.id ?? '') === saleCenterId) : undefined;
    const anterior = tarifas[localId];
    setTarifas((prev) => ({
      ...prev,
      [localId]: { saleCenterId, priceListId: centro?.priceListId ?? null },
    }));
    setGuardandoLocalId(localId);
    setErrorGuardarTarifa(null);
    apiFetch('/api/agora/locales-tarifa', {
      method: 'PUT',
      body: JSON.stringify({ localId, saleCenterId }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          saleCenterId?: string | number | null;
          priceListId?: string | number | null;
          error?: string;
        };
        if (!res.ok || data.error) throw new Error(data.error || 'No se pudo guardar la tarifa');
        setTarifas((prev) => ({
          ...prev,
          [localId]: {
            saleCenterId: data.saleCenterId != null ? String(data.saleCenterId) : null,
            priceListId: data.priceListId ?? null,
          },
        }));
      })
      .catch((e) => {
        setTarifas((prev) => {
          const next = { ...prev };
          if (anterior) next[localId] = anterior;
          else delete next[localId];
          return next;
        });
        setErrorGuardarTarifa(errorMessage(e, 'No se pudo guardar la tarifa'));
      })
      .finally(() => setGuardandoLocalId((prev) => (prev === localId ? null : prev)));
  }, [centros, tarifas, puedeEditarTarifa]);

  const apilarFilaTarifa = shouldStackPanels || isPhone;

  const columnas = COLUMNAS;

  const filtrados = useMemo(() => {
    let list = saleCenters;
    const q = filtroBusqueda.trim().toLowerCase();
    if (q) {
      list = list.filter((item) =>
        columnas.some((col) => {
          const val = getValorCelda(item, col);
          return val !== '—' && val.toLowerCase().includes(q);
        })
      );
    }
    list = [...list].sort((a, b) => {
      const localA = String(a.Local ?? '').localeCompare(String(b.Local ?? ''), undefined, { sensitivity: 'base' });
      if (localA !== 0) return localA;
      return String(a.Nombre ?? '').localeCompare(String(b.Nombre ?? ''), undefined, { sensitivity: 'base' });
    });
    return list;
  }, [saleCenters, filtroBusqueda, columnas]);

  const totalPages = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtrados.slice(start, start + PAGE_SIZE);
  }, [filtrados, safePage]);

  const contentBasedWidths = useMemo(() => {
    const out: Record<string, number> = {};
    const CHAR = 6, PAD = 12;
    for (const col of columnas) {
      if (col === 'Activo') {
        out[col] = ACTIVO_COL_WIDTH;
        continue;
      }
      let maxLen = col.length;
      for (const item of paginated) {
        const val = getValorCelda(item, col);
        if (val.length > maxLen) maxLen = val.length;
      }
      const w = PAD + maxLen * CHAR;
      out[col] = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, w));
    }
    return out;
  }, [paginated, columnas]);

  const getColWidth = useCallback((col: string): number => {
    if (colWidths[col] != null) return colWidths[col];
    return contentBasedWidths[col] ?? DEFAULT_COL_WIDTH;
  }, [colWidths, contentBasedWidths]);

  const tableMinWidth = useMemo(() => {
    return columnas.reduce((sum, col) => sum + (colWidths[col] ?? contentBasedWidths[col] ?? DEFAULT_COL_WIDTH), 0);
  }, [colWidths, contentBasedWidths, columnas]);

  const createResizePanResponder = useCallback((col: string) => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        resizeCol.current = col;
        resizeStartWidth.current = colWidths[col] ?? contentBasedWidths[col] ?? DEFAULT_COL_WIDTH;
      },
      onPanResponderMove: (_, gestureState) => {
        if (resizeCol.current === null) return;
        const w = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, resizeStartWidth.current + gestureState.dx));
        setColWidths((prev) => ({ ...prev, [resizeCol.current!]: w }));
      },
      onPanResponderRelease: () => { resizeCol.current = null; },
    });
  }, [colWidths, contentBasedWidths]);

  const resizePanResponders = useMemo(
    () => Object.fromEntries(columnas.map((col) => [col, createResizePanResponder(col)])),
    [createResizePanResponder, columnas]
  );

  useEffect(() => { setCurrentPage((p) => (p > totalPages ? totalPages : p)); }, [totalPages]);

  const toggleActivo = useCallback((item: PuntoVentaItem, newActivo: boolean) => {
    if (!puedeEditarTarifa) return;
    const id = item.Id ?? item.id;
    if (id == null) return;
    setSaleCenters((prev) =>
      prev.map((p) => (String(p.Id ?? p.id) === String(id) ? { ...p, Activo: newActivo } : p))
    );
    apiFetch('/api/agora/sale-centers', {
      method: 'PATCH',
      body: JSON.stringify({ id: String(id), Activo: newActivo }),
    })
      .then((res) => res.json())
      .then((data: { ok?: boolean; error?: string }) => {
        if (!data.ok && data.error) {
          setSaleCenters((prev) =>
            prev.map((p) => (String(p.Id ?? p.id) === String(id) ? { ...p, Activo: !newActivo } : p))
          );
        }
      })
      .catch(() => {
        setSaleCenters((prev) =>
          prev.map((p) => (String(p.Id ?? p.id) === String(id) ? { ...p, Activo: !newActivo } : p))
        );
      });
  }, [puedeEditarTarifa]);

  if (loading && saleCenters.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Cargando puntos de venta…</Text>
      </View>
    );
  }

  if (error && saleCenters.length === 0) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="error-outline" size={48} color={colors.danger} />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => refetch()}>
          <MaterialIcons name="refresh" size={20} color={colors.accent} />
          <Text style={styles.retryBtnText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Volver">
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Puntos de venta</Text>
        <View style={styles.headerSpacer} />
        {puedeEditarTarifa ? (
          <TouchableOpacity
            style={[styles.syncBtn, syncing && styles.pageBtnDisabled]}
            onPress={syncAndRefetch}
            disabled={syncing}
            accessibilityLabel="Sincronizar"
          >
            {syncing ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons name="sync" size={20} color={colors.accent} />
            )}
            <Text style={styles.syncBtnText}>{syncing ? 'Sincronizando…' : 'Sincronizar'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {syncError ? <Text style={styles.syncErrorText}>{syncError}</Text> : null}

      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={[styles.tab, pestana === 'tarifas' && styles.tabActive]}
          onPress={() => setPestana('tarifas')}
          accessibilityRole="tab"
          accessibilityState={{ selected: pestana === 'tarifas' }}
          accessibilityLabel="Tarifas por local"
        >
          <Text style={[styles.tabText, pestana === 'tarifas' && styles.tabTextActive]}>
            Tarifas por local
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, pestana === 'tpv' && styles.tabActive]}
          onPress={() => setPestana('tpv')}
          accessibilityRole="tab"
          accessibilityState={{ selected: pestana === 'tpv' }}
          accessibilityLabel="TPV / cajas"
        >
          <Text style={[styles.tabText, pestana === 'tpv' && styles.tabTextActive]}>
            TPV / cajas
          </Text>
        </TouchableOpacity>
      </View>

      {pestana === 'tarifas' ? (
        <View style={styles.tabPanel}>
          <View style={styles.tarifaHeader}>
            <MaterialIcons name="sell" size={18} color={colors.accent} />
            <Text style={styles.tarifaTitle}>Tarifa de venta por local</Text>
            {loadingTarifas ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          </View>
          <Text style={styles.tarifaHelp}>
            Elige el centro de venta de Ágora de cada local. Esa tarifa es la que usa Escandallos para el P. venta.
          </Text>
          {!puedeEditarTarifa ? (
            <View style={styles.tarifaSoloLecturaBanner}>
              <MaterialIcons name="visibility" size={16} color={colors.warning} />
              <Text style={styles.tarifaSoloLectura}>
                Solo lectura: no tienes permiso para cambiar la asignación.
              </Text>
            </View>
          ) : null}

          <View style={styles.searchWrap}>
            <MaterialIcons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              value={filtroLocalTarifa}
              onChangeText={setFiltroLocalTarifa}
              placeholder="Buscar local…"
              placeholderTextColor={colors.textMuted}
            />
          </View>

          {errorTarifas ? (
            <View style={styles.tarifaErrorRow}>
              <Text style={styles.tarifaErrorText}>{errorTarifas}</Text>
              <TouchableOpacity style={styles.tarifaRetryBtn} onPress={() => cargarTarifas()}>
                <MaterialIcons name="refresh" size={16} color={colors.accent} />
                <Text style={styles.tarifaRetryText}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {errorGuardarTarifa ? <Text style={styles.tarifaErrorText}>{errorGuardarTarifa}</Text> : null}

          {loadingTarifas && localesTarifa.length === 0 ? (
            <Text style={styles.tarifaVacio}>Cargando locales y centros de venta…</Text>
          ) : localesTarifa.length === 0 ? (
            !errorTarifas ? <Text style={styles.tarifaVacio}>No hay locales disponibles.</Text> : null
          ) : localesTarifaFiltrados.length === 0 ? (
            <Text style={styles.tarifaVacio}>Ningún local coincide con la búsqueda.</Text>
          ) : (
            <ScrollView
              style={styles.tarifaScroll}
              contentContainerStyle={styles.tarifaLista}
              nestedScrollEnabled
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled"
            >
              {localesTarifaFiltrados.map((local, idx) => {
                const tarifa = tarifas[local.id];
                const priceListId = tarifa?.priceListId;
                const tieneTarifa = priceListId != null && String(priceListId) !== '';
                return (
                  <View
                    key={local.id}
                    style={[
                      styles.tarifaRow,
                      apilarFilaTarifa && styles.tarifaRowStack,
                      { zIndex: localesTarifaFiltrados.length - idx },
                    ]}
                  >
                    <Text style={[styles.tarifaLocalNombre, apilarFilaTarifa && styles.tarifaLocalNombreStack]} numberOfLines={1}>
                      {local.nombre}
                    </Text>
                    <View style={[styles.tarifaControl, apilarFilaTarifa && styles.tarifaControlStack]}>
                      <SelectorDesplegable
                        placeholder="Centro de venta…"
                        icono="storefront"
                        opciones={opcionesCentros}
                        valorId={tarifa?.saleCenterId ?? OPCION_SIN_ASIGNAR}
                        onSeleccionar={(id) => asignarCentroVenta(local.id, id)}
                        tituloLista="Centro de venta"
                        iconoLista="storefront"
                        loading={loadingTarifas}
                        disabled={!puedeEditarTarifa || guardandoLocalId === local.id}
                        buscador
                        buscadorPlaceholder="Nombre del centro…"
                        limiteResultados={80}
                        vacioTexto="No hay centros de venta sincronizados desde Ágora."
                        compact
                        triggerStyle={isPhone ? styles.tarifaTriggerTactil : undefined}
                        style={styles.tarifaSelector}
                      />
                      <View style={styles.tarifaChipWrap}>
                        {guardandoLocalId === local.id ? (
                          <ActivityIndicator size="small" color={colors.accent} />
                        ) : (
                          <View style={[styles.tarifaChip, !tieneTarifa && styles.tarifaChipVacio]}>
                            <Text
                              style={[styles.tarifaChipText, !tieneTarifa && styles.tarifaChipTextVacio]}
                              numberOfLines={1}
                            >
                              {tieneTarifa ? `Tarifa ${priceListId}` : 'Sin asignar'}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      ) : (
        <View style={styles.tabPanel}>
          <View style={styles.tpvToolbar}>
            <View style={[styles.searchWrap, styles.searchWrapTpv]}>
              <MaterialIcons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                value={filtroBusqueda}
                onChangeText={setFiltroBusqueda}
                placeholder="Buscar en la tabla…"
                placeholderTextColor={colors.textMuted}
              />
            </View>
          </View>

          <Text style={styles.subtitle}>
            {filtrados.length === 0
              ? '0 puntos'
              : `${filtrados.length} punto${filtrados.length !== 1 ? 's' : ''}`}
            {filtrados.length > 0 ? (
              <Text style={styles.subtitlePage}> · Página {safePage} de {totalPages}</Text>
            ) : null}
          </Text>

          <View style={[erpListTableStyles.tableOuter, styles.tableFlex]}>
            <View style={erpListTableStyles.tableWrapper}>
              <ScrollView
                horizontal
                style={[erpListTableStyles.scroll, erpListTableStyles.scrollTable, erpListTableStyles.tableScrollLtr]}
                contentContainerStyle={[erpListTableStyles.scrollContent, { minWidth: tableMinWidth }]}
                showsHorizontalScrollIndicator
                nestedScrollEnabled
              >
                <View style={[erpListTableStyles.table, { minWidth: tableMinWidth }]}>
                  <View style={erpListTableStyles.rowHeader}>
                    {columnas.map((col, colIdx) => (
                      <View
                        key={col}
                        style={[
                          erpListTableStyles.cellHeader,
                          col === 'Activo' && styles.cellHeaderCenter,
                          { width: getColWidth(col) },
                        ]}
                      >
                        <Text style={erpListTableStyles.cellHeaderText} {...ERP_LIST_HEADER_TEXT_PROPS}>
                          {COL_LABELS[col]}
                        </Text>
                        {colIdx < columnas.length - 1 ? (
                          <View style={erpListTableStyles.resizeHandle} {...(resizePanResponders[col]?.panHandlers ?? {})} />
                        ) : null}
                      </View>
                    ))}
                  </View>

                  <ScrollView
                    style={erpListTableStyles.tableBodyScroll}
                    contentContainerStyle={erpListTableStyles.tableBodyContent}
                    showsVerticalScrollIndicator
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                  >
                    {filtrados.length === 0 ? (
                      <View style={erpListTableStyles.row}>
                        <View style={[erpListTableStyles.cellEmpty, { minWidth: tableMinWidth }]}>
                          <Text style={erpListTableStyles.cellEmptyText}>
                            {saleCenters.length === 0
                              ? 'No hay puntos de venta. Comprueba la conexión con Ágora (export-master WorkplacesSummary).'
                              : 'Ningún resultado con el filtro'}
                          </Text>
                        </View>
                      </View>
                    ) : (
                      paginated.map((item, idx) => {
                        const activo = isActivo(item);
                        return (
                          <View
                            key={`${item.Id ?? item.id ?? idx}-${idx}`}
                            style={[erpListTableStyles.row, !activo && styles.rowInactiva]}
                          >
                            {columnas.map((col) => (
                              <View
                                key={col}
                                style={[
                                  erpListTableStyles.cell,
                                  col === 'Activo' && styles.cellCenter,
                                  { width: getColWidth(col) },
                                ]}
                              >
                                {col === 'Activo' ? (
                                  <TouchableOpacity
                                    style={styles.checkboxTouch}
                                    onPress={() => toggleActivo(item, !activo)}
                                    disabled={!puedeEditarTarifa}
                                    accessibilityLabel={activo ? 'Desactivar' : 'Activar'}
                                    accessibilityRole="checkbox"
                                  >
                                    <MaterialIcons
                                      name={activo ? 'check-box' : 'check-box-outline-blank'}
                                      size={16}
                                      color={activo ? colors.accent : colors.textMuted}
                                    />
                                  </TouchableOpacity>
                                ) : (
                                  <Text style={[erpListTableStyles.cellText, !activo && styles.cellTextInactiva]}>
                                    {getValorCelda(item, col)}
                                  </Text>
                                )}
                              </View>
                            ))}
                          </View>
                        );
                      })
                    )}
                  </ScrollView>
                </View>
              </ScrollView>
            </View>
          </View>

          {filtrados.length > PAGE_SIZE ? (
            <View style={styles.paginationRow}>
              <TouchableOpacity style={[styles.pageBtn, safePage <= 1 && styles.pageBtnDisabled]} onPress={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
                <MaterialIcons name="chevron-left" size={20} color={safePage <= 1 ? colors.textMuted : colors.textPrimary} />
                <Text style={[styles.pageBtnText, safePage <= 1 && styles.pageBtnTextDisabled]}>Anterior</Text>
              </TouchableOpacity>
              <Text style={styles.pageInfo}>{(safePage - 1) * PAGE_SIZE + 1}-{Math.min(safePage * PAGE_SIZE, filtrados.length)} de {filtrados.length}</Text>
              <TouchableOpacity style={[styles.pageBtn, safePage >= totalPages && styles.pageBtnDisabled]} onPress={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>
                <Text style={[styles.pageBtnText, safePage >= totalPages && styles.pageBtnTextDisabled]}>Siguiente</Text>
                <MaterialIcons name="chevron-right" size={20} color={safePage >= totalPages ? colors.textMuted : colors.textPrimary} />
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10, minHeight: 0 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10 },
  loadingText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, textAlign: 'center' },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: SPACING.sm,
    padding: SPACING.sm,
    backgroundColor: colors.bg,
    borderRadius: RADIO_MEDIO,
    borderWidth: 1,
    borderColor: colors.border,
  },
  retryBtnText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm, gap: SPACING.sm },
  backBtn: { padding: 4, minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  headerSpacer: { flex: 1 },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingVertical: 6,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  syncBtnText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  syncErrorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, marginBottom: SPACING.sm },
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: SPACING.md,
  },
  tab: {
    flex: 1,
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: colors.accent },
  tabText: { fontSize: fontSizes[13], fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight, color: colors.textMuted },
  tabTextActive: { fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.accent },
  tabPanel: { flex: 1, minHeight: 0, gap: SPACING.sm },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    paddingHorizontal: SPACING.sm,
  },
  searchWrapTpv: { flex: 1, maxWidth: 320 },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, paddingVertical: 0 },
  tpvToolbar: { flexDirection: 'row', alignItems: 'center' },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  subtitlePage: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted },
  tableFlex: { flex: 1, minHeight: 0 },
  paginationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.lg,
    marginTop: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  pageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minHeight: MIN_TOUCH,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.bg,
  },
  pageBtnDisabled: { opacity: 0.6 },
  pageBtnText: { fontSize: fontSizes[12], color: colors.textPrimary, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  pageBtnTextDisabled: { color: colors.textMuted },
  pageInfo: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  tarifaHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tarifaTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  tarifaHelp: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, lineHeight: 18 },
  tarifaSoloLecturaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: 10,
    backgroundColor: statusColors.warning.bg,
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: RADIO_MEDIO,
  },
  tarifaSoloLectura: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.warning },
  tarifaErrorRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  tarifaErrorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, flexShrink: 1 },
  tarifaRetryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minHeight: MIN_TOUCH,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: RADIO_MEDIO,
    backgroundColor: colors.bg,
  },
  tarifaRetryText: { fontSize: fontSizes[12], color: colors.accent, fontFamily: fontFamily.medium, fontWeight: typography.nav.fontWeight },
  tarifaVacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted },
  tarifaScroll: { flex: 1, minHeight: 0 },
  tarifaLista: { gap: SPACING.sm, paddingBottom: SPACING.sm },
  tarifaRow: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: 10,
    paddingHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    minHeight: MIN_TOUCH,
  },
  tarifaRowStack: { flexDirection: 'column', alignItems: 'stretch', gap: SPACING.sm },
  tarifaLocalNombre: {
    width: '28%',
    minWidth: 120,
    fontSize: fontSizes[13],
    fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight,
    color: colors.textPrimary,
  },
  tarifaLocalNombreStack: { width: '100%', minWidth: 0 },
  tarifaControl: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  tarifaControlStack: { width: '100%' },
  tarifaSelector: { flex: 1, minWidth: 0 },
  tarifaTriggerTactil: { minHeight: MIN_TOUCH },
  tarifaChipWrap: { minWidth: 96, alignItems: 'flex-end', justifyContent: 'center' },
  tarifaChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: statusColors.success.bg,
  },
  tarifaChipVacio: { backgroundColor: colors.navActive },
  tarifaChipText: { fontSize: fontSizes[12], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.success },
  tarifaChipTextVacio: { color: colors.textMuted, fontStyle: 'italic', fontFamily: fontFamily.regular, fontWeight: typography.cuerpo.fontWeight },
  cellHeaderCenter: { alignItems: 'center' },
  cellCenter: { alignItems: 'center', justifyContent: 'center' },
  rowInactiva: { backgroundColor: colors.bg },
  cellTextInactiva: { color: colors.textMuted },
  checkboxTouch: { padding: 2, minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center', alignItems: 'center' },
});
