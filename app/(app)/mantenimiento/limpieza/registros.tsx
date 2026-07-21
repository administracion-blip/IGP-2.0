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
import { useMantenimientoLocales, valorEnLocal } from '../LocalesContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { InputFecha } from '../../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../../components/RangoFechas';
import { LimpiezaAgenda, type RegistroAgenda } from '../../../components/limpieza/LimpiezaAgenda';
import { apiFetch } from '../../../utils/api';

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
  pendiente: { bg: '#fef3c7', color: '#b45309', label: 'Pendiente' },
  hecha: { bg: '#dcfce7', color: '#15803d', label: 'Hecha' },
  retrasada: { bg: '#fee2e2', color: '#b91c1c', label: 'Retrasada' },
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
  const { locales, loading: loadingLocales } = useMantenimientoLocales();
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
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <Text style={styles.title}>Checklist de limpieza</Text>
      </View>

      {loadingLocales ? (
        <View style={styles.center}><ActivityIndicator size="small" color="#0ea5e9" /></View>
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
                      color={selectedKeys.size === registros.length && registros.length > 0 ? '#0ea5e9' : '#94a3b8'}
                    />
                    <Text style={styles.toolbarBtnText}>Todas</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.toolbarBtn} onPress={salirMultiSelect} activeOpacity={0.7}>
                    <MaterialIcons name="close" size={18} color="#64748b" />
                    <Text style={styles.toolbarBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.deleteBtn, (selectedKeys.size === 0 || borrando) && styles.deleteBtnDisabled]}
                    onPress={abrirModalBorrar}
                    disabled={selectedKeys.size === 0 || borrando}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name="delete-outline" size={20} color={selectedKeys.size === 0 || borrando ? '#94a3b8' : '#dc2626'} />
                    <Text style={[styles.deleteBtnText, (selectedKeys.size === 0 || borrando) && styles.deleteBtnTextDisabled]}>
                      Borrar{selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ''}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity style={styles.toolbarBtn} onPress={() => setMultiSelectMode(true)} activeOpacity={0.7}>
                  <MaterialIcons name="checklist" size={18} color="#0ea5e9" />
                  <Text style={[styles.toolbarBtnText, { color: '#0ea5e9' }]}>Seleccionar</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null}

          {error && !selected ? <Text style={styles.errorText}>{error}</Text> : null}

          {loading ? (
            <View style={styles.center}><ActivityIndicator size="large" color="#0ea5e9" /></View>
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
                        color={isSelected ? '#0ea5e9' : '#94a3b8'}
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
                      <MaterialIcons name="ac-unit" size={18} color="#0284c7" style={{ marginRight: 6 }} />
                    ) : null}
                    <View style={[styles.badge, { backgroundColor: est.bg }]}>
                      <Text style={[styles.badgeText, { color: est.color }]}>{est.label}</Text>
                    </View>
                    {!multiSelectMode ? (
                      <MaterialIcons name="chevron-right" size={22} color="#94a3b8" />
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
                <MaterialIcons name="close" size={24} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {tipoSel?.requiere_vaciado_previo ? (
                <View style={styles.avisoVaciado}>
                  <MaterialIcons name="warning-amber" size={16} color="#b45309" />
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
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <MaterialIcons name="photo-camera" size={22} color="#fff" />
                        <Text style={styles.fotoBtnText}>Hacer foto y marcar como hecha</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <Text style={styles.ayuda}>Al hacer la foto, la limpieza se marca como hecha automáticamente.</Text>
                </>
              ) : selected?.estado === 'hecha' ? (
                <View style={styles.hechaWrap}>
                  <MaterialIcons name="verified" size={20} color="#16a34a" />
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
                  <MaterialIcons name="close" size={22} color="#64748b" />
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
                    <ActivityIndicator size="small" color="#fff" />
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

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  backBtn: { padding: 4 },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: '#334155' },
  filtros: { flexDirection: 'row', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' },
  filtrosStacked: { flexDirection: 'column', alignItems: 'stretch', gap: 8 },
  modoToggle: { flexDirection: 'row', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, overflow: 'hidden' },
  modoBtn: { paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#f8fafc' },
  modoBtnActive: { backgroundColor: '#e0f2fe' },
  modoBtnText: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  modoBtnTextActive: { color: '#0369a1' },
  fechaWrap: { width: 130 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
  toolbarBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 8 },
  toolbarBtnText: { fontSize: 13, color: '#64748b', fontWeight: '600' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  deleteBtnDisabled: { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  deleteBtnText: { fontSize: 13, fontWeight: '700', color: '#dc2626' },
  deleteBtnTextDisabled: { color: '#94a3b8' },
  center: { paddingVertical: 40, alignItems: 'center' },
  errorText: { fontSize: 12, color: '#dc2626', marginBottom: 8 },
  errorTextModal: { fontSize: 13, color: '#dc2626', marginTop: 12 },
  resumen: { fontSize: 12, color: '#64748b', marginBottom: 4 },
  list: { gap: 8, paddingBottom: 20 },
  vacio: { fontSize: 13, color: '#94a3b8', padding: 16, lineHeight: 19 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, padding: 14, minHeight: 60 },
  cardSelected: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  cardTitle: { fontSize: 15, fontWeight: '600', color: '#334155' },
  cardMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  badge: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  overlayCentered: { justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalCard: { backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '90%', overflow: 'hidden' },
  modalCardCentered: { width: '100%', maxWidth: 520, borderRadius: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#334155' },
  modalSub: { fontSize: 12, color: '#b91c1c', marginTop: 2 },
  modalScroll: { padding: 16 },
  avisoVaciado: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fcd34d', borderRadius: 8, padding: 10, marginBottom: 4 },
  avisoVaciadoText: { flex: 1, fontSize: 12, color: '#b45309' },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#475569', marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  proc: { fontSize: 14, color: '#334155', lineHeight: 20 },
  prodLine: { fontSize: 13, color: '#475569', lineHeight: 20 },
  fotoBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#16a34a', borderRadius: 12, paddingVertical: 16, marginTop: 16, minHeight: 52 },
  fotoBtnDisabled: { backgroundColor: '#94a3b8' },
  fotoBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  ayuda: { fontSize: 11, color: '#64748b', marginTop: 8, textAlign: 'center', marginBottom: 10 },
  hechaWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#f0fdf4', borderRadius: 10, padding: 14, marginTop: 14, marginBottom: 10 },
  hechaText: { flex: 1, fontSize: 13, color: '#15803d' },
  modalBorrarOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalBorrarWrap: { width: '100%', maxWidth: 420 },
  modalBorrarCard: { backgroundColor: '#fff', borderRadius: 14, padding: 18, gap: 12 },
  modalBorrarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalBorrarTitle: { fontSize: 17, fontWeight: '700', color: '#334155' },
  modalBorrarMsg: { fontSize: 14, color: '#475569', lineHeight: 20 },
  modalBorrarAviso: { fontSize: 12, color: '#b45309', backgroundColor: '#fffbeb', borderRadius: 8, padding: 10, lineHeight: 17 },
  modalBorrarFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtnNo: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  modalBtnNoText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  modalBtnSi: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#dc2626', minWidth: 100, alignItems: 'center' },
  modalBtnSiText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
