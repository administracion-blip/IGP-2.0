import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { TablaBasica } from '../../../components/TablaBasica';
import { SelectorDesplegable, type OpcionDesplegable } from '../../../components/SelectorDesplegable';
import { useConfirmar } from '../../../hooks/useConfirmar';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { ICONS, ICON_SIZE } from '../../../constants/icons';
import { MIN_TOUCH, SPACING, catalogoCardColumns } from '../../../constants/layout';
import { colors, inputCursorProps, radius, statusColors, typography } from '../../../constants/theme';
import { apiFetch, errorMessage } from '../../../utils/api';
import * as ImagePicker from 'expo-image-picker';
import { FORMATOS_ETIQUETA, SCHEMA_TALLA, labelFormatoEtiqueta, modeloPideTalla, ordenarStockTallas } from '../../../lib/activos';
import { subirFotoModelo } from '../../../lib/activosUpload';
import { useCestaActivos } from '../../../lib/activosCesta';
import { EntregarModeloModal } from '../../../components/activos/EntregarModeloModal';
import { CestaEntregaModal } from '../../../components/activos/CestaEntregaModal';
import { BotonCestaActivos } from '../../../components/activos/BotonCestaActivos';
import type { CategoriaActivo, FormatoEtiqueta, ModeloActivo } from '../../../types/activos';

type Tab = 'modelos' | 'categorias';

const COLS_CAT = ['Nombre', 'Prefijo', 'Formato', 'Tipo'];

type FormCat = {
  nombre: string;
  prefijo_etiqueta: string;
  formato_etiqueta: FormatoEtiqueta;
  es_serializable_default: boolean;
};
type FormMod = {
  categoria_id: string;
  marca: string;
  nombre: string;
  es_serializable: boolean;
  pide_talla: boolean;
};

const FORM_CAT: FormCat = {
  nombre: '',
  prefijo_etiqueta: '',
  formato_etiqueta: 'completa',
  es_serializable_default: true,
};
const FORM_MOD: FormMod = { categoria_id: '', marca: '', nombre: '', es_serializable: true, pide_talla: false };

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || fallback);
  return data;
}

export default function ActivosCatalogoScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels, shouldStackToolbar, isCompact, width, height } = useBreakpoint();
  const gridCols = catalogoCardColumns(width, height);
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeVer = hasPermiso('activos.ver') || hasPermiso('activos.crear') || hasPermiso('activos.editar');
  const puedeCrear = hasPermiso('activos.crear');
  const puedeEditar = hasPermiso('activos.editar');
  const puedeBorrar = hasPermiso('activos.borrar');
  const puedeEscribir = puedeCrear || puedeEditar || puedeBorrar;

  const [tab, setTab] = useState<Tab>('modelos');
  const [categorias, setCategorias] = useState<CategoriaActivo[]>([]);
  const [modelos, setModelos] = useState<ModeloActivo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [modalCat, setModalCat] = useState(false);
  const [modalMod, setModalMod] = useState(false);
  const [editCatId, setEditCatId] = useState<string | null>(null);
  const [editModId, setEditModId] = useState<string | null>(null);
  const [formCat, setFormCat] = useState<FormCat>(FORM_CAT);
  const [formMod, setFormMod] = useState<FormMod>(FORM_MOD);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [fotoModUrl, setFotoModUrl] = useState<string | null>(null);
  const [fotoModLocal, setFotoModLocal] = useState<{ uri: string; mime?: string } | null>(null);
  const [quitarFoto, setQuitarFoto] = useState(false);
  const [subiendoFoto, setSubiendoFoto] = useState(false);

  const { unidades: udCesta } = useCestaActivos();
  const [modeloEntrega, setModeloEntrega] = useState<ModeloActivo | null>(null);
  const [modalCesta, setModalCesta] = useState(false);

  const nombreCat = useCallback(
    (id: string) => categorias.find((c) => c.categoria_id === id)?.nombre || '—',
    [categorias],
  );

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rc, rm] = await Promise.all([
        apiFetch('/api/activos/categorias?limite=200'),
        apiFetch('/api/activos/modelos?limite=200&conStock=1'),
      ]);
      const dc = await jsonOrThrow<{ categorias?: CategoriaActivo[] }>(rc, 'No se pudieron cargar las categorías');
      const dm = await jsonOrThrow<{ modelos?: ModeloActivo[] }>(rm, 'No se pudieron cargar los modelos');
      setCategorias((dc.categorias || []).filter((c) => c.activo !== false));
      setModelos((dm.modelos || []).filter((m) => m.activo !== false));
    } catch (e) {
      setError(errorMessage(e, 'No se pudo cargar el catálogo'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (puedeVer) void cargar();
  }, [cargar, puedeVer]);

  const modelosFiltrados = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return modelos;
    return modelos.filter((m) =>
      [m.marca, m.nombre, nombreCat(m.categoria_id)].join(' ').toLowerCase().includes(q),
    );
  }, [modelos, filtro, nombreCat]);

  const categoriasFiltradas = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return categorias;
    return categorias.filter((c) =>
      [c.nombre, c.prefijo_etiqueta].join(' ').toLowerCase().includes(q),
    );
  }, [categorias, filtro]);

  const gruposModelo = useMemo(() => {
    const porCat = new Map<string, ModeloActivo[]>();
    for (const m of modelosFiltrados) {
      const lista = porCat.get(m.categoria_id) || [];
      lista.push(m);
      porCat.set(m.categoria_id, lista);
    }
    const ordenados: { categoriaId: string; titulo: string; modelos: ModeloActivo[] }[] = [];
    for (const c of categorias) {
      const lista = porCat.get(c.categoria_id);
      if (!lista?.length) continue;
      lista.sort((a, b) => `${a.marca} ${a.nombre}`.localeCompare(`${b.marca} ${b.nombre}`, 'es'));
      ordenados.push({ categoriaId: c.categoria_id, titulo: c.nombre, modelos: lista });
      porCat.delete(c.categoria_id);
    }
    for (const [id, lista] of porCat) {
      lista.sort((a, b) => `${a.marca} ${a.nombre}`.localeCompare(`${b.marca} ${b.nombre}`, 'es'));
      ordenados.push({ categoriaId: id, titulo: nombreCat(id), modelos: lista });
    }
    return ordenados;
  }, [modelosFiltrados, categorias, nombreCat]);

  const opcionesCat: OpcionDesplegable[] = useMemo(
    () =>
      [...categorias]
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
        .map((c) => ({ id: c.categoria_id, titulo: c.nombre })),
    [categorias],
  );

  const abrirCrear = async () => {
    if (!puedeCrear) {
      await confirmar('Sin permiso', 'Necesitas el permiso de crear activos para dar de alta en el catálogo.');
      return;
    }
    setErrorForm(null);
    setSelected(null);
    if (tab === 'categorias') {
      setEditCatId(null);
      setFormCat(FORM_CAT);
      setModalCat(true);
    } else {
      setEditModId(null);
      setFormMod({
        ...FORM_MOD,
        categoria_id: categorias[0]?.categoria_id || '',
        es_serializable: categorias[0]?.es_serializable_default !== false,
      });
      setFotoModUrl(null);
      setFotoModLocal(null);
      setQuitarFoto(false);
      setModalMod(true);
    }
  };

  const abrirEditarCat = async (index: number) => {
    if (!puedeEditar) {
      await confirmar('Sin permiso', 'Necesitas el permiso de editar activos para cambiar el catálogo.');
      return;
    }
    const c = categoriasFiltradas[index];
    if (!c) return;
    setErrorForm(null);
    setEditCatId(c.categoria_id);
    setFormCat({
      nombre: c.nombre,
      prefijo_etiqueta: c.prefijo_etiqueta,
      formato_etiqueta: c.formato_etiqueta,
      es_serializable_default: c.es_serializable_default !== false,
    });
    setModalCat(true);
  };

  const abrirEditarModelo = async (m: ModeloActivo) => {
    setErrorForm(null);
    setEditModId(m.modelo_id);
    setFormMod({
      categoria_id: m.categoria_id,
      marca: m.marca,
      nombre: m.nombre,
      es_serializable: m.es_serializable !== false,
      pide_talla: modeloPideTalla(m),
    });
    setFotoModUrl(m.foto_url || null);
    setFotoModLocal(null);
    setQuitarFoto(false);
    setModalMod(true);
  };

  const pedirBajaCat = async (index: number) => {
    if (!puedeBorrar) {
      await confirmar('Sin permiso', 'Necesitas el permiso de borrar para dar de baja del catálogo.');
      return;
    }
    const c = categoriasFiltradas[index];
    if (!c) return;
    const ok = await confirmar(
      'Dar de baja categoría',
      `Se ocultará «${c.nombre}» (${c.prefijo_etiqueta}). No se pueden borrar categorías con modelos activos.`,
      { confirmarLabel: 'Dar de baja', variant: 'danger' },
    );
    if (!ok) return;
    await baja(`/api/activos/categorias/${c.categoria_id}/baja`);
  };

  const pedirBajaModelo = async (m: ModeloActivo) => {
    if (!puedeBorrar) {
      await confirmar('Sin permiso', 'Necesitas el permiso de borrar para dar de baja del catálogo.');
      return;
    }
    const ok = await confirmar(
      'Dar de baja modelo',
      `Se ocultará «${m.marca} ${m.nombre}». No se puede si hay activos de este modelo.`,
      { confirmarLabel: 'Dar de baja', variant: 'danger' },
    );
    if (!ok) return;
    await baja(`/api/activos/modelos/${m.modelo_id}/baja`);
  };

  const baja = async (path: string) => {
    setGuardando(true);
    try {
      const res = await apiFetch(path, { method: 'POST' });
      await jsonOrThrow(res, 'No se pudo dar de baja');
      setSelected(null);
      await cargar();
    } catch (e) {
      setError(errorMessage(e, 'No se pudo dar de baja'));
    } finally {
      setGuardando(false);
    }
  };

  const guardarCat = async () => {
    setErrorForm(null);
    if (!formCat.nombre.trim() || !formCat.prefijo_etiqueta.trim()) {
      setErrorForm('Nombre y prefijo son obligatorios');
      return;
    }
    setGuardando(true);
    try {
      const body = {
        nombre: formCat.nombre.trim(),
        prefijo_etiqueta: formCat.prefijo_etiqueta.trim().toUpperCase(),
        formato_etiqueta: formCat.formato_etiqueta,
        es_serializable_default: formCat.es_serializable_default,
      };
      const res = await apiFetch(
        editCatId ? `/api/activos/categorias/${editCatId}` : '/api/activos/categorias',
        {
          method: editCatId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      await jsonOrThrow(res, 'No se pudo guardar la categoría');
      setModalCat(false);
      await cargar();
    } catch (e) {
      setErrorForm(errorMessage(e, 'No se pudo guardar la categoría'));
    } finally {
      setGuardando(false);
    }
  };

  const elegirFotoModelo = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const asset = result.assets[0];
      setFotoModLocal({ uri: asset.uri, mime: asset.mimeType || 'image/jpeg' });
      setQuitarFoto(false);
    } catch (e) {
      setErrorForm(errorMessage(e, 'No se pudo elegir la foto'));
    }
  };

  const guardarMod = async () => {
    setErrorForm(null);
    if (!formMod.categoria_id || !formMod.marca.trim() || !formMod.nombre.trim()) {
      setErrorForm('Categoría, marca y modelo son obligatorios');
      return;
    }
    setGuardando(true);
    try {
      const body = {
        categoria_id: formMod.categoria_id,
        marca: formMod.marca.trim(),
        nombre: formMod.nombre.trim(),
        es_serializable: formMod.es_serializable,
        atributos_schema: !formMod.es_serializable && formMod.pide_talla ? [SCHEMA_TALLA] : [],
      };
      const res = await apiFetch(
        editModId ? `/api/activos/modelos/${editModId}` : '/api/activos/modelos',
        {
          method: editModId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const saved = await jsonOrThrow<ModeloActivo>(res, 'No se pudo guardar el modelo');
      const modeloId = saved.modelo_id || editModId;
      if (modeloId && fotoModLocal) {
        setSubiendoFoto(true);
        await subirFotoModelo(modeloId, fotoModLocal.uri, fotoModLocal.mime);
      } else if (modeloId && quitarFoto && editModId) {
        const del = await apiFetch(`/api/activos/modelos/${encodeURIComponent(modeloId)}/fotos`, { method: 'DELETE' });
        await jsonOrThrow(del, 'No se pudo quitar la foto');
      }
      setModalMod(false);
      await cargar();
    } catch (e) {
      setErrorForm(errorMessage(e, 'No se pudo guardar el modelo'));
    } finally {
      setGuardando(false);
      setSubiendoFoto(false);
    }
  };

  if (!puedeVer) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.vacio}>No tienes permiso para ver el catálogo.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {tab === 'modelos' ? (
        <View style={styles.catalogo}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => router.push('/mantenimiento/activos' as never)}
              style={[styles.backBtn, isCompact && styles.backBtnTactil]}
              accessibilityLabel="Volver"
            >
              <MaterialIcons name="arrow-back" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
            <Text style={styles.title}>Catálogo</Text>
          </View>

          <View style={[styles.toolbarRow, shouldStackToolbar && styles.toolbarStack]}>
            <View style={styles.searchBox}>
              <MaterialIcons name="search" size={18} color={colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={filtro}
                onChangeText={setFiltro}
                placeholder="Buscar marca o modelo"
                placeholderTextColor={colors.textMuted}
                {...inputCursorProps}
              />
            </View>
            <View style={styles.toolbarActions}>
              {puedeEditar ? (
                <BotonCestaActivos
                  unidades={udCesta}
                  compact={isCompact}
                  onPress={() => setModalCesta(true)}
                />
              ) : null}
              {puedeCrear ? (
                <TouchableOpacity
                  style={[styles.toolbarBtn, styles.toolbarBtnPri, isCompact && styles.btnTactil]}
                  onPress={() => void abrirCrear()}
                  accessibilityLabel="Nuevo modelo"
                >
                  <MaterialIcons name={ICONS.add} size={ICON_SIZE} color="#fff" />
                  <Text style={styles.toolbarBtnPriTxt}>Nuevo modelo</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.toolbarBtn, isCompact && styles.btnTactil]}
                onPress={() => {
                  setTab('categorias');
                  setSelected(null);
                  setFiltro('');
                }}
                accessibilityLabel="Categorías"
              >
                <MaterialIcons name="category" size={ICON_SIZE} color={colors.textSecondary} />
                <Text style={styles.toolbarBtnTxt}>Categorías</Text>
              </TouchableOpacity>
            </View>
          </View>

          {loading ? (
            <View style={styles.centerMsg}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : error ? (
            <View style={styles.centerMsg}>
              <Text style={styles.err}>{error}</Text>
              <TouchableOpacity style={styles.toolbarBtn} onPress={() => void cargar()}>
                <Text style={styles.toolbarBtnTxt}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : gruposModelo.length === 0 ? (
            <View style={styles.centerMsg}>
              <Text style={styles.vacio}>
                {filtro.trim()
                  ? 'Ningún modelo coincide'
                  : 'No hay modelos. Crea primero una categoría y luego un modelo.'}
              </Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.gridScroll} keyboardShouldPersistTaps="handled">
              {gruposModelo.map((grupo) => (
                <View key={grupo.categoriaId} style={styles.seccion}>
                  <Text style={styles.seccionTitulo}>{grupo.titulo}</Text>
                  <View style={styles.grid}>
                    {grupo.modelos.map((m) => (
                      <View key={m.modelo_id} style={[styles.cardWrap, { width: `${100 / gridCols}%` }]}>
                        <View style={styles.modeloCard}>
                          <TouchableOpacity
                            style={styles.modeloCardBtn}
                            onPress={() => void abrirEditarModelo(m)}
                            accessibilityLabel={`${m.marca} ${m.nombre}`}
                          >
                            {m.foto_url ? (
                              <Image source={{ uri: m.foto_url }} style={styles.modeloFoto} resizeMode="contain" />
                            ) : (
                              <View style={[styles.modeloFoto, styles.modeloFotoVacia]}>
                                <MaterialIcons name="image" size={22} color={colors.textMuted} />
                              </View>
                            )}
                            <View style={styles.modeloBody}>
                              <Text style={styles.modeloMarca} numberOfLines={1}>
                                {m.marca}
                              </Text>
                              <Text style={styles.modeloNombre} numberOfLines={1}>
                                {m.nombre}
                              </Text>
                              <Text
                                style={[
                                  styles.modeloStock,
                                  (m.disponible || 0) > 0 ? styles.modeloStockOk : styles.modeloStockCero,
                                ]}
                              >
                                Disp: {m.disponible ?? 0}
                              </Text>
                              <TablaTallasDisponibles tallas={m.tallas} />
                            </View>
                          </TouchableOpacity>
                          {puedeCrear || puedeEditar ? (
                            <View style={styles.cardAcciones}>
                              {puedeCrear ? (
                                <TouchableOpacity
                                  style={[styles.cardBtn, styles.cardBtnPri, isCompact && styles.cardBtnTactil]}
                                  onPress={() =>
                                    router.push(
                                      `/mantenimiento/activos/alta?modelo=${encodeURIComponent(m.modelo_id)}` as never,
                                    )
                                  }
                                  accessibilityLabel={`Dar de alta ${m.marca} ${m.nombre}`}
                                >
                                  <MaterialIcons name="add-box" size={16} color="#fff" />
                                  <Text style={styles.cardBtnPriTxt}>Alta</Text>
                                </TouchableOpacity>
                              ) : null}
                              {puedeEditar ? (
                                <TouchableOpacity
                                  style={[styles.cardBtn, styles.cardBtnSec, isCompact && styles.cardBtnTactil]}
                                  onPress={() => setModeloEntrega(m)}
                                  accessibilityLabel={`Entregar ${m.marca} ${m.nombre}`}
                                >
                                  <MaterialIcons name="add-shopping-cart" size={16} color={colors.accentPressed} />
                                  <Text style={styles.cardBtnSecTxt}>Entregar</Text>
                                </TouchableOpacity>
                              ) : null}
                            </View>
                          ) : null}
                          {puedeBorrar ? (
                            <TouchableOpacity
                              style={[styles.cardBorrar, isCompact && styles.cardBorrarTactil]}
                              onPress={() => void pedirBajaModelo(m)}
                              accessibilityLabel={`Dar de baja ${m.marca} ${m.nombre}`}
                            >
                              <MaterialIcons name={ICONS.delete} size={18} color={colors.textMuted} />
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : (
        <TablaBasica<CategoriaActivo>
          title="Categorías"
          onBack={() => {
            setTab('modelos');
            setSelected(null);
            setFiltro('');
          }}
          columnas={COLS_CAT}
          datos={categoriasFiltradas}
          getValorCelda={(item, col) => {
            if (col === 'Nombre') return item.nombre;
            if (col === 'Prefijo') return item.prefijo_etiqueta;
            if (col === 'Formato') return labelFormatoEtiqueta(item.formato_etiqueta);
            return item.es_serializable_default === false ? 'Lote' : 'Unidad';
          }}
          loading={loading}
          error={error}
          onRetry={cargar}
          filtroBusqueda={filtro}
          onFiltroChange={setFiltro}
          selectedRowIndex={selected}
          onSelectRow={setSelected}
          onCrear={abrirCrear}
          onEditar={() => selected != null && void abrirEditarCat(selected)}
          onBorrar={() => selected != null && void pedirBajaCat(selected)}
          guardando={guardando}
          hideToolbarActions={!puedeEscribir}
          toolbarCrearLabel="Nueva categoría"
          emptyMessage="No hay categorías. Crea «PDA», «Portátil», «Sudadera»…"
          emptyFilterMessage="Ninguna categoría coincide"
          getRowKey={(item) => item.categoria_id}
          defaultColWidth={140}
        />
      )}

      <Modal visible={modalCat} transparent animationType="fade" onRequestClose={() => setModalCat(false)}>
        <Pressable style={styles.overlay}>
          <KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={[styles.card, shouldStackPanels && styles.cardAncho]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editCatId ? 'Editar categoría' : 'Nueva categoría'}</Text>
                <TouchableOpacity onPress={() => setModalCat(false)} style={styles.close} accessibilityLabel="Cerrar">
                  <MaterialIcons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
                <Campo label="Nombre *" value={formCat.nombre} onChange={(t) => setFormCat((p) => ({ ...p, nombre: t }))} placeholder="PDA, Portátil, Sudadera…" />
                <Campo
                  label="Prefijo de etiqueta *"
                  value={formCat.prefijo_etiqueta}
                  onChange={(t) => setFormCat((p) => ({ ...p, prefijo_etiqueta: t.toUpperCase() }))}
                  placeholder="PDA"
                  editable={!editCatId}
                />
                <SelectorDesplegable
                  label="Formato de etiqueta"
                  opciones={FORMATOS_ETIQUETA.map((f) => ({ id: f.id, titulo: f.label }))}
                  valorId={formCat.formato_etiqueta}
                  onSeleccionar={(id) => setFormCat((p) => ({ ...p, formato_etiqueta: id as FormatoEtiqueta }))}
                />
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>Cada unidad lleva número de serie</Text>
                  <Switch
                    value={formCat.es_serializable_default}
                    onValueChange={(v) => setFormCat((p) => ({ ...p, es_serializable_default: v }))}
                  />
                </View>
              </ScrollView>
              {errorForm ? <Text style={styles.err}>{errorForm}</Text> : null}
              <View style={styles.footer}>
                <TouchableOpacity style={[styles.btn, isCompact && styles.btnTactil]} onPress={() => setModalCat(false)}>
                  <Text style={styles.btnTxt}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPri, isCompact && styles.btnTactil]}
                  onPress={() => void guardarCat()}
                  disabled={guardando}
                >
                  <Text style={styles.btnPriTxt}>{guardando ? 'Guardando…' : 'Guardar'}</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <Modal visible={modalMod} transparent animationType="fade" onRequestClose={() => setModalMod(false)}>
        <Pressable style={styles.overlay}>
          <KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={[styles.card, shouldStackPanels && styles.cardAncho]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {!editModId ? 'Nuevo modelo' : puedeEditar ? 'Editar modelo' : 'Modelo'}
                </Text>
                <TouchableOpacity onPress={() => setModalMod(false)} style={styles.close} accessibilityLabel="Cerrar">
                  <MaterialIcons name="close" size={22} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
                <SelectorDesplegable
                  label="Categoría *"
                  icono="category"
                  placeholder="Elige categoría"
                  opciones={opcionesCat}
                  valorId={formMod.categoria_id}
                  buscador
                  buscadorPlaceholder="Buscar categoría…"
                  disabled={!puedeEditar && !!editModId}
                  onSeleccionar={(id) => {
                    const cat = categorias.find((c) => c.categoria_id === id);
                    setFormMod((p) => ({
                      ...p,
                      categoria_id: id,
                      es_serializable: cat?.es_serializable_default !== false,
                    }));
                  }}
                  vacioTexto="Crea antes una categoría"
                />
                <Campo
                  label="Marca *"
                  value={formMod.marca}
                  onChange={(t) => setFormMod((p) => ({ ...p, marca: t }))}
                  placeholder="Sunmi"
                  editable={!editModId || puedeEditar}
                />
                <Campo
                  label="Modelo *"
                  value={formMod.nombre}
                  onChange={(t) => setFormMod((p) => ({ ...p, nombre: t }))}
                  placeholder="L2K"
                  editable={!editModId || puedeEditar}
                />
                <View style={styles.campo}>
                  <Text style={styles.label}>Foto del modelo</Text>
                  <View style={styles.fotoRow}>
                    {fotoModLocal?.uri || (fotoModUrl && !quitarFoto) ? (
                      <Image source={{ uri: fotoModLocal?.uri || fotoModUrl || undefined }} style={styles.fotoPrev} />
                    ) : (
                      <View style={[styles.fotoPrev, styles.fotoVacia]}>
                        <MaterialIcons name="image" size={22} color={colors.textMuted} />
                      </View>
                    )}
                    {(!editModId || puedeEditar) ? (
                    <View style={{ flex: 1, gap: 8 }}>
                      <TouchableOpacity style={styles.fotoBtn} onPress={() => void elegirFotoModelo()}>
                        <Text style={styles.fotoBtnTxt}>Elegir foto</Text>
                      </TouchableOpacity>
                      {fotoModLocal || (fotoModUrl && !quitarFoto) ? (
                        <TouchableOpacity
                          style={styles.fotoBtn}
                          onPress={() => {
                            setFotoModLocal(null);
                            setQuitarFoto(true);
                          }}
                        >
                          <Text style={styles.fotoBtnTxt}>Quitar</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                    ) : null}
                  </View>
                  <Text style={styles.fotoHint}>Saldrá en el alta, el listado y la ficha de cada unidad.</Text>
                </View>
                <View style={styles.switchRow}>
                  <Text style={styles.switchLabel}>Serializable (un aparato = una etiqueta)</Text>
                  <Switch
                    value={formMod.es_serializable}
                    disabled={!!editModId && !puedeEditar}
                    onValueChange={(v) => setFormMod((p) => ({ ...p, es_serializable: v, pide_talla: v ? false : p.pide_talla }))}
                  />
                </View>
                {!formMod.es_serializable ? (
                  <View style={styles.switchRow}>
                    <Text style={styles.switchLabel}>Este modelo tiene tallas (S, M, L…)</Text>
                    <Switch
                      value={formMod.pide_talla}
                      disabled={!!editModId && !puedeEditar}
                      onValueChange={(v) => setFormMod((p) => ({ ...p, pide_talla: v }))}
                    />
                  </View>
                ) : null}
              </ScrollView>
              {errorForm ? <Text style={styles.err}>{errorForm}</Text> : null}
              <View style={styles.footer}>
                <TouchableOpacity style={[styles.btn, isCompact && styles.btnTactil]} onPress={() => setModalMod(false)}>
                  <Text style={styles.btnTxt}>{editModId && !puedeEditar ? 'Cerrar' : 'Cancelar'}</Text>
                </TouchableOpacity>
                {!editModId || puedeEditar ? (
                <TouchableOpacity
                  style={[styles.btn, styles.btnPri, isCompact && styles.btnTactil]}
                  onPress={() => void guardarMod()}
                  disabled={guardando || subiendoFoto}
                >
                  {guardando || subiendoFoto ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.btnPriTxt}>Guardar</Text>
                  )}
                </TouchableOpacity>
                ) : null}
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      <EntregarModeloModal
        visible={modeloEntrega != null}
        modelo={modeloEntrega}
        onClose={() => setModeloEntrega(null)}
      />

      <CestaEntregaModal
        visible={modalCesta}
        onClose={() => setModalCesta(false)}
        onEntregado={() => void cargar()}
      />

      {ConfirmarView}
    </View>
  );
}

function TablaTallasDisponibles({ tallas }: { tallas?: ModeloActivo['tallas'] }) {
  const filas = ordenarStockTallas(tallas);
  if (!filas.length) return null;
  return (
    <View style={styles.tallasTabla}>
      {filas.map((t) => (
        <View key={t.talla} style={styles.tallasCelda}>
          <View style={styles.tallasThBox}>
            <Text style={styles.tallasTh}>{t.talla}</Text>
          </View>
          <View style={styles.tallasTdBox}>
            <Text style={styles.tallasTd}>{t.cantidad}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function Campo({
  label,
  value,
  onChange,
  placeholder,
  editable = true,
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  editable?: boolean;
}) {
  return (
    <View style={styles.campo}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, !editable && styles.inputOff]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        editable={editable}
        {...inputCursorProps}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc' },
  catalogo: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  backBtnTactil: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH },
  title: { ...typography.titulo, fontSize: 20, fontWeight: '600' },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  toolbarStack: { flexDirection: 'column', alignItems: 'stretch' },
  searchBox: {
    flex: 1,
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.textPrimary, paddingVertical: 0 },
  toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toolbarBtn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  toolbarBtnPri: { backgroundColor: colors.accent, borderColor: colors.accent },
  toolbarBtnTxt: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  toolbarBtnPriTxt: { fontSize: 13, fontWeight: '600', color: '#fff' },
  centerMsg: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  gridScroll: { paddingBottom: 32 },
  seccion: { marginBottom: SPACING.lg },
  seccionTitulo: { ...typography.subtitulo, fontSize: 14, marginBottom: SPACING.sm, paddingHorizontal: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  cardWrap: { padding: 4 },
  modeloCard: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  modeloCardBtn: { width: '100%' },
  modeloFoto: { width: '100%', aspectRatio: 1, backgroundColor: colors.bgSubtle },
  modeloFotoVacia: { alignItems: 'center', justifyContent: 'center' },
  modeloBody: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4, gap: 1 },
  modeloMarca: { fontSize: 11, color: colors.textSecondary, fontWeight: '500' },
  modeloNombre: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  modeloStock: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  modeloStockOk: { color: colors.success },
  modeloStockCero: { color: colors.textMuted },
  tallasTabla: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 6,
    overflow: 'hidden',
  },
  tallasCelda: {
    minWidth: 28,
    flexGrow: 1,
    borderRightWidth: 1,
    borderColor: colors.borderStrong,
  },
  tallasThBox: {
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 4,
    backgroundColor: colors.bg,
  },
  tallasTdBox: {
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 4,
    backgroundColor: colors.surface,
  },
  tallasTh: { fontSize: 11, fontWeight: '700', color: '#111' },
  tallasTd: { fontSize: 12, fontWeight: '600', color: '#e11d48' },
  cardAcciones: {
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingBottom: 6,
    gap: 4,
  },
  cardBtn: {
    flex: 1,
    minHeight: 32,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderWidth: 1,
  },
  cardBtnTactil: { minHeight: MIN_TOUCH },
  cardBtnPri: { backgroundColor: colors.accent, borderColor: colors.accent },
  cardBtnPriTxt: { fontSize: 11, fontWeight: '700', color: '#fff' },
  cardBtnSec: { backgroundColor: colors.accentMuted, borderColor: colors.accentMuted },
  cardBtnSecTxt: { fontSize: 11, fontWeight: '700', color: colors.accentPressed },
  cardBorrar: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBorrarTactil: {
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
  },
  vacio: { padding: 16, color: colors.textMuted },
  overlay: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)', justifyContent: 'center' },
  center: { flex: 1, justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 440, backgroundColor: '#fff', borderRadius: 16, alignSelf: 'center', overflow: 'hidden' },
  cardAncho: { maxWidth: '100%' },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  close: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 20, paddingVertical: 16, maxHeight: 420 },
  campo: { marginBottom: 14 },
  label: { fontSize: 11, fontWeight: '500', color: colors.textSecondary, marginBottom: 4 },
  input: {
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.bgSubtle,
    color: colors.textPrimary,
  },
  inputOff: { opacity: 0.6 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 },
  switchLabel: { flex: 1, fontSize: 13, color: colors.textPrimary },
  err: { color: statusColors.danger.text, fontSize: 12, paddingHorizontal: 20, paddingBottom: 6 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  btn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgSubtle },
  btnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 20 },
  btnTxt: { fontSize: 13, color: colors.textSecondary, fontWeight: '500' },
  btnPri: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnPriTxt: { fontSize: 13, color: '#fff', fontWeight: '600' },
  fotoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  fotoPrev: { width: 72, height: 72, borderRadius: 8, backgroundColor: colors.border },
  fotoVacia: { alignItems: 'center', justifyContent: 'center' },
  fotoBtn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fotoBtnTxt: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  fotoHint: { fontSize: 12, color: colors.textMuted, marginTop: 6 },
});
