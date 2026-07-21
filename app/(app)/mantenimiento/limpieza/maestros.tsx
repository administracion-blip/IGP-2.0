import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Modal,
  Switch,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useMantenimientoLocales, valorEnLocal } from '../LocalesContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { apiFetch } from '../../../utils/api';

type ProductoDosis = { producto: string; dosis: string; epi: string };
type TipoLimpieza = {
  id_tipo: string;
  nombre: string;
  descripcion_procedimiento?: string;
  productos_y_dosis?: ProductoDosis[];
  requiere_vaciado_previo?: boolean;
  frecuencia_por_defecto?: string;
  activo?: boolean;
};
type Objeto = {
  id_objeto: string;
  local_id: string;
  tipo_objeto_id: string | null;
  nombre: string;
  ubicacion: string;
  codigo: string;
  activo: boolean;
};

const FRECUENCIAS = ['diaria', 'cada_n_dias', 'semanal', 'mensual', 'trimestral', 'anual', 'personalizada'] as const;

function slugCodigo(texto: string) {
  const base = String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return base || 'X';
}

export default function MaestrosLimpiezaScreen() {
  const router = useRouter();
  const { shouldStackPanels } = useBreakpoint();
  const { locales, loading: loadingLocales } = useMantenimientoLocales();
  const { hasPermiso } = useAuth();
  const puedeEditarTipos = hasPermiso('limpieza.catalogo');
  const puedeEditarObjetos = hasPermiso('limpieza.catalogo') || hasPermiso('limpieza.programar');

  const [tabMovil, setTabMovil] = useState<'tipos' | 'objetos'>('tipos');
  const [tipoFiltroId, setTipoFiltroId] = useState<string | null>(null);

  const [tipos, setTipos] = useState<TipoLimpieza[]>([]);
  const [loadingTipos, setLoadingTipos] = useState(true);
  const [errorTipos, setErrorTipos] = useState<string | null>(null);

  const [localId, setLocalId] = useState('');
  const [objetos, setObjetos] = useState<Objeto[]>([]);
  const [loadingObjetos, setLoadingObjetos] = useState(false);
  const [errorObjetos, setErrorObjetos] = useState<string | null>(null);

  // Modal tipo
  const [modalTipo, setModalTipo] = useState(false);
  const [guardandoTipo, setGuardandoTipo] = useState(false);
  const [editTipoId, setEditTipoId] = useState<string | null>(null);
  const [tipoNombre, setTipoNombre] = useState('');
  const [procedimiento, setProcedimiento] = useState('');
  const [productos, setProductos] = useState<ProductoDosis[]>([]);
  const [requiereVaciado, setRequiereVaciado] = useState(false);
  const [frecuencia, setFrecuencia] = useState<string>('diaria');
  const [tipoActivo, setTipoActivo] = useState(true);

  // Modal objeto
  const [modalObjeto, setModalObjeto] = useState(false);
  const [guardandoObjeto, setGuardandoObjeto] = useState(false);
  const [editObjetoId, setEditObjetoId] = useState<string | null>(null);
  const [tipoObjetoId, setTipoObjetoId] = useState('');
  const [objetoNombre, setObjetoNombre] = useState('');
  const [ubicacion, setUbicacion] = useState('');
  const [codigoActual, setCodigoActual] = useState('');
  const [objetoActivo, setObjetoActivo] = useState(true);

  const localesOpciones = useMemo(
    () => locales.map((l) => ({
      id: valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'id_locales') ?? '',
      titulo: valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '',
      icono: 'store' as const,
    })).filter((o) => o.id),
    [locales],
  );

  const tiposActivos = useMemo(() => tipos.filter((t) => t.activo !== false), [tipos]);

  const codigoPreview = useMemo(() => {
    if (editObjetoId) return null;
    const tipoNom = tipos.find((t) => t.id_tipo === tipoObjetoId)?.nombre ?? '';
    const localNom = localesOpciones.find((l) => l.id === localId)?.titulo ?? '';
    if (!tipoNom || !localNom) return '—';
    const slugTipo = slugCodigo(tipoNom);
    const mismos = objetos.filter((o) => o.tipo_objeto_id === tipoObjetoId);
    let max = 0;
    const re = new RegExp(`^${slugTipo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)-`);
    for (const o of mismos) {
      const m = String(o.codigo || '').match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
    }
    const nn = String(Math.max(max + 1, mismos.length + 1)).padStart(2, '0');
    const slugUbic = ubicacion.trim() ? slugCodigo(ubicacion.trim()) : 'SINUBIC';
    return `${slugTipo}-${nn}-${slugCodigo(localNom)}-${slugUbic}`;
  }, [editObjetoId, tipos, tipoObjetoId, localesOpciones, localId, objetos, ubicacion]);

  const objetosFiltrados = useMemo(() => {
    if (!tipoFiltroId) return objetos;
    return objetos.filter((o) => o.tipo_objeto_id === tipoFiltroId);
  }, [objetos, tipoFiltroId]);

  const nombreTipo = useCallback(
    (id: string | null) => tipos.find((t) => t.id_tipo === id)?.nombre ?? (id ?? '—'),
    [tipos],
  );

  useEffect(() => {
    if (!localId && localesOpciones.length > 0) setLocalId(localesOpciones[0].id);
  }, [localesOpciones, localId]);

  const cargarTipos = useCallback(() => {
    setLoadingTipos(true);
    setErrorTipos(null);
    apiFetch('/api/limpieza/tipos')
      .then((res) => res.json())
      .then((data: { tipos?: TipoLimpieza[]; error?: string }) => {
        if (data.error) { setErrorTipos(data.error); return; }
        setTipos(data.tipos || []);
      })
      .catch((e) => setErrorTipos(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoadingTipos(false));
  }, []);

  const cargarObjetos = useCallback(() => {
    if (!localId) return;
    setLoadingObjetos(true);
    setErrorObjetos(null);
    apiFetch(`/api/limpieza/objetos?local_id=${encodeURIComponent(localId)}`)
      .then((res) => res.json())
      .then((data: { objetos?: Objeto[]; error?: string }) => {
        if (data.error) { setErrorObjetos(data.error); return; }
        setObjetos(data.objetos || []);
      })
      .catch((e) => setErrorObjetos(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoadingObjetos(false));
  }, [localId]);

  useFocusEffect(useCallback(() => {
    cargarTipos();
    cargarObjetos();
  }, [cargarTipos, cargarObjetos]));

  // ── Tipos CRUD ──
  const abrirNuevoTipo = () => {
    setEditTipoId(null);
    setTipoNombre('');
    setProcedimiento('');
    setProductos([]);
    setRequiereVaciado(false);
    setFrecuencia('diaria');
    setTipoActivo(true);
    setModalTipo(true);
  };

  const abrirEditarTipo = (t: TipoLimpieza) => {
    setEditTipoId(t.id_tipo);
    setTipoNombre(t.nombre ?? '');
    setProcedimiento(t.descripcion_procedimiento ?? '');
    setProductos(Array.isArray(t.productos_y_dosis) ? t.productos_y_dosis : []);
    setRequiereVaciado(Boolean(t.requiere_vaciado_previo));
    setFrecuencia(t.frecuencia_por_defecto ?? 'diaria');
    setTipoActivo(t.activo !== false);
    setModalTipo(true);
  };

  const guardarTipo = async () => {
    if (!tipoNombre.trim()) { setErrorTipos('El nombre es obligatorio'); return; }
    setGuardandoTipo(true);
    setErrorTipos(null);
    const payload = {
      nombre: tipoNombre.trim(),
      descripcion_procedimiento: procedimiento.trim(),
      productos_y_dosis: productos.filter((p) => p.producto.trim()),
      requiere_vaciado_previo: requiereVaciado,
      frecuencia_por_defecto: frecuencia,
      activo: tipoActivo,
    };
    try {
      const res = await apiFetch(
        editTipoId ? `/api/limpieza/tipos/${editTipoId}` : '/api/limpieza/tipos',
        { method: editTipoId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await res.json();
      if (!res.ok) { setErrorTipos(data.error ?? 'Error al guardar'); return; }
      setModalTipo(false);
      cargarTipos();
    } catch (e) {
      setErrorTipos(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardandoTipo(false);
    }
  };

  const borrarTipo = async (t: TipoLimpieza) => {
    setErrorTipos(null);
    try {
      const res = await apiFetch(`/api/limpieza/tipos/${t.id_tipo}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { setErrorTipos(data.error ?? 'Error al borrar'); return; }
      if (tipoFiltroId === t.id_tipo) setTipoFiltroId(null);
      cargarTipos();
    } catch (e) {
      setErrorTipos(e instanceof Error ? e.message : 'Error de conexión');
    }
  };

  // ── Objetos CRUD ──
  const abrirNuevoObjeto = () => {
    const preTipo = tipoFiltroId && tiposActivos.some((t) => t.id_tipo === tipoFiltroId)
      ? tipoFiltroId
      : (tiposActivos[0]?.id_tipo ?? '');
    setEditObjetoId(null);
    setTipoObjetoId(preTipo);
    setObjetoNombre('');
    setUbicacion('');
    setCodigoActual('');
    setObjetoActivo(true);
    setModalObjeto(true);
  };

  const abrirEditarObjeto = (o: Objeto) => {
    setEditObjetoId(o.id_objeto);
    setTipoObjetoId(o.tipo_objeto_id ?? '');
    setObjetoNombre(o.nombre ?? '');
    setUbicacion(o.ubicacion ?? '');
    setCodigoActual(o.codigo ?? '');
    setObjetoActivo(o.activo !== false);
    setModalObjeto(true);
  };

  const guardarObjeto = async () => {
    if (!tipoObjetoId) { setErrorObjetos('Selecciona el tipo (cómo se limpia)'); return; }
    if (!objetoNombre.trim()) { setErrorObjetos('El nombre es obligatorio'); return; }
    setGuardandoObjeto(true);
    setErrorObjetos(null);
    const payload = {
      local_id: localId,
      tipo_objeto_id: tipoObjetoId,
      nombre: objetoNombre.trim(),
      ubicacion: ubicacion.trim(),
      activo: objetoActivo,
    };
    try {
      const res = await apiFetch(
        editObjetoId ? `/api/limpieza/objetos/${localId}/${editObjetoId}` : '/api/limpieza/objetos',
        { method: editObjetoId ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      const data = await res.json();
      if (!res.ok) { setErrorObjetos(data.error ?? 'Error al guardar'); return; }
      setModalObjeto(false);
      cargarObjetos();
    } catch (e) {
      setErrorObjetos(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setGuardandoObjeto(false);
    }
  };

  const borrarObjeto = async (o: Objeto) => {
    setErrorObjetos(null);
    try {
      const res = await apiFetch(`/api/limpieza/objetos/${localId}/${o.id_objeto}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { setErrorObjetos(data.error ?? 'Error al borrar'); return; }
      cargarObjetos();
    } catch (e) {
      setErrorObjetos(e instanceof Error ? e.message : 'Error de conexión');
    }
  };

  const seleccionarTipo = (id: string) => {
    setTipoFiltroId((prev) => (prev === id ? null : id));
    if (shouldStackPanels) setTabMovil('objetos');
  };

  const panelTipos = (
    <View style={[styles.panel, shouldStackPanels && styles.panelFull]}>
      <View style={styles.panelHeader}>
        <View style={styles.panelTitleRow}>
          <View style={styles.panelIconWrap}>
            <MaterialIcons name="inventory-2" size={18} color="#0ea5e9" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.panelTitle}>Tipos</Text>
            <Text style={styles.panelSub}>Cómo se limpia · {tipos.length}</Text>
          </View>
          {puedeEditarTipos ? (
            <TouchableOpacity style={styles.addBtn} onPress={abrirNuevoTipo}>
              <MaterialIcons name="add" size={18} color="#fff" />
              <Text style={styles.addBtnText}>Nuevo</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {tipoFiltroId ? (
          <TouchableOpacity style={styles.filtroChip} onPress={() => setTipoFiltroId(null)}>
            <Text style={styles.filtroChipText}>
              Filtrando: {nombreTipo(tipoFiltroId)}
            </Text>
            <MaterialIcons name="close" size={14} color="#0369a1" />
          </TouchableOpacity>
        ) : (
          <Text style={styles.hint}>Pulsa un tipo para filtrar objetos del local</Text>
        )}
      </View>

      {errorTipos ? <Text style={styles.errorText}>{errorTipos}</Text> : null}

      {loadingTipos ? (
        <View style={styles.center}><ActivityIndicator size="small" color="#0ea5e9" /></View>
      ) : (
        <ScrollView style={styles.panelScroll} contentContainerStyle={styles.list}>
          {tipos.length === 0 ? (
            <Text style={styles.vacio}>Aún no hay tipos. Crea el primero (p. ej. Nevera, Freidora).</Text>
          ) : tipos.map((t) => {
            const selected = tipoFiltroId === t.id_tipo;
            return (
              <View key={t.id_tipo} style={[styles.rowCard, selected && styles.rowCardSelected]}>
                <TouchableOpacity
                  style={{ flex: 1, gap: 4 }}
                  onPress={() => seleccionarTipo(t.id_tipo)}
                  activeOpacity={0.75}
                >
                  <View style={styles.rowTop}>
                    <Text style={styles.rowTitle}>{t.nombre}</Text>
                    <View style={[styles.badge, t.activo === false ? styles.badgeOff : styles.badgeOn]}>
                      <Text style={[styles.badgeText, t.activo === false ? styles.badgeTextOff : styles.badgeTextOn]}>
                        {t.activo === false ? 'Inactivo' : 'Activo'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {(t.frecuencia_por_defecto ?? 'diaria').replace(/_/g, ' ')}
                    {t.requiere_vaciado_previo ? ' · vaciado previo' : ''}
                  </Text>
                  {t.descripcion_procedimiento ? (
                    <Text style={styles.rowProc} numberOfLines={2}>{t.descripcion_procedimiento}</Text>
                  ) : null}
                </TouchableOpacity>
                {puedeEditarTipos ? (
                  <View style={styles.rowActions}>
                    <TouchableOpacity onPress={() => abrirEditarTipo(t)} style={styles.iconBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <MaterialIcons name="edit" size={18} color="#0ea5e9" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => borrarTipo(t)} style={styles.iconBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <MaterialIcons name="delete" size={18} color="#dc2626" />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );

  const panelObjetos = (
    <View style={[styles.panel, shouldStackPanels && styles.panelFull]}>
      <View style={styles.panelHeader}>
        <View style={styles.panelTitleRow}>
          <View style={styles.panelIconWrap}>
            <MaterialIcons name="kitchen" size={18} color="#0ea5e9" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.panelTitle}>Objetos del local</Text>
            <Text style={styles.panelSub}>
              Unidades físicas · {objetosFiltrados.length}
              {tipoFiltroId && objetosFiltrados.length !== objetos.length ? ` / ${objetos.length}` : ''}
            </Text>
          </View>
          {puedeEditarObjetos ? (
            <TouchableOpacity
              style={[styles.addBtn, (!localId || tiposActivos.length === 0) && styles.addBtnDisabled]}
              onPress={abrirNuevoObjeto}
              disabled={!localId || tiposActivos.length === 0}
            >
              <MaterialIcons name="add" size={18} color="#fff" />
              <Text style={styles.addBtnText}>Nuevo</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {loadingLocales ? (
          <ActivityIndicator size="small" color="#0ea5e9" />
        ) : (
          <SelectorDesplegable
            style={{ marginTop: 4 }}
            placeholder="Selecciona local"
            icono="store"
            tituloLista="Local"
            iconoLista="store"
            valorId={localId}
            opciones={localesOpciones}
            onSeleccionar={setLocalId}
          />
        )}
      </View>

      {errorObjetos ? <Text style={styles.errorText}>{errorObjetos}</Text> : null}
      {tiposActivos.length === 0 && !loadingTipos ? (
        <Text style={styles.vacio}>Crea primero un tipo a la izquierda para poder añadir objetos.</Text>
      ) : null}

      {loadingObjetos ? (
        <View style={styles.center}><ActivityIndicator size="small" color="#0ea5e9" /></View>
      ) : (
        <ScrollView style={styles.panelScroll} contentContainerStyle={styles.list}>
          {objetosFiltrados.length === 0 ? (
            <Text style={styles.vacio}>
              {tipoFiltroId
                ? 'No hay objetos de este tipo en el local.'
                : 'Sin objetos en este local. Añade, por ejemplo, «Nevera Cocina 1».'}
            </Text>
          ) : objetosFiltrados.map((o) => (
            <View key={o.id_objeto} style={styles.rowCard}>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowTitle}>{o.nombre}</Text>
                  <View style={[styles.badge, o.activo === false ? styles.badgeOff : styles.badgeOn]}>
                    <Text style={[styles.badgeText, o.activo === false ? styles.badgeTextOff : styles.badgeTextOn]}>
                      {o.activo === false ? 'Inactivo' : 'Activo'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.rowMeta}>
                  {nombreTipo(o.tipo_objeto_id)}
                  {o.ubicacion ? ` · ${o.ubicacion}` : ''}
                </Text>
                {o.codigo ? <Text style={styles.codigo}>{o.codigo}</Text> : null}
              </View>
              {puedeEditarObjetos ? (
                <View style={styles.rowActions}>
                  <TouchableOpacity onPress={() => abrirEditarObjeto(o)} style={styles.iconBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <MaterialIcons name="edit" size={18} color="#0ea5e9" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => borrarObjeto(o)} style={styles.iconBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <MaterialIcons name="delete" size={18} color="#dc2626" />
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Tipos y objetos</Text>
          <Text style={styles.subtitle}>Catálogo global y unidades físicas por local</Text>
        </View>
      </View>

      {shouldStackPanels ? (
        <>
          <View style={styles.tabs}>
            <TouchableOpacity
              style={[styles.tab, tabMovil === 'tipos' && styles.tabActive]}
              onPress={() => setTabMovil('tipos')}
            >
              <Text style={[styles.tabText, tabMovil === 'tipos' && styles.tabTextActive]}>Tipos</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, tabMovil === 'objetos' && styles.tabActive]}
              onPress={() => setTabMovil('objetos')}
            >
              <Text style={[styles.tabText, tabMovil === 'objetos' && styles.tabTextActive]}>Objetos</Text>
            </TouchableOpacity>
          </View>
          {tabMovil === 'tipos' ? panelTipos : panelObjetos}
        </>
      ) : (
        <View style={styles.split}>
          {panelTipos}
          {panelObjetos}
        </View>
      )}

      {/* Modal tipo */}
      <Modal visible={modalTipo} transparent animationType="fade" onRequestClose={() => setModalTipo(false)}>
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editTipoId ? 'Editar tipo' : 'Nuevo tipo'}</Text>
              <TouchableOpacity onPress={() => setModalTipo(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Nombre *</Text>
              <TextInput style={styles.input} value={tipoNombre} onChangeText={setTipoNombre} placeholder="Nevera, Congelador…" placeholderTextColor="#94a3b8" />

              <Text style={styles.label}>Procedimiento de limpieza</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={procedimiento}
                onChangeText={setProcedimiento}
                placeholder="Pasos comunes de limpieza para este tipo…"
                placeholderTextColor="#94a3b8"
                multiline
              />

              <View style={styles.prodHeader}>
                <Text style={styles.label}>Productos y dosis</Text>
                <TouchableOpacity onPress={() => setProductos((p) => [...p, { producto: '', dosis: '', epi: '' }])}>
                  <MaterialIcons name="add-circle-outline" size={20} color="#0ea5e9" />
                </TouchableOpacity>
              </View>
              {productos.map((p, i) => (
                <View key={i} style={styles.prodRow}>
                  <TextInput style={[styles.input, styles.prodInput]} value={p.producto} onChangeText={(v) => setProductos((arr) => arr.map((x, j) => (j === i ? { ...x, producto: v } : x)))} placeholder="Producto" placeholderTextColor="#94a3b8" />
                  <TextInput style={[styles.input, styles.prodInput]} value={p.dosis} onChangeText={(v) => setProductos((arr) => arr.map((x, j) => (j === i ? { ...x, dosis: v } : x)))} placeholder="Dosis / EPI" placeholderTextColor="#94a3b8" />
                  <TouchableOpacity onPress={() => setProductos((arr) => arr.filter((_, j) => j !== i))} style={styles.iconBtn}>
                    <MaterialIcons name="close" size={18} color="#dc2626" />
                  </TouchableOpacity>
                </View>
              ))}

              <Text style={styles.label}>Frecuencia por defecto</Text>
              <View style={styles.chipsWrap}>
                {FRECUENCIAS.map((f) => (
                  <TouchableOpacity key={f} style={[styles.chip, frecuencia === f && styles.chipActive]} onPress={() => setFrecuencia(f)}>
                    <Text style={[styles.chipText, frecuencia === f && styles.chipTextActive]}>{f.replace(/_/g, ' ')}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.switchRow}>
                <Text style={styles.label}>Requiere vaciado previo</Text>
                <Switch value={requiereVaciado} onValueChange={setRequiereVaciado} />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.label}>Activo</Text>
                <Switch value={tipoActivo} onValueChange={setTipoActivo} />
              </View>

              <TouchableOpacity style={styles.saveBtn} onPress={guardarTipo} disabled={guardandoTipo}>
                {guardandoTipo ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText}>Guardar</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Modal objeto */}
      <Modal visible={modalObjeto} transparent animationType="fade" onRequestClose={() => setModalObjeto(false)}>
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editObjetoId ? 'Editar objeto' : 'Nuevo objeto'}</Text>
              <TouchableOpacity onPress={() => setModalObjeto(false)}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Tipo (cómo se limpia)</Text>
              <SelectorDesplegable
                placeholder="Selecciona tipo"
                icono="inventory-2"
                tituloLista="Tipo del catálogo"
                valorId={tipoObjetoId}
                opciones={tiposActivos.map((t) => ({ id: t.id_tipo, titulo: t.nombre, icono: 'cleaning-services' as const }))}
                onSeleccionar={setTipoObjetoId}
              />

              <Text style={styles.label}>Nombre *</Text>
              <TextInput style={styles.input} value={objetoNombre} onChangeText={setObjetoNombre} placeholder="Nevera Cocina 1" placeholderTextColor="#94a3b8" />

              <Text style={styles.label}>Ubicación</Text>
              <TextInput style={styles.input} value={ubicacion} onChangeText={setUbicacion} placeholder="Cocina, Barra, Almacén…" placeholderTextColor="#94a3b8" />

              <Text style={styles.label}>Código / etiqueta</Text>
              {editObjetoId ? (
                <Text style={styles.codigoFijo}>{codigoActual || '—'}</Text>
              ) : (
                <Text style={styles.codigoPreview}>Se generará: {codigoPreview}</Text>
              )}

              <View style={styles.switchRow}>
                <Text style={styles.label}>Activo</Text>
                <Switch value={objetoActivo} onValueChange={setObjetoActivo} />
              </View>

              <TouchableOpacity style={styles.saveBtn} onPress={guardarObjeto} disabled={guardandoObjeto}>
                {guardandoObjeto ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText}>Guardar</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  backBtn: { padding: 4 },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 12, color: '#64748b', marginTop: 2 },
  tabs: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderRadius: 10,
    padding: 3,
    marginBottom: 10,
    gap: 2,
  },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  tabActive: { backgroundColor: '#fff' },
  tabText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  tabTextActive: { color: '#0ea5e9' },
  split: { flex: 1, flexDirection: 'row', gap: 12, minHeight: 0 },
  panel: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    minWidth: 0,
    minHeight: 0,
  },
  panelFull: { flex: 1 },
  panelHeader: {
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  panelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  panelIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#f0f9ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  panelSub: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  hint: { fontSize: 11, color: '#94a3b8' },
  filtroChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#e0f2fe',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  filtroChipText: { fontSize: 11, fontWeight: '600', color: '#0369a1' },
  panelScroll: { flex: 1 },
  list: { padding: 10, gap: 8, paddingBottom: 20 },
  rowCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 12,
  },
  rowCardSelected: {
    borderColor: '#7dd3fc',
    backgroundColor: '#f0f9ff',
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowTitle: { fontSize: 14, fontWeight: '700', color: '#334155', flexShrink: 1 },
  rowMeta: { fontSize: 12, color: '#64748b' },
  rowProc: { fontSize: 12, color: '#475569', lineHeight: 16 },
  rowActions: { flexDirection: 'row', gap: 2, marginTop: 2 },
  badge: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999 },
  badgeOn: { backgroundColor: '#dcfce7' },
  badgeOff: { backgroundColor: '#f1f5f9' },
  badgeText: { fontSize: 10, fontWeight: '700' },
  badgeTextOn: { color: '#15803d' },
  badgeTextOff: { color: '#64748b' },
  codigo: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0ea5e9',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  addBtnDisabled: { opacity: 0.45 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  center: { paddingVertical: 32, alignItems: 'center' },
  errorText: { fontSize: 12, color: '#dc2626', paddingHorizontal: 14, paddingTop: 8 },
  vacio: { fontSize: 13, color: '#94a3b8', padding: 8, lineHeight: 19 },
  iconBtn: { padding: 6 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '85%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#334155' },
  modalScroll: { padding: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6, marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#334155',
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  textArea: { minHeight: 70, textAlignVertical: 'top' },
  prodHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  prodRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  prodInput: { flex: 1, marginTop: 0 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  chipActive: { borderColor: '#7dd3fc', backgroundColor: '#e0f2fe' },
  chipText: { fontSize: 12, color: '#64748b' },
  chipTextActive: { color: '#0369a1', fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  saveBtn: {
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 10,
  },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  codigoPreview: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0ea5e9',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  codigoFijo: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
});
