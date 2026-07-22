import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
  TextInput,
  Switch,
  useWindowDimensions,
  Platform,
  Alert,
  ScrollView,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch } from '../../utils/api';
import { abrirEnlaceExterno, normalizarUrlExterna } from '../../utils/enlaceExterno';
import {
  type EnlacePlanning,
  MAX_ENLACES_PLANNING,
  PERMISO_ENLACE_DEFECTO,
  ICONO_ENLACE_DEFECTO,
  crearEnlacePlanningVacio,
  enlacesDesdeItemAjuste,
  validarEnlacesParaGuardar,
  iconoEnlaceValido,
  permisoEnlaceValido,
} from '../../lib/planningEnlaces';
import HubTile from '../HubTile';
import { SelectorDesplegable } from '../SelectorDesplegable';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

const ICONOS_SUGERIDOS: { id: IconName; label: string }[] = [
  { id: 'fact-check', label: 'Inventario' },
  { id: 'inventory-2', label: 'Stock' },
  { id: 'shopping-cart', label: 'Pedidos' },
  { id: 'local-shipping', label: 'Envíos' },
  { id: 'warehouse', label: 'Almacén' },
  { id: 'groups', label: 'Personal' },
  { id: 'mic', label: 'Actuaciones' },
  { id: 'cleaning-services', label: 'Limpieza' },
  { id: 'celebration', label: 'Activaciones' },
  { id: 'account-balance-wallet', label: 'Caja' },
  { id: 'store', label: 'Local' },
  { id: 'open-in-new', label: 'Externo' },
];

const PERMISOS_OPCIONES = [
  { id: 'planning_dia.ver', titulo: 'Planning del día · Ver' },
  { id: 'pedidos.ver', titulo: 'Pedidos · Ver' },
  { id: 'pedidos.preparar', titulo: 'Pedidos · Preparar almacén' },
  { id: 'limpieza.ver', titulo: 'Limpieza · Ver' },
  { id: 'actuaciones.ver', titulo: 'Actuaciones · Ver' },
  { id: 'activaciones.ver', titulo: 'Activaciones · Ver' },
  { id: 'cierres.ver', titulo: 'Cierres · Ver' },
  { id: 'compras.ver', titulo: 'Compras · Ver' },
];

function serializarEnlaces(list: EnlacePlanning[]): string {
  return JSON.stringify(
    list.map((e) => ({
      id: e.id,
      label: e.label,
      descripcion: e.descripcion ?? '',
      url: e.url,
      icon: e.icon,
      permiso: e.permiso,
      activo: e.activo !== false,
      orden: e.orden,
    })),
  );
}

function truncarUrl(url: string, max = 48): string {
  if (url.length <= max) return url;
  try {
    const u = new URL(url);
    const host = u.hostname + u.pathname;
    if (host.length <= max) return host;
    return `${host.slice(0, max - 1)}…`;
  } catch {
    return `${url.slice(0, max - 1)}…`;
  }
}

function etiquetaPermiso(codigo?: string): string {
  const c = codigo?.trim() || PERMISO_ENLACE_DEFECTO;
  return PERMISOS_OPCIONES.find((p) => p.id === c)?.titulo ?? c;
}

function confirmarAccion(titulo: string, mensaje: string, onConfirm: () => void) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (window.confirm(`${titulo}\n\n${mensaje}`)) onConfirm();
    return;
  }
  Alert.alert(titulo, mensaje, [
    { text: 'Cancelar', style: 'cancel' },
    { text: 'Eliminar', style: 'destructive', onPress: onConfirm },
  ]);
}

export function EnlacesPlanningPanel() {
  const { width: winWidth } = useWindowDimensions();
  const { isCompact } = useBreakpoint();

  const [enlaces, setEnlaces] = useState<EnlacePlanning[]>([]);
  const [enlacesGuardados, setEnlacesGuardados] = useState('');
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalId, setModalId] = useState<string | null>(null);
  const [form, setForm] = useState<EnlacePlanning>(() => crearEnlacePlanningVacio(0));
  const [modalError, setModalError] = useState<string | null>(null);
  const [iconoPersonalizado, setIconoPersonalizado] = useState(false);

  const [menuEnlaceId, setMenuEnlaceId] = useState<string | null>(null);

  const hayCambios = useMemo(
    () => serializarEnlaces(enlaces) !== enlacesGuardados,
    [enlaces, enlacesGuardados],
  );

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/ajustes/planning_dia/enlaces');
      const data = await res.json();
      const list = res.ok && data.ok && data.item
        ? enlacesDesdeItemAjuste(data.item as Record<string, unknown>)
        : [];
      setEnlaces(list);
      setEnlacesGuardados(serializarEnlaces(list));
    } catch {
      setEnlaces([]);
      setEnlacesGuardados(serializarEnlaces([]));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const guardar = useCallback(async () => {
    setGuardando(true);
    setError(null);
    const validacion = validarEnlacesParaGuardar(enlaces);
    if (!validacion.ok) {
      setError(validacion.error);
      setGuardando(false);
      return;
    }
    try {
      const res = await apiFetch('/api/ajustes', {
        method: 'POST',
        body: JSON.stringify({
          PK: 'planning_dia',
          SK: 'enlaces',
          Nombre: 'Enlaces Planning del día',
          Enlaces: validacion.enlaces,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || 'No se pudo guardar');
        return;
      }
      setEnlaces(validacion.enlaces);
      setEnlacesGuardados(serializarEnlaces(validacion.enlaces));
    } catch {
      setError('Error de conexión al guardar');
    } finally {
      setGuardando(false);
    }
  }, [enlaces]);

  const abrirNuevo = useCallback(() => {
    setForm(crearEnlacePlanningVacio(enlaces.length));
    setModalError(null);
    setIconoPersonalizado(false);
    setModalId('new');
  }, [enlaces.length]);

  const abrirEditar = useCallback((e: EnlacePlanning) => {
    setForm({ ...e });
    setModalError(null);
    const iconKnown = ICONOS_SUGERIDOS.some((i) => i.id === e.icon);
    setIconoPersonalizado(!iconKnown && Boolean(e.icon));
    setModalId(e.id);
  }, []);

  const cerrarModal = useCallback(() => {
    setModalId(null);
    setModalError(null);
  }, []);

  const confirmarModal = useCallback(() => {
    const label = form.label.trim();
    if (!label) {
      setModalError('El título del botón es obligatorio');
      return;
    }
    const url = normalizarUrlExterna(form.url.trim());
    if (!url) {
      setModalError('Indica una URL http:// o https:// válida');
      return;
    }
    const item: EnlacePlanning = {
      ...form,
      label,
      url,
      descripcion: form.descripcion?.trim() || undefined,
      icon: iconoEnlaceValido(form.icon),
      permiso: permisoEnlaceValido(form.permiso),
      activo: form.activo !== false,
    };
    setEnlaces((prev) => {
      if (modalId === 'new') return [...prev, { ...item, orden: prev.length }];
      return prev.map((e) => (e.id === modalId ? { ...item, orden: e.orden } : e));
    });
    cerrarModal();
  }, [form, modalId, cerrarModal]);

  const mover = useCallback((id: string, dir: -1 | 1) => {
    setEnlaces((prev) => {
      const idx = prev.findIndex((e) => e.id === id);
      if (idx < 0) return prev;
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(idx, 1);
      copy.splice(next, 0, moved);
      return copy.map((e, i) => ({ ...e, orden: i }));
    });
    setMenuEnlaceId(null);
  }, []);

  const toggleActivo = useCallback((id: string) => {
    setEnlaces((prev) =>
      prev.map((e) => (e.id === id ? { ...e, activo: e.activo === false } : e)),
    );
    setMenuEnlaceId(null);
  }, []);

  const borrar = useCallback((id: string) => {
    setMenuEnlaceId(null);
    confirmarAccion(
      'Eliminar enlace',
      '¿Quieres quitar este botón del Planning del día?',
      () => {
        setEnlaces((prev) =>
          prev.filter((e) => e.id !== id).map((e, i) => ({ ...e, orden: i })),
        );
      },
    );
  }, []);

  const menuEnlace = menuEnlaceId ? enlaces.find((e) => e.id === menuEnlaceId) : null;
  const menuIdx = menuEnlace ? enlaces.findIndex((e) => e.id === menuEnlace.id) : -1;

  const previewIcon = iconoEnlaceValido(form.icon) as IconName;
  const previewLabel = form.label.trim() || 'Título del botón';
  const previewDesc = form.descripcion?.trim() || 'Descripción en Planning del día';

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <View style={styles.headerTitleBlock}>
          <MaterialIcons name="open-in-new" size={18} color="#0369a1" />
          <Text style={styles.sectionTitle}>Enlaces · Planning del día</Text>
          {hayCambios && !loading ? (
            <View style={styles.dirtyBadge}>
              <Text style={styles.dirtyBadgeText}>Sin guardar</Text>
            </View>
          ) : null}
        </View>
        {!loading && (
          <TouchableOpacity
            style={[
              styles.saveBtn,
              guardando && styles.saveBtnDisabled,
              !hayCambios && styles.saveBtnMuted,
            ]}
            onPress={guardar}
            disabled={guardando || !hayCambios}
            activeOpacity={0.75}
            accessibilityLabel="Guardar enlaces del planning"
          >
            {guardando ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <MaterialIcons name="save" size={16} color="#fff" />
                <Text style={styles.saveBtnText}>Guardar</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.sectionDesc}>
        Botones externos del hub Planning del día. Se abren en nueva pestaña (http o https).
      </Text>

      {loading ? (
        <ActivityIndicator size="small" color="#0ea5e9" style={{ marginTop: 20 }} />
      ) : enlaces.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIcon}>
            <MaterialIcons name="open-in-new" size={32} color="#0ea5e9" />
          </View>
          <Text style={styles.emptyTitle}>No hay enlaces configurados</Text>
          <Text style={styles.emptyDesc}>
            Crea accesos rápidos a herramientas externas (inventario, pedidos, etc.) visibles en Planning del día.
          </Text>
          <TouchableOpacity style={styles.emptyCta} onPress={abrirNuevo} activeOpacity={0.85}>
            <MaterialIcons name="add" size={18} color="#fff" />
            <Text style={styles.emptyCtaText}>Añadir primer enlace</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.list}>
          {enlaces.map((e, idx) => (
            <View key={e.id} style={[styles.row, isCompact && styles.rowCompact]}>
              <View style={styles.rowMain}>
                <View style={[styles.rowIcon, e.activo === false && styles.rowIconInactive]}>
                  <MaterialIcons
                    name={iconoEnlaceValido(e.icon) as IconName}
                    size={20}
                    color={e.activo === false ? '#94a3b8' : '#0369a1'}
                  />
                </View>
                <View style={styles.rowText}>
                  <View style={styles.rowTitleLine}>
                    <Text style={[styles.rowTitle, e.activo === false && styles.rowTitleInactive]} numberOfLines={1}>
                      {e.label}
                    </Text>
                    <View style={[styles.statusBadge, e.activo === false ? styles.statusOff : styles.statusOn]}>
                      <View style={[styles.statusDot, e.activo === false ? styles.dotOff : styles.dotOn]} />
                      <Text style={[styles.statusText, e.activo === false ? styles.statusTextOff : styles.statusTextOn]}>
                        {e.activo === false ? 'Inactivo' : 'Activo'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.rowMetaLine}>
                    <MaterialIcons name="link" size={12} color="#94a3b8" />
                    <Text style={styles.rowMeta} numberOfLines={1}>{truncarUrl(e.url, isCompact ? 32 : 56)}</Text>
                    <Text style={styles.rowMetaSep}>·</Text>
                    <MaterialIcons name="lock-outline" size={12} color="#94a3b8" />
                    <Text style={styles.rowMeta} numberOfLines={1}>{etiquetaPermiso(e.permiso)}</Text>
                  </View>
                </View>
              </View>
              <View style={styles.rowActions}>
                <TouchableOpacity style={styles.editBtn} onPress={() => abrirEditar(e)} activeOpacity={0.75}>
                  <MaterialIcons name="edit" size={16} color="#0ea5e9" />
                  {!isCompact ? <Text style={styles.editBtnText}>Editar</Text> : null}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuBtn}
                  onPress={() => setMenuEnlaceId(e.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MaterialIcons name="more-vert" size={20} color="#64748b" />
                </TouchableOpacity>
              </View>
              {!isCompact ? (
                <Text style={styles.rowOrderHint}>#{idx + 1}</Text>
              ) : null}
            </View>
          ))}

          {enlaces.length < MAX_ENLACES_PLANNING ? (
            <TouchableOpacity style={styles.addRowBtn} onPress={abrirNuevo} activeOpacity={0.85}>
              <MaterialIcons name="add" size={18} color="#0ea5e9" />
              <Text style={styles.addRowText}>Añadir enlace</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}

      {error ? (
        <View style={styles.errorBox}>
          <MaterialIcons name="error-outline" size={14} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Modal visible={modalId !== null} transparent animationType="fade" onRequestClose={cerrarModal}>
        <Pressable style={styles.modalOverlay} onPress={cerrarModal}>
          <Pressable
            style={[styles.modalBox, { maxWidth: Math.min(winWidth - 32, 520) }]}
            onPress={() => {}}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{modalId === 'new' ? 'Nuevo enlace' : 'Editar enlace'}</Text>
              <TouchableOpacity onPress={cerrarModal} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 480 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.fieldLabel}>Vista previa en Planning</Text>
              <View style={styles.previewWrap}>
                <HubTile
                  label={previewLabel}
                  description={previewDesc}
                  icon={previewIcon}
                  size={isCompact ? 120 : 132}
                  onPress={() => {}}
                />
              </View>

              <Text style={styles.fieldLabel}>Título del botón *</Text>
              <TextInput
                style={styles.input}
                value={form.label}
                onChangeText={(v) => { setForm((f) => ({ ...f, label: v })); setModalError(null); }}
                placeholder="Realizar inventario"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.fieldLabel}>Descripción</Text>
              <TextInput
                style={styles.input}
                value={form.descripcion ?? ''}
                onChangeText={(v) => setForm((f) => ({ ...f, descripcion: v }))}
                placeholder="Texto bajo el título en Planning del día"
                placeholderTextColor="#94a3b8"
              />

              <Text style={styles.fieldLabel}>URL *</Text>
              <View style={styles.urlRow}>
                <TextInput
                  style={[styles.input, styles.inputFlex]}
                  value={form.url}
                  onChangeText={(v) => { setForm((f) => ({ ...f, url: v })); setModalError(null); }}
                  placeholder="http://… o https://…"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <TouchableOpacity
                  style={styles.testUrlBtn}
                  onPress={() => {
                    const url = normalizarUrlExterna(form.url.trim());
                    if (!url) { setModalError('URL no válida para probar'); return; }
                    void abrirEnlaceExterno(url);
                  }}
                  activeOpacity={0.75}
                >
                  <MaterialIcons name="open-in-new" size={16} color="#0369a1" />
                  {!isCompact ? <Text style={styles.testUrlText}>Probar</Text> : null}
                </TouchableOpacity>
              </View>

              <Text style={styles.fieldLabel}>Icono</Text>
              <View style={styles.iconGrid}>
                {ICONOS_SUGERIDOS.map((ic) => {
                  const sel = !iconoPersonalizado && iconoEnlaceValido(form.icon) === ic.id;
                  return (
                    <TouchableOpacity
                      key={ic.id}
                      style={[styles.iconChip, sel && styles.iconChipActive]}
                      onPress={() => {
                        setIconoPersonalizado(false);
                        setForm((f) => ({ ...f, icon: ic.id }));
                      }}
                      activeOpacity={0.75}
                    >
                      <MaterialIcons name={ic.id} size={18} color={sel ? '#0369a1' : '#64748b'} />
                      {!isCompact ? (
                        <Text style={[styles.iconChipText, sel && styles.iconChipTextActive]} numberOfLines={1}>
                          {ic.label}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity
                style={styles.otroIconoBtn}
                onPress={() => setIconoPersonalizado((v) => !v)}
                activeOpacity={0.75}
              >
                <MaterialIcons name={iconoPersonalizado ? 'expand-less' : 'expand-more'} size={18} color="#64748b" />
                <Text style={styles.otroIconoText}>Otro icono (nombre MaterialIcons)</Text>
              </TouchableOpacity>
              {iconoPersonalizado ? (
                <TextInput
                  style={styles.input}
                  value={form.icon ?? ICONO_ENLACE_DEFECTO}
                  onChangeText={(v) => setForm((f) => ({ ...f, icon: v }))}
                  placeholder={ICONO_ENLACE_DEFECTO}
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              ) : null}

              <View style={styles.selectorWrap}>
                <Text style={styles.fieldLabelInline}>Permiso requerido</Text>
                <SelectorDesplegable
                  placeholder="Selecciona permiso"
                  icono="lock-outline"
                  tituloLista="Permiso"
                  iconoLista="lock-outline"
                  valorId={form.permiso ?? PERMISO_ENLACE_DEFECTO}
                  opciones={PERMISOS_OPCIONES}
                  onSeleccionar={(id) => setForm((f) => ({ ...f, permiso: id }))}
                />
                <Text style={styles.fieldHintInline}>Solo verán el botón usuarios con ese permiso.</Text>
              </View>

              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabelInline}>Visible en Planning</Text>
                  <Text style={styles.fieldHintInline}>Desactiva para ocultar sin borrar</Text>
                </View>
                <Switch
                  value={form.activo !== false}
                  onValueChange={(v) => setForm((f) => ({ ...f, activo: v }))}
                  trackColor={{ false: '#cbd5e1', true: '#7dd3fc' }}
                  thumbColor={form.activo !== false ? '#0ea5e9' : '#94a3b8'}
                />
              </View>

              {modalError ? <Text style={styles.modalError}>{modalError}</Text> : null}
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={cerrarModal}>
                <Text style={styles.modalCancelText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSaveBtn} onPress={confirmarModal} activeOpacity={0.7}>
                <Text style={styles.modalSaveText}>{modalId === 'new' ? 'Añadir' : 'Aplicar'}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={menuEnlaceId !== null} transparent animationType="fade" onRequestClose={() => setMenuEnlaceId(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setMenuEnlaceId(null)}>
          <Pressable style={[styles.menuSheet, { maxWidth: Math.min(winWidth - 32, 360) }]} onPress={() => {}}>
            <Text style={styles.menuTitle} numberOfLines={1}>{menuEnlace?.label ?? 'Enlace'}</Text>
            <TouchableOpacity
              style={[styles.menuItem, menuIdx <= 0 && styles.menuItemDisabled]}
              onPress={() => menuEnlace && mover(menuEnlace.id, -1)}
              disabled={menuIdx <= 0}
            >
              <MaterialIcons name="arrow-upward" size={18} color={menuIdx <= 0 ? '#cbd5e1' : '#334155'} />
              <Text style={[styles.menuItemText, menuIdx <= 0 && styles.menuItemTextDisabled]}>Subir</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.menuItem, menuIdx >= enlaces.length - 1 && styles.menuItemDisabled]}
              onPress={() => menuEnlace && mover(menuEnlace.id, 1)}
              disabled={menuIdx < 0 || menuIdx >= enlaces.length - 1}
            >
              <MaterialIcons name="arrow-downward" size={18} color={menuIdx >= enlaces.length - 1 ? '#cbd5e1' : '#334155'} />
              <Text style={[styles.menuItemText, menuIdx >= enlaces.length - 1 && styles.menuItemTextDisabled]}>Bajar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => menuEnlace && toggleActivo(menuEnlace.id)}>
              <MaterialIcons name={menuEnlace?.activo === false ? 'visibility' : 'visibility-off'} size={18} color="#334155" />
              <Text style={styles.menuItemText}>
                {menuEnlace?.activo === false ? 'Activar' : 'Desactivar'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.menuItem, styles.menuItemDanger]}
              onPress={() => menuEnlace && borrar(menuEnlace.id)}
            >
              <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
              <Text style={[styles.menuItemText, styles.menuItemTextDanger]}>Eliminar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuCancel} onPress={() => setMenuEnlaceId(null)}>
              <Text style={styles.menuCancelText}>Cerrar</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 4,
  },
  headerTitleBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    flexWrap: 'wrap',
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  sectionDesc: { fontSize: 12, color: '#64748b', marginBottom: 16, lineHeight: 17 },
  dirtyBadge: {
    backgroundColor: '#fef3c7',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  dirtyBadgeText: { fontSize: 10, fontWeight: '700', color: '#b45309' },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  saveBtnDisabled: { opacity: 0.7 },
  saveBtnMuted: { backgroundColor: '#94a3b8' },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  list: { gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 10,
  },
  rowCompact: { flexWrap: 'wrap' },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIconInactive: { backgroundColor: '#f1f5f9' },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowTitle: { fontSize: 14, fontWeight: '700', color: '#0f172a', flexShrink: 1 },
  rowTitleInactive: { color: '#64748b' },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusOn: { backgroundColor: '#ecfdf5' },
  statusOff: { backgroundColor: '#f1f5f9' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  dotOn: { backgroundColor: '#10b981' },
  dotOff: { backgroundColor: '#94a3b8' },
  statusText: { fontSize: 10, fontWeight: '600' },
  statusTextOn: { color: '#059669' },
  statusTextOff: { color: '#64748b' },
  rowMetaLine: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  rowMeta: { fontSize: 11, color: '#64748b', flexShrink: 1 },
  rowMetaSep: { fontSize: 11, color: '#cbd5e1' },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  editBtnText: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  menuBtn: { padding: 6, borderRadius: 8 },
  rowOrderHint: { fontSize: 10, color: '#94a3b8', fontWeight: '600', minWidth: 20, textAlign: 'right' },
  addRowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    marginTop: 4,
  },
  addRowText: { fontSize: 13, fontWeight: '600', color: '#0369a1' },
  emptyWrap: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 12, gap: 10 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#e0f2fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: '#334155' },
  emptyDesc: { fontSize: 12, color: '#64748b', textAlign: 'center', lineHeight: 18, maxWidth: 360 },
  emptyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginTop: 8,
  },
  emptyCtaText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 10,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  errorText: { fontSize: 12, color: '#dc2626', flex: 1 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalBox: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 12px 40px rgba(0,0,0,0.15)' } as object : {}),
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  previewWrap: { alignItems: 'flex-start', marginBottom: 8, paddingHorizontal: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#475569', marginTop: 12, marginBottom: 6, paddingHorizontal: 16 },
  fieldLabelInline: { fontSize: 12, fontWeight: '600', color: '#475569', marginBottom: 6 },
  fieldHintInline: { fontSize: 11, color: '#94a3b8', marginTop: 4, lineHeight: 15 },
  input: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#fff',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  inputFlex: { flex: 1, marginHorizontal: 0 },
  urlRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  testUrlBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
  },
  testUrlText: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  iconGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
  },
  iconChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    minWidth: 44,
  },
  iconChipActive: { borderColor: '#7dd3fc', backgroundColor: '#e0f2fe' },
  iconChipText: { fontSize: 11, color: '#64748b', maxWidth: 72 },
  iconChipTextActive: { color: '#0369a1', fontWeight: '600' },
  otroIconoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  otroIconoText: { fontSize: 12, color: '#64748b' },
  selectorWrap: { paddingHorizontal: 16, marginTop: 12 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
  },
  modalError: { fontSize: 12, color: '#dc2626', paddingHorizontal: 16, marginTop: 8 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalCancelBtn: { paddingVertical: 10, paddingHorizontal: 14 },
  modalCancelText: { fontSize: 14, color: '#64748b', fontWeight: '600' },
  modalSaveBtn: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  modalSaveText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  menuSheet: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 12,
    ...(Platform.OS === 'web' ? { boxShadow: '0 12px 40px rgba(0,0,0,0.15)' } as object : {}),
  },
  menuTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#334155',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    marginBottom: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  menuItemDisabled: { opacity: 0.5 },
  menuItemDanger: { marginTop: 4, borderTopWidth: 1, borderTopColor: '#f1f5f9' },
  menuItemText: { fontSize: 14, color: '#334155', fontWeight: '500' },
  menuItemTextDisabled: { color: '#94a3b8' },
  menuItemTextDanger: { color: '#dc2626' },
  menuCancel: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  menuCancelText: { fontSize: 13, color: '#64748b', fontWeight: '600' },
});
