import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  TouchableOpacity,
  Switch,
  Platform,
  Pressable,
  KeyboardAvoidingView,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { TablaBasica } from '../components/TablaBasica';
import { SelectorDesplegable, type OpcionDesplegable } from '../components/SelectorDesplegable';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { MIN_TOUCH } from '../constants/layout';
import { apiFetch, errorMessage } from '../utils/api';
import type { Departamento } from '../types/tasks';

const COLUMNAS = ['Nombre', 'Responsable', 'Orden', 'Estado'];

/** Opción del desplegable de responsable que deja el departamento sin responsable. */
const SIN_RESPONSABLE_ID = '';

type UsuarioItem = {
  id_usuario?: string | number;
  Nombre?: string;
  Apellidos?: string;
  Email?: string;
};

type FormDepartamento = {
  nombre: string;
  responsable_id: string;
  /** Nombre que resolvió el backend, para pintar el responsable grabado aunque no esté entre las opciones. */
  responsable_nombre: string | null;
  orden: string;
  activo: boolean;
};

const INITIAL_FORM: FormDepartamento = {
  nombre: '',
  responsable_id: '',
  responsable_nombre: null,
  orden: '',
  activo: true,
};

function nombreCompletoUsuario(u: UsuarioItem): string {
  const nombre = `${u.Nombre ?? ''} ${u.Apellidos ?? ''}`.trim();
  return nombre || (u.Email ?? '').trim();
}

export default function DepartamentosScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { shouldStackPanels, isCompact } = useBreakpoint();

  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [usuarios, setUsuarios] = useState<UsuarioItem[]>([]);
  // El listado de usuarios solo alimenta el desplegable de responsable y exige
  // `usuarios.ver`: si falla, el formulario lo avisa en vez de tragárselo.
  const [usuariosNoDisponibles, setUsuariosNoDisponibles] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [form, setForm] = useState<FormDepartamento>(INITIAL_FORM);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const [bajaVisible, setBajaVisible] = useState(false);
  const [departamentoBaja, setDepartamentoBaja] = useState<Departamento | null>(null);

  // La lectura del maestro solo pide sesión: alimenta desplegables de todo el
  // módulo. El permiso únicamente decide si se puede escribir.
  const puedeEditar = hasPermiso('departamentos.editar');

  const cargarDepartamentos = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/api/departamentos')
      .then((r) => r.json())
      .then((data: { departamentos?: Departamento[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setDepartamentos(data.departamentos || []);
      })
      .catch((e) => setError(errorMessage(e, 'No se pudieron cargar los departamentos')))
      .finally(() => setLoading(false));
  }, []);

  const cargarUsuarios = useCallback(() => {
    apiFetch('/api/usuarios')
      .then((r) => r.json())
      .then((data: { usuarios?: UsuarioItem[]; error?: string }) => {
        if (data.error || !Array.isArray(data.usuarios)) {
          setUsuarios([]);
          setUsuariosNoDisponibles(true);
          return;
        }
        setUsuarios(data.usuarios);
        setUsuariosNoDisponibles(false);
      })
      .catch(() => {
        setUsuarios([]);
        setUsuariosNoDisponibles(true);
      });
  }, []);

  useEffect(() => {
    cargarDepartamentos();
  }, [cargarDepartamentos]);

  useEffect(() => {
    cargarUsuarios();
  }, [cargarUsuarios]);

  const responsableOpciones = useMemo<OpcionDesplegable[]>(() => {
    const opciones: OpcionDesplegable[] = [
      { id: SIN_RESPONSABLE_ID, titulo: '(sin responsable)' },
      ...usuarios
        .map((u) => ({
          id: u.id_usuario != null ? String(u.id_usuario).trim() : '',
          titulo: nombreCompletoUsuario(u),
          subtitulo: (u.Email ?? '').trim() || undefined,
          icono: 'person' as const,
        }))
        .filter((o) => o.id !== '' && o.titulo !== '')
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es')),
    ];
    // El responsable grabado puede no estar entre las opciones (sin permiso de
    // usuarios, o usuario borrado): se añade para que el trigger muestre su
    // nombre y no el placeholder «Sin responsable».
    const actual = form.responsable_id.trim();
    if (actual && !opciones.some((o) => o.id === actual)) {
      opciones.push({
        id: actual,
        titulo: form.responsable_nombre?.trim() || 'Responsable actual (usuario no disponible)',
        icono: 'person',
      });
    }
    return opciones;
  }, [usuarios, form.responsable_id, form.responsable_nombre]);

  const getValorCelda = useCallback((item: Departamento, col: string): string => {
    switch (col) {
      case 'Nombre':
        return item.nombre || '—';
      case 'Responsable': {
        const id = item.responsable_id?.trim();
        if (!id) return '—';
        // El nombre lo resuelve el backend; si viene vacío con id grabado, el
        // usuario ya no existe. Nunca se pinta el id crudo.
        return item.responsable_nombre?.trim() || 'Usuario eliminado';
      }
      case 'Orden':
        return item.orden != null ? String(item.orden) : '—';
      case 'Estado':
        return item.activo ? 'Activo' : 'Inactivo';
      default:
        return '—';
    }
  }, []);

  const departamentosFiltrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return departamentos;
    return departamentos.filter((d) =>
      COLUMNAS.some((col) => getValorCelda(d, col).toLowerCase().includes(q)),
    );
  }, [departamentos, filtroBusqueda, getValorCelda]);

  const abrirCrear = useCallback(() => {
    setForm(INITIAL_FORM);
    setEditandoId(null);
    setErrorForm(null);
    setModalVisible(true);
  }, []);

  const abrirEditar = useCallback((item: Departamento) => {
    setForm({
      nombre: item.nombre ?? '',
      responsable_id: item.responsable_id?.trim() ?? '',
      responsable_nombre: item.responsable_nombre?.trim() || null,
      orden: item.orden != null ? String(item.orden) : '',
      activo: item.activo !== false,
    });
    setEditandoId(item.id);
    setErrorForm(null);
    setModalVisible(true);
  }, []);

  const cerrarModal = useCallback(() => {
    if (guardando) return;
    setModalVisible(false);
    setErrorForm(null);
  }, [guardando]);

  const guardar = useCallback(async () => {
    const nombre = form.nombre.trim();
    if (!nombre) {
      setErrorForm('El nombre es obligatorio');
      return;
    }
    const ordenTexto = form.orden.trim();
    const orden = ordenTexto === '' ? null : Number(ordenTexto);
    if (orden != null && !Number.isFinite(orden)) {
      setErrorForm('El orden debe ser un número');
      return;
    }
    setGuardando(true);
    setErrorForm(null);
    try {
      const esEdicion = editandoId != null;
      const body: Record<string, string | number | boolean> = { nombre };
      if (esEdicion) {
        // Sin lista de usuarios no se puede elegir responsable: se omite el
        // campo para que el PATCH conserve el que ya estuviera grabado.
        if (!usuariosNoDisponibles) body.responsable_id = form.responsable_id.trim();
        body.activo = form.activo;
      } else if (form.responsable_id.trim()) {
        body.responsable_id = form.responsable_id.trim();
      }
      // Al editar, vaciar el campo debe restablecer el orden por defecto (0),
      // que es lo que promete el texto de ayuda.
      if (orden != null) body.orden = orden;
      else if (esEdicion) body.orden = 0;

      const res = await apiFetch(
        esEdicion ? `/api/departamentos/${encodeURIComponent(editandoId)}` : '/api/departamentos',
        { method: esEdicion ? 'PATCH' : 'POST', body: JSON.stringify(body) },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorForm(
          data.error ||
            (res.status === 409 ? 'Ya existe un departamento con ese nombre' : 'No se pudo guardar el departamento'),
        );
        return;
      }
      cargarDepartamentos();
      setSelectedRowIndex(null);
      setModalVisible(false);
    } catch (e) {
      setErrorForm(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }, [form, editandoId, cargarDepartamentos, usuariosNoDisponibles]);

  const solicitarBaja = useCallback((item: Departamento) => {
    setDepartamentoBaja(item);
    setBajaVisible(true);
  }, []);

  const cancelarBaja = useCallback(() => {
    setBajaVisible(false);
    setDepartamentoBaja(null);
  }, []);

  const confirmarBaja = useCallback(async () => {
    if (!departamentoBaja) return;
    setGuardando(true);
    try {
      const res = await apiFetch(`/api/departamentos/${encodeURIComponent(departamentoBaja.id)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || 'No se pudo dar de baja el departamento');
        return;
      }
      cargarDepartamentos();
      setSelectedRowIndex(null);
    } catch (e) {
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
      setBajaVisible(false);
      setDepartamentoBaja(null);
    }
  }, [departamentoBaja, cargarDepartamentos]);

  return (
    <View style={styles.container}>
      <TablaBasica<Departamento>
        title="Departamentos"
        onBack={() => router.push('/base-datos')}
        columnas={COLUMNAS}
        datos={departamentosFiltrados}
        getValorCelda={getValorCelda}
        loading={loading}
        error={error}
        onRetry={cargarDepartamentos}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={selectedRowIndex}
        onSelectRow={setSelectedRowIndex}
        onCrear={abrirCrear}
        onEditar={abrirEditar}
        onBorrar={solicitarBaja}
        guardando={guardando}
        hideToolbarActions={!puedeEditar}
        toolbarCrearLabel="Crear departamento"
        emptyMessage="No hay departamentos dados de alta"
        emptyFilterMessage="Ningún departamento coincide con el filtro"
        defaultColWidth={140}
        getRowKey={(item) => item.id}
        getRowStyle={(item) => (item.activo ? undefined : styles.filaInactiva)}
        renderCell={(item, col) => {
          if (col !== 'Estado') return null;
          return (
            <View style={[styles.badge, item.activo ? styles.badgeActivo : styles.badgeInactivo]}>
              <Text style={[styles.badgeText, item.activo ? styles.badgeTextActivo : styles.badgeTextInactivo]}>
                {item.activo ? 'Activo' : 'Inactivo'}
              </Text>
            </View>
          );
        }}
      />

      {!puedeEditar ? (
        <View style={styles.avisoSoloLectura}>
          <MaterialIcons name="lock-outline" size={16} color="#64748b" />
          <Text style={styles.avisoSoloLecturaTexto}>
            Solo lectura: necesitas el permiso de edición de departamentos para crear, editar o dar de baja.
          </Text>
        </View>
      ) : null}

      {/* Modal crear / editar */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={cerrarModal}>
        {/* El fondo no cierra el formulario (evita perder datos): usar la X o Cancelar. */}
        <Pressable style={styles.modalOverlay}>
          <KeyboardAvoidingView
            style={styles.modalCenter}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Pressable style={[styles.modalCardWrap, shouldStackPanels && styles.modalCardWrapAncho]}>
              <View style={styles.modalCard}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>
                    {editandoId != null ? 'Editar departamento' : 'Nuevo departamento'}
                  </Text>
                  <TouchableOpacity onPress={cerrarModal} style={styles.modalClose} disabled={guardando}>
                    <MaterialIcons name="close" size={22} color="#64748b" />
                  </TouchableOpacity>
                </View>

                <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Nombre *</Text>
                    <TextInput
                      style={styles.formInput}
                      value={form.nombre}
                      onChangeText={(t) => setForm((p) => ({ ...p, nombre: t }))}
                      placeholder="Ej.: Marketing, Contabilidad…"
                      placeholderTextColor="#94a3b8"
                      editable={!guardando}
                      autoCapitalize="words"
                    />
                  </View>

                  <View style={styles.formGroup}>
                    <SelectorDesplegable
                      label="Responsable"
                      icono="person"
                      placeholder="Sin responsable"
                      tituloLista="Selecciona un responsable"
                      iconoLista="person"
                      buscador
                      buscadorPlaceholder="Buscar usuario…"
                      valorId={form.responsable_id}
                      opciones={responsableOpciones}
                      vacioTexto="No hay usuarios disponibles"
                      disabled={guardando || usuariosNoDisponibles}
                      onSeleccionar={(id) => setForm((p) => ({ ...p, responsable_id: id }))}
                    />
                    {usuariosNoDisponibles ? (
                      <View style={styles.formAviso}>
                        <MaterialIcons name="info-outline" size={14} color="#d97706" />
                        <Text style={styles.formAvisoTexto}>
                          No se puede elegir responsable sin el permiso de usuarios. Se conserva el responsable
                          que ya tuviera este departamento.
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Orden</Text>
                    <TextInput
                      style={styles.formInput}
                      value={form.orden}
                      onChangeText={(t) => setForm((p) => ({ ...p, orden: t }))}
                      placeholder="Ej.: 10"
                      placeholderTextColor="#94a3b8"
                      editable={!guardando}
                      keyboardType="number-pad"
                    />
                    <Text style={styles.formHelp}>
                      Posición en las listas y desplegables. Si lo dejas vacío, se ordena por nombre.
                    </Text>
                  </View>

                  {editandoId != null ? (
                    <View style={styles.formGroup}>
                      <View style={styles.formGroupRow}>
                        <Text style={styles.formLabel}>Activo</Text>
                        <Switch
                          value={form.activo}
                          onValueChange={(v) => setForm((p) => ({ ...p, activo: v }))}
                          disabled={guardando}
                          trackColor={{ false: '#e2e8f0', true: '#0ea5e9' }}
                          thumbColor="#fff"
                        />
                      </View>
                      <Text style={styles.formHelp}>
                        Los inactivos no aparecen en los desplegables, pero siguen resolviendo el nombre de lo ya
                        grabado. Vuelve a activarlo aquí para que se pueda elegir de nuevo.
                      </Text>
                    </View>
                  ) : null}
                </ScrollView>

                {errorForm ? <Text style={styles.modalError}>{errorForm}</Text> : null}

                <View style={styles.modalFooter}>
                  <TouchableOpacity
                    style={[styles.modalBtn, isCompact && styles.modalBtnTactil]}
                    onPress={cerrarModal}
                    disabled={guardando}
                  >
                    <Text style={styles.modalBtnText}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalBtn, styles.modalBtnPrimario, isCompact && styles.modalBtnTactil]}
                    onPress={guardar}
                    disabled={guardando}
                  >
                    {guardando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.modalBtnTextPrimario}>{editandoId != null ? 'Guardar' : 'Crear'}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {/* Modal confirmación de baja */}
      <Modal visible={bajaVisible} transparent animationType="fade" onRequestClose={cancelarBaja}>
        <Pressable style={styles.modalOverlay} onPress={cancelarBaja}>
          <Pressable style={styles.confirmCard} onPress={(e) => e.stopPropagation()}>
            <MaterialIcons name="warning" size={36} color="#d97706" style={styles.confirmIcono} />
            <Text style={styles.confirmTitle}>Dar de baja el departamento</Text>
            <Text style={styles.confirmText}>
              <Text style={styles.confirmNombre}>{departamentoBaja?.nombre}</Text> dejará de aparecer en los
              desplegables, pero seguirá en esta lista marcado como inactivo para no perder el nombre en proyectos,
              tareas y fichas de usuario ya grabados. Puedes reactivarlo desde la edición.
            </Text>
            <View style={styles.confirmBotones}>
              <TouchableOpacity
                style={[styles.modalBtn, isCompact && styles.modalBtnTactil]}
                onPress={cancelarBaja}
                disabled={guardando}
              >
                <Text style={styles.modalBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPeligro, isCompact && styles.modalBtnTactil]}
                onPress={confirmarBaja}
                disabled={guardando}
              >
                {guardando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnTextPeligro}>Dar de baja</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },

  filaInactiva: { backgroundColor: '#f8fafc', opacity: 0.7 },

  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '600' },
  badgeActivo: { backgroundColor: '#dcfce7' },
  badgeInactivo: { backgroundColor: '#e2e8f0' },
  badgeTextActivo: { color: '#16a34a' },
  badgeTextInactivo: { color: '#64748b' },

  avisoSoloLectura: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 10,
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  avisoSoloLecturaTexto: { flex: 1, fontSize: 12, color: '#64748b', lineHeight: 17 },

  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalCenter: { flex: 1, justifyContent: 'center', alignItems: 'center', width: '100%', padding: 20 },
  modalCardWrap: { width: '100%', maxWidth: 440 },
  modalCardWrapAncho: { maxWidth: '100%' },
  modalCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#334155' },
  modalClose: { padding: 4 },
  modalBody: { paddingHorizontal: 20, paddingVertical: 16, maxHeight: 420 },

  formGroup: { marginBottom: 14 },
  formGroupRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formLabel: { fontSize: 11, fontWeight: '500', color: '#475569', marginBottom: 4 },
  formInput: {
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    color: '#334155',
  },
  formHelp: { fontSize: 11, color: '#94a3b8', marginTop: 4, lineHeight: 16 },
  formAviso: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  formAvisoTexto: { flex: 1, fontSize: 11, color: '#d97706', lineHeight: 16 },

  modalError: { fontSize: 12, color: '#ef4444', paddingHorizontal: 20, paddingBottom: 4 },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  modalBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 20 },
  modalBtnText: { fontSize: 13, fontWeight: '500', color: '#64748b' },
  modalBtnPrimario: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  modalBtnTextPrimario: { fontSize: 13, fontWeight: '600', color: '#fff' },
  modalBtnPeligro: { backgroundColor: '#d97706', borderColor: '#d97706' },
  modalBtnTextPeligro: { fontSize: 13, fontWeight: '600', color: '#fff' },

  confirmCard: {
    width: '90%',
    maxWidth: 400,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 12,
    gap: 12,
  },
  confirmIcono: { alignSelf: 'center' },
  confirmTitle: { fontSize: 16, fontWeight: '700', color: '#334155', textAlign: 'center' },
  confirmText: { fontSize: 13, color: '#475569', textAlign: 'center', lineHeight: 20 },
  confirmNombre: { fontWeight: '700', color: '#334155' },
  confirmBotones: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginTop: 4 },
});
