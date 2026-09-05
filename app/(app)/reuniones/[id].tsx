/**
 * Ficha de una reunión: layout 2 columnas (principal / lateral), acta en modal,
 * historial en modal, cabecera con duración y progreso de pipeline.
 *
 * Acciones de escritura: `permisos_fila` si llega; si no, `reuniones.gestionar`
 * (TODO: quitar fallback cuando el backend lo mande siempre).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Animated,
  Easing,
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
  ETIQUETA_ESTADO_PIPELINE,
  ETIQUETA_MODALIDAD_REUNION,
  ETIQUETA_VISIBILIDAD_REUNION,
  duracionEntreHoras,
  nombreUsuario,
  ordenDelDiaEditable,
  pipelineEnVuelo,
  urlMeetDesdeCodigo,
} from '../../lib/tasksUi';
import { descargarActaReunionPdf } from '../../lib/descargarActaReunion';
import { abrirEnlaceExterno } from '../../utils/enlaceExterno';
import { copyToClipboard } from '../../utils/clipboard';
import { SeccionFicha } from '../../components/tasks/SeccionFicha';
import { SeccionAudioReunion } from '../../components/tasks/SeccionAudioReunion';
import { SeccionPropuestasReunion } from '../../components/tasks/SeccionPropuestasReunion';
import { BadgeEstadoAcuerdo, BadgeEstadoReunion } from '../../components/tasks/BadgesTasks';
import {
  ModalFormularioReunion,
  type ResultadoGuardadoReunion,
} from '../../components/tasks/ModalFormularioReunion';
import { TasksPageHeader } from '../../components/tasks/TasksPageHeader';
import { TarjetaTarea } from '../../components/tasks/TarjetaTarea';
import { HistorialActividad } from '../../components/tasks/HistorialActividad';
import {
  CabeceraMetaActa,
  ModalActaReunion,
  type MetaActaReunion,
} from '../../components/tasks/ModalActaReunion';
import { estilosFormTasks as form, estilosModalTasks as modal } from '../../components/tasks/estilosTasks';
import { InputFecha } from '../../components/InputFecha';
import { estiloCampoFechaCompacto } from '../../components/RangoFechas';
import { SelectorDesplegable, type OpcionDesplegable } from '../../components/SelectorDesplegable';
import {
  tasksColor,
  tasksIcono,
  tasksRadius,
  tasksSpace,
  tasksTipo,
} from '../../constants/tasksUiTokens';
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

const POLL_PIPELINE_MS = 20_000;

function puedeEditarReunion(reunion: Reunion | null, puedeGestionar: boolean): boolean {
  if (!reunion) return false;
  if (reunion.permisos_fila) return reunion.permisos_fila.editar === true;
  return puedeGestionar;
}

function BarraPipelineIndeterminada({ etiqueta }: { etiqueta: string }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: 1400,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      anim.setValue(0);
    };
  }, [anim]);

  const left = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ['-35%', '100%'],
  });

  return (
    <View style={styles.pipelineBarraWrap} accessibilityLabel={etiqueta}>
      <View style={styles.pipelineBarraFondo}>
        <Animated.View style={[styles.pipelineBarraGlow, { left }]} />
      </View>
      <View style={styles.pipelineFaseFila}>
        <ActivityIndicator size="small" color="#0ea5e9" />
        <Text style={styles.pipelineFaseTexto}>{etiqueta}</Text>
      </View>
    </View>
  );
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

  const [historialVisible, setHistorialVisible] = useState(false);
  const [actaVisible, setActaVisible] = useState(false);
  const [descargandoPdf, setDescargandoPdf] = useState(false);

  const puedeVer = puedeVerReuniones(acceso);
  const puedeGestionar = puedeGestionarReuniones(acceso);
  const puedeEditar = puedeEditarReunion(reunion, puedeGestionar);
  const ordenEditable = ordenDelDiaEditable(reunion?.estado);

  const aplicarFicha = useCallback((data: {
    reunion: ReunionFicha;
    asistentes?: AsistenteReunion[];
    acuerdos?: AcuerdoReunion[];
  }) => {
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
  }, []);

  const cargarFicha = useCallback(
    async (opts?: { silencioso?: boolean }) => {
      if (!idReunion || !puedeVer) return;
      const silencioso = opts?.silencioso === true;
      if (!silencioso) {
        setCargando(true);
        setError(null);
      }
      try {
        const res = await apiFetch(`/api/reuniones/${encodeURIComponent(idReunion)}`);
        const data = (await res.json().catch(() => ({}))) as {
          reunion?: ReunionFicha;
          asistentes?: AsistenteReunion[];
          acuerdos?: AcuerdoReunion[];
          error?: string;
        };
        if (res.status === 404) {
          if (!silencioso) setNoDisponible(true);
          return;
        }
        if (!res.ok || !data.reunion) {
          if (!silencioso) setError(data.error || 'No se pudo cargar la reunión');
          return;
        }
        aplicarFicha({
          reunion: data.reunion,
          asistentes: data.asistentes,
          acuerdos: data.acuerdos,
        });
      } catch (e) {
        console.error('[reuniones] fallo al leer la ficha', e);
        if (!silencioso) setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        if (!silencioso) setCargando(false);
      }
    },
    [idReunion, puedeVer, aplicarFicha],
  );

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

  const enPipeline = pipelineEnVuelo(reunion?.pipeline_estado);

  useEffect(() => {
    if (!enPipeline) return;
    const id = setInterval(() => {
      void cargarFicha({ silencioso: true });
    }, POLL_PIPELINE_MS);
    return () => clearInterval(id);
  }, [enPipeline, cargarFicha]);

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

  const nombresAsistentes = useMemo(
    () =>
      asistentes
        .map((a) => (a.nombre || nombreUsuario(a.usuario_id)).trim())
        .filter(Boolean),
    [asistentes],
  );

  const duracion = useMemo(
    () => duracionEntreHoras(reunion?.hora_inicio, reunion?.hora_fin),
    [reunion?.hora_inicio, reunion?.hora_fin],
  );

  const metaActa = useMemo<MetaActaReunion>(
    () => ({
      titulo: reunion?.titulo ?? '',
      fecha: reunion?.fecha,
      horaInicio: reunion?.hora_inicio,
      horaFin: reunion?.hora_fin,
      duracion,
      asistentes: nombresAsistentes,
    }),
    [reunion?.titulo, reunion?.fecha, reunion?.hora_inicio, reunion?.hora_fin, duracion, nombresAsistentes],
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

  async function descargarPdfActa() {
    if (!idReunion || !(reunion?.resumen ?? '').trim() || descargandoPdf) return;
    setDescargandoPdf(true);
    setMsgAccion(null);
    try {
      await descargarActaReunionPdf(idReunion);
    } catch (e) {
      console.error('[reuniones] fallo al descargar PDF del acta', e);
      setMsgAccion(errorMessage(e, 'No se pudo descargar el PDF del acta'));
    } finally {
      setDescargandoPdf(false);
    }
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
  const resumenTexto = (reunion.resumen ?? '').trim();
  const modalidadTxt = reunion.modalidad
    ? ETIQUETA_MODALIDAD_REUNION[reunion.modalidad] ?? reunion.modalidad
    : null;
  const urlMeet = urlMeetDesdeCodigo(reunion.meet_code);

  const metaCabecera = [
    formatFecha(reunion.fecha),
    reunion.hora_inicio || reunion.hora_fin
      ? `${reunion.hora_inicio || '—'}${reunion.hora_fin ? `–${reunion.hora_fin}` : ''}`
      : null,
    duracion,
    modalidadTxt,
  ]
    .filter(Boolean)
    .join(' · ');

  const abrirMeet = () => {
    if (!urlMeet) return;
    void abrirEnlaceExterno(urlMeet).then((r) => {
      if (!r.ok) setMsgAccion(r.error);
    });
  };

  const copiarMeet = () => {
    if (!urlMeet) return;
    void copyToClipboard(urlMeet).then((ok) => {
      setMsgAccion(ok ? 'Enlace de Meet copiado.' : 'No se pudo copiar el enlace.');
    });
  };

  const etiquetaPipeline = reunion.pipeline_estado
    ? ETIQUETA_ESTADO_PIPELINE[reunion.pipeline_estado] ?? reunion.pipeline_estado
    : '';

  const colPrincipal = (
    <>
      <SeccionFicha titulo="Orden del día" icono="format-list-bulleted" variante="destacada">
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

      <SeccionFicha titulo="Acta / resumen" icono="description" variante="destacada">
        {resumenTexto ? (
          <View style={styles.actaPreview}>
            <CabeceraMetaActa meta={metaActa} />
            <Text style={styles.textoLargo} numberOfLines={5}>
              {resumenTexto}
            </Text>
            <View style={styles.actaAcciones}>
              <TouchableOpacity
                style={[styles.btnSecundario, isCompact && styles.btnSecundarioTactil]}
                onPress={() => setActaVisible(true)}
              >
                <MaterialIcons name="visibility" size={16} color="#0ea5e9" />
                <Text style={styles.btnSecundarioTexto}>Ver</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.btnSecundario,
                  isCompact && styles.btnSecundarioTactil,
                  descargandoPdf && styles.btnSecundarioDisabled,
                ]}
                onPress={() => void descargarPdfActa()}
                disabled={descargandoPdf}
                accessibilityRole="button"
                accessibilityLabel="Descargar acta en PDF"
                accessibilityState={{ disabled: descargandoPdf, busy: descargandoPdf }}
              >
                {descargandoPdf ? (
                  <ActivityIndicator size="small" color="#0ea5e9" />
                ) : (
                  <MaterialIcons name="picture-as-pdf" size={16} color="#0ea5e9" />
                )}
                <Text style={styles.btnSecundarioTexto}>
                  {descargandoPdf ? 'Descargando…' : 'PDF'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <Text style={styles.vacioSeccion}>
            Todavía no hay resumen ni acta. Aparecerá cuando el pipeline termine de procesar el
            audio.
          </Text>
        )}
      </SeccionFicha>

      <SeccionPropuestasReunion
        idReunion={idReunion}
        puedeEditar={puedeEditar}
        usuarios={usuarios}
        variante="destacada"
        onResuelto={() => {
          setMsgAccion('Propuestas actualizadas. Se han refrescado acuerdos y tareas.');
          void cargarFicha();
          void cargarTareas();
          void actividad.recargar();
        }}
      />

      <SeccionFicha
        titulo="Acuerdos"
        icono="assignment-turned-in"
        variante="destacada"
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
                        router.push(
                          `/proyectos/tarea/${encodeURIComponent(a.tarea_id as string)}` as never,
                        )
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
        titulo="Tareas salidas"
        icono="task-alt"
        variante="destacada"
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
    </>
  );

  const colLateral = (
    <>
      <SeccionFicha titulo="Datos" icono="info-outline" variante="destacada">
        <View style={styles.datosGrid}>
          <Dato
            etiqueta="Visibilidad"
            valor={ETIQUETA_VISIBILIDAD_REUNION[reunion.visibilidad] ?? reunion.visibilidad}
          />
          <Dato etiqueta="Modalidad" valor={modalidadTxt || '—'} />
          <Dato etiqueta="Departamento" valor={deptNombre} />
          <Dato etiqueta="Local" valor={reunion.local_nombre || '—'} />
          <Dato etiqueta="Proyecto" valor={reunion.proyecto_id || '—'} />
          <Dato etiqueta="Serie" valor={reunion.serie_id || '—'} />
          <Dato etiqueta="Convocada por" valor={usuarios.nombrePorId(reunion.convocada_por)} />
          <Dato
            etiqueta="Calendar"
            valor={reunion.calendar_event_id ? 'Evento creado' : 'Sin evento'}
          />
        </View>
      </SeccionFicha>

      <SeccionFicha
        titulo="Asistentes"
        icono="groups"
        variante="destacada"
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

      <SeccionAudioReunion
        idReunion={idReunion}
        reunion={reunion}
        puedeEditar={puedeEditar}
        variante="destacada"
        onPedirAviso={() => {
          setAvisoInformados(
            aviso?.informados ??
              (asistentes.map((a) => a.usuario_id).filter(Boolean) as string[]),
          );
          setErrorAviso(null);
          setAvisoFormVisible(true);
        }}
        onProcesado={(actualizada) => {
          const importada = actualizada?.origen_audio === 'transcripcion_importada';
          setMsgAccion(
            importada
              ? 'Transcripción importada. El resumen automático está en marcha.'
              : 'Audio subido. El procesado automático está en marcha.',
          );
          if (actualizada) {
            setReunion((prev) =>
              prev ? { ...prev, ...actualizada } : (actualizada as ReunionFicha),
            );
          }
          void actividad.recargar();
          void cargarFicha({ silencioso: true });
        }}
      />

      <SeccionFicha
        titulo="Aviso de grabación"
        icono="mic"
        variante="destacada"
        accion={
          puedeEditar
            ? {
                etiqueta: aviso?.aceptado_en ? 'Actualizar' : 'Registrar',
                icono: 'how-to-reg',
                onPress: () => {
                  setAvisoInformados(
                    aviso?.informados ??
                      (asistentes.map((a) => a.usuario_id).filter(Boolean) as string[]),
                  );
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
            Todavía no hay aviso registrado. Hace falta para subir audio.
          </Text>
        )}
      </SeccionFicha>

      <TouchableOpacity
        style={[styles.btnHistorial, isCompact && styles.btnHistorialTactil]}
        onPress={() => setHistorialVisible(true)}
      >
        <MaterialIcons name="history" size={18} color="#0ea5e9" />
        <Text style={styles.btnHistorialTexto}>Ver historial</Text>
      </TouchableOpacity>
    </>
  );

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, shouldStackPanels && styles.scrollContentCompact]}
      >
        <TasksPageHeader
          title={reunion.titulo}
          onBack={() => router.push('/reuniones' as never)}
          backAccessibilityLabel="Volver al listado de reuniones"
          compact={isCompact}
          actions={
            puedeEditar ? (
              <TouchableOpacity
                style={[styles.editarBtn, isCompact && styles.editarBtnTactil]}
                onPress={() => setEditarVisible(true)}
                accessibilityLabel="Editar la reunión"
              >
                <MaterialIcons name="edit" size={tasksIcono.sizeSm} color={tasksColor.textoInverso} />
                <Text style={styles.editarTexto}>Editar</Text>
              </TouchableOpacity>
            ) : null
          }
          below={
            <View style={styles.cabeceraMeta}>
              <View style={styles.cabeceraBadges}>
                <BadgeEstadoReunion estado={reunion.estado} grande />
                {metaCabecera ? <Text style={styles.cabeceraFecha}>{metaCabecera}</Text> : null}
              </View>
              {urlMeet ? (
                <View style={styles.meetRow}>
                  <TouchableOpacity
                    style={[styles.meetChip, isCompact && styles.meetChipTactil]}
                    onPress={abrirMeet}
                    accessibilityRole="button"
                    accessibilityLabel="Abrir Google Meet"
                  >
                    <MaterialIcons name="videocam" size={16} color="#92400e" />
                    <Text style={styles.meetChipTexto} numberOfLines={1}>
                      Abrir Meet
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.meetCopiar, isCompact && styles.meetChipTactil]}
                    onPress={copiarMeet}
                    accessibilityLabel="Copiar enlace de Meet"
                  >
                    <MaterialIcons name="content-copy" size={15} color={tasksColor.textoSecundario} />
                    <Text style={styles.meetCopiarTexto}>Copiar enlace</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {!puedeEditar ? (
                <View style={styles.avisoSoloLectura}>
                  <MaterialIcons
                    name="lock-outline"
                    size={tasksIcono.sizeSm}
                    color={tasksColor.textoSecundario}
                  />
                  <Text style={styles.avisoSoloLecturaTexto}>
                    Solo lectura: para cambiar esta reunión hace falta permiso de gestión.
                  </Text>
                </View>
              ) : null}
              {enPipeline ? <BarraPipelineIndeterminada etiqueta={etiquetaPipeline} /> : null}
            </View>
          }
        />

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

        <View style={[styles.columnas, shouldStackPanels && styles.columnasApiladas]}>
          <View style={[styles.colPrincipal, shouldStackPanels && styles.colApilada]}>
            {colPrincipal}
          </View>
          <View style={[styles.colLateral, shouldStackPanels && styles.colApilada]}>
            {colLateral}
          </View>
        </View>
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

      {actaVisible && resumenTexto ? (
        <ModalActaReunion
          visible
          onCerrar={() => setActaVisible(false)}
          meta={metaActa}
          resumen={resumenTexto}
        />
      ) : null}

      <Modal
        visible={historialVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setHistorialVisible(false)}
      >
        <Pressable style={modal.overlay} onPress={() => setHistorialVisible(false)}>
          <Pressable
            style={[modal.cardWrap, { maxWidth: 560 }, isCompact && modal.cardWrapAncho]}
            onPress={(e) => e?.stopPropagation?.()}
          >
            <View style={modal.card}>
              <View style={modal.header}>
                <Text style={modal.title}>Historial</Text>
                <TouchableOpacity
                  style={[modal.close, isCompact && { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH }]}
                  onPress={() => setHistorialVisible(false)}
                  accessibilityLabel="Cerrar"
                >
                  <MaterialIcons name="close" size={22} color="#64748b" />
                </TouchableOpacity>
              </View>
              <ScrollView style={modal.body}>
                <HistorialActividad
                  actividad={actividad}
                  nombrePorId={usuarios.nombrePorId}
                  modo="embebido"
                />
              </ScrollView>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={acuerdoFormVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAcuerdoFormVisible(false)}
      >
        <Pressable style={modal.overlay} onPress={() => !guardando && setAcuerdoFormVisible(false)}>
          <Pressable
            style={[modal.cardWrap, { maxWidth: 440 }]}
            onPress={(e) => e?.stopPropagation?.()}
          >
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
                <TouchableOpacity
                  style={modal.btn}
                  onPress={() => setAcuerdoFormVisible(false)}
                  disabled={guardando}
                >
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

      <Modal
        visible={avisoFormVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAvisoFormVisible(false)}
      >
        <Pressable style={modal.overlay} onPress={() => !guardando && setAvisoFormVisible(false)}>
          <Pressable style={modal.confirmCard} onPress={(e) => e?.stopPropagation?.()}>
            <MaterialIcons name="mic" size={36} color="#0ea5e9" style={modal.confirmIcono} />
            <Text style={modal.confirmTitle}>Aviso de grabación</Text>
            <Text style={modal.confirmText}>
              Se registrará que los asistentes han sido informados de que la reunión puede
              grabarse, y que tú aceptas el aviso. Es requisito para poder subir el audio.
            </Text>
            <Text style={styles.avisoDetalle}>
              Informados: {avisoInformados.length || asistentes.length} persona
              {(avisoInformados.length || asistentes.length) === 1 ? '' : 's'}.
            </Text>
            {errorAviso ? <Text style={styles.errorTexto}>{errorAviso}</Text> : null}
            <View style={modal.confirmBotones}>
              <TouchableOpacity
                style={modal.btn}
                onPress={() => setAvisoFormVisible(false)}
                disabled={guardando}
              >
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
  container: { flex: 1, backgroundColor: tasksColor.fondoApp },
  centro: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    backgroundColor: tasksColor.fondoApp,
  },
  centroTexto: { ...tasksTipo.cuerpo, textAlign: 'center' },
  errorTexto: { ...tasksTipo.cuerpo, color: tasksColor.peligro, textAlign: 'center' },
  btnVolver: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    backgroundColor: tasksColor.superficie,
  },
  btnVolverTexto: { ...tasksTipo.dato, color: tasksColor.textoEnlace, fontWeight: '600' },

  cabeceraMeta: { gap: tasksSpace[2] },
  cabeceraBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
  },
  cabeceraFecha: { ...tasksTipo.etiqueta, color: tasksColor.textoSecundario },
  editarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tasksColor.acento,
    paddingHorizontal: tasksSpace[3],
    paddingVertical: tasksSpace[2],
    borderRadius: tasksRadius.control,
  },
  editarBtnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  editarTexto: { ...tasksTipo.dato, color: tasksColor.textoInverso, fontWeight: '600' },
  avisoSoloLectura: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: tasksSpace[2],
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.superficie,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
  },
  avisoSoloLecturaTexto: { flex: 1, ...tasksTipo.micro, color: tasksColor.textoSecundario },

  meetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  meetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fcd34d',
  },
  meetChipTactil: { minHeight: MIN_TOUCH },
  meetChipTexto: { ...tasksTipo.dato, fontWeight: '600', color: '#92400e' },
  meetCopiar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: tasksRadius.contenedor,
  },
  meetCopiarTexto: { ...tasksTipo.etiqueta, fontWeight: '600', color: tasksColor.textoSecundario },

  pipelineBarraWrap: { gap: 6 },
  pipelineBarraFondo: {
    height: 3,
    borderRadius: 2,
    backgroundColor: tasksColor.acentoSuave,
    overflow: 'hidden',
  },
  pipelineBarraGlow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '35%',
    backgroundColor: tasksColor.acento,
    borderRadius: 2,
    opacity: 0.85,
  },
  pipelineFaseFila: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pipelineFaseTexto: { ...tasksTipo.etiqueta, fontWeight: '600', color: tasksColor.acentoTexto },

  scroll: { flex: 1 },
  scrollContent: { padding: tasksSpace[4], gap: tasksSpace[3], paddingBottom: tasksSpace[6] },
  scrollContentCompact: { padding: tasksSpace[3] },

  columnas: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  columnasApiladas: { flexDirection: 'column' },
  colPrincipal: { flex: 1.55, minWidth: 0, gap: 12 },
  colLateral: { flex: 1, minWidth: 280, maxWidth: 420, gap: 12 },
  colApilada: { maxWidth: '100%', width: '100%', minWidth: 0 },

  bannerCalendario: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.avisoSuave,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  bannerCalendarioTexto: { flex: 1, ...tasksTipo.etiqueta, color: '#92400e', lineHeight: 17 },
  bannerInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.acentoSuave,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  bannerInfoTexto: { flex: 1, ...tasksTipo.etiqueta, color: '#0c4a6e', lineHeight: 17 },

  datosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  dato: { width: '47%', minWidth: 120, gap: 2 },
  datoEtiqueta: { ...tasksTipo.etiqueta },
  datoValor: { ...tasksTipo.dato },

  listaSimple: { gap: 8 },
  filaAsistente: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  asistenteNombre: { flex: 1, ...tasksTipo.cuerpo, color: tasksColor.textoPrimario },
  asistioSi: { ...tasksTipo.micro, fontWeight: '600', color: tasksColor.exito },
  asistioNo: { ...tasksTipo.micro, fontWeight: '600', color: tasksColor.textoTerciario },

  avisoBloqueo: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 6 },
  avisoBloqueoTexto: { flex: 1, ...tasksTipo.micro, color: tasksColor.aviso, lineHeight: 16 },
  textoLargo: { ...tasksTipo.cuerpo, color: tasksColor.textoPrimario, lineHeight: 20 },
  vacioSeccion: { ...tasksTipo.micro, lineHeight: 18 },

  actaPreview: { gap: 10 },
  actaAcciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btnSecundario: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    backgroundColor: tasksColor.superficieHundida,
  },
  btnSecundarioTactil: { minHeight: MIN_TOUCH },
  btnSecundarioDisabled: { opacity: 0.65 },
  btnSecundarioTexto: { ...tasksTipo.etiqueta, fontWeight: '600', color: tasksColor.textoEnlace },

  tarjetaAcuerdo: {
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    borderRadius: 10,
    padding: 10,
    backgroundColor: tasksColor.superficieHundida,
    gap: 6,
  },
  acuerdoCabecera: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  acuerdoTexto: { ...tasksTipo.cuerpo, color: tasksColor.textoPrimario, lineHeight: 18 },
  acuerdoMeta: { ...tasksTipo.micro },
  enlaceTarea: { ...tasksTipo.micro, fontWeight: '600', color: tasksColor.textoEnlace },
  acuerdoAcciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  chipAccion: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: tasksRadius.pildora,
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    backgroundColor: tasksColor.superficie,
  },
  chipAccionTactil: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  chipAccionTexto: { ...tasksTipo.micro, fontWeight: '600', color: tasksColor.textoSecundario },

  btnPrimario: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.acento,
  },
  btnPrimarioTactil: { minHeight: MIN_TOUCH },
  btnPrimarioTexto: { ...tasksTipo.dato, fontWeight: '700', color: tasksColor.textoInverso },

  btnHistorial: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    backgroundColor: tasksColor.superficie,
  },
  btnHistorialTactil: { minHeight: MIN_TOUCH },
  btnHistorialTexto: { ...tasksTipo.cuerpo, fontWeight: '700', color: tasksColor.textoEnlace },

  avisoDetalle: { ...tasksTipo.etiqueta, color: tasksColor.textoSecundario, textAlign: 'center' },
});
