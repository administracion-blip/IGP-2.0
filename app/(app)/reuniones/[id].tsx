/**
 * Ficha de una reunión (Fase 1B): datos, asistentes, orden del día, acta manual,
 * acuerdos, aviso de grabación y tareas salidas.
 *
 * Acciones de escritura: `permisos_fila` si llega; si no, `reuniones.gestionar`
 * (TODO: quitar fallback cuando el backend lo mande siempre).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import { useActividadTasks } from '../../hooks/useActividadTasks';
import { puedeGestionarReuniones, puedeVerReuniones } from '../../lib/tasksAcceso';
import {
  ETIQUETA_ESTADO_ACUERDO,
  ETIQUETA_MODALIDAD_REUNION,
  ETIQUETA_VISIBILIDAD_REUNION,
  nombreUsuario,
  ordenDelDiaEditable,
} from '../../lib/tasksUi';
import { SeccionFicha } from '../../components/tasks/SeccionFicha';
import { BadgeEstadoAcuerdo, BadgeEstadoReunion } from '../../components/tasks/BadgesTasks';
import {
  ModalFormularioReunion,
  type ResultadoGuardadoReunion,
} from '../../components/tasks/ModalFormularioReunion';
import { TarjetaTarea } from '../../components/tasks/TarjetaTarea';
import { HistorialActividad } from '../../components/tasks/HistorialActividad';
import { estilosFormTasks as form, estilosModalTasks as modal } from '../../components/tasks/estilosTasks';
import { InputFecha } from '../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../components/RangoFechas';
import { SelectorDesplegable, type OpcionDesplegable } from '../../components/SelectorDesplegable';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';
import {
  ESTADOS_ACUERDO,
  type AcuerdoReunion,
  type AsistenteReunion,
  type EstadoAcuerdo,
  type Reunion,
  type Tarea,
} from '../../types/tasks';

type ReunionFicha = Reunion & {
  asistentes?: AsistenteReunion[];
  acuerdos?: AcuerdoReunion[];
};

function puedeEditarReunion(reunion: Reunion | null, puedeGestionar: boolean): boolean {
  if (!reunion) return false;
  if (reunion.permisos_fila) return reunion.permisos_fila.editar === true;
  return puedeGestionar;
}

export default function FichaReunionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idReunion = Array.isArray(params.id) ? params.id[0] : params.id ?? '';

  const acceso = useAccesoTasks();
  const { isCompact, shouldStackPanels } = useBreakpoint();
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();
  const actividad = useActividadTasks(
    idReunion ? `/api/reuniones/${encodeURIComponent(idReunion)}/actividad` : null,
  );

  const [reunion, setReunion] = useState<ReunionFicha | null>(null);
  const [asistentes, setAsistentes] = useState<AsistenteReunion[]>([]);
  const [acuerdos, setAcuerdos] = useState<AcuerdoReunion[]>([]);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noDisponible, setNoDisponible] = useState(false);
  const [avisoCalendario, setAvisoCalendario] = useState<string | null>(null);

  const [cargandoTareas, setCargandoTareas] = useState(false);
  const [errorTareas, setErrorTareas] = useState<string | null>(null);

  const [editarVisible, setEditarVisible] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const [acuerdoFormVisible, setAcuerdoFormVisible] = useState(false);
  const [acuerdoTexto, setAcuerdoTexto] = useState('');
  const [acuerdoResponsable, setAcuerdoResponsable] = useState('');
  const [acuerdoFecha, setAcuerdoFecha] = useState('');
  const [errorAcuerdo, setErrorAcuerdo] = useState<string | null>(null);

  const [avisoFormVisible, setAvisoFormVisible] = useState(false);
  const [avisoInformados, setAvisoInformados] = useState<string[]>([]);
  const [errorAviso, setErrorAviso] = useState<string | null>(null);
  const [msgAccion, setMsgAccion] = useState<string | null>(null);

  const puedeVer = puedeVerReuniones(acceso);
  const puedeGestionar = puedeGestionarReuniones(acceso);
  const puedeEditar = puedeEditarReunion(reunion, puedeGestionar);
  const ordenEditable = ordenDelDiaEditable(reunion?.estado);

  const cargarFicha = useCallback(async () => {
    if (!idReunion || !puedeVer) return;
    setCargando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/reuniones/${encodeURIComponent(idReunion)}`);
      const data = (await res.json().catch(() => ({}))) as {
        reunion?: ReunionFicha;
        asistentes?: AsistenteReunion[];
        acuerdos?: AcuerdoReunion[];
        error?: string;
      };
      if (res.status === 404) {
        setNoDisponible(true);
        return;
      }
      if (!res.ok || !data.reunion) {
        setError(data.error || 'No se pudo cargar la reunión');
        return;
      }
      setReunion(data.reunion);
      setAsistentes(
        Array.isArray(data.asistentes)
          ? data.asistentes
          : Array.isArray(data.reunion.asistentes)
            ? data.reunion.asistentes
            : [],
      );
      setAcuerdos(
        Array.isArray(data.acuerdos)
          ? data.acuerdos
          : Array.isArray(data.reunion.acuerdos)
            ? data.reunion.acuerdos
            : [],
      );
      if (!(data.reunion.calendar_event_id ?? '').trim()) {
        setAvisoCalendario(
          'Esta reunión no tiene evento en Google Calendar (no se sincronizó al convocar o Calendar no está configurado).',
        );
      } else {
        setAvisoCalendario(null);
      }
    } catch (e) {
      console.error('[reuniones] fallo al leer la ficha', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setCargando(false);
    }
  }, [idReunion, puedeVer]);

  const cargarTareas = useCallback(async () => {
    if (!idReunion || !puedeVer) return;
    setCargandoTareas(true);
    setErrorTareas(null);
    try {
      const res = await apiFetch(`/api/reuniones/${encodeURIComponent(idReunion)}/tareas`);
      const data = (await res.json().catch(() => ({}))) as {
        tareas?: Tarea[];
        items?: Tarea[];
        error?: string;
      };
      if (!res.ok) {
        setErrorTareas(data.error || 'No se pudieron cargar las tareas de la reunión');
        return;
      }
      setTareas(Array.isArray(data.tareas) ? data.tareas : Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      console.error('[reuniones] fallo al listar tareas de la reunión', e);
      setErrorTareas(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setCargandoTareas(false);
    }
  }, [idReunion, puedeVer]);

  useEffect(() => {
    void cargarFicha();
  }, [cargarFicha]);

  useEffect(() => {
    void cargarTareas();
  }, [cargarTareas]);

  const opcionesResponsable = useMemo<OpcionDesplegable[]>(() => {
    const lista: OpcionDesplegable[] = [{ id: '', titulo: '(sin responsable)' }, ...usuarios.opciones];
    if (acuerdoResponsable && !lista.some((o) => o.id === acuerdoResponsable)) {
      lista.push({
        id: acuerdoResponsable,
        titulo: usuarios.nombrePorId(acuerdoResponsable),
        icono: 'person',
      });
    }
    return lista;
  }, [usuarios, acuerdoResponsable]);

  const acuerdosAbiertos = useMemo(
    () => acuerdos.filter((a) => a.estado === 'abierto' && !(a.tarea_id ?? '').trim()),
    [acuerdos],
  );

  async function crearAcuerdo() {
    const texto = acuerdoTexto.trim();
    if (!texto) {
      setErrorAcuerdo('El texto del acuerdo es obligatorio');
      return;
    }
    if (acuerdoFecha && !/^\d{4}-\d{2}-\d{2}$/.test(acuerdoFecha)) {
      setErrorAcuerdo('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    setGuardando(true);
    setErrorAcuerdo(null);
    try {
      const res = await apiFetch(`/api/reuniones/${encodeURIComponent(idReunion)}/acuerdos`, {
        method: 'POST',
        body: JSON.stringify({
          texto,
          responsable_id: acuerdoResponsable.trim() || null,
          fecha_limite: acuerdoFecha.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        acuerdo?: AcuerdoReunion;
        error?: string;
      };
      if (!res.ok) {
        setErrorAcuerdo(data.error || 'No se pudo crear el acuerdo');
        return;
      }
      setAcuerdoFormVisible(false);
      setAcuerdoTexto('');
      setAcuerdoResponsable('');
      setAcuerdoFecha('');
      if (data.acuerdo) setAcuerdos((prev) => [...prev, data.acuerdo as AcuerdoReunion]);
      else void cargarFicha();
    } catch (e) {
      setErrorAcuerdo(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarEstadoAcuerdo(acuerdo: AcuerdoReunion, estado: EstadoAcuerdo) {
    if (!puedeEditar) return;
    setGuardando(true);
    setMsgAccion(null);
    try {
      const res = await apiFetch(
        `/api/reuniones/${encodeURIComponent(idReunion)}/acuerdos/${encodeURIComponent(acuerdo.id_acuerdo)}`,
        { method: 'PATCH', body: JSON.stringify({ estado }) },
      );
      const data = (await res.json().catch(() => ({}))) as {
        acuerdo?: AcuerdoReunion;
        error?: string;
      };
      if (!res.ok) {
        setMsgAccion(data.error || 'No se pudo actualizar el acuerdo');
        return;
      }
      setAcuerdos((prev) =>
        prev.map((a) =>
          a.id_acuerdo === acuerdo.id_acuerdo ? (data.acuerdo ?? { ...a, estado }) : a,
        ),
      );
    } catch (e) {
      setMsgAccion(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  async function crearTareasDesdeAcuerdos() {
    if (!puedeEditar) return;
    setGuardando(true);
    setMsgAccion(null);
    try {
      const res = await apiFetch(
        `/api/reuniones/${encodeURIComponent(idReunion)}/acuerdos/crear-tareas`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      const data = (await res.json().catch(() => ({}))) as {
        creadas?: number;
        tareas?: Tarea[];
        error?: string;
        mensaje?: string;
      };
      if (!res.ok) {
        setMsgAccion(data.error || data.mensaje || 'No se pudieron crear las tareas');
        return;
      }
      const n = data.creadas ?? data.tareas?.length ?? 0;
      setMsgAccion(
        n > 0
          ? `Se crearon ${n} tarea${n === 1 ? '' : 's'} desde los acuerdos abiertos.`
          : data.mensaje || 'No había acuerdos abiertos pendientes de convertir.',
      );
      void cargarFicha();
      void cargarTareas();
    } catch (e) {
      setMsgAccion(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  async function registrarAvisoGrabacion() {
    if (!puedeEditar) return;
    setGuardando(true);
    setErrorAviso(null);
    try {
      const res = await apiFetch(
        `/api/reuniones/${encodeURIComponent(idReunion)}/aviso-grabacion`,
        {
          method: 'POST',
          body: JSON.stringify({
            informados: avisoInformados,
            aceptado: true,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        reunion?: Reunion;
        aviso_grabacion?: Reunion['aviso_grabacion'];
        error?: string;
      };
      if (!res.ok) {
        setErrorAviso(data.error || 'No se pudo registrar el aviso de grabación');
        return;
      }
      setAvisoFormVisible(false);
      if (data.reunion) setReunion((prev) => (prev ? { ...prev, ...data.reunion } : data.reunion ?? null));
      else if (data.aviso_grabacion) {
        setReunion((prev) => (prev ? { ...prev, aviso_grabacion: data.aviso_grabacion } : prev));
      } else {
        void cargarFicha();
      }
      setMsgAccion('Aviso de grabación registrado.');
    } catch (e) {
      setErrorAviso(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }

  function trasEdicion(resultado: ResultadoGuardadoReunion) {
    setEditarVisible(false);
    if (resultado.avisoCalendario) setAvisoCalendario(resultado.avisoCalendario);
    else if (resultado.calendarioSincronizado === false) {
      setAvisoCalendario(
        'Los cambios se guardaron, pero no se pudo sincronizar con Google Calendar.',
      );
    }
    void cargarFicha();
  }

  if (acceso.permisosCargando || cargando) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.centroTexto}>Cargando reunión…</Text>
      </View>
    );
  }

  if (!puedeVer) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={30} color="#94a3b8" />
        <Text style={styles.centroTexto}>No tienes permiso para ver las reuniones.</Text>
      </View>
    );
  }

  if (noDisponible) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="event-busy" size={30} color="#94a3b8" />
        <Text style={styles.centroTexto}>Esta reunión no existe o ya no está disponible.</Text>
        <TouchableOpacity style={styles.btnVolver} onPress={() => router.push('/reuniones' as never)}>
          <Text style={styles.btnVolverTexto}>Volver al listado</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (error || !reunion) {
    return (
      <View style={styles.centro}>
        <Text style={styles.errorTexto}>{error || 'No se pudo cargar la reunión'}</Text>
        <TouchableOpacity style={styles.btnVolver} onPress={() => void cargarFicha()}>
          <Text style={styles.btnVolverTexto}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const aviso = reunion.aviso_grabacion;
  const deptNombre = reunion.departamento_id
    ? departamentos.nombrePorId(reunion.departamento_id)
    : '—';

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/reuniones' as never)}
          style={[styles.backBtn, isCompact && styles.backBtnTactil]}
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerTexto}>
          <Text style={styles.title} numberOfLines={2}>
            {reunion.titulo}
          </Text>
          <Text style={styles.subtitle}>
            {formatFecha(reunion.fecha)}
            {reunion.hora_inicio ? ` · ${reunion.hora_inicio}` : ''}
            {reunion.hora_fin ? `–${reunion.hora_fin}` : ''}
          </Text>
        </View>
        <BadgeEstadoReunion estado={reunion.estado} grande />
        {puedeEditar ? (
          <TouchableOpacity
            style={[styles.btnEditar, isCompact && styles.btnEditarTactil]}
            onPress={() => setEditarVisible(true)}
          >
            <MaterialIcons name="edit" size={16} color="#0ea5e9" />
            <Text style={styles.btnEditarTexto}>Editar</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, shouldStackPanels && styles.scrollContentCompact]}
      >
        {avisoCalendario ? (
          <View style={styles.bannerCalendario}>
            <MaterialIcons name="event-busy" size={18} color="#b45309" />
            <Text style={styles.bannerCalendarioTexto}>{avisoCalendario}</Text>
          </View>
        ) : null}

        {msgAccion ? (
          <View style={styles.bannerInfo}>
            <MaterialIcons name="info-outline" size={18} color="#0369a1" />
            <Text style={styles.bannerInfoTexto}>{msgAccion}</Text>
            <TouchableOpacity onPress={() => setMsgAccion(null)}>
              <MaterialIcons name="close" size={18} color="#0369a1" />
            </TouchableOpacity>
          </View>
        ) : null}

        <SeccionFicha titulo="Datos" icono="info-outline">
          <View style={styles.datosGrid}>
            <Dato etiqueta="Visibilidad" valor={ETIQUETA_VISIBILIDAD_REUNION[reunion.visibilidad] ?? reunion.visibilidad} />
            <Dato
              etiqueta="Modalidad"
              valor={
                reunion.modalidad
                  ? ETIQUETA_MODALIDAD_REUNION[reunion.modalidad] ?? reunion.modalidad
                  : '—'
              }
            />
            <Dato etiqueta="Departamento" valor={deptNombre} />
            <Dato etiqueta="Local" valor={reunion.local_nombre || '—'} />
            <Dato etiqueta="Proyecto" valor={reunion.proyecto_id || '—'} />
            <Dato etiqueta="Serie" valor={reunion.serie_id || '—'} />
            <Dato
              etiqueta="Convocada por"
              valor={usuarios.nombrePorId(reunion.convocada_por)}
            />
            <Dato
              etiqueta="Calendar"
              valor={reunion.calendar_event_id ? 'Evento creado' : 'Sin evento'}
            />
          </View>
        </SeccionFicha>

        <SeccionFicha
          titulo="Asistentes"
          icono="groups"
          contador={asistentes.length}
          vacio="Todavía no hay asistentes registrados."
        >
          {asistentes.length > 0 ? (
            <View style={styles.listaSimple}>
              {asistentes.map((a, i) => (
                <View key={`${a.usuario_id ?? a.nombre}-${i}`} style={styles.filaAsistente}>
                  <MaterialIcons
                    name={a.es_externo ? 'person-outline' : 'person'}
                    size={16}
                    color="#64748b"
                  />
                  <Text style={styles.asistenteNombre}>
                    {(a.nombre || nombreUsuario(a.usuario_id)).trim() || '—'}
                  </Text>
                  {a.asistio === true ? (
                    <Text style={styles.asistioSi}>Asistió</Text>
                  ) : a.asistio === false ? (
                    <Text style={styles.asistioNo}>No asistió</Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </SeccionFicha>

        <SeccionFicha titulo="Orden del día" icono="format-list-bulleted">
          {!ordenEditable ? (
            <View style={styles.avisoBloqueo}>
              <MaterialIcons name="lock-outline" size={14} color="#d97706" />
              <Text style={styles.avisoBloqueoTexto}>
                Bloqueado: la reunión ya está celebrada o tiene acta (D-20).
              </Text>
            </View>
          ) : null}
          <Text style={styles.textoLargo}>
            {(reunion.orden_del_dia_congelado || reunion.orden_del_dia || '').trim() ||
              'Sin orden del día.'}
          </Text>
        </SeccionFicha>

        <SeccionFicha titulo="Resumen / acta" icono="description">
          <Text style={styles.textoLargo}>
            {(reunion.resumen ?? '').trim() || 'Todavía no hay acta manual.'}
          </Text>
        </SeccionFicha>

        <SeccionFicha
          titulo="Acuerdos"
          icono="assignment-turned-in"
          contador={acuerdos.length}
          accion={
            puedeEditar
              ? {
                  etiqueta: 'Añadir',
                  icono: 'add',
                  onPress: () => {
                    setErrorAcuerdo(null);
                    setAcuerdoFormVisible(true);
                  },
                }
              : undefined
          }
          vacio="No hay acuerdos registrados."
        >
          {acuerdos.length > 0 ? (
            <View style={styles.listaSimple}>
              {acuerdos.map((a) => (
                <View key={a.id_acuerdo} style={styles.tarjetaAcuerdo}>
                  <View style={styles.acuerdoCabecera}>
                    <BadgeEstadoAcuerdo estado={a.estado} />
                    {a.tarea_id ? (
                      <TouchableOpacity
                        onPress={() =>
                          router.push(`/proyectos/tarea/${encodeURIComponent(a.tarea_id as string)}` as never)
                        }
                      >
                        <Text style={styles.enlaceTarea}>Ver tarea</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <Text style={styles.acuerdoTexto}>{a.texto}</Text>
                  <Text style={styles.acuerdoMeta}>
                    {usuarios.nombrePorId(a.responsable_id)}
                    {a.fecha_limite ? ` · ${formatFecha(a.fecha_limite)}` : ''}
                  </Text>
                  {puedeEditar && a.estado === 'abierto' ? (
                    <View style={styles.acuerdoAcciones}>
                      {ESTADOS_ACUERDO.filter((e) => e !== 'abierto').map((e) => (
                        <TouchableOpacity
                          key={e}
                          style={[styles.chipAccion, isCompact && styles.chipAccionTactil]}
                          onPress={() => void cambiarEstadoAcuerdo(a, e)}
                          disabled={guardando}
                        >
                          <Text style={styles.chipAccionTexto}>{ETIQUETA_ESTADO_ACUERDO[e]}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          {puedeEditar && acuerdosAbiertos.length > 0 ? (
            <TouchableOpacity
              style={[styles.btnPrimario, isCompact && styles.btnPrimarioTactil]}
              onPress={() => void crearTareasDesdeAcuerdos()}
              disabled={guardando}
            >
              {guardando ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <MaterialIcons name="playlist-add-check" size={16} color="#ffffff" />
                  <Text style={styles.btnPrimarioTexto}>
                    Crear tareas desde acuerdos abiertos ({acuerdosAbiertos.length})
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </SeccionFicha>

        <SeccionFicha
          titulo="Aviso de grabación"
          icono="mic"
          accion={
            puedeEditar
              ? {
                  etiqueta: aviso?.aceptado_en ? 'Actualizar' : 'Registrar',
                  icono: 'how-to-reg',
                  onPress: () => {
                    setAvisoInformados(aviso?.informados ?? asistentes.map((a) => a.usuario_id).filter(Boolean) as string[]);
                    setErrorAviso(null);
                    setAvisoFormVisible(true);
                  },
                }
              : undefined
          }
        >
          {aviso?.aceptado_en ? (
            <Text style={styles.textoLargo}>
              Aceptado el {formatFecha((aviso.aceptado_en ?? '').slice(0, 10))} por{' '}
              {usuarios.nombrePorId(aviso.aceptado_por)}. Informados:{' '}
              {(aviso.informados ?? []).length || 0}.
            </Text>
          ) : (
            <Text style={styles.vacioSeccion}>
              Todavía no hay aviso registrado. En Fase 2 hace falta para subir audio.
            </Text>
          )}
        </SeccionFicha>

        <SeccionFicha
          titulo="Tareas salidas"
          icono="task-alt"
          contador={tareas.length}
          cargando={cargandoTareas}
          error={errorTareas}
          onReintentar={() => void cargarTareas()}
          vacio="Ninguna tarea ha salido todavía de esta reunión."
        >
          {tareas.length > 0 ? (
            <View style={styles.listaSimple}>
              {tareas.map((t) => (
                <TarjetaTarea
                  key={t.id_tarea}
                  tarea={t}
                  mostrarProyecto
                  onAbrir={() =>
                    router.push(`/proyectos/tarea/${encodeURIComponent(t.id_tarea)}` as never)
                  }
                />
              ))}
            </View>
          ) : null}
        </SeccionFicha>

        <HistorialActividad actividad={actividad} nombrePorId={usuarios.nombrePorId} />
      </ScrollView>

      {editarVisible ? (
        <ModalFormularioReunion
          visible
          modo="editar"
          reunion={reunion}
          asistentesIniciales={asistentes}
          usuarios={usuarios}
          departamentos={departamentos}
          onCerrar={() => setEditarVisible(false)}
          onGuardado={trasEdicion}
        />
      ) : null}

      <Modal visible={acuerdoFormVisible} transparent animationType="fade" onRequestClose={() => setAcuerdoFormVisible(false)}>
        <Pressable style={modal.overlay} onPress={() => !guardando && setAcuerdoFormVisible(false)}>
          <Pressable style={[modal.cardWrap, { maxWidth: 440 }]}>
            <View style={modal.card}>
              <View style={modal.header}>
                <Text style={modal.title}>Nuevo acuerdo</Text>
                <TouchableOpacity style={modal.close} onPress={() => setAcuerdoFormVisible(false)}>
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <View style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 12 }}>
                <View style={form.group}>
                  <Text style={form.label}>Texto</Text>
                  <TextInput
                    style={[form.input, form.inputMultilinea]}
                    value={acuerdoTexto}
                    onChangeText={setAcuerdoTexto}
                    placeholder="Qué se acordó…"
                    placeholderTextColor="#94a3b8"
                    multiline
                  />
                </View>
                <View style={form.group}>
                  <Text style={form.label}>Responsable</Text>
                  <SelectorDesplegable
                    sinIconoTrigger
                    tituloLista="Responsable"
                    valorId={acuerdoResponsable}
                    opciones={opcionesResponsable}
                    loading={usuarios.cargando}
                    onSeleccionar={setAcuerdoResponsable}
                  />
                </View>
                <View style={form.group}>
                  <Text style={form.label}>Fecha límite</Text>
                  <InputFecha
                    compact
                    valueIso={acuerdoFecha}
                    onChangeIso={setAcuerdoFecha}
                    style={estiloCampoFechaCompacto}
                  />
                </View>
              </View>
              {errorAcuerdo ? <Text style={modal.error}>{errorAcuerdo}</Text> : null}
              <View style={modal.footer}>
                <TouchableOpacity style={modal.btn} onPress={() => setAcuerdoFormVisible(false)} disabled={guardando}>
                  <Text style={modal.btnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[modal.btn, modal.btnPrimario]}
                  onPress={() => void crearAcuerdo()}
                  disabled={guardando}
                >
                  {guardando ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={modal.btnTextPrimario}>Guardar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={avisoFormVisible} transparent animationType="fade" onRequestClose={() => setAvisoFormVisible(false)}>
        <Pressable style={modal.overlay} onPress={() => !guardando && setAvisoFormVisible(false)}>
          <Pressable style={modal.confirmCard}>
            <MaterialIcons name="mic" size={36} color="#0ea5e9" style={modal.confirmIcono} />
            <Text style={modal.confirmTitle}>Aviso de grabación</Text>
            <Text style={modal.confirmText}>
              Se registrará que los asistentes han sido informados de que la reunión puede
              grabarse, y que tú aceptas el aviso. En Fase 2 esto será requisito para subir audio.
            </Text>
            <Text style={styles.avisoDetalle}>
              Informados: {avisoInformados.length || asistentes.length} persona
              {(avisoInformados.length || asistentes.length) === 1 ? '' : 's'}.
            </Text>
            {errorAviso ? <Text style={styles.errorTexto}>{errorAviso}</Text> : null}
            <View style={modal.confirmBotones}>
              <TouchableOpacity style={modal.btn} onPress={() => setAvisoFormVisible(false)} disabled={guardando}>
                <Text style={modal.btnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modal.btn, modal.btnPrimario]}
                onPress={() => void registrarAvisoGrabacion()}
                disabled={guardando}
              >
                {guardando ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text style={modal.btnTextPrimario}>Registrar</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <View style={styles.dato}>
      <Text style={styles.datoEtiqueta}>{etiqueta}</Text>
      <Text style={styles.datoValor}>{valor}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  errorTexto: { fontSize: 13, color: '#ef4444', textAlign: 'center' },
  btnVolver: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  btnVolverTexto: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    flexWrap: 'wrap',
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  backBtnTactil: { width: MIN_TOUCH, height: MIN_TOUCH },
  headerTexto: { flex: 1, minWidth: 140 },
  title: { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  btnEditar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  btnEditarTactil: { minHeight: MIN_TOUCH },
  btnEditarTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 12, paddingBottom: 32 },
  scrollContentCompact: { padding: 12 },

  bannerCalendario: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  bannerCalendarioTexto: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 17 },
  bannerInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  bannerInfoTexto: { flex: 1, fontSize: 12, color: '#0c4a6e', lineHeight: 17 },

  datosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  dato: { width: '47%', minWidth: 140, gap: 2 },
  datoEtiqueta: { fontSize: 11, color: '#94a3b8', fontWeight: '500' },
  datoValor: { fontSize: 13, color: '#334155', fontWeight: '600' },

  listaSimple: { gap: 8 },
  filaAsistente: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  asistenteNombre: { flex: 1, fontSize: 13, color: '#334155' },
  asistioSi: { fontSize: 11, fontWeight: '600', color: '#16a34a' },
  asistioNo: { fontSize: 11, fontWeight: '600', color: '#94a3b8' },

  avisoBloqueo: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 6 },
  avisoBloqueoTexto: { flex: 1, fontSize: 11, color: '#d97706', lineHeight: 16 },
  textoLargo: { fontSize: 13, color: '#334155', lineHeight: 20 },
  vacioSeccion: { fontSize: 12, color: '#94a3b8', lineHeight: 18 },

  tarjetaAcuerdo: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
    backgroundColor: '#f8fafc',
    gap: 6,
  },
  acuerdoCabecera: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  acuerdoTexto: { fontSize: 13, color: '#0f172a', lineHeight: 18 },
  acuerdoMeta: { fontSize: 11, color: '#64748b' },
  enlaceTarea: { fontSize: 11, fontWeight: '600', color: '#0ea5e9' },
  acuerdoAcciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  chipAccion: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  chipAccionTactil: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  chipAccionTexto: { fontSize: 11, fontWeight: '600', color: '#475569' },

  btnPrimario: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnPrimarioTactil: { minHeight: MIN_TOUCH },
  btnPrimarioTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },

  avisoDetalle: { fontSize: 12, color: '#64748b', textAlign: 'center' },
});
