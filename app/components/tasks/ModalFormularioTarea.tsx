/**
 * Alta y edición de una tarea.
 *
 * El responsable solo se elige al crear: cambiarlo después es reasignar, tiene
 * su propio endpoint y su propio permiso. En edición se manda únicamente lo que
 * ha cambiado, porque el `PATCH` responde `400` si el cuerpo llega vacío y no
 * tiene sentido reescribir campos que nadie tocó.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch, errorMessage } from '../../utils/api';
import { InputFecha } from '../InputFecha';
import { estiloCampoFechaCompacto } from '../RangoFechas';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { ETIQUETA_PRIORIDAD } from '../../lib/tasksUi';
import { PRIORIDADES, type Prioridad, type Tarea } from '../../types/tasks';
import { estilosFormTasks as form, estilosModalTasks as modal } from './estilosTasks';
import type { NombresUsuarios } from '../../hooks/useNombresUsuarios';
import type { MaestroDepartamentos } from '../../hooks/useDepartamentos';

const SIN_DEPARTAMENTO = '';

type FormTarea = {
  titulo: string;
  descripcion: string;
  responsable_id: string;
  fecha_limite: string;
  prioridad: Prioridad;
  departamento_id: string;
};

export function ModalFormularioTarea({
  visible,
  modo,
  tarea,
  proyectoId,
  tareaPadreId,
  departamentoPorDefecto,
  responsablePorDefecto,
  usuarios,
  departamentos,
  onCerrar,
  onGuardada,
}: {
  visible: boolean;
  modo: 'crear' | 'editar';
  tarea?: Tarea | null;
  proyectoId?: string;
  tareaPadreId?: string;
  departamentoPorDefecto?: string;
  responsablePorDefecto?: string;
  usuarios: NombresUsuarios;
  departamentos: MaestroDepartamentos;
  onCerrar: () => void;
  onGuardada: (tarea: Tarea) => void;
}) {
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const [datos, setDatos] = useState<FormTarea>(() => vacio());
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function vacio(): FormTarea {
    return {
      titulo: '',
      descripcion: '',
      responsable_id: responsablePorDefecto ?? '',
      fecha_limite: '',
      prioridad: 'media',
      departamento_id: departamentoPorDefecto ?? '',
    };
  }

  useEffect(() => {
    if (!visible) return;
    setError(null);
    if (modo === 'editar' && tarea) {
      setDatos({
        titulo: tarea.titulo ?? '',
        descripcion: tarea.descripcion ?? '',
        responsable_id: tarea.responsable_id ?? '',
        fecha_limite: tarea.fecha_limite ?? '',
        prioridad: tarea.prioridad ?? 'media',
        departamento_id: tarea.departamento_id ?? '',
      });
    } else {
      setDatos(vacio());
    }
    // `vacio` solo lee props estables dentro de una apertura del modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, modo, tarea, departamentoPorDefecto, responsablePorDefecto]);

  const opcionesDepartamento = useMemo<OpcionDesplegable[]>(
    () => [{ id: SIN_DEPARTAMENTO, titulo: '(sin departamento)' }, ...departamentos.opciones],
    [departamentos.opciones],
  );

  const opcionesResponsable = useMemo<OpcionDesplegable[]>(() => {
    const lista = [...usuarios.opciones];
    const actual = datos.responsable_id.trim();
    if (actual && !lista.some((o) => o.id === actual)) {
      lista.push({ id: actual, titulo: usuarios.nombrePorId(actual), icono: 'person' });
    }
    return lista;
  }, [usuarios, datos.responsable_id]);

  async function guardar() {
    const titulo = datos.titulo.trim();
    if (!titulo) {
      setError('El título es obligatorio');
      return;
    }
    if (modo === 'crear' && !datos.responsable_id.trim()) {
      setError('La tarea necesita una persona responsable');
      return;
    }
    if (datos.fecha_limite && !/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha_limite)) {
      setError('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }

    setGuardando(true);
    setError(null);
    try {
      let ruta = '/api/tareas';
      let metodo: 'POST' | 'PATCH' = 'POST';
      let cuerpo: Record<string, unknown>;

      if (modo === 'editar' && tarea) {
        ruta = `/api/tareas/${encodeURIComponent(tarea.id_tarea)}`;
        metodo = 'PATCH';
        cuerpo = {};
        if (titulo !== (tarea.titulo ?? '')) cuerpo.titulo = titulo;
        if (datos.descripcion.trim() !== (tarea.descripcion ?? '')) {
          cuerpo.descripcion = datos.descripcion.trim();
        }
        if (datos.fecha_limite !== (tarea.fecha_limite ?? '')) cuerpo.fecha_limite = datos.fecha_limite;
        if (datos.prioridad !== (tarea.prioridad ?? 'media')) cuerpo.prioridad = datos.prioridad;
        if (datos.departamento_id !== (tarea.departamento_id ?? '')) {
          cuerpo.departamento_id = datos.departamento_id;
        }
        if (Object.keys(cuerpo).length === 0) {
          onCerrar();
          return;
        }
      } else {
        cuerpo = {
          titulo,
          descripcion: datos.descripcion.trim(),
          responsable_id: datos.responsable_id.trim(),
          fecha_limite: datos.fecha_limite,
          prioridad: datos.prioridad,
          departamento_id: datos.departamento_id,
        };
        if (proyectoId) cuerpo.proyecto_id = proyectoId;
        if (tareaPadreId) cuerpo.tarea_padre_id = tareaPadreId;
      }

      const res = await apiFetch(ruta, { method: metodo, body: JSON.stringify(cuerpo) });
      const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };
      if (!res.ok || !data.tarea) {
        setError(data.error || 'No se pudo guardar la tarea');
        return;
      }
      onGuardada(data.tarea);
    } catch (e) {
      console.error('[tasks] fallo al guardar la tarea', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  const tituloModal =
    modo === 'editar' ? 'Editar tarea' : tareaPadreId ? 'Nueva subtarea' : 'Nueva tarea';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={modal.overlay}>
        <KeyboardAvoidingView
          style={modal.center}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable
            style={[modal.cardWrap, (shouldStackPanels || isCompact) && modal.cardWrapAncho]}
          >
            <View style={modal.card}>
              <View style={modal.header}>
                <Text style={modal.title}>{tituloModal}</Text>
                <TouchableOpacity onPress={onCerrar} style={modal.close} disabled={guardando}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>

              <ScrollView style={modal.body} keyboardShouldPersistTaps="handled">
                <View style={form.group}>
                  <Text style={form.label}>Título *</Text>
                  <TextInput
                    style={form.input}
                    value={datos.titulo}
                    onChangeText={(t) => setDatos((p) => ({ ...p, titulo: t }))}
                    placeholder="Qué hay que hacer"
                    placeholderTextColor="#94a3b8"
                    editable={!guardando}
                  />
                </View>

                <View style={form.group}>
                  <Text style={form.label}>Descripción</Text>
                  <TextInput
                    style={[form.input, form.inputMultilinea]}
                    value={datos.descripcion}
                    onChangeText={(t) => setDatos((p) => ({ ...p, descripcion: t }))}
                    placeholder="Detalle, contexto, con @nombre para mencionar a alguien"
                    placeholderTextColor="#94a3b8"
                    multiline
                    numberOfLines={4}
                    editable={!guardando}
                  />
                </View>

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    {modo === 'crear' ? (
                      <>
                        <SelectorDesplegable
                          label="Responsable *"
                          icono="person"
                          placeholder="Sin responsable"
                          tituloLista="Selecciona el responsable"
                          iconoLista="person"
                          buscador
                          buscadorPlaceholder="Buscar usuario…"
                          valorId={datos.responsable_id}
                          opciones={opcionesResponsable}
                          vacioTexto="No hay usuarios disponibles"
                          disabled={guardando || usuarios.noDisponibles}
                          loading={usuarios.cargando}
                          onSeleccionar={(id) => setDatos((p) => ({ ...p, responsable_id: id }))}
                        />
                        {usuarios.noDisponibles ? (
                          <View style={form.aviso}>
                            <MaterialIcons name="info-outline" size={14} color="#d97706" />
                            <Text style={form.avisoTexto}>
                              No se puede elegir responsable sin el permiso de usuarios. Pide a
                              alguien con ese permiso que cree la tarea.
                            </Text>
                          </View>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <Text style={form.label}>Responsable</Text>
                        <Text style={styles.soloLectura}>
                          {usuarios.nombrePorId(datos.responsable_id)}
                        </Text>
                        <Text style={form.help}>
                          El responsable se cambia desde «Reasignar» en la ficha de la tarea.
                        </Text>
                      </>
                    )}
                  </View>
                  <View style={form.col}>
                    <SelectorDesplegable
                      label="Departamento"
                      icono="account-tree"
                      placeholder="Sin departamento"
                      tituloLista="Selecciona un departamento"
                      iconoLista="account-tree"
                      valorId={datos.departamento_id}
                      opciones={opcionesDepartamento}
                      vacioTexto="No hay departamentos activos"
                      disabled={guardando}
                      loading={departamentos.cargando}
                      onSeleccionar={(id) => setDatos((p) => ({ ...p, departamento_id: id }))}
                    />
                    <Text style={form.help}>
                      Es etiqueta organizativa: no limita a quién se le puede asignar la tarea.
                    </Text>
                  </View>
                </View>

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <Text style={form.label}>Fecha límite</Text>
                    <InputFecha
                      compact
                      valueIso={datos.fecha_limite}
                      onChangeIso={(iso) => setDatos((p) => ({ ...p, fecha_limite: iso }))}
                      editable={!guardando}
                      style={estiloCampoFechaCompacto}
                    />
                  </View>
                  <View style={form.col}>
                    <Text style={form.label}>Prioridad</Text>
                    <View style={form.chipsRow}>
                      {PRIORIDADES.map((p) => (
                        <TouchableOpacity
                          key={p}
                          style={[
                            form.chip,
                            isCompact && form.chipTactil,
                            datos.prioridad === p && form.chipActivo,
                          ]}
                          onPress={() => setDatos((prev) => ({ ...prev, prioridad: p }))}
                          disabled={guardando}
                        >
                          <Text
                            style={[form.chipTexto, datos.prioridad === p && form.chipTextoActivo]}
                          >
                            {ETIQUETA_PRIORIDAD[p]}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                </View>
              </ScrollView>

              {error ? <Text style={modal.error}>{error}</Text> : null}

              <View style={modal.footer}>
                <TouchableOpacity
                  style={[modal.btn, isCompact && modal.btnTactil]}
                  onPress={onCerrar}
                  disabled={guardando}
                >
                  <Text style={modal.btnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[modal.btn, modal.btnPrimario, isCompact && modal.btnTactil]}
                  onPress={guardar}
                  disabled={guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={modal.btnTextPrimario}>{modo === 'editar' ? 'Guardar' : 'Crear'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  soloLectura: { fontSize: 13, fontWeight: '600', color: '#334155', paddingVertical: 4 },
});
