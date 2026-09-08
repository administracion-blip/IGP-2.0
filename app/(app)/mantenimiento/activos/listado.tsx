import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useMantenimientoLocales, valorEnLocal } from '../LocalesContext';
import { SelectorDesplegable, type OpcionDesplegable } from '../../../components/SelectorDesplegable';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';
import { colors, inputCursorProps, radius, shadowCard, statusColors, typography } from '../../../constants/theme';
import { apiFetch, errorMessage } from '../../../utils/api';
import { formatId6 } from '../../../utils/idFormat';
import { colorEstadoActivo, ESTADOS_ACTIVO, fotoGeneralUrl, labelEstadoActivo, tallaDeActivo } from '../../../lib/activos';
import { activoSePuedeEntregar, useCestaActivos } from '../../../lib/activosCesta';
import { ActivoDetallePanel } from '../../../components/activos/ActivoDetallePanel';
import { CestaEntregaModal } from '../../../components/activos/CestaEntregaModal';
import { BotonCestaActivos } from '../../../components/activos/BotonCestaActivos';
import type { ActivoFicha, ActivoListado, CategoriaActivo, EstadoActivo } from '../../../types/activos';

const ROSA_BG = '#fce7f3';
const ROSA_FG = '#be185d';

export default function ActivosListadoScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ pendientes?: string; buscar?: string; alta?: string; sel?: string }>();
  const { hasPermiso, user } = useAuth();
  const alcanceGlobal = user?.Rol === 'Administrador' || !user?.Locales?.length;
  const { locales, loading: localesLoading } = useMantenimientoLocales();
  const { isPhone, shouldStackToolbar, shouldStackPanels } = useBreakpoint();
  const searchRef = useRef<TextInput>(null);

  const soloPendientes = params.pendientes === '1';
  const [idLocal, setIdLocal] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [estado, setEstado] = useState<EstadoActivo | ''>('');
  const [q, setQ] = useState('');
  const [qAplicada, setQAplicada] = useState('');
  const [categorias, setCategorias] = useState<CategoriaActivo[]>([]);
  const [items, setItems] = useState<ActivoListado[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    typeof params.sel === 'string' && params.sel ? params.sel : null,
  );
  const [modalCesta, setModalCesta] = useState(false);
  const [fichaTick, setFichaTick] = useState(0);
  const { unidades: udCesta, enCesta, anadir, quitar } = useCestaActivos();

  const opcionesLocal: OpcionDesplegable[] = useMemo(
    () =>
      locales
        .map((l) => {
          const id = formatId6(valorEnLocal(l, 'id_Locales'));
          const nombre = String(valorEnLocal(l, 'nombre') || valorEnLocal(l, 'Nombre') || '').trim();
          return { id, titulo: nombre || id };
        })
        .filter((o) => o.id && o.id !== '000000'),
    [locales],
  );

  const opcionesCategoria: OpcionDesplegable[] = useMemo(
    () => [
      { id: '', titulo: 'Todas las categorías' },
      ...categorias.map((c) => ({ id: c.categoria_id, titulo: `${c.prefijo_etiqueta} · ${c.nombre}` })),
    ],
    [categorias],
  );

  useEffect(() => {
    if (idLocal) return;
    if (opcionesLocal.length === 1 || (!alcanceGlobal && opcionesLocal.length > 0) || soloPendientes) {
      if (opcionesLocal[0]) setIdLocal(opcionesLocal[0].id);
    }
  }, [opcionesLocal, idLocal, alcanceGlobal, soloPendientes]);

  useEffect(() => {
    apiFetch('/api/activos/categorias?soloActivas=1')
      .then((r) => r.json())
      .then((data: { categorias?: CategoriaActivo[] }) => {
        setCategorias(Array.isArray(data.categorias) ? data.categorias : []);
      })
      .catch(() => setCategorias([]));
  }, []);

  useEffect(() => {
    if (params.buscar === '1') {
      const t = setTimeout(() => searchRef.current?.focus(), 300);
      return () => clearTimeout(t);
    }
  }, [params.buscar]);

  useEffect(() => {
    if (!shouldStackPanels) return;
    if (typeof params.sel === 'string' && params.sel) {
      router.replace(`/mantenimiento/activos/${params.sel}` as never);
    }
  }, [shouldStackPanels, params.sel, router]);

  const cargar = useCallback(
    async (reiniciar: boolean, cursorPage: string | null = null, signal?: AbortSignal) => {
      if (!hasPermiso('activos.ver')) return;
      const exigeLocal = !alcanceGlobal || soloPendientes;
      if (localesLoading) return;
      if (exigeLocal && !idLocal) {
        if (opcionesLocal.length === 0) {
          setLoading(false);
          setError('No tienes locales asignados');
        }
        return;
      }
      if (reiniciar) {
        setLoading(true);
        setError(null);
      } else {
        setCargandoMas(true);
      }
      try {
        const qs = new URLSearchParams();
        if (idLocal) qs.set('id_local', idLocal);
        if (categoriaId) qs.set('categoria_id', categoriaId);
        if (estado) qs.set('estado', estado);
        if (qAplicada) qs.set('q', qAplicada);
        if (cursorPage) qs.set('cursor', cursorPage);
        qs.set('limite', '50');
        const path = soloPendientes
          ? `/api/activos/pendientes-verificacion?${qs.toString()}`
          : `/api/activos?${qs.toString()}`;
        const res = await apiFetch(path, { signal });
        if (signal?.aborted) return;
        const data = (await res.json()) as { activos?: ActivoListado[]; cursor?: string | null; error?: string };
        if (!res.ok) throw new Error(data.error || 'No se pudieron cargar los activos');
        const lote = Array.isArray(data.activos) ? data.activos : [];
        setItems((prev) => (reiniciar ? lote : [...prev, ...lote]));
        setCursor(data.cursor ?? null);
      } catch (e) {
        if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) return;
        setError(errorMessage(e, 'No se pudieron cargar los activos'));
        if (reiniciar) setItems([]);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setCargandoMas(false);
        }
      }
    },
    [hasPermiso, idLocal, categoriaId, estado, qAplicada, soloPendientes, alcanceGlobal, localesLoading, opcionesLocal.length],
  );

  useEffect(() => {
    const ac = new AbortController();
    void cargar(true, null, ac.signal);
    return () => ac.abort();
  }, [cargar]);

  const aplicarBusqueda = () => setQAplicada(q.trim());

  const toggleCesta = (item: ActivoListado) => {
    if (enCesta(item.asset_id)) quitar(item.asset_id);
    else anadir(item);
  };

  const abrir = (id: string) => {
    if (shouldStackPanels) {
      router.push(`/mantenimiento/activos/${id}` as never);
      return;
    }
    setSelectedId(id);
  };

  const parchearFila = (ficha: ActivoFicha) => {
    setItems((prev) =>
      prev.map((a) =>
        a.asset_id === ficha.asset_id
          ? {
              ...a,
              estado: ficha.estado,
              id_local: ficha.id_local,
              local_nombre: ficha.local_nombre,
              numero_serie: ficha.numero_serie,
              cantidad: ficha.cantidad,
              etiqueta_legible: ficha.etiqueta_legible,
              atributos: ficha.atributos,
              foto_url: fotoGeneralUrl(ficha),
            }
          : a,
      ),
    );
  };

  if (!hasPermiso('activos.ver')) {
    return (
      <View style={styles.container}>
        <Text style={styles.vacio}>No tienes permiso para ver el inventario.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, shouldStackToolbar && styles.topBarStack]}>
        <View style={styles.topLeft}>
          <TouchableOpacity
            onPress={() => router.push('/mantenimiento/activos' as never)}
            style={styles.iconBtn}
            accessibilityLabel="Volver"
          >
            <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.title}>{soloPendientes ? 'Pendientes' : 'Activos'}</Text>
        </View>
        <View style={styles.topSearch}>
          <TextInput
            ref={searchRef}
            style={styles.busqueda}
            value={q}
            onChangeText={setQ}
            placeholder="Etiqueta o serie…"
            placeholderTextColor={colors.textMuted}
            onSubmitEditing={aplicarBusqueda}
            returnKeyType="search"
            {...inputCursorProps}
          />
          <TouchableOpacity style={styles.iconBtnAccent} onPress={aplicarBusqueda} accessibilityLabel="Buscar">
            <MaterialIcons name="search" size={20} color="#fff" />
          </TouchableOpacity>
          {!soloPendientes && hasPermiso('activos.editar') ? (
            <BotonCestaActivos unidades={udCesta} onPress={() => setModalCesta(true)} />
          ) : null}
          {!soloPendientes && hasPermiso('activos.crear') ? (
            <TouchableOpacity
              style={styles.iconBtnAccent}
              onPress={() => router.push('/mantenimiento/activos/alta' as never)}
              accessibilityLabel="Dar de alta"
            >
              <MaterialIcons name="add" size={22} color="#fff" />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {params.alta && Number(params.alta) > 0 ? (
        <View style={styles.avisoAlta}>
          <MaterialIcons name="check-circle" size={20} color={statusColors.success.text} />
          <Text style={styles.avisoAltaTxt}>
            {Number(params.alta) === 1
              ? 'Se ha dado de alta 1 activo.'
              : `Se han dado de alta ${params.alta} activos.`}
          </Text>
        </View>
      ) : null}

      <View style={[styles.filtros, shouldStackToolbar && styles.filtrosStack]}>
        <View style={styles.filtroFijo}>
          <SelectorDesplegable
            compact
            sinIconoTrigger
            icono="storefront"
            placeholder={alcanceGlobal ? 'Todos los locales' : 'Local'}
            tituloLista="Local"
            opciones={
              alcanceGlobal
                ? [{ id: '', titulo: 'Todos los locales' }, ...opcionesLocal]
                : opcionesLocal
            }
            valorId={idLocal}
            onSeleccionar={setIdLocal}
          />
        </View>
        <View style={styles.filtroFijo}>
          <SelectorDesplegable
            compact
            sinIconoTrigger
            icono="category"
            placeholder="Categoría"
            tituloLista="Categoría"
            opciones={opcionesCategoria}
            valorId={categoriaId}
            onSeleccionar={setCategoriaId}
          />
        </View>
        {!soloPendientes ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipsScroll}
            contentContainerStyle={styles.chips}
          >
            <Chip
              label="Todos"
              activo={!estado}
              onPress={() => setEstado('')}
              color={statusColors.neutral}
            />
            {ESTADOS_ACTIVO.map((e) => (
              <Chip
                key={e.id}
                label={e.label}
                activo={estado === e.id}
                onPress={() => setEstado(e.id)}
                color={colorEstadoActivo(e.id)}
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {loading || localesLoading ? (
        <View style={styles.centro}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <View style={styles.centro}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => void cargar(true)}>
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.vacioBox}>
          <MaterialIcons name="inventory-2" size={36} color={colors.textMuted} />
          <Text style={styles.vacioTitulo}>
            {soloPendientes
              ? 'No hay etiquetas pendientes en este local'
              : idLocal
                ? 'No hay activos en este local'
                : 'No hay activos con esos filtros'}
          </Text>
          <Text style={styles.vacioTxt}>
            {soloPendientes
              ? 'Cuando se impriman etiquetas aparecerán aquí hasta verificarlas.'
              : 'Aún no hay aparatos. Puedes darlos de alta desde aquí.'}
          </Text>
          {!soloPendientes && hasPermiso('activos.crear') ? (
            <TouchableOpacity
              style={styles.altaBtn}
              onPress={() => router.push('/mantenimiento/activos/alta' as never)}
            >
              <Text style={styles.altaBtnTxt}>Dar de alta</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <View style={[styles.split, shouldStackPanels && styles.splitStack]}>
          <ScrollView style={styles.lista} contentContainerStyle={styles.listaContent}>
            {items.map((a) => (
              <FilaActivo
                key={a.asset_id}
                item={a}
                compact={isPhone}
                seleccionado={!shouldStackPanels && selectedId === a.asset_id}
                enCesta={enCesta(a.asset_id)}
                puedeCesta={!soloPendientes && hasPermiso('activos.editar') && activoSePuedeEntregar(a)}
                onToggleCesta={() => toggleCesta(a)}
                onPress={() => abrir(a.asset_id)}
              />
            ))}
            {cursor ? (
              <TouchableOpacity
                style={styles.masBtn}
                onPress={() => void cargar(false, cursor)}
                disabled={cargandoMas}
              >
                {cargandoMas ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Text style={styles.masText}>Cargar más</Text>
                )}
              </TouchableOpacity>
            ) : null}
          </ScrollView>
          {!shouldStackPanels ? (
            <View style={[styles.detalle, shadowCard()]}>
              <ActivoDetallePanel
                key={`${selectedId || 'ninguno'}-${fichaTick}`}
                assetId={selectedId}
                onActualizado={parchearFila}
              />
            </View>
          ) : null}
        </View>
      )}

      <CestaEntregaModal
        visible={modalCesta}
        onClose={() => setModalCesta(false)}
        onEntregado={() => {
          void cargar(true);
          setFichaTick((n) => n + 1);
        }}
      />
    </View>
  );
}

function Chip({
  label,
  activo,
  onPress,
  color,
}: {
  label: string;
  activo: boolean;
  onPress: () => void;
  color: { bg: string; text: string };
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, { backgroundColor: color.bg, borderColor: activo ? color.text : 'transparent' }]}
    >
      <Text style={[styles.chipText, { color: color.text, fontWeight: activo ? '700' : '500' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function FilaActivo({
  item,
  compact,
  seleccionado,
  enCesta,
  puedeCesta,
  onToggleCesta,
  onPress,
}: {
  item: ActivoListado;
  compact: boolean;
  seleccionado?: boolean;
  enCesta?: boolean;
  puedeCesta?: boolean;
  onToggleCesta?: () => void;
  onPress: () => void;
}) {
  const tono = colorEstadoActivo(item.estado);
  const talla = tallaDeActivo(item);
  const thumb = fotoGeneralUrl(item);
  return (
    <TouchableOpacity
      style={[styles.fila, compact && styles.filaCompact, seleccionado && styles.filaSel]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Abrir ${item.etiqueta_legible}`}
    >
      <View style={[styles.barraEstado, { backgroundColor: tono.text }]} />
      {puedeCesta ? (
        <TouchableOpacity
          style={styles.checkHit}
          onPress={onToggleCesta}
          accessibilityLabel={enCesta ? 'Quitar de la cesta' : 'Añadir a la cesta'}
        >
          <MaterialIcons
            name={enCesta ? 'shopping-cart' : 'add-shopping-cart'}
            size={22}
            color={enCesta ? colors.accent : colors.textMuted}
          />
        </TouchableOpacity>
      ) : null}
      {thumb ? (
        <Image source={{ uri: thumb }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbVacio]}>
          <MaterialIcons name="image" size={22} color={colors.textMuted} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <View style={styles.filaTop}>
          <Text style={styles.etiqueta}>{item.etiqueta_legible}</Text>
          <View style={[styles.badge, { backgroundColor: tono.bg }]}>
            <Text style={[styles.badgeText, { color: tono.text }]}>{labelEstadoActivo(item.estado)}</Text>
          </View>
        </View>
        <Text style={styles.modelo} numberOfLines={1}>
          {[item.marca, item.nombre_modelo].filter(Boolean).join(' ') || 'Sin modelo'}
          {talla ? ` · ${talla}` : ''}
          {item.granularidad === 'lote' && item.cantidad != null ? ` · ${item.cantidad} ud.` : ''}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.meta} numberOfLines={1}>
            {item.custodio_nombre
              ? `${item.custodio_nombre} · ${item.local_nombre || item.id_local}`
              : item.local_nombre || item.id_local}
          </Text>
          {talla ? (
            <View style={styles.tallaChip}>
              <Text style={styles.tallaChipTxt}>{talla}</Text>
            </View>
          ) : null}
          {item.numero_serie ? (
            <View style={styles.serieChip}>
              <Text style={styles.serieChipTxt} numberOfLines={1}>
                {item.numero_serie}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  topBarStack: { flexDirection: 'column', alignItems: 'stretch' },
  topLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  topSearch: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 200 },
  iconBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnAccent: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkHit: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  ctaEntregar: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  ctaEntregarTxt: { color: '#fff', fontWeight: '700' },
  modalFondo: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCaja: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 16,
    maxHeight: '88%',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  modalTitulo: { ...typography.titulo, color: '#0f172a', marginBottom: 4 },
  modalSub: { fontSize: 13, color: colors.textSecondary, marginBottom: 12 },
  modalLista: { maxHeight: 280, marginBottom: 8 },
  modalFila: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalEtiqueta: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  modalMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  modalCant: {
    width: 56,
    height: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    textAlign: 'center',
    fontWeight: '700',
    color: '#0f172a',
  },
  modalUd: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  modalMax: { fontSize: 12, color: colors.textMuted },
  modalError: { color: statusColors.danger.text, marginBottom: 8, fontSize: 13 },
  modalAcciones: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  modalCancel: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelTxt: { fontWeight: '700', color: colors.textSecondary },
  altaBtn: {
    marginTop: 12,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  altaBtnTxt: { color: '#fff', fontWeight: '700' },
  avisoAlta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: statusColors.success.bg,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  avisoAltaTxt: { color: statusColors.success.text, fontWeight: '600', flex: 1 },
  title: { ...typography.titulo, color: '#0f172a' },
  filtros: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    zIndex: 20,
    flexGrow: 0,
    flexShrink: 0,
  },
  filtrosStack: { flexDirection: 'column', alignItems: 'stretch' },
  filtroFijo: { width: 168, zIndex: 21 },
  chipsScroll: { flexGrow: 0, flexShrink: 1, minHeight: 40, maxHeight: 40 },
  chips: { gap: 6, flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  chip: {
    height: 36,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    justifyContent: 'center',
  },
  chipText: { fontSize: 12 },
  busqueda: {
    flex: 1,
    height: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.bgSubtle,
  },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  error: { color: statusColors.danger.text, textAlign: 'center' },
  retry: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.accentMuted, borderRadius: radius.md },
  retryText: { color: colors.accentPressed, fontWeight: '600' },
  vacio: { padding: 16, color: colors.textMuted },
  vacioBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  vacioTitulo: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, textAlign: 'center' },
  vacioTxt: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  split: { flex: 1, flexDirection: 'row', gap: 10, minHeight: 0 },
  splitStack: { flexDirection: 'column' },
  lista: { flex: 0.38, minWidth: 280 },
  listaContent: { paddingBottom: 16, gap: 6 },
  detalle: {
    flex: 0.62,
    minWidth: 0,
    backgroundColor: colors.bgSubtle,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 16,
  },
  fila: {
    flexDirection: 'row',
    backgroundColor: colors.bgSubtle,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    minHeight: MIN_TOUCH + 12,
  },
  filaSel: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  filaCompact: { minHeight: MIN_TOUCH + 20 },
  barraEstado: { width: 6 },
  thumb: { width: 56, height: 56, alignSelf: 'center', marginLeft: 8, borderRadius: radius.sm, backgroundColor: colors.border },
  thumbVacio: { alignItems: 'center', justifyContent: 'center' },
  filaTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 10, paddingBottom: 0 },
  etiqueta: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  badge: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  modelo: { fontSize: 14, color: colors.textPrimary, paddingHorizontal: 10, marginTop: 4 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
    marginTop: 4,
  },
  meta: { flex: 1, fontSize: 12, color: colors.textSecondary },
  tallaChip: {
    backgroundColor: colors.accentMuted,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tallaChipTxt: { fontSize: 11, fontWeight: '700', color: colors.accentPressed },
  serieChip: {
    backgroundColor: ROSA_BG,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    maxWidth: '55%',
  },
  serieChipTxt: { fontSize: 11, fontWeight: '700', color: ROSA_FG },
  masBtn: {
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    marginTop: 8,
  },
  masText: { color: colors.accentPressed, fontWeight: '600' },
});
