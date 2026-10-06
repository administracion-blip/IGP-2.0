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
import { CampoMenciones } from './CampoMenciones';
import { ETIQUETA_PRIORIDAD } from '../../lib/tasksUi';
import { MAX_CHECKLIST, PRIORIDADES, type Prioridad, type Tarea } from '../../types/tasks';
import { estilosFormTasks as form, estilosModalTasks as modal } from './estilosTasks';
import { aplicarHoraInicio, InputHora } from './InputHora';
import { diaMesDeFecha, diaSemanaDeFecha, SelectorRepeticion } from './SelectorRepeticion';
import type { NombresUsuarios } from '../../hooks/useNombresUsuarios';
import type { MaestroDepartamentos } from '../../hooks/useDepartamentos';

const SIN_DEPARTAMENTO = '';

type CasillaForm = {
  clave: string;
  id?: string;
  texto: string;
};

type FormTarea = {
  titulo: string;
  descripcion: string;
  casillas: CasillaForm[];
  responsable_id: string;
  participantes_ids: string[];
  fecha_limite: string;
  repetir: string;
  dias_semana: number[];
  dias_mes: number[];
  hora_inicio: string;
  hora_fin: string;
  prioridad: Prioridad;
  departamento_id: string;
};

function claveCasilla(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function casillasDesdeTarea(tarea: Tarea): CasillaForm[] {
  return [...(tarea.checklist ?? [])]
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .map((item) => ({ clave: item.id, id: item.id, texto: item.texto ?? '' }));
}

function textosCasilla(casillas: CasillaForm[]): string[] {
  return casillas.map((c) => c.texto.trim()).filter(Boolean);
}

function casillasIguales(tarea: Tarea, casillas: CasillaForm[]): boolean {
  const antes = [...(tarea.checklist ?? [])].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  const ahora = casillas.filter((c) => c.texto.trim());
  if (antes.length !== ahora.length) return false;
  return ahora.every((c, i) => c.id === antes[i].id && c.texto.trim() === antes[i].texto);
}

async function sincronizarCasillas(
  idTarea: string,
  tarea: Tarea,
  casillas: CasillaForm[],
): Promise<{ error?: string; tarea?: Tarea }> {
  const base = `/api/tareas/${encodeURIComponent(idTarea)}/checklist`;
  const antes = [...(tarea.checklist ?? [])].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  const ahora = casillas.filter((c) => c.texto.trim());
  const ids = new Set(ahora.map((c) => c.id).filter((id): id is string => !!id));
  let ultima: Tarea | undefined;

  async function pedir(ruta: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
    const res = await apiFetch(ruta, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };
    if (!res.ok) return data.error || 'No se pudo guardar una casilla';
    if (data.tarea) ultima = data.tarea;
    return null;
  }

  for (const item of antes) {
    if (ids.has(item.id)) continue;
    const error = await pedir(`${base}/${encodeURIComponent(item.id)}`, 'DELETE');
    if (error) return { error };
  }
  for (const casilla of ahora) {
    if (!casilla.id) {
      const error = await pedir(base, 'POST', { texto: casilla.texto.trim() });
      if (error) return { error };
      continue;
    }
    const previa = antes.find((item) => item.id === casilla.id);
    if (!previa || previa.texto === casilla.texto.trim()) continue;
    const error = await pedir(`${base}/${encodeURIComponent(casilla.id)}`, 'PATCH', {
      texto: casilla.texto.trim(),
    });
    if (error) return { error };
  }
  return { tarea: ultima };
}

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
      casillas: [],
      responsable_id: responsablePorDefecto ?? '',
      participantes_ids: [],
      fecha_limite: (fechaPorDefecto ?? '').trim(),
      repetir: 'ninguna',
      dias_semana: [diaSemanaDeFecha((fechaPorDefecto ?? '').trim())],
      dias_mes: [diaMesDeFecha((fechaPorDefecto ?? '').trim())],
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
        casillas: casillasDesdeTarea(tarea),
        responsable_id: tarea.responsable_id ?? '',
        participantes_ids: (tarea.participantes_ids ?? []).filter((id) => id !== (tarea.responsable_id ?? '')),
        fecha_limite: tarea.fecha_limite ?? '',
        repetir: 'ninguna',
        dias_semana: [1],
        dias_mes: [1],
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

  const opcionesParticipantes = useMemo(
    () => opcionesResponsable.filter((o) => o.id !== datos.responsable_id.trim()),
    [opcionesResponsable, datos.responsable_id],
  );

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
        const participantes = datos.participantes_ids.filter((id) => id !== (tarea.responsable_id ?? ''));
        const anteriores = (tarea.participantes_ids ?? []).filter((id) => id !== (tarea.responsable_id ?? ''));
        if ([...participantes].sort().join('\0') !== [...anteriores].sort().join('\0')) {
          cuerpo.participantes_ids = participantes;
        }
        const hiPrev = (tarea.hora_inicio ?? '').trim();
        const hfPrev = (tarea.hora_fin ?? '').trim();
        if (hi !== hiPrev || hf !== hfPrev) {
          // Vacío al editar = quitar el tramo (el API acepta cadena vacía).
          cuerpo.hora_inicio = hi;
          cuerpo.hora_fin = hf;
        }
        const casillasCambiaron = !casillasIguales(tarea, datos.casillas);
        if (Object.keys(cuerpo).length === 0 && !casillasCambiaron) {
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
        const participantes = datos.participantes_ids.filter((id) => id !== datos.responsable_id.trim());
        if (participantes.length > 0) cuerpo.participantes_ids = participantes;
        const casillas = textosCasilla(datos.casillas);
        if (casillas.length > 0) cuerpo.checklist = casillas;
        if (hi && hf) {
          cuerpo.hora_inicio = hi;
          cuerpo.hora_fin = hf;
        }
        if (proyectoId) cuerpo.proyecto_id = proyectoId;
        if (tareaPadreId) cuerpo.tarea_padre_id = tareaPadreId;
        if (!tareaPadreId && datos.repetir && datos.repetir !== 'ninguna') {
          cuerpo.recurrencia = {
            frecuencia: datos.repetir,
            ...(datos.repetir === 'semanal' ? { dias_semana: datos.dias_semana } : {}),
            ...(datos.repetir === 'mensual' ? { dias_mes: datos.dias_mes } : {}),
          };
        }
      }

      let tareaGuardada: Tarea | undefined;
      let avisoCalendario: string | undefined;
      const hayCampos = Object.keys(cuerpo).length > 0;
      if (hayCampos) {
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
        tareaGuardada = data.tarea;
        if (data.calendario_sincronizado === false) {
          avisoCalendario =
            data.calendario_error?.trim() ||
            'La tarea se guardó, pero no se pudo sincronizar con Google Calendar.';
        }
      }
      if (modo === 'editar' && tarea && !casillasIguales(tarea, datos.casillas)) {
        const sync = await sincronizarCasillas(tarea.id_tarea, tarea, datos.casillas);
        if (sync.error) {
          setError(sync.error);
          return;
        }
        if (sync.tarea) tareaGuardada = sync.tarea;
      }
      if (!tareaGuardada) {
        onCerrar();
        return;
      }
      onGuardada(tareaGuardada, avisoCalendario ? { avisoCalendario } : undefined);
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
                  <View style={styles.casillasCabecera}>
                    <Text style={form.label}>Casillas</Text>
                    <TouchableOpacity
                      style={styles.casillaAnadir}
                      onPress={() =>
                        setDatos((p) => {
                          if (p.casillas.length >= MAX_CHECKLIST) return p;
                          return { ...p, casillas: [...p.casillas, { clave: claveCasilla(), texto: '' }] };
                        })
                      }
                      disabled={guardando || datos.casillas.length >= MAX_CHECKLIST}
                    >
                      <MaterialIcons name="add-box" size={16} color="#0ea5e9" />
                      <Text style={styles.casillaAnadirTexto}>Añadir casilla</Text>
                    </TouchableOpacity>
                  </View>
                  {datos.casillas.map((casilla) => (
                    <View key={casilla.clave} style={styles.casillaFila}>
                      <MaterialIcons name="check-box-outline-blank" size={18} color="#94a3b8" />
                      <TextInput
                        style={[form.input, styles.casillaInput]}
                        value={casilla.texto}
                        onChangeText={(texto) =>
                          setDatos((p) => ({
                            ...p,
                            casillas: p.casillas.map((c) => (c.clave === casilla.clave ? { ...c, texto } : c)),
                          }))
                        }
                        placeholder="Paso a seguir"
                        placeholderTextColor="#94a3b8"
                        editable={!guardando}
                      />
                      <TouchableOpacity
                        onPress={() =>
                          setDatos((p) => ({
                            ...p,
                            casillas: p.casillas.filter((c) => c.clave !== casilla.clave),
                          }))
                        }
                        disabled={guardando}
                        accessibilityLabel="Quitar casilla"
                      >
                        <MaterialIcons name="close" size={18} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>
                  ))}
                  {datos.casillas.length > 0 ? (
                    <Text style={form.help}>
                      Al marcarlas en la tarea verás el avance, por ejemplo 2/5.
                    </Text>
                  ) : null}
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
                          onSeleccionar={(id) =>
                            setDatos((p) => ({
                              ...p,
                              responsable_id: id,
                              participantes_ids: p.participantes_ids.filter((x) => x !== id),
                            }))
                          }
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

                <View style={form.group}>
                  <Text style={form.label}>También en la agenda de</Text>
                  <CampoMenciones
                    opciones={opcionesParticipantes}
                    valorIds={datos.participantes_ids}
                    onChange={(ids) => setDatos((p) => ({ ...p, participantes_ids: ids }))}
                    nombreDe={(id) => usuarios.nombrePorId(id)}
                    loading={usuarios.cargando}
                    disabled={guardando || usuarios.noDisponibles}
                  />
                  <Text style={form.help}>
                    Escribe un nombre y elige a la persona. Verá la misma tarea en su calendario.
                    El responsable sigue siendo una sola persona.
                  </Text>
                </View>

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <Text style={form.label}>Fecha límite *</Text>
                    <InputFecha
                      compact
                      valueIso={datos.fecha_limite}
                      onChangeIso={(iso) =>
                        setDatos((p) => ({
                          ...p,
                          fecha_limite: iso,
                          dias_semana: p.repetir === 'semanal' ? p.dias_semana : [diaSemanaDeFecha(iso)],
                          dias_mes: p.repetir === 'mensual' ? p.dias_mes : [diaMesDeFecha(iso)],
                        }))
                      }
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

                {modo === 'crear' && !tareaPadreId ? (
                  <SelectorRepeticion
                    frecuencia={datos.repetir}
                    diasSemana={datos.dias_semana}
                    diasMes={datos.dias_mes}
                    disabled={guardando}
                    onCambiarFrecuencia={(frecuencia) =>
                      setDatos((p) => ({
                        ...p,
                        repetir: frecuencia,
                        dias_semana:
                          frecuencia === 'semanal' && p.dias_semana.length === 0
                            ? [diaSemanaDeFecha(p.fecha_limite)]
                            : p.dias_semana,
                        dias_mes:
                          frecuencia === 'mensual' && p.dias_mes.length === 0
                            ? [diaMesDeFecha(p.fecha_limite)]
                            : p.dias_mes,
                      }))
                    }
                    onCambiarDiasSemana={(dias) => setDatos((p) => ({ ...p, dias_semana: dias }))}
                    onCambiarDiasMes={(dias) => setDatos((p) => ({ ...p, dias_mes: dias }))}
                  />
                ) : null}

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
  casillasCabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  casillaAnadir: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 },
  casillaAnadirTexto: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  casillaFila: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  casillaInput: { flex: 1 },
  soloLectura: { fontSize: 13, fontWeight: '600', color: '#334155', paddingVertical: 4 },
  colHora: { flexGrow: 0, flexShrink: 0, alignSelf: 'flex-start' },
  overlayFlotante: { backgroundColor: 'rgba(15, 23, 42, 0.12)' },
  cuerpoFlotante: { maxHeight: 420 },
});
