/**
 * Convocar o editar una reunión (Fase 1B).
 *
 * El orden del día se bloquea en cliente según D-20; si el servidor responde
 * `409`, se enseña el mensaje. Tras crear, si Calendar no sincronizó (D-21),
 * `onGuardado` recibe el aviso para que la ficha o el listado lo muestren.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { SelectorDesplegableMulti } from '../SelectorDesplegableMulti';
import { InputHora } from './InputHora';
import {
  autoNumerarOrdenDelDiaAlEnter,
  ETIQUETA_ESTADO_REUNION,
  ETIQUETA_VISIBILIDAD_REUNION,
  hoyIso,
  numerarOrdenDelDia,
  ordenDelDiaEditable,
} from '../../lib/tasksUi';
import {
  ESTADOS_REUNION,
  VISIBILIDADES_REUNION,
  type AsistenteReunion,
  type EstadoReunion,
  type Reunion,
  type VisibilidadReunion,
} from '../../types/tasks';
import { estilosFormTasks as form, estilosModalTasks as modal } from './estilosTasks';
import type { NombresUsuarios } from '../../hooks/useNombresUsuarios';
import type { MaestroDepartamentos } from '../../hooks/useDepartamentos';

const SIN_VALOR = '';

type LocalOpcion = { id: string; nombre: string };

type FormReunion = {
  titulo: string;
  fecha: string;
  hora_inicio: string;
  hora_fin: string;
  estado: EstadoReunion;
  visibilidad: VisibilidadReunion;
  departamento_id: string;
  local_id: string;
  local_nombre: string;
  proyecto_id: string;
  serie_id: string;
  orden_del_dia: string;
  resumen: string;
  asistente_ids: string[];
};

export type ResultadoGuardadoReunion = {
  reunion: Reunion;
  calendarioSincronizado: boolean | null;
  avisoCalendario?: string;
};

const INICIAL: FormReunion = {
  titulo: '',
  fecha: '',
  hora_inicio: '',
  hora_fin: '',
  estado: 'convocada',
  visibilidad: 'empresa',
  departamento_id: '',
  local_id: '',
  local_nombre: '',
  proyecto_id: '',
  serie_id: '',
  orden_del_dia: '',
  resumen: '',
  asistente_ids: [],
};

function horaValida(valor: string): boolean {
  const t = valor.trim();
  if (!t) return true;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(t);
}

/** GET sugerencia-orden-del-dia. Devuelve texto limpio o null si no hay. */
async function fetchSugerenciaOrden(idReunion: string): Promise<{
  texto: string | null;
  errorHttp?: string;
}> {
  const res = await apiFetch(
    `/api/reuniones/${encodeURIComponent(idReunion)}/sugerencia-orden-del-dia`,
  );
  const data = (await res.json().catch(() => ({}))) as {
    texto?: string;
    sugerencia?: string;
    orden_del_dia?: string;
    error?: string;
  };
  if (!res.ok) {
    return {
      texto: null,
      errorHttp: data.error || 'No se pudo obtener la sugerencia de orden del día',
    };
  }
  const texto = (data.texto ?? data.sugerencia ?? data.orden_del_dia ?? '').trim();
  return { texto: texto || null };
}

export function ModalFormularioReunion({
  visible,
  modo,
  reunion,
  asistentesIniciales,
  proyectoId,
  usuarios,
  departamentos,
  onCerrar,
  onGuardado,
}: {
  visible: boolean;
  modo: 'crear' | 'editar';
  reunion?: Reunion | null;
  asistentesIniciales?: AsistenteReunion[];
  /** Si viene de la ficha de un proyecto, fija `proyecto_id` y oculta el campo libre. */
  proyectoId?: string;
  usuarios: NombresUsuarios;
  departamentos: MaestroDepartamentos;
  onCerrar: () => void;
  onGuardado: (resultado: ResultadoGuardadoReunion) => void;
}) {
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const [datos, setDatos] = useState<FormReunion>(INICIAL);
  const [locales, setLocales] = useState<LocalOpcion[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [sugiriendo, setSugiriendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Evita re-disparar la auto-sugerencia en la misma apertura (id + visible). */
  const autoSugeridoKeyRef = useRef<string | null>(null);
  /** Solo hidratar al abrir; no en cada refresh de `reunion` con el modal abierto. */
  const estabaVisibleRef = useRef(false);

  const proyectoFijo = (proyectoId ?? '').trim();

  const ordenBloqueado =
    modo === 'editar' && reunion != null && !ordenDelDiaEditable(reunion.estado);

  useEffect(() => {
    if (!visible) {
      autoSugeridoKeyRef.current = null;
      estabaVisibleRef.current = false;
      return;
    }

    const acabaDeAbrir = !estabaVisibleRef.current;
    estabaVisibleRef.current = true;
    if (!acabaDeAbrir) return;

    setError(null);
    if (modo === 'editar' && reunion) {
      setDatos({
        titulo: reunion.titulo ?? '',
        fecha: reunion.fecha ?? '',
        hora_inicio: reunion.hora_inicio ?? '',
        hora_fin: reunion.hora_fin ?? '',
        estado: reunion.estado ?? 'convocada',
        visibilidad: reunion.visibilidad ?? 'empresa',
        departamento_id: reunion.departamento_id ?? '',
        local_id: reunion.local_id ?? '',
        local_nombre: reunion.local_nombre ?? '',
        proyecto_id: reunion.proyecto_id ?? '',
        serie_id: reunion.serie_id ?? '',
        orden_del_dia: reunion.orden_del_dia ?? '',
        resumen: reunion.resumen ?? '',
        asistente_ids: (asistentesIniciales ?? [])
          .map((a) => (a.usuario_id ?? '').trim())
          .filter(Boolean),
      });
    } else {
      setDatos({
        ...INICIAL,
        fecha: hoyIso(),
        proyecto_id: proyectoFijo || '',
      });
    }
  }, [visible, modo, reunion, asistentesIniciales, proyectoFijo]);

  useEffect(() => {
    if (!visible) return;
    let cancelado = false;
    apiFetch('/api/locales')
      .then((r) => r.json())
      .then((data: { locales?: { id_Locales?: string; nombre?: string }[] }) => {
        if (cancelado) return;
        const lista = Array.isArray(data.locales) ? data.locales : [];
        setLocales(
          lista
            .map((l) => ({
              id: l.id_Locales != null ? String(l.id_Locales).trim() : '',
              nombre: (l.nombre ?? '').trim(),
            }))
            .filter((l) => l.id && l.nombre),
        );
      })
      .catch((e) => {
        if (!cancelado) console.error('[reuniones] no se pudieron cargar los locales', e);
      });
    return () => {
      cancelado = true;
    };
  }, [visible]);

  const opcionesEstado = useMemo<OpcionDesplegable[]>(
    () => ESTADOS_REUNION.map((e) => ({ id: e, titulo: ETIQUETA_ESTADO_REUNION[e] })),
    [],
  );

  const opcionesDepartamento = useMemo<OpcionDesplegable[]>(
    () => [{ id: SIN_VALOR, titulo: '(sin departamento)' }, ...departamentos.opciones],
    [departamentos.opciones],
  );

  const opcionesLocal = useMemo<OpcionDesplegable[]>(() => {
    const lista: OpcionDesplegable[] = [
      { id: SIN_VALOR, titulo: '(sin local)' },
      ...locales.map((l) => ({ id: l.id, titulo: l.nombre, icono: 'store' as const })),
    ];
    const actual = datos.local_id.trim();
    if (actual && !lista.some((o) => o.id === actual)) {
      lista.push({
        id: actual,
        titulo: datos.local_nombre.trim() || 'Local no disponible',
        icono: 'store',
      });
    }
    return lista;
  }, [locales, datos.local_id, datos.local_nombre]);

  function setCampo<K extends keyof FormReunion>(clave: K, valor: FormReunion[K]) {
    setDatos((prev) => ({ ...prev, [clave]: valor }));
  }

  async function sugerirOrden() {
    if (!reunion?.id_reunion || !datos.serie_id.trim()) return;
    setSugiriendo(true);
    setError(null);
    try {
      const { texto, errorHttp } = await fetchSugerenciaOrden(reunion.id_reunion);
      if (errorHttp) {
        setError(errorHttp);
        return;
      }
      if (!texto) {
        setError('No hay sugerencia disponible para esta serie');
        return;
      }
      setCampo('orden_del_dia', texto);
    } catch (e) {
      console.error('[reuniones] fallo al sugerir orden del día', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setSugiriendo(false);
    }
  }

  // Auto-sugerir orden del día al abrir en editar (serie + vacío + editable), una vez por apertura.
  useEffect(() => {
    if (!visible) {
      autoSugeridoKeyRef.current = null;
      return;
    }
    if (modo !== 'editar' || !reunion?.id_reunion) return;
    if (ordenBloqueado) return;
    if (!(reunion.serie_id ?? '').trim()) return;
    if ((reunion.orden_del_dia ?? '').trim()) return;

    const key = reunion.id_reunion;
    if (autoSugeridoKeyRef.current === key) return;

    let cancelado = false;
    setSugiriendo(true);
    fetchSugerenciaOrden(reunion.id_reunion)
      .then(({ texto }) => {
        if (cancelado || !texto) return;
        // No pisar si el usuario ya escribió mientras llegaba la respuesta.
        setDatos((prev) => {
          if (prev.orden_del_dia.trim()) return prev;
          return { ...prev, orden_del_dia: texto };
        });
      })
      .catch((e) => {
        if (!cancelado) {
          console.error('[reuniones] auto-sugerencia de orden del día omitida', e);
        }
      })
      .finally(() => {
        if (cancelado) return;
        // Una sola auto-sugerencia por id en esta apertura (también si no hubo texto).
        autoSugeridoKeyRef.current = key;
        setSugiriendo(false);
      });

    return () => {
      cancelado = true;
    };
  }, [
    visible,
    modo,
    reunion?.id_reunion,
    reunion?.serie_id,
    reunion?.orden_del_dia,
    ordenBloqueado,
  ]);

  async function guardarAsistentes(idReunion: string, ids: string[]): Promise<{
    calendarioSincronizado: boolean | null;
    avisoCalendario?: string;
  }> {
    const asistentes = ids.map((id) => {
      const u = usuarios.usuarios.find((x) => x.id === id);
      return {
        usuario_id: id,
        nombre: u?.nombre || usuarios.nombrePorId(id),
        email: u?.email,
      };
    });
    const res = await apiFetch(`/api/reuniones/${encodeURIComponent(idReunion)}/asistentes`, {
      method: 'POST',
      body: JSON.stringify({ asistentes }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      calendario_sincronizado?: boolean;
      calendario_error?: string | null;
    };
    if (!res.ok) {
      throw new Error(data.error || 'No se pudieron guardar los asistentes');
    }
    if (data.calendario_sincronizado === false) {
      return {
        calendarioSincronizado: false,
        avisoCalendario:
          data.calendario_error?.trim() ||
          'Los asistentes se guardaron, pero no se pudo actualizar las invitaciones de Google Calendar.',
      };
    }
    if (data.calendario_sincronizado === true) {
      return { calendarioSincronizado: true };
    }
    return { calendarioSincronizado: null };
  }

  async function guardar() {
    const titulo = datos.titulo.trim().replace(/\s+/g, ' ');
    if (!titulo) {
      setError('El título de la reunión es obligatorio');
      return;
    }
    if (!datos.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha)) {
      setError('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    if (!horaValida(datos.hora_inicio) || !horaValida(datos.hora_fin)) {
      setError('Las horas deben tener formato HH:mm');
      return;
    }
    if (datos.visibilidad === 'departamento' && !datos.departamento_id.trim()) {
      setError('Elige un departamento para la visibilidad de departamento');
      return;
    }
    if (datos.visibilidad === 'local' && !datos.local_id.trim()) {
      setError('Elige un local para la visibilidad de local');
      return;
    }

    const cuerpo: Record<string, unknown> = {
      titulo,
      fecha: datos.fecha,
      hora_inicio: datos.hora_inicio.trim() || undefined,
      hora_fin: datos.hora_fin.trim() || undefined,
      estado: datos.estado,
      visibilidad: datos.visibilidad,
      departamento_id: datos.departamento_id.trim() || null,
      local_id: datos.local_id.trim() || null,
      local_nombre: datos.local_nombre.trim() || null,
      proyecto_id: (proyectoFijo || datos.proyecto_id.trim()) || null,
      serie_id: datos.serie_id.trim() || null,
      resumen: datos.resumen.trim() || null,
    };
    if (!ordenBloqueado) {
      cuerpo.orden_del_dia = datos.orden_del_dia;
    }

    setGuardando(true);
    setError(null);
    try {
      let reunionGuardada: Reunion | null = null;
      let calendarioSincronizado: boolean | null = null;
      let avisoCalendario: string | undefined;

      if (modo === 'crear') {
        const res = await apiFetch('/api/reuniones', {
          method: 'POST',
          body: JSON.stringify(cuerpo),
        });
        const data = (await res.json().catch(() => ({}))) as {
          reunion?: Reunion;
          calendario_sincronizado?: boolean;
          calendar_sincronizado?: boolean;
          aviso?: string;
          error?: string;
          mensaje?: string;
        };
        if (!res.ok || !data.reunion) {
          setError(data.error || data.mensaje || 'No se pudo convocar la reunión');
          return;
        }
        reunionGuardada = data.reunion;
        if (typeof data.calendario_sincronizado === 'boolean') {
          calendarioSincronizado = data.calendario_sincronizado;
        } else if (typeof data.calendar_sincronizado === 'boolean') {
          calendarioSincronizado = data.calendar_sincronizado;
        } else if (!(reunionGuardada.calendar_event_id ?? '').trim()) {
          calendarioSincronizado = false;
        } else {
          calendarioSincronizado = true;
        }
        if (calendarioSincronizado === false) {
          avisoCalendario =
            data.aviso ||
            data.mensaje ||
            'La reunión se guardó, pero no se pudo crear el evento en Google Calendar.';
        }
      } else if (reunion) {
        const res = await apiFetch(`/api/reuniones/${encodeURIComponent(reunion.id_reunion)}`, {
          method: 'PATCH',
          body: JSON.stringify(cuerpo),
        });
        const data = (await res.json().catch(() => ({}))) as {
          reunion?: Reunion;
          calendario_sincronizado?: boolean;
          aviso?: string;
          error?: string;
          mensaje?: string;
        };
        if (!res.ok) {
          setError(data.error || data.mensaje || 'No se pudo guardar la reunión');
          return;
        }
        reunionGuardada = data.reunion ?? { ...reunion, ...cuerpo, id_reunion: reunion.id_reunion } as Reunion;
        if (typeof data.calendario_sincronizado === 'boolean') {
          calendarioSincronizado = data.calendario_sincronizado;
          if (!data.calendario_sincronizado) {
            avisoCalendario =
              data.aviso ||
              data.mensaje ||
              'Los cambios se guardaron, pero no se pudo actualizar el evento en Calendar.';
          }
        }
      }

      if (!reunionGuardada) {
        setError('No se recibió la reunión guardada');
        return;
      }

      // Solo tocamos asistentes si conocemos la lista (alta, o edición desde ficha).
      // Editar desde el listado no trae asistentes: no los pisamos con [].
      // Sin ids no llamamos al API: POST /asistentes exige al menos uno (400).
      // En edición, vaciar la lista tampoco se sincroniza (mismo límite del contrato).
      if (
        (modo === 'crear' || asistentesIniciales != null) &&
        datos.asistente_ids.length > 0
      ) {
        try {
          const syncAsist = await guardarAsistentes(
            reunionGuardada.id_reunion,
            datos.asistente_ids,
          );
          if (syncAsist.calendarioSincronizado === false) {
            calendarioSincronizado = false;
            avisoCalendario = syncAsist.avisoCalendario || avisoCalendario;
          } else if (syncAsist.calendarioSincronizado === true && calendarioSincronizado !== false) {
            calendarioSincronizado = true;
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : 'No se pudieron guardar los asistentes');
          onGuardado({
            reunion: reunionGuardada,
            calendarioSincronizado,
            avisoCalendario,
          });
          return;
        }
      }

      onGuardado({
        reunion: reunionGuardada,
        calendarioSincronizado,
        avisoCalendario,
      });
    } catch (e) {
      console.error('[reuniones] fallo al guardar la reunión', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={modal.overlay} onPress={() => !guardando && onCerrar()}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={modal.center}
        >
          <Pressable
            style={[modal.cardWrap, (shouldStackPanels || isCompact) && modal.cardWrapAncho]}
          >
            <View style={modal.card}>
              <View style={modal.header}>
                <Text style={modal.title}>{modo === 'crear' ? 'Convocar reunión' : 'Editar reunión'}</Text>
                <TouchableOpacity style={modal.close} onPress={onCerrar} disabled={guardando}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>

              <ScrollView style={modal.body} keyboardShouldPersistTaps="handled">
                <View style={form.group}>
                  <Text style={form.label}>Título</Text>
                  <TextInput
                    style={form.input}
                    value={datos.titulo}
                    onChangeText={(t) => setCampo('titulo', t)}
                    placeholder="Comité de dirección, seguimiento…"
                    placeholderTextColor="#94a3b8"
                  />
                </View>

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <Text style={form.label}>Fecha</Text>
                    <InputFecha
                      compact
                      valueIso={datos.fecha}
                      onChangeIso={(iso) => setCampo('fecha', iso)}
                      style={estiloCampoFechaCompacto}
                    />
                  </View>
                  <View style={form.col}>
                    <Text style={form.label}>Estado</Text>
                    <SelectorDesplegable
                      compact
                      sinIconoTrigger
                      tituloLista="Estado"
                      valorId={datos.estado}
                      opciones={opcionesEstado}
                      onSeleccionar={(id) => setCampo('estado', id as EstadoReunion)}
                      disabled={guardando}
                    />
                  </View>
                </View>
                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <Text style={form.label}>Hora inicio</Text>
                    <InputHora
                      compact
                      value={datos.hora_inicio}
                      onChange={(hhmm) => setCampo('hora_inicio', hhmm)}
                      editable={!guardando}
                    />
                  </View>
                  <View style={form.col}>
                    <Text style={form.label}>Hora fin</Text>
                    <InputHora
                      compact
                      value={datos.hora_fin}
                      onChange={(hhmm) => setCampo('hora_fin', hhmm)}
                      editable={!guardando}
                    />
                  </View>
                </View>

                <View style={form.group}>
                  <Text style={form.label}>Visibilidad</Text>
                  <View style={form.chipsRow}>
                    {VISIBILIDADES_REUNION.map((v) => {
                      const activo = datos.visibilidad === v;
                      return (
                        <TouchableOpacity
                          key={v}
                          style={[form.chip, isCompact && form.chipTactil, activo && form.chipActivo]}
                          onPress={() => setCampo('visibilidad', v)}
                        >
                          <Text style={[form.chipTexto, activo && form.chipTextoActivo]}>
                            {ETIQUETA_VISIBILIDAD_REUNION[v]}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                {datos.visibilidad === 'departamento' ? (
                  <View style={form.group}>
                    <Text style={form.label}>Departamento</Text>
                    <SelectorDesplegable
                      sinIconoTrigger
                      tituloLista="Departamento"
                      valorId={datos.departamento_id}
                      opciones={opcionesDepartamento}
                      loading={departamentos.cargando}
                      onSeleccionar={(id) => setCampo('departamento_id', id)}
                    />
                  </View>
                ) : null}

                {datos.visibilidad === 'local' ? (
                  <View style={form.group}>
                    <Text style={form.label}>Local</Text>
                    <SelectorDesplegable
                      sinIconoTrigger
                      tituloLista="Local"
                      valorId={datos.local_id}
                      opciones={opcionesLocal}
                      onSeleccionar={(id) => {
                        const local = locales.find((l) => l.id === id);
                        setDatos((prev) => ({
                          ...prev,
                          local_id: id,
                          local_nombre: local?.nombre ?? prev.local_nombre,
                        }));
                      }}
                    />
                  </View>
                ) : null}

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <Text style={form.label}>Asistentes</Text>
                    <SelectorDesplegableMulti
                      compact
                      buscador
                      placeholder="Seleccionar asistentes…"
                      tituloLista="Asistentes"
                      iconoLista="groups"
                      opciones={usuarios.opciones}
                      valorIds={datos.asistente_ids}
                      onChange={(ids) => setCampo('asistente_ids', ids)}
                      loading={usuarios.cargando}
                      vacioTexto={
                        usuarios.noDisponibles
                          ? 'No se pudo cargar el listado de usuarios (hace falta usuarios.ver).'
                          : 'No hay usuarios disponibles.'
                      }
                    />
                  </View>
                  <View style={form.col}>
                    {!proyectoFijo ? (
                      <View style={form.group}>
                        <Text style={form.label}>Proyecto (opcional)</Text>
                        <TextInput
                          style={form.input}
                          value={datos.proyecto_id}
                          onChangeText={(t) => setCampo('proyecto_id', t)}
                          placeholder="id_proyecto"
                          placeholderTextColor="#94a3b8"
                          autoCapitalize="none"
                        />
                      </View>
                    ) : null}
                    <View>
                      <Text style={form.label}>Serie (opcional)</Text>
                      <TextInput
                        style={form.input}
                        value={datos.serie_id}
                        onChangeText={(t) => setCampo('serie_id', t)}
                        placeholder="id de serie"
                        placeholderTextColor="#94a3b8"
                        autoCapitalize="none"
                      />
                    </View>
                  </View>
                </View>

                <View style={[form.group, form.gridDos, shouldStackPanels && form.gridDosApilado]}>
                  <View style={form.col}>
                    <View style={form.groupRow}>
                      <Text style={form.label}>Orden del día</Text>
                      {!ordenBloqueado ? (
                        <View style={styles.accionesOrden}>
                          <TouchableOpacity
                            style={[
                              styles.btnSugerir,
                              (guardando || !datos.orden_del_dia.trim()) && styles.btnSugerirDisabled,
                            ]}
                            onPress={() =>
                              setCampo('orden_del_dia', numerarOrdenDelDia(datos.orden_del_dia))
                            }
                            disabled={guardando || !datos.orden_del_dia.trim()}
                          >
                            <MaterialIcons
                              name="format-list-numbered"
                              size={14}
                              color={
                                guardando || !datos.orden_del_dia.trim() ? '#94a3b8' : '#0ea5e9'
                              }
                            />
                            <Text
                              style={[
                                styles.btnSugerirTexto,
                                (guardando || !datos.orden_del_dia.trim()) &&
                                  styles.btnSugerirTextoDisabled,
                              ]}
                            >
                              Numerar
                            </Text>
                          </TouchableOpacity>
                          {modo === 'editar' && datos.serie_id.trim() ? (
                            <TouchableOpacity
                              style={styles.btnSugerir}
                              onPress={() => void sugerirOrden()}
                              disabled={sugiriendo || guardando}
                            >
                              {sugiriendo ? (
                                <ActivityIndicator size="small" color="#0ea5e9" />
                              ) : (
                                <>
                                  <MaterialIcons name="auto-awesome" size={14} color="#0ea5e9" />
                                  <Text style={styles.btnSugerirTexto}>Sugerir</Text>
                                </>
                              )}
                            </TouchableOpacity>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                    <TextInput
                      style={[form.input, form.inputMultilineaLarga]}
                      value={datos.orden_del_dia}
                      onChangeText={(t) =>
                        setCampo(
                          'orden_del_dia',
                          ordenBloqueado
                            ? t
                            : autoNumerarOrdenDelDiaAlEnter(datos.orden_del_dia, t),
                        )
                      }
                      placeholder="Temas a tratar…"
                      placeholderTextColor="#94a3b8"
                      multiline
                      numberOfLines={6}
                      editable={!ordenBloqueado}
                    />
                    {ordenBloqueado ? (
                      <View style={form.aviso}>
                        <MaterialIcons name="lock-outline" size={14} color="#d97706" />
                        <Text style={form.avisoTexto}>
                          El orden del día ya no se puede editar: la reunión ha pasado a celebrada o
                          tiene acta.
                        </Text>
                      </View>
                    ) : (
                      <Text style={form.help}>
                        Texto libre. Usa «Numerar» para listar puntos; al pulsar Enter tras un
                        punto numerado se sugiere el siguiente. Si hay serie, puedes pedir una
                        sugerencia con pendientes de la anterior.
                      </Text>
                    )}
                  </View>
                  {modo === 'editar' ? (
                    <View style={form.col}>
                      <Text style={form.label}>Resumen / acta (manual)</Text>
                      <TextInput
                        style={[form.input, form.inputMultilineaLarga]}
                        value={datos.resumen}
                        onChangeText={(t) => setCampo('resumen', t)}
                        placeholder="Acta escrita a mano…"
                        placeholderTextColor="#94a3b8"
                        multiline
                        numberOfLines={6}
                      />
                    </View>
                  ) : null}
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
                  onPress={() => void guardar()}
                  disabled={guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={modal.btnTextPrimario}>
                      {modo === 'crear' ? 'Convocar' : 'Guardar'}
                    </Text>
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
  accionesOrden: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  btnSugerir: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    marginBottom: 4,
  },
  btnSugerirDisabled: {
    opacity: 0.55,
  },
  btnSugerirTexto: { fontSize: 11, fontWeight: '600', color: '#0ea5e9' },
  btnSugerirTextoDisabled: { color: '#94a3b8' },
});
