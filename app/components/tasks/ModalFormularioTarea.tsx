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
import { aplicarHoraInicio, InputHora } from './InputHora';
import type { NombresUsuarios } from '../../hooks/useNombresUsuarios';
import type { MaestroDepartamentos } from '../../hooks/useDepartamentos';

const SIN_DEPARTAMENTO = '';

type FormTarea = {
  titulo: string;
  descripcion: string;
  responsable_id: string;
  fecha_limite: string;
  hora_inicio: string;
  hora_fin: string;
  prioridad: Prioridad;
  departamento_id: string;
};

function horaValida(valor: string): boolean {
  const t = valor.trim();
  if (!t) return true;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(t);
}

export function ModalFormularioTarea({
  visible,
  modo,
  tarea,
  proyectoId,
  tareaPadreId,
  departamentoPorDefecto,
  responsablePorDefecto,
  fechaPorDefecto,
  horaInicioPorDefecto,
  presentacion = 'modal',
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
  /** Alta desde un hueco de la agenda. */
  fechaPorDefecto?: string;
  horaInicioPorDefecto?: string;
  presentacion?: 'modal' | 'flotante';
  usuarios: NombresUsuarios;
  departamentos: MaestroDepartamentos;
  onCerrar: () => void;
  onGuardada: (tarea: Tarea, extras?: { avisoCalendario?: string }) => void;
}) {
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const [datos, setDatos] = useState<FormTarea>(() => vacio());
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function vacio(): FormTarea {
    const hi = (horaInicioPorDefecto ?? '').trim();
    const par = hi ? aplicarHoraInicio(hi, '') : { hora_inicio: '', hora_fin: '' };
    return {
      titulo: '',
      descripcion: '',
      responsable_id: responsablePorDefecto ?? '',
      fecha_limite: (fechaPorDefecto ?? '').trim(),
      hora_inicio: par.hora_inicio,
      hora_fin: par.hora_fin,
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
        hora_inicio: tarea.hora_inicio ?? '',
        hora_fin: tarea.hora_fin ?? '',
        prioridad: tarea.prioridad ?? 'media',
        departamento_id: tarea.departamento_id ?? '',
      });
    } else {
      setDatos(vacio());
    }
    // `vacio` solo lee props estables dentro de una apertura del modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, modo, tarea, departamentoPorDefecto, responsablePorDefecto, fechaPorDefecto, horaInicioPorDefecto]);

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
    if (!datos.fecha_limite.trim()) {
      setError('La fecha límite es obligatoria');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha_limite)) {
      setError('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    if (!horaValida(datos.hora_inicio) || !horaValida(datos.hora_fin)) {
      setError('Las horas deben tener formato HH:mm');
      return;
    }
    const hi = datos.hora_inicio.trim();
    const hf = datos.hora_fin.trim();
    if ((hi && !hf) || (!hi && hf)) {
      setError('Indica hora de inicio y hora de fin, o deja ambas vacías');
      return;
    }
    if (hi && hf && hf <= hi) {
      setError('La hora de fin debe ser posterior a la de inicio');
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
        const hiPrev = (tarea.hora_inicio ?? '').trim();
        const hfPrev = (tarea.hora_fin ?? '').trim();
        if (hi !== hiPrev || hf !== hfPrev) {
          // Vacío al editar = quitar el tramo (el API acepta cadena vacía).
          cuerpo.hora_inicio = hi;
          cuerpo.hora_fin = hf;
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
        if (hi && hf) {
          cuerpo.hora_inicio = hi;
          cuerpo.hora_fin = hf;
        }
        if (proyectoId) cuerpo.proyecto_id = proyectoId;
        if (tareaPadreId) cuerpo.tarea_padre_id = tareaPadreId;
      }

      const res = await apiFetch(ruta, { method: metodo, body: JSON.stringify(cuerpo) });
      const data = (await res.json().catch(() => ({}))) as {
        tarea?: Tarea;
        error?: string;
        calendario_sincronizado?: boolean;
        calendario_error?: string | null;
      };
      if (!res.ok || !data.tarea) {
        setError(data.error || 'No se pudo guardar la tarea');
        return;
      }
      const avisoCalendario =
        data.calendario_sincronizado === false
          ? data.calendario_error?.trim() ||
            'La tarea se guardó, pero no se pudo sincronizar con Google Calendar.'
          : undefined;
      onGuardada(data.tarea, avisoCalendario ? { avisoCalendario } : undefined);
    } catch (e) {
      console.error('[tasks] fallo al guardar la tarea', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  const tituloModal =
    modo === 'editar' ? 'Editar tarea' : tareaPadreId ? 'Nueva subtarea' : 'Nueva tarea';
  const flotante = presentacion === 'flotante';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable
        style={[modal.overlay, flotante && styles.overlayFlotante]}
        onPress={flotante && !guardando ? onCerrar : undefined}
      >
        <KeyboardAvoidingView
          style={modal.center}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable
            style={[
              modal.cardWrap,
              flotante ? modal.cardWrapEstrecho : null,
              (shouldStackPanels || isCompact) && !flotante && modal.cardWrapAncho,
            ]}
            onPress={() => {}}
          >
            <View style={modal.card}>
              <View style={modal.header}>
                <Text style={modal.title}>{tituloModal}</Text>
                <TouchableOpacity onPress={onCerrar} style={modal.close} disabled={guardando}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={[modal.body, flotante && styles.cuerpoFlotante]}
                keyboardShouldPersistTaps="handled"
              >
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
                    <Text style={form.label}>Fecha límite *</Text>
                    <InputFecha
                      compact
                      valueIso={datos.fecha_limite}
                      onChangeIso={(iso) => setDatos((p) => ({ ...p, fecha_limite: iso }))}
                      editable={!guardando}
                      style={estiloCampoFechaCompacto}
                    />
                  </View>
                  <View style={styles.colHora}>
                    <Text style={form.label}>Hora inicio</Text>
                    <InputHora
                      compact
                      value={datos.hora_inicio}
                      onChange={(hhmm) =>
                        setDatos((p) => ({ ...p, ...aplicarHoraInicio(hhmm, p.hora_fin) }))
                      }
                      editable={!guardando}
                    />
                  </View>
                  <View style={styles.colHora}>
                    <Text style={form.label}>Hora fin</Text>
                    <InputHora
                      compact
                      value={datos.hora_fin}
                      onChange={(hhmm) => setDatos((p) => ({ ...p, hora_fin: hhmm }))}
                      editable={!guardando}
                    />
                  </View>
                </View>

                <View style={form.group}>
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
  colHora: { flexGrow: 0, flexShrink: 0, alignSelf: 'flex-start' },
  overlayFlotante: { backgroundColor: 'rgba(15, 23, 42, 0.12)' },
  cuerpoFlotante: { maxHeight: 420 },
});
