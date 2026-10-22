import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Image,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  cacheDirectory,
  documentDirectory,
  writeAsStringAsync,
  EncodingType,
} from 'expo-file-system/legacy';
import { useLocalesPermitidos, valorEnLocal } from '../../../contexts/LocalesContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { InputFecha } from '../../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../../components/RangoFechas';
import { LimpiezaAgenda, type RegistroAgenda } from '../../../components/limpieza/LimpiezaAgenda';
import { apiFetch } from '../../../utils/api';
import {
  colors,
  fontFamily,
  fontSizes,
  radius,
  statusColors,
  typography,
  SPACING,
} from '../../../constants/theme';

type ProductoDosis = { producto: string; dosis: string; epi: string };
type Tipo = {
  id_tipo: string;
  nombre: string;
  descripcion_procedimiento?: string;
  productos_y_dosis?: ProductoDosis[];
  requiere_vaciado_previo?: boolean;
};
type Registro = {
  id_registro: string;
  local_id: string;
  tipo_objeto_id: string;
  objeto_id?: string | null;
  objeto_nombre?: string | null;
  ubicacion?: string | null;
  tarea_key?: string | null;
  tarea_nombre?: string | null;
  fecha_programada: string;
  estado: string;
  realizado_por_nombre?: string | null;
  completado_at?: string | null;
  tiene_foto?: boolean;
};
type EmpleadoItem = { employee_id?: string | number; full_name?: string };

const ESTADO_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  pendiente: { bg: statusColors.warning.bg, color: statusColors.warning.text, label: 'Pendiente' },
  hecha: { bg: statusColors.success.bg, color: statusColors.success.text, label: 'Hecha' },
  retrasada: { bg: statusColors.danger.bg, color: statusColors.danger.text, label: 'Retrasada' },
  reprogramada: { bg: '#e0e7ff', color: '#4338ca', label: 'Reprogramada' },
};

function hoyIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fechaCorta(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function registroKey(r: Registro): string {
  return `${r.local_id}|${r.fecha_programada}|${r.objeto_id ?? r.tipo_objeto_id}|${r.tarea_key ?? ''}`;
}

/** Añade una imagen base64 (dataURL o crudo) a un FormData de forma multiplataforma. */
async function appendImagen(formData: FormData, field: string, dataUrl: string, filename: string, mime: string) {
  const raw = dataUrl.replace(/^data:[^;]+;base64,/, '');
  if (Platform.OS === 'web') {
    const res = await fetch(`data:${mime};base64,${raw}`);
    const blob = await res.blob();
    formData.append(field, blob, filename);
  } else {
    const baseDir = cacheDirectory ?? documentDirectory;
    const uri = `${baseDir}${filename}`;
    await writeAsStringAsync(uri, raw, { encoding: EncodingType.Base64 });
    formData.append(field, { uri, name: filename, type: mime } as unknown as Blob);
  }
}

export default function RegistrosLimpiezaScreen() {
  const router = useRouter();
  const { locales, loading: loadingLocales } = useLocalesPermitidos();
  const { hasPermiso } = useAuth();
  const { isPhone } = useBreakpoint();
  const puedeCompletar = hasPermiso('limpieza.completar');
  const puedeBorrar = hasPermiso('limpieza.borrar');

  /** Agenda (Próximas/Realizadas) o checklist de un día concreto. */
  const [modoVista, setModoVista] = useState<'agenda' | 'dia'>('agenda');
  const [agendaRefresh, setAgendaRefresh] = useState(0);

  const [localId, setLocalId] = useState('');
  const [fecha, setFecha] = useState(hoyIso());
  const [tipos, setTipos] = useState<Record<string, Tipo>>({});
  const [empleados, setEmpleados] = useState<EmpleadoItem[]>([]);
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [modalBorrarVisible, setModalBorrarVisible] = useState(false);
  const [borrando, setBorrando] = useState(false);

  const [selected, setSelected] = useState<Registro | null>(null);
  const [realizadoPorId, setRealizadoPorId] = useState('');
  const [realizadoPorNombre, setRealizadoPorNombre] = useState('');
  const [enviando, setEnviando] = useState(false);

  const localesOpciones = useMemo(
    () => locales.map((l) => ({
      id: valorEnLocal(l, 'id_Locales') ?? valorEnLocal(l, 'id_locales') ?? '',
      titulo: valorEnLocal(l, 'nombre') ?? valorEnLocal(l, 'Nombre') ?? '',
      icono: 'store' as const,
    })).filter((o) => o.id),
    [locales],
  );

  const staffOpciones = useMemo(
    () => empleados
      .map((e) => ({ id: String(e.employee_id ?? ''), titulo: String(e.full_name ?? '—'), icono: 'person' as const }))
      .filter((o) => o.id),
    [empleados],
  );

  useEffect(() => {
    if (!localId && localesOpciones.length > 0) setLocalId(localesOpciones[0].id);
  }, [localesOpciones, localId]);

  useEffect(() => {
    apiFetch('/api/limpieza/tipos')
      .then((res) => res.json())
      .then((data: { tipos?: Tipo[] }) => {
        const map: Record<string, Tipo> = {};
        (data.tipos || []).forEach((t) => { map[t.id_tipo] = t; });
        setTipos(map);
      })
      .catch(() => setTipos({}));
    apiFetch('/api/personal/employees')
      .then((res) => res.json())
      .then((data: { employees?: EmpleadoItem[] }) => setEmpleados(Array.isArray(data.employees) ? data.employees : []))
      .catch(() => setEmpleados([]));
  }, []);

  const cargar = useCallback(() => {
    if (!localId || modoVista !== 'dia') return;
    setLoading(true);
    setError(null);
    apiFetch(`/api/limpieza/registros?local_id=${encodeURIComponent(localId)}&fecha=${encodeURIComponent(fecha)}`)
      .then((res) => res.json())
      .then((data: { registros?: Registro[]; error?: string }) => {
        if (data.error) { setError(data.error); return; }
        setRegistros(data.registros || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error de conexión'))
      .finally(() => setLoading(false));
  }, [localId, fecha, modoVista]);

  useFocusEffect(useCallback(() => { cargar(); }, [cargar]));

  const abrirDetalle = (r: Registro | RegistroAgenda) => {
    setSelected({
      id_registro: r.id_registro,
      local_id: r.local_id,
      tipo_objeto_id: r.tipo_objeto_id ?? '',
      objeto_id: r.objeto_id,
      objeto_nombre: r.objeto_nombre,
      ubicacion: r.ubicacion,
      tarea_key: r.tarea_key,
      tarea_nombre: r.tarea_nombre,
      fecha_programada: r.fecha_programada,
      estado: r.estado,
      realizado_por_nombre: r.realizado_por_nombre,
      completado_at: r.completado_at,
    });
    setRealizadoPorId('');
    setRealizadoPorNombre('');
    setError(null);
  };

  const cerrarDetalle = () => {
    setSelected(null);
    setRealizadoPorId('');
    setRealizadoPorNombre('');
  };

  const salirMultiSelect = () => {
    setMultiSelectMode(false);
    setSelectedKeys(new Set());
  };

  const activarMultiSelect = (r: Registro) => {
    if (!puedeBorrar) return;
    setMultiSelectMode(true);
    setSelectedKeys(new Set([registroKey(r)]));
    cerrarDetalle();
  };

  const toggleSeleccion = (r: Registro) => {
    const key = registroKey(r);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSeleccionTodas = () => {
    if (selectedKeys.size === registros.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(registros.map(registroKey)));
    }
  };

  const registrosSeleccionados = useMemo(
    () => registros.filter((r) => selectedKeys.has(registroKey(r))),
    [registros, selectedKeys],
  );

  const hayHechasSeleccionadas = registrosSeleccionados.some((r) => r.estado === 'hecha');

  const abrirModalBorrar = () => {
    if (registrosSeleccionados.length === 0) return;
    setModalBorrarVisible(true);
  };

  const cerrarModalBorrar = () => setModalBorrarVisible(false);

  const ejecutarBorrado = async () => {
    if (registrosSeleccionados.length === 0) return;
    setBorrando(true);
    setError(null);
    cerrarModalBorrar();
    try {
      const res = await apiFetch('/api/limpieza/registros', {
        method: 'DELETE',
        body: JSON.stringify({
          items: registrosSeleccionados.map((r) => ({
            local_id: r.local_id,
            fecha_programada: r.fecha_programada,
            objeto_id: r.objeto_id ?? undefined,
            tarea_key: r.tarea_key ?? undefined,
            tipo_objeto_id: r.tipo_objeto_id,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Error al borrar');
        return;
      }
      salirMultiSelect();
      setAgendaRefresh((t) => t + 1);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setBorrando(false);
    }
  };

  const borrarUnoAgenda = async (r: RegistroAgenda) => {
    setBorrando(true);
    setError(null);
    try {
      const res = await apiFetch('/api/limpieza/registros', {
        method: 'DELETE',
        body: JSON.stringify({
          items: [{
            local_id: r.local_id,
            fecha_programada: r.fecha_programada,
            objeto_id: r.objeto_id ?? undefined,
            tarea_key: r.tarea_key ?? undefined,
            tipo_objeto_id: r.tipo_objeto_id,
          }],
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al borrar'); return; }
      setAgendaRefresh((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setBorrando(false);
    }
  };

  const pulsarRegistro = (r: Registro) => {
    if (multiSelectMode) toggleSeleccion(r);
    else abrirDetalle(r);
  };

  const seleccionarStaff = (id: string) => {
    setRealizadoPorId(id);
    setRealizadoPorNombre(staffOpciones.find((o) => o.id === id)?.titulo ?? '');
  };

  /** Captura la foto y, al obtenerla, completa automáticamente el registro. */
  const hacerFotoYCompletar = async () => {
    if (!selected) return;
    if (!realizadoPorNombre) { setError('Selecciona quién ha realizado la limpieza'); return; }
    setError(null);
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      const usarCamara = status === 'granted';
      const result = usarCamara
        ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const manipulated = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1000 } }],
        { compress: 0.5, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!manipulated.base64) { setError('No se pudo procesar la foto'); return; }
      await completar(`data:image/jpeg;base64,${manipulated.base64}`);
    } catch {
      setError('No se pudo capturar la foto');
    }
  };

  const completar = async (fotoDataUrl: string) => {
    if (!selected) return;
    setEnviando(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('local_id', selected.local_id);
      formData.append('fecha_programada', selected.fecha_programada);
      formData.append('objeto_id', selected.objeto_id ?? '');
      if (selected.tarea_key) formData.append('tarea_key', selected.tarea_key);
      formData.append('realizado_por_id', realizadoPorId);
      formData.append('realizado_por_nombre', realizadoPorNombre);
      await appendImagen(formData, 'foto', fotoDataUrl, 'foto.jpg', 'image/jpeg');

      const res = await apiFetch('/api/limpieza/registros/completar', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Error al completar'); return; }
      cerrarDetalle();
      setAgendaRefresh((t) => t + 1);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setEnviando(false);
    }
  };

  const tipoSel = selected ? tipos[selected.tipo_objeto_id] : null;
  const pendientes = registros.filter((r) => r.estado !== 'hecha').length;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Checklist de limpieza</Text>
      </View>

      {loadingLocales ? (
        <View style={styles.center}><ActivityIndicator size="small" color={colors.accent} /></View>
      ) : (
        <>
          <View style={[styles.filtros, isPhone && styles.filtrosStacked]}>
            <SelectorDesplegable
              style={isPhone ? undefined : { flex: 1 }}
              placeholder="Local"
              icono="store"
              tituloLista="Local"
              valorId={localId}
              opciones={localesOpciones}
              onSeleccionar={(id) => { salirMultiSelect(); setLocalId(id); }}
            />
            <View style={styles.modoToggle}>
              <TouchableOpacity
                style={[styles.modoBtn, modoVista === 'agenda' && styles.modoBtnActive]}
                onPress={() => { salirMultiSelect(); setModoVista('agenda'); }}
              >
                <Text style={[styles.modoBtnText, modoVista === 'agenda' && styles.modoBtnTextActive]}>Agenda</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modoBtn, modoVista === 'dia' && styles.modoBtnActive]}
                onPress={() => { salirMultiSelect(); setModoVista('dia'); }}
              >
                <Text style={[styles.modoBtnText, modoVista === 'dia' && styles.modoBtnTextActive]}>Por día</Text>
              </TouchableOpacity>
            </View>
            {modoVista === 'dia' ? (
              <View style={isPhone ? undefined : styles.fechaWrap}>
                <InputFecha compact valueIso={fecha} onChangeIso={(f) => { salirMultiSelect(); setFecha(f); }} style={estiloCampoFechaCompacto} />
              </View>
            ) : null}
          </View>

          {modoVista === 'agenda' ? (
            <>
              {error && !selected ? <Text style={styles.errorText}>{error}</Text> : null}
              {localId ? (
                <LimpiezaAgenda
                  localId={localId}
                  onPressRegistro={(r) => abrirDetalle(r)}
                  onBorrarRegistro={puedeBorrar && !borrando ? borrarUnoAgenda : undefined}
                  refreshToken={agendaRefresh}
                />
              ) : (
                <Text style={styles.vacio}>Selecciona un local.</Text>
              )}
            </>
          ) : (
          <>
          {puedeBorrar && registros.length > 0 && !loading ? (
            <View style={styles.toolbar}>
              {multiSelectMode ? (
                <>
                  <TouchableOpacity style={styles.toolbarBtn} onPress={toggleSeleccionTodas} activeOpacity={0.7}>
                    <MaterialIcons
                      name={selectedKeys.size === registros.length && registros.length > 0 ? 'check-box' : 'check-box-outline-blank'}
                      size={20}
                      color={selectedKeys.size === registros.length && registros.length > 0 ? colors.accent : colors.textMuted}
                    />
                    <Text style={styles.toolbarBtnText}>Todas</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.toolbarBtn} onPress={salirMultiSelect} activeOpacity={0.7}>
                    <MaterialIcons name="close" size={18} color={colors.textMuted} />
                    <Text style={styles.toolbarBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.deleteBtn, (selectedKeys.size === 0 || borrando) && styles.deleteBtnDisabled]}
                    onPress={abrirModalBorrar}
                    disabled={selectedKeys.size === 0 || borrando}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name="delete-outline" size={20} color={selectedKeys.size === 0 || borrando ? colors.textMuted : colors.danger} />
                    <Text style={[styles.deleteBtnText, (selectedKeys.size === 0 || borrando) && styles.deleteBtnTextDisabled]}>
                      Borrar{selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ''}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity style={styles.toolbarBtn} onPress={() => setMultiSelectMode(true)} activeOpacity={0.7}>
                  <MaterialIcons name="checklist" size={18} color={colors.accent} />
                  <Text style={[styles.toolbarBtnText, { color: colors.accent }]}>Seleccionar</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null}

          {error && !selected ? <Text style={styles.errorText}>{error}</Text> : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /></View>
          ) : (
            <ScrollView contentContainerStyle={styles.list}>
              {registros.length > 0 ? (
                <Text style={styles.resumen}>{pendientes} pendiente{pendientes !== 1 ? 's' : ''} · {registros.length} en total</Text>
              ) : null}
              {registros.length === 0 ? (
                <Text style={styles.vacio}>No hay limpiezas para esta fecha. Genera los registros desde Programación.</Text>
              ) : registros.map((r) => {
                const est = ESTADO_STYLE[r.estado] ?? ESTADO_STYLE.pendiente;
                const tipo = tipos[r.tipo_objeto_id];
                const arrastrada = r.estado !== 'hecha' && r.fecha_programada < fecha;
                const key = registroKey(r);
                const isSelected = selectedKeys.has(key);
                return (
                  <TouchableOpacity
                    key={r.id_registro}
                    style={[styles.card, isSelected && styles.cardSelected]}
                    onPress={() => pulsarRegistro(r)}
                    onLongPress={() => activarMultiSelect(r)}
                    activeOpacity={0.8}
                  >
                    {multiSelectMode ? (
                      <MaterialIcons
                        name={isSelected ? 'check-box' : 'check-box-outline-blank'}
                        size={22}
                        color={isSelected ? colors.accent : colors.textMuted}
                        style={{ marginRight: 4 }}
                      />
                    ) : null}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>
                        {r.objeto_nombre ?? tipo?.nombre ?? r.tipo_objeto_id}
                        {r.tarea_nombre ? ` — ${r.tarea_nombre}` : ''}
                      </Text>
                      <Text style={styles.cardMeta}>
                        {r.ubicacion ? `${r.ubicacion} · ` : ''}
                        {arrastrada ? `Programada ${fechaCorta(r.fecha_programada)}` : (r.realizado_por_nombre ? `Por ${r.realizado_por_nombre}` : 'Sin realizar')}
                      </Text>
                    </View>
                    {tipo?.requiere_vaciado_previo ? (
                      <MaterialIcons name="ac-unit" size={18} color={colors.accentPressed} style={{ marginRight: 6 }} />
                    ) : null}
                    <View style={[styles.badge, { backgroundColor: est.bg }]}>
                      <Text style={[styles.badgeText, { color: est.color }]}>{est.label}</Text>
                    </View>
                    {!multiSelectMode ? (
                      <MaterialIcons name="chevron-right" size={22} color={colors.textMuted} />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
          </>
          )}
        </>
      )}

      {/* Detalle / completar */}
      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={cerrarDetalle}>
        <View style={[styles.overlay, !isPhone && styles.overlayCentered]}>
          <View style={[styles.modalCard, !isPhone && styles.modalCardCentered]}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle} numberOfLines={1}>
                  {selected?.objeto_nombre ?? tipoSel?.nombre ?? 'Limpieza'}
                  {selected?.tarea_nombre ? ` — ${selected.tarea_nombre}` : ''}
                </Text>
                {selected?.ubicacion ? (
                  <Text style={styles.modalSub}>{selected.ubicacion}</Text>
                ) : null}
                {selected && selected.fecha_programada !== fecha ? (
                  <Text style={styles.modalSub}>Programada el {fechaCorta(selected.fecha_programada)}</Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={cerrarDetalle} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <MaterialIcons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {tipoSel?.requiere_vaciado_previo ? (
                <View style={styles.avisoVaciado}>
                  <MaterialIcons name="warning-amber" size={16} color={statusColors.warning.text} />
                  <Text style={styles.avisoVaciadoText}>Requiere vaciado previo: no rellenar antes de limpiar.</Text>
                </View>
              ) : null}

              {tipoSel?.descripcion_procedimiento ? (
                <>
                  <Text style={styles.sectionLabel}>Procedimiento</Text>
                  <Text style={styles.proc}>{tipoSel.descripcion_procedimiento}</Text>
                </>
              ) : null}

              {Array.isArray(tipoSel?.productos_y_dosis) && tipoSel!.productos_y_dosis!.length > 0 ? (
                <>
                  <Text style={styles.sectionLabel}>Productos y dosis</Text>
                  {tipoSel!.productos_y_dosis!.map((p, i) => (
                    <Text key={i} style={styles.prodLine}>• {p.producto}{p.dosis ? ` — ${p.dosis}` : ''}{p.epi ? ` (EPI: ${p.epi})` : ''}</Text>
                  ))}
                </>
              ) : null}

              {error && selected ? <Text style={styles.errorTextModal}>{error}</Text> : null}

              {selected && selected.estado !== 'hecha' && puedeCompletar ? (
                <>
                  <Text style={styles.sectionLabel}>¿Quién la realiza?</Text>
                  <SelectorDesplegable
                    placeholder="Selecciona empleado"
                    icono="person"
                    tituloLista="Empleado que realiza la limpieza"
                    iconoLista="person"
                    buscador
                    buscadorPlaceholder="Buscar empleado…"
                    valorId={realizadoPorId}
                    opciones={staffOpciones}
                    onSeleccionar={seleccionarStaff}
                  />

                  <TouchableOpacity
                    style={[styles.fotoBtn, (!realizadoPorNombre || enviando) && styles.fotoBtnDisabled]}
                    onPress={hacerFotoYCompletar}
                    disabled={!realizadoPorNombre || enviando}
                    activeOpacity={0.85}
                  >
                    {enviando ? (
                      <ActivityIndicator size="small" color={colors.surface} />
                    ) : (
                      <>
                        <MaterialIcons name="photo-camera" size={22} color={colors.surface} />
                        <Text style={styles.fotoBtnText}>Hacer foto y marcar como hecha</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <Text style={styles.ayuda}>Al hacer la foto, la limpieza se marca como hecha automáticamente.</Text>
                </>
              ) : selected?.estado === 'hecha' ? (
                <View style={styles.hechaWrap}>
                  <MaterialIcons name="verified" size={20} color={colors.success} />
                  <Text style={styles.hechaText}>
                    Hecha{selected.realizado_por_nombre ? ` por ${selected.realizado_por_nombre}` : ''}
                    {selected.completado_at ? ` · ${new Date(selected.completado_at).toLocaleString('es-ES')}` : ''}
                  </Text>
                </View>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={modalBorrarVisible} transparent animationType="fade" onRequestClose={cerrarModalBorrar}>
        <TouchableOpacity style={styles.modalBorrarOverlay} activeOpacity={1} onPress={cerrarModalBorrar}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalBorrarWrap}>
            <View style={styles.modalBorrarCard}>
              <View style={styles.modalBorrarHeader}>
                <Text style={styles.modalBorrarTitle}>
                  {registrosSeleccionados.length === 1 ? 'Borrar registro' : 'Borrar registros'}
                </Text>
                <TouchableOpacity onPress={cerrarModalBorrar} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <MaterialIcons name="close" size={22} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              <Text style={styles.modalBorrarMsg}>
                {registrosSeleccionados.length === 1
                  ? '¿Estás seguro de que deseas borrar este registro de limpieza?'
                  : `¿Estás seguro de que deseas borrar los ${registrosSeleccionados.length} registros seleccionados?`}
              </Text>
              {hayHechasSeleccionadas ? (
                <Text style={styles.modalBorrarAviso}>
                  Algunos registros ya están marcados como hechos: se eliminará también la evidencia (fotos).
                </Text>
              ) : null}
              <View style={styles.modalBorrarFooter}>
                <TouchableOpacity style={styles.modalBtnNo} onPress={cerrarModalBorrar}>
                  <Text style={styles.modalBtnNoText}>No</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalBtnSi} onPress={ejecutarBorrado} disabled={borrando}>
                  {borrando ? (
                    <ActivityIndicator size="small" color={colors.surface} />
                  ) : (
                    <Text style={styles.modalBtnSiText}>Sí, borrar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

/** Entre radius.sm (6) y radius.md (10). */
const RADIO_MEDIO = 8;
/** Entre radius.lg (12) y radius.xl (16). */
const RADIO_TARJETA = 14;

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: SPACING.md },
  backBtn: { padding: SPACING.xs },
  title: { flex: 1, fontSize: fontSizes[18], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  filtros: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.md, alignItems: 'center', flexWrap: 'wrap' },
  filtrosStacked: { flexDirection: 'column', alignItems: 'stretch', gap: SPACING.sm },
  modoToggle: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' },
  modoBtn: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md, backgroundColor: colors.bg },
  modoBtnActive: { backgroundColor: colors.accentMuted },
  modoBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  modoBtnTextActive: { color: statusColors.info.text },
  fechaWrap: { width: 130 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: 10, flexWrap: 'wrap' },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingVertical: 6, paddingHorizontal: SPACING.sm },
  toolbarBtnText: { fontSize: fontSizes[13], color: colors.textMuted, fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, marginLeft: 'auto', paddingVertical: 6, paddingHorizontal: 10, borderRadius: RADIO_MEDIO, borderWidth: 1, borderColor: '#fecaca', backgroundColor: statusColors.danger.bg },
  deleteBtnDisabled: { borderColor: colors.border, backgroundColor: colors.bg },
  deleteBtnText: { fontSize: fontSizes[13], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.danger },
  deleteBtnTextDisabled: { color: colors.textMuted },
  center: { paddingVertical: 40, alignItems: 'center' },
  errorText: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.danger, marginBottom: SPACING.sm },
  errorTextModal: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.danger, marginTop: SPACING.md },
  resumen: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginBottom: SPACING.xs },
  list: { gap: SPACING.sm, paddingBottom: 20 },
  vacio: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textMuted, padding: SPACING.lg, lineHeight: 19 },
  card: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, minHeight: 60 },
  cardSelected: { borderColor: colors.accent, backgroundColor: colors.accentMuted },
  cardTitle: { fontSize: fontSizes[16], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textPrimary },
  cardMeta: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: colors.textMuted, marginTop: 2 },
  badge: { paddingVertical: SPACING.xs, paddingHorizontal: 10, borderRadius: radius.pill },
  badgeText: { fontSize: typography.etiqueta.fontSize, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight },
  // Más oscuro que colors.overlay.
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  overlayCentered: { justifyContent: 'center', alignItems: 'center', padding: 20 },
  // 18 px: entre radius.xl (16) y el siguiente salto.
  modalCard: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '90%', overflow: 'hidden' },
  modalCardCentered: { width: '100%', maxWidth: 520, borderRadius: radius.xl },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: SPACING.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  // 17 px: entre fontSizes[16] y fontSizes[18].
  modalTitle: { fontSize: 17, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  modalSub: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.danger.text, marginTop: 2 },
  modalScroll: { padding: SPACING.lg },
  avisoVaciado: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: statusColors.warning.bg, borderWidth: 1, borderColor: '#fcd34d', borderRadius: RADIO_MEDIO, padding: 10, marginBottom: SPACING.xs },
  avisoVaciadoText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.warning.text },
  sectionLabel: { fontSize: fontSizes[12], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  proc: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, lineHeight: 20 },
  prodLine: { fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: colors.textPrimary, lineHeight: 20 },
  fotoBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, backgroundColor: colors.success, borderRadius: radius.lg, paddingVertical: SPACING.lg, marginTop: SPACING.lg, minHeight: 52 },
  fotoBtnDisabled: { backgroundColor: colors.textMuted },
  fotoBtnText: { color: colors.surface, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, fontSize: fontSizes[16] },
  ayuda: { fontFamily: fontFamily.regular, fontSize: typography.etiqueta.fontSize, color: colors.textMuted, marginTop: SPACING.sm, textAlign: 'center', marginBottom: 10 },
  hechaWrap: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, backgroundColor: '#f0fdf4', borderRadius: radius.md, padding: 14, marginTop: 14, marginBottom: 10 },
  hechaText: { flex: 1, fontFamily: fontFamily.regular, fontSize: fontSizes[13], color: statusColors.success.text },
  // Más oscuro que colors.overlay.
  modalBorrarOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalBorrarWrap: { width: '100%', maxWidth: 420 },
  modalBorrarCard: { backgroundColor: colors.surface, borderRadius: RADIO_TARJETA, padding: 18, gap: SPACING.md },
  modalBorrarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // 17 px: entre fontSizes[16] y fontSizes[18].
  modalBorrarTitle: { fontSize: 17, fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.textPrimary },
  modalBorrarMsg: { fontFamily: fontFamily.regular, fontSize: fontSizes[14], color: colors.textPrimary, lineHeight: 20 },
  modalBorrarAviso: { fontFamily: fontFamily.regular, fontSize: fontSizes[12], color: statusColors.warning.text, backgroundColor: statusColors.warning.bg, borderRadius: RADIO_MEDIO, padding: 10, lineHeight: 17 },
  modalBorrarFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: SPACING.xs },
  modalBtnNo: { paddingVertical: 10, paddingHorizontal: SPACING.lg, borderRadius: RADIO_MEDIO, borderWidth: 1, borderColor: colors.border },
  modalBtnNoText: { fontSize: fontSizes[14], fontFamily: fontFamily.semibold, fontWeight: typography.boton.fontWeight, color: colors.textMuted },
  modalBtnSi: { paddingVertical: 10, paddingHorizontal: SPACING.lg, borderRadius: RADIO_MEDIO, backgroundColor: colors.danger, minWidth: 100, alignItems: 'center' },
  modalBtnSiText: { fontSize: fontSizes[14], fontFamily: fontFamily.bold, fontWeight: typography.titulo.fontWeight, color: colors.surface },
});
