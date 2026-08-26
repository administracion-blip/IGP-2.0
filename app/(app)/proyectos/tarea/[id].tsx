/**
 * Ficha de una tarea: datos, estado con sus transiciones, lista de comprobación,
 * subtareas, comentarios e historial.
 *
 * Los botones de estado son los que el estado actual admite (espejo de las
 * transiciones del backend); si el servidor rechaza uno responde `422` y se
 * enseña su mensaje. Una tarea que no se alcanza responde `404` y se trata como
 * «ya no está disponible», no como falta de permiso.
 *
 * Editar, comentar, reasignar y crear subtareas se habilitan con `permisos_fila`,
 * cada uno con su campo: crear una subtarea decide sobre el proyecto y no sobre la
 * tarea madre, así que va con `crear_subtarea` y no con `editar`. El nombre del
 * proyecto llega en `proyecto_nombre`: la pantalla no lee la ficha del proyecto
 * para decidir nada ni para resolver nombres. Ese nombre a `null` significa que
 * quien mira no alcanza el proyecto, así que tampoco se ofrece abrirlo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../../constants/layout';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../../hooks/useAccesoTasks';
import { useNombresUsuarios } from '../../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../../hooks/useDepartamentos';
import { useActividadTasks } from '../../../hooks/useActividadTasks';
import { useCambioEstadoTarea } from '../../../hooks/useCambioEstadoTarea';
import { puedeVerProyectos } from '../../../lib/tasksAcceso';
import {
  ETIQUETA_TIPO_VINCULO,
  nombreProyectoDeTarea,
  nombreUsuario,
  proyectoDeTareaAlcanzable,
  textoVencimiento,
} from '../../../lib/tasksUi';
import { SeccionFicha } from '../../../components/tasks/SeccionFicha';
import { BadgeEstadoTarea, BadgePrioridad } from '../../../components/tasks/BadgesTasks';
import { AccionesEstadoTarea } from '../../../components/tasks/AccionesEstadoTarea';
import { TarjetaTarea } from '../../../components/tasks/TarjetaTarea';
import { HistorialActividad } from '../../../components/tasks/HistorialActividad';
import { ModalMotivoBloqueo } from '../../../components/tasks/ModalMotivoBloqueo';
import { ModalFormularioTarea } from '../../../components/tasks/ModalFormularioTarea';
import { SeccionEnlacesTarea } from '../../../components/tasks/SeccionEnlacesTarea';
import { SeccionAdjuntosTarea } from '../../../components/tasks/SeccionAdjuntosTarea';
import { estilosFormTasks as form } from '../../../components/tasks/estilosTasks';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { apiFetch, errorMessage } from '../../../utils/api';
import { formatFecha, formatCreadoEn } from '../../../utils/formatFecha';
import type { AdjuntoTarea, ComentarioTarea, EnlaceTarea, Tarea, TareaDetalle } from '../../../types/tasks';

/** Reconsulta suave mientras la captura sigue en `pendiente` (~4 s × 10 ≈ 40 s). */
const MS_REFRESCO_CAPTURA = 4000;
const MAX_INTENTOS_CAPTURA = 10;

const LIMITE_COMENTARIOS = 20;

export default function FichaTareaScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idTarea = Array.isArray(params.id) ? params.id[0] : params.id ?? '';

  const acceso = useAccesoTasks();
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();

  const [tarea, setTarea] = useState<TareaDetalle | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noDisponible, setNoDisponible] = useState(false);

  const [editarVisible, setEditarVisible] = useState(false);
  const [subtareaVisible, setSubtareaVisible] = useState(false);

  const [subtareas, setSubtareas] = useState<Tarea[]>([]);
  const [cargandoSubtareas, setCargandoSubtareas] = useState(false);
  const [errorSubtareas, setErrorSubtareas] = useState<string | null>(null);

  const [textoItem, setTextoItem] = useState('');
  const [itemEnCurso, setItemEnCurso] = useState<string | null>(null);
  const [errorChecklist, setErrorChecklist] = useState<string | null>(null);

  const [comentarios, setComentarios] = useState<ComentarioTarea[]>([]);
  const [cursorComentarios, setCursorComentarios] = useState<string | null>(null);
  const [cargandoComentarios, setCargandoComentarios] = useState(false);
  const [errorComentarios, setErrorComentarios] = useState<string | null>(null);
  const [textoComentario, setTextoComentario] = useState('');
  const [enviandoComentario, setEnviandoComentario] = useState(false);

  const [panelReasignar, setPanelReasignar] = useState(false);
  const [nuevoResponsable, setNuevoResponsable] = useState('');
  const [reasignando, setReasignando] = useState(false);
  const [errorReasignar, setErrorReasignar] = useState<string | null>(null);
  const enlacesRef = useRef<EnlaceTarea[]>([]);
  const intentosCapturaRef = useRef(0);
  /** Fuerza a reiniciar el ciclo de refresco (añadir / recapturar / foco). */
  const [cicloCaptura, setCicloCaptura] = useState(0);

  const actividad = useActividadTasks(
    idTarea ? `/api/tareas/${encodeURIComponent(idTarea)}/actividad` : null,
  );

  const puedeVer = puedeVerProyectos(acceso);
  // Lo que se puede hacer con esta tarea lo dice el servidor, no la pantalla.
  const puedeEditar = tarea?.permisos_fila?.editar === true;
  const puedeReasignar = tarea?.permisos_fila?.reasignar === true;
  // Colgar una subtarea decide sobre el proyecto, no sobre esta tarea: viene en su
  // propio permiso de fila y no se deduce de `editar`.
  const puedeCrearSubtarea = tarea?.permisos_fila?.crear_subtarea === true;

  enlacesRef.current = tarea?.enlaces ?? [];
  const hayCapturasPendientes = (tarea?.enlaces ?? []).some((e) => e.captura_estado === 'pendiente');

  const cargarTarea = useCallback(async (opciones?: { silencioso?: boolean }) => {
    if (!idTarea || !puedeVer) return;
    const silencioso = opciones?.silencioso === true;
    if (!silencioso) {
      setCargando(true);
      setError(null);
    }
    try {
      const res = await apiFetch(`/api/tareas/${encodeURIComponent(idTarea)}`);
      const data = (await res.json().catch(() => ({}))) as { tarea?: TareaDetalle; error?: string };
      if (res.status === 404) {
        setNoDisponible(true);
        return;
      }
      if (!res.ok || !data.tarea) {
        if (!silencioso) setError(data.error || 'No se pudo cargar la tarea');
        return;
      }
      setTarea(data.tarea);
      enlacesRef.current = data.tarea.enlaces ?? [];
    } catch (e) {
      console.error('[tasks] fallo al leer la ficha de la tarea', e);
      if (!silencioso) setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      if (!silencioso) setCargando(false);
    }
  }, [idTarea, puedeVer]);

  useEffect(() => {
    void cargarTarea();
  }, [cargarTarea]);

  const pedirRefrescoCaptura = useCallback(() => {
    intentosCapturaRef.current = 0;
    setCicloCaptura((n) => n + 1);
  }, []);

  // Mientras queden capturas en `pendiente`, reconsulta cada ~4 s (tope ~40 s).
  useEffect(() => {
    if (!hayCapturasPendientes) {
      intentosCapturaRef.current = 0;
      return;
    }
    if (intentosCapturaRef.current >= MAX_INTENTOS_CAPTURA) return;

    const timer = setTimeout(() => {
      intentosCapturaRef.current += 1;
      void cargarTarea({ silencioso: true });
    }, MS_REFRESCO_CAPTURA);

    return () => clearTimeout(timer);
  }, [hayCapturasPendientes, tarea?.enlaces, cicloCaptura, cargarTarea]);

  // Al volver a la ficha, reinicia el ciclo si aún hay capturas en vuelo.
  useFocusEffect(
    useCallback(() => {
      if (!enlacesRef.current.some((e) => e.captura_estado === 'pendiente')) return;
      intentosCapturaRef.current = 0;
      setCicloCaptura((n) => n + 1);
      void cargarTarea({ silencioso: true });
    }, [cargarTarea]),
  );

  const cargarSubtareas = useCallback(async () => {
    if (!idTarea || !puedeVer) return;
    setCargandoSubtareas(true);
    setErrorSubtareas(null);
    try {
      const res = await apiFetch(`/api/tareas/${encodeURIComponent(idTarea)}/subtareas?limite=50`);
      const data = (await res.json().catch(() => ({}))) as { tareas?: Tarea[]; error?: string };
      if (!res.ok) {
        setErrorSubtareas(data.error || 'No se pudieron cargar las subtareas');
        return;
      }
      setSubtareas(Array.isArray(data.tareas) ? data.tareas : []);
    } catch (e) {
      console.error('[tasks] fallo al listar las subtareas', e);
      setErrorSubtareas(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setCargandoSubtareas(false);
    }
  }, [idTarea, puedeVer]);

  useEffect(() => {
    void cargarSubtareas();
  }, [cargarSubtareas]);

  const cargarComentarios = useCallback(
    async (desde: string | null) => {
      if (!idTarea || !puedeVer) return;
      setCargandoComentarios(true);
      setErrorComentarios(null);
      try {
        const query = new URLSearchParams({ limite: String(LIMITE_COMENTARIOS) });
        if (desde) query.set('cursor', desde);
        const res = await apiFetch(
          `/api/tareas/${encodeURIComponent(idTarea)}/comentarios?${query.toString()}`,
        );
        const data = (await res.json().catch(() => ({}))) as {
          comentarios?: ComentarioTarea[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setErrorComentarios(data.error || 'No se pudieron cargar los comentarios');
          return;
        }
        const lote = Array.isArray(data.comentarios) ? data.comentarios : [];
        setComentarios((previos) => (desde ? [...previos, ...lote] : lote));
        setCursorComentarios(data.cursor ?? null);
      } catch (e) {
        console.error('[tasks] fallo al listar los comentarios', e);
        setErrorComentarios(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setCargandoComentarios(false);
      }
    },
    [idTarea, puedeVer],
  );

  useEffect(() => {
    setComentarios([]);
    setCursorComentarios(null);
    void cargarComentarios(null);
  }, [cargarComentarios]);

  const onCambiada = useCallback((actualizada: Tarea) => {
    setTarea((previa) => (previa ? { ...previa, ...actualizada } : previa));
    actividad.recargar();
  }, [actividad]);

  const cambio = useCambioEstadoTarea({
    onCambiada,
    onNoDisponible: () => setNoDisponible(true),
  });

  const subcambio = useCambioEstadoTarea({
    onCambiada: useCallback((actualizada: Tarea) => {
      setSubtareas((previas) =>
        previas.map((t) => (t.id_tarea === actualizada.id_tarea ? actualizada : t)),
      );
    }, []),
    onNoDisponible: useCallback((id: string) => {
      setSubtareas((previas) => previas.filter((t) => t.id_tarea !== id));
    }, []),
  });

  /** Las tres operaciones de la lista devuelven la tarea completa ya recalculada. */
  const operarChecklist = useCallback(
    async (clave: string, ruta: string, opciones: RequestInit) => {
      setItemEnCurso(clave);
      setErrorChecklist(null);
      try {
        const res = await apiFetch(ruta, opciones);
        const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };
        if (res.status === 404) {
          setErrorChecklist('Ese elemento ya no está disponible.');
          void cargarTarea();
          return;
        }
        if (!res.ok || !data.tarea) {
          setErrorChecklist(data.error || 'No se pudo actualizar la lista de comprobación');
          return;
        }
        const actualizada = data.tarea;
        setTarea((previa) => (previa ? { ...previa, ...actualizada } : previa));
      } catch (e) {
        console.error('[tasks] fallo al operar sobre la lista de comprobación', e);
        setErrorChecklist(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setItemEnCurso(null);
      }
    },
    [cargarTarea],
  );

  const anadirItem = useCallback(async () => {
    const texto = textoItem.trim();
    if (!texto || !idTarea) return;
    await operarChecklist('nuevo', `/api/tareas/${encodeURIComponent(idTarea)}/checklist`, {
      method: 'POST',
      body: JSON.stringify({ texto }),
    });
    setTextoItem('');
  }, [textoItem, idTarea, operarChecklist]);

  const enviarComentario = useCallback(async () => {
    const texto = textoComentario.trim();
    if (!texto || !idTarea) return;
    setEnviandoComentario(true);
    setErrorComentarios(null);
    try {
      const res = await apiFetch(`/api/tareas/${encodeURIComponent(idTarea)}/comentarios`, {
        method: 'POST',
        body: JSON.stringify({ texto }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        comentario?: ComentarioTarea;
        error?: string;
      };
      if (!res.ok || !data.comentario) {
        setErrorComentarios(data.error || 'No se pudo publicar el comentario');
        return;
      }
      const nuevo = data.comentario;
      setComentarios((previos) => [nuevo, ...previos]);
      setTextoComentario('');
      actividad.recargar();
    } catch (e) {
      console.error('[tasks] fallo al publicar el comentario', e);
      setErrorComentarios(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setEnviandoComentario(false);
    }
  }, [textoComentario, idTarea, actividad]);

  const reasignar = useCallback(async () => {
    if (!idTarea) return;
    const destino = nuevoResponsable.trim();
    if (!destino) {
      setErrorReasignar('Elige la persona que se hace cargo');
      return;
    }
    setReasignando(true);
    setErrorReasignar(null);
    try {
      const res = await apiFetch(`/api/tareas/${encodeURIComponent(idTarea)}/reasignar`, {
        method: 'POST',
        body: JSON.stringify({ responsable_id: destino }),
      });
      const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };
      if (res.status === 404) {
        setNoDisponible(true);
        return;
      }
      if (!res.ok || !data.tarea) {
        setErrorReasignar(data.error || 'No se pudo reasignar la tarea');
        return;
      }
      const actualizada = data.tarea;
      setTarea((previa) => (previa ? { ...previa, ...actualizada } : previa));
      setPanelReasignar(false);
      setNuevoResponsable('');
      actividad.recargar();
    } catch (e) {
      console.error('[tasks] fallo al reasignar la tarea', e);
      setErrorReasignar(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setReasignando(false);
    }
  }, [idTarea, nuevoResponsable, actividad]);

  if (acceso.permisosCargando) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.centroTexto}>Cargando permisos…</Text>
      </View>
    );
  }

  if (!puedeVer) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="lock-outline" size={30} color="#94a3b8" />
        <Text style={styles.centroTexto}>No tienes permiso para ver las tareas.</Text>
      </View>
    );
  }

  if (noDisponible) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="search-off" size={36} color="#94a3b8" />
        <Text style={styles.centroTexto}>Esta tarea no existe o ya no está disponible.</Text>
        <TouchableOpacity
          style={styles.volverBtn}
          onPress={() => router.push('/proyectos/mis-tareas' as never)}
        >
          <MaterialIcons name="arrow-back" size={18} color="#0ea5e9" />
          <Text style={styles.volverTexto}>Volver a mis tareas</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (cargando && !tarea) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.centroTexto}>Cargando la tarea…</Text>
      </View>
    );
  }

  if (!tarea) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="error-outline" size={36} color="#f87171" />
        <Text style={styles.centroError}>{error ?? 'No se pudo cargar la tarea'}</Text>
        <TouchableOpacity style={styles.volverBtn} onPress={() => void cargarTarea()}>
          <MaterialIcons name="refresh" size={18} color="#0ea5e9" />
          <Text style={styles.volverTexto}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const checklist = [...(tarea.checklist ?? [])].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  const hechos = checklist.filter((i) => i.hecho).length;
  const vinculos = tarea.vinculos ?? [];
  const abierta = tarea.estado !== 'hecha' && tarea.estado !== 'cancelada';
  const nombreProyecto = nombreProyectoDeTarea(tarea);
  const proyectoAlcanzable = proyectoDeTareaAlcanzable(tarea);

  const columnaIzquierda = (
    <View style={styles.columna}>
      <SeccionFicha
        titulo="Datos"
        icono="info-outline"
        accion={
          puedeEditar
            ? { etiqueta: 'Editar', icono: 'edit', onPress: () => setEditarVisible(true) }
            : undefined
        }
      >
        <View style={styles.datosGrid}>
          <Dato
            etiqueta="Responsable"
            valor={nombreUsuario(tarea.responsable_id, tarea.responsable_nombre)}
          />
          <Dato
            etiqueta="Fecha límite"
            valor={abierta ? textoVencimiento(tarea.fecha_limite) : formatFecha(tarea.fecha_limite)}
          />
          <Dato etiqueta="Departamento" valor={departamentos.nombrePorId(tarea.departamento_id)} />
          {nombreProyecto ? <Dato etiqueta="Proyecto" valor={nombreProyecto} /> : null}
          <Dato etiqueta="Creada por" valor={usuarios.nombrePorId(tarea.creado_por)} />
          {tarea.cerrada_en ? (
            <Dato etiqueta="Cerrada" valor={formatCreadoEn(tarea.cerrada_en)} />
          ) : null}
        </View>

        {proyectoAlcanzable ? (
          <TouchableOpacity
            style={[styles.enlaceProyecto, isCompact && styles.enlaceProyectoTactil]}
            onPress={() =>
              router.push(`/proyectos/${encodeURIComponent(tarea.proyecto_id as string)}` as never)
            }
          >
            <MaterialIcons name="folder-open" size={16} color="#0ea5e9" />
            <Text style={styles.enlaceProyectoTexto}>Ver el proyecto</Text>
          </TouchableOpacity>
        ) : null}

        {tarea.descripcion ? (
          <Text style={styles.descripcion}>{tarea.descripcion}</Text>
        ) : (
          <Text style={styles.sinDescripcion}>Sin descripción.</Text>
        )}

        {tarea.estado === 'bloqueada' && tarea.bloqueo_motivo ? (
          <View style={styles.bloqueo}>
            <MaterialIcons name="block" size={16} color="#b45309" />
            <Text style={styles.bloqueoTexto}>{tarea.bloqueo_motivo}</Text>
          </View>
        ) : null}

        {tarea.cita_origen ? (
          <View style={styles.cita}>
            <MaterialIcons name="format-quote" size={16} color="#94a3b8" />
            <Text style={styles.citaTexto}>{tarea.cita_origen}</Text>
          </View>
        ) : null}

        {puedeReasignar ? (
          <View style={styles.reasignarWrap}>
            <TouchableOpacity
              style={[styles.reasignarBtn, isCompact && styles.reasignarBtnTactil]}
              onPress={() => {
                setErrorReasignar(null);
                setPanelReasignar((v) => !v);
              }}
            >
              <MaterialIcons
                name={panelReasignar ? 'close' : 'swap-horiz'}
                size={16}
                color="#0ea5e9"
              />
              <Text style={styles.reasignarTexto}>
                {panelReasignar ? 'Cancelar la reasignación' : 'Reasignar'}
              </Text>
            </TouchableOpacity>

            {panelReasignar ? (
              <View style={styles.formEmbebido}>
                <SelectorDesplegable
                  label="Nuevo responsable"
                  icono="person"
                  placeholder="Selecciona una persona"
                  tituloLista="Reasignar la tarea"
                  iconoLista="swap-horiz"
                  buscador
                  buscadorPlaceholder="Buscar usuario…"
                  valorId={nuevoResponsable}
                  opciones={usuarios.opciones}
                  vacioTexto="No hay usuarios disponibles"
                  disabled={reasignando || usuarios.noDisponibles}
                  loading={usuarios.cargando}
                  onSeleccionar={setNuevoResponsable}
                />
                {usuarios.noDisponibles ? (
                  <View style={form.aviso}>
                    <MaterialIcons name="info-outline" size={14} color="#d97706" />
                    <Text style={form.avisoTexto}>
                      No se puede reasignar sin el permiso de usuarios.
                    </Text>
                  </View>
                ) : null}
                <TouchableOpacity
                  style={[styles.primarioBtn, isCompact && styles.primarioBtnTactil]}
                  onPress={() => void reasignar()}
                  disabled={reasignando}
                >
                  {reasignando ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.primarioTexto}>Reasignar la tarea</Text>
                  )}
                </TouchableOpacity>
                {errorReasignar ? <Text style={styles.errorSeccion}>{errorReasignar}</Text> : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </SeccionFicha>

      <SeccionFicha
        titulo="Lista de comprobación"
        icono="checklist"
        contador={checklist.length > 0 ? checklist.length : undefined}
      >
        <View style={styles.lista}>
          {checklist.length > 0 ? (
            <>
              <Text style={styles.progreso}>
                {hechos} de {checklist.length} completados
              </Text>
              {checklist.map((item) => (
                <View key={item.id} style={styles.filaLista}>
                  <TouchableOpacity
                    style={[styles.check, isCompact && styles.checkTactil]}
                    onPress={() =>
                      void operarChecklist(
                        item.id,
                        `/api/tareas/${encodeURIComponent(tarea.id_tarea)}/checklist/${encodeURIComponent(item.id)}`,
                        { method: 'PATCH', body: JSON.stringify({ hecho: !item.hecho }) },
                      )
                    }
                    disabled={!puedeEditar || itemEnCurso === item.id}
                    accessibilityLabel={item.hecho ? 'Desmarcar el elemento' : 'Marcar el elemento'}
                  >
                    {itemEnCurso === item.id ? (
                      <ActivityIndicator size="small" color="#0ea5e9" />
                    ) : (
                      <MaterialIcons
                        name={item.hecho ? 'check-box' : 'check-box-outline-blank'}
                        size={20}
                        color={item.hecho ? '#16a34a' : '#94a3b8'}
                      />
                    )}
                  </TouchableOpacity>
                  <Text style={[styles.itemTexto, item.hecho && styles.itemHecho]}>{item.texto}</Text>
                  {puedeEditar ? (
                    <TouchableOpacity
                      style={[styles.iconoBtn, isCompact && styles.iconoBtnTactil]}
                      onPress={() =>
                        void operarChecklist(
                          item.id,
                          `/api/tareas/${encodeURIComponent(tarea.id_tarea)}/checklist/${encodeURIComponent(item.id)}`,
                          { method: 'DELETE' },
                        )
                      }
                      disabled={itemEnCurso === item.id}
                      accessibilityLabel="Borrar el elemento"
                    >
                      <MaterialIcons name="delete-outline" size={16} color="#d97706" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
            </>
          ) : (
            <Text style={styles.vacioSeccion}>
              Todavía no hay elementos en la lista de comprobación.
            </Text>
          )}

          {puedeEditar ? (
            <View style={styles.filaNuevoItem}>
              <TextInput
                style={[form.input, styles.inputItem]}
                value={textoItem}
                onChangeText={setTextoItem}
                placeholder="Añadir un paso"
                placeholderTextColor="#94a3b8"
                editable={itemEnCurso !== 'nuevo'}
                onSubmitEditing={() => void anadirItem()}
                returnKeyType="done"
              />
              <TouchableOpacity
                style={[styles.primarioBtn, styles.primarioBtnCorto, isCompact && styles.primarioBtnTactil]}
                onPress={() => void anadirItem()}
                disabled={itemEnCurso === 'nuevo' || !textoItem.trim()}
              >
                {itemEnCurso === 'nuevo' ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <MaterialIcons name="add" size={18} color="#ffffff" />
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          {errorChecklist ? <Text style={styles.errorSeccion}>{errorChecklist}</Text> : null}
        </View>
      </SeccionFicha>

      {vinculos.length > 0 ? (
        <SeccionFicha titulo="Vínculos" icono="link" contador={vinculos.length}>
          <View style={styles.lista}>
            {vinculos.map((vinculo) => (
              <View key={`${vinculo.tipo}-${vinculo.id}`} style={styles.filaLista}>
                <MaterialIcons name="link" size={16} color="#94a3b8" />
                <View style={styles.filaTexto}>
                  <Text style={styles.filaTitulo}>{vinculo.etiqueta?.trim() || 'Sin etiqueta'}</Text>
                  <Text style={styles.filaSub}>
                    {ETIQUETA_TIPO_VINCULO[vinculo.tipo] ?? vinculo.tipo}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </SeccionFicha>
      ) : null}

      <SeccionEnlacesTarea
        idTarea={tarea.id_tarea}
        enlaces={tarea.enlaces ?? []}
        puedeEditar={puedeEditar}
        onEnlacesCambiados={(siguiente) =>
          setTarea((previa) => (previa ? { ...previa, enlaces: siguiente } : previa))
        }
        onPedirRefrescoCaptura={pedirRefrescoCaptura}
      />

      <SeccionAdjuntosTarea
        idTarea={tarea.id_tarea}
        adjuntos={tarea.adjuntos ?? []}
        puedeEditar={puedeEditar}
        onAdjuntosCambiados={(siguiente: AdjuntoTarea[]) =>
          setTarea((previa) => (previa ? { ...previa, adjuntos: siguiente } : previa))
        }
      />
    </View>
  );

  const columnaDerecha = (
    <View style={styles.columna}>
      <SeccionFicha
        titulo="Subtareas"
        icono="account-tree"
        contador={subtareas.length}
        cargando={cargandoSubtareas && subtareas.length === 0}
        error={subtareas.length === 0 ? errorSubtareas : null}
        onReintentar={() => void cargarSubtareas()}
        accion={
          puedeCrearSubtarea
            ? { etiqueta: 'Nueva', icono: 'add', onPress: () => setSubtareaVisible(true) }
            : undefined
        }
        vacio="Esta tarea no tiene subtareas."
      >
        {subtareas.length > 0 ? (
          <View style={styles.lista}>
            {subcambio.error ? <Text style={styles.errorSeccion}>{subcambio.error}</Text> : null}
            {subtareas.map((sub) => (
              <TarjetaTarea
                key={sub.id_tarea}
                tarea={sub}
                mostrarResponsable
                onAbrir={() =>
                  router.push(`/proyectos/tarea/${encodeURIComponent(sub.id_tarea)}` as never)
                }
                onCambiarEstado={
                  sub.permisos_fila?.editar
                    ? (destino) => subcambio.pedirCambio(sub, destino)
                    : undefined
                }
                ocupado={subcambio.enCurso?.idTarea === sub.id_tarea}
                estadoEnCurso={
                  subcambio.enCurso?.idTarea === sub.id_tarea ? subcambio.enCurso.destino : null
                }
              />
            ))}
          </View>
        ) : null}
      </SeccionFicha>

      <SeccionFicha
        titulo="Comentarios"
        icono="chat-bubble-outline"
        contador={comentarios.length}
        cargando={cargandoComentarios && comentarios.length === 0}
        error={comentarios.length === 0 ? errorComentarios : null}
        onReintentar={() => void cargarComentarios(null)}
      >
        <View style={styles.lista}>
          {/* Comentar exige nivel de edición: estar mencionado da lectura, nunca escritura. */}
          {puedeEditar ? (
            <View style={styles.formComentario}>
              <TextInput
                style={[form.input, form.inputMultilinea]}
                value={textoComentario}
                onChangeText={setTextoComentario}
                placeholder="Escribe un comentario; con @nombre mencionas a alguien"
                placeholderTextColor="#94a3b8"
                multiline
                editable={!enviandoComentario}
              />
              <TouchableOpacity
                style={[styles.primarioBtn, isCompact && styles.primarioBtnTactil]}
                onPress={() => void enviarComentario()}
                disabled={enviandoComentario || !textoComentario.trim()}
              >
                {enviandoComentario ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <>
                    <MaterialIcons name="send" size={16} color="#ffffff" />
                    <Text style={styles.primarioTexto}>Comentar</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          {comentarios.length === 0 && !cargandoComentarios ? (
            <Text style={styles.vacioSeccion}>Todavía no hay comentarios.</Text>
          ) : null}

          {comentarios.map((comentario) => (
            <View key={comentario.id_comentario} style={styles.comentario}>
              <Text style={styles.comentarioAutor}>
                {comentario.autor_nombre?.trim() || usuarios.nombrePorId(comentario.autor_id)}
                {' · '}
                {formatCreadoEn(comentario.creado_en)}
              </Text>
              <Text style={styles.comentarioTexto}>{comentario.texto}</Text>
            </View>
          ))}

          {comentarios.length > 0 && errorComentarios ? (
            <Text style={styles.errorSeccion}>{errorComentarios}</Text>
          ) : null}

          {cursorComentarios ? (
            <TouchableOpacity
              style={[styles.masBtn, isCompact && styles.masBtnTactil]}
              onPress={() => void cargarComentarios(cursorComentarios)}
              disabled={cargandoComentarios}
            >
              {cargandoComentarios ? (
                <ActivityIndicator size="small" color="#0ea5e9" />
              ) : (
                <>
                  <MaterialIcons name="expand-more" size={16} color="#0ea5e9" />
                  <Text style={styles.masTexto}>Ver más comentarios</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </SeccionFicha>

      <HistorialActividad actividad={actividad} nombrePorId={usuarios.nombrePorId} />
    </View>
  );

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.cabecera}>
          <View style={styles.cabeceraFila}>
            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.backBtn}
              accessibilityLabel="Volver"
            >
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <View style={styles.cabeceraTexto}>
              <Text style={styles.titulo}>{tarea.titulo}</Text>
              <View style={styles.cabeceraBadges}>
                <BadgeEstadoTarea estado={tarea.estado} grande />
                <BadgePrioridad prioridad={tarea.prioridad} siempre grande />
                <Text style={styles.cabeceraFecha}>{textoVencimiento(tarea.fecha_limite)}</Text>
              </View>
            </View>
          </View>

          {puedeEditar ? (
            <AccionesEstadoTarea
              estado={tarea.estado}
              onCambiar={(destino) => cambio.pedirCambio(tarea, destino)}
              ocupado={cambio.enCurso != null}
              estadoEnCurso={cambio.enCurso?.destino ?? null}
              tactil={isCompact}
            />
          ) : (
            <View style={styles.avisoSoloLectura}>
              <MaterialIcons name="lock-outline" size={15} color="#64748b" />
              <Text style={styles.avisoSoloLecturaTexto}>
                Solo lectura: esta tarea la cambia su responsable o quien pueda editar su proyecto.
              </Text>
            </View>
          )}

          {cambio.error ? (
            <TouchableOpacity style={styles.avisoError} onPress={cambio.descartarError}>
              <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
              <Text style={styles.avisoErrorTexto}>{cambio.error}</Text>
              <MaterialIcons name="close" size={16} color="#b91c1c" />
            </TouchableOpacity>
          ) : null}
        </View>

        {error ? <Text style={styles.errorGeneral}>{error}</Text> : null}

        <View style={[styles.cuerpo, shouldStackPanels && styles.cuerpoApilado]}>
          {columnaIzquierda}
          {columnaDerecha}
        </View>
      </ScrollView>

      <ModalFormularioTarea
        visible={editarVisible}
        modo="editar"
        tarea={tarea}
        usuarios={usuarios}
        departamentos={departamentos}
        onCerrar={() => setEditarVisible(false)}
        onGuardada={(guardada) => {
          setEditarVisible(false);
          setTarea((previa) => (previa ? { ...previa, ...guardada } : previa));
          actividad.recargar();
        }}
      />

      <ModalFormularioTarea
        visible={subtareaVisible}
        modo="crear"
        tareaPadreId={tarea.id_tarea}
        proyectoId={tarea.proyecto_id}
        departamentoPorDefecto={tarea.departamento_id}
        responsablePorDefecto={tarea.responsable_id}
        usuarios={usuarios}
        departamentos={departamentos}
        onCerrar={() => setSubtareaVisible(false)}
        onGuardada={() => {
          setSubtareaVisible(false);
          void cargarSubtareas();
          actividad.recargar();
        }}
      />

      <ModalMotivoBloqueo
        visible={cambio.tareaBloqueo != null || subcambio.tareaBloqueo != null}
        titulo={(cambio.tareaBloqueo ?? subcambio.tareaBloqueo)?.titulo}
        guardando={
          cambio.enCurso?.destino === 'bloqueada' || subcambio.enCurso?.destino === 'bloqueada'
        }
        onCancelar={() => {
          cambio.cancelarBloqueo();
          subcambio.cancelarBloqueo();
        }}
        onConfirmar={(motivo) => {
          if (cambio.tareaBloqueo) cambio.confirmarBloqueo(motivo);
          else subcambio.confirmarBloqueo(motivo);
        }}
      />
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
  container: { flex: 1, backgroundColor: '#e2e8f0' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32, gap: 12 },

  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center', lineHeight: 19 },
  centroError: { fontSize: 13, color: '#ef4444', textAlign: 'center' },
  volverBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: MIN_TOUCH },
  volverTexto: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },

  cabecera: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 10,
  },
  cabeceraFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cabeceraTexto: { flex: 1, minWidth: 0, gap: 6 },
  cabeceraBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  cabeceraFecha: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  backBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  titulo: { fontSize: 19, fontWeight: '700', color: '#0f172a', lineHeight: 25 },
  avisoSoloLectura: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  avisoSoloLecturaTexto: { flex: 1, fontSize: 12, color: '#64748b', lineHeight: 17 },
  avisoError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fee2e2',
    minHeight: MIN_TOUCH,
  },
  avisoErrorTexto: { flex: 1, fontSize: 12, color: '#b91c1c', lineHeight: 17 },
  errorGeneral: { fontSize: 12, color: '#ef4444' },

  cuerpo: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  cuerpoApilado: { flexDirection: 'column' },
  columna: { flex: 1, minWidth: 0, gap: 12, width: '100%' },

  datosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  dato: { minWidth: 130, gap: 2 },
  datoEtiqueta: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  datoValor: { fontSize: 13, fontWeight: '600', color: '#334155' },
  descripcion: { fontSize: 13, color: '#475569', lineHeight: 19 },
  sinDescripcion: { fontSize: 12, color: '#94a3b8' },
  enlaceProyecto: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  enlaceProyectoTactil: { minHeight: MIN_TOUCH },
  enlaceProyectoTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  bloqueo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fef3c7',
  },
  bloqueoTexto: { flex: 1, fontSize: 12, color: '#b45309', lineHeight: 17 },
  cita: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    borderLeftWidth: 3,
    borderLeftColor: '#cbd5e1',
  },
  citaTexto: { flex: 1, fontSize: 12, color: '#64748b', fontStyle: 'italic', lineHeight: 17 },

  reasignarWrap: { gap: 8 },
  reasignarBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  reasignarBtnTactil: { minHeight: MIN_TOUCH },
  reasignarTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },

  lista: { gap: 8 },
  progreso: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  filaLista: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  filaTexto: { flex: 1, minWidth: 0 },
  filaTitulo: { fontSize: 13, fontWeight: '600', color: '#334155' },
  filaSub: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  check: { padding: 2 },
  checkTactil: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  itemTexto: { flex: 1, fontSize: 13, color: '#334155', lineHeight: 18 },
  itemHecho: { color: '#94a3b8', textDecorationLine: 'line-through' },
  iconoBtn: {
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  iconoBtnTactil: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  filaNuevoItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputItem: { flex: 1 },
  vacioSeccion: { fontSize: 12, color: '#94a3b8', lineHeight: 18 },

  formEmbebido: {
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  formComentario: { gap: 8 },
  primarioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  primarioBtnCorto: { paddingHorizontal: 14, alignSelf: 'stretch' },
  primarioBtnTactil: { minHeight: MIN_TOUCH },
  primarioTexto: { fontSize: 13, fontWeight: '700', color: '#ffffff' },
  errorSeccion: { fontSize: 12, color: '#ef4444', lineHeight: 17 },

  comentario: {
    gap: 3,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  comentarioAutor: { fontSize: 11, fontWeight: '600', color: '#94a3b8' },
  comentarioTexto: { fontSize: 13, color: '#334155', lineHeight: 18 },

  masBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  masBtnTactil: { minHeight: MIN_TOUCH },
  masTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
});
