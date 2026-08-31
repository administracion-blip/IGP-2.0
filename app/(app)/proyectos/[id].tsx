/**
 * Ficha de un proyecto: cabecera, datos, presupuesto, miembros, tareas, vínculos
 * e historial.
 *
 * Qué puede hacer quien mira lo dice `permisos_fila` de la respuesta, tanto para
 * el proyecto como para cada tarea: la pantalla no lo recalcula.
 *
 * El presupuesto y los dos gastos **solo se pintan si llegan** en la respuesta:
 * sin `proyectos.presupuesto_ver` el backend no manda esos campos, y enseñar un
 * cero haría pensar que el proyecto no tiene presupuesto asignado.
 *
 * Un proyecto que no se alcanza responde `404`, no `403`, así que se trata como
 * «no existe o ya no está disponible» y nunca como falta de permiso.
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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import { useActividadTasks } from '../../hooks/useActividadTasks';
import { useCambioEstadoTarea } from '../../hooks/useCambioEstadoTarea';
import { puedeVerPresupuesto, puedeVerProyectos, puedeVerReuniones, puedeGestionarReuniones } from '../../lib/tasksAcceso';
import {
  ETIQUETA_ROL_PROYECTO,
  ETIQUETA_TIPO_VINCULO,
  formatEuros,
  nombreUsuario,
} from '../../lib/tasksUi';
import { SeccionFicha } from '../../components/tasks/SeccionFicha';
import {
  BadgeEstadoProyecto,
  BadgeEstadoReunion,
  BadgePrioridad,
  BadgeRolProyecto,
} from '../../components/tasks/BadgesTasks';
import { TarjetaTarea } from '../../components/tasks/TarjetaTarea';
import { HistorialActividad } from '../../components/tasks/HistorialActividad';
import { ModalMotivoBloqueo } from '../../components/tasks/ModalMotivoBloqueo';
import { ModalFormularioProyecto } from '../../components/tasks/ModalFormularioProyecto';
import { ModalFormularioTarea } from '../../components/tasks/ModalFormularioTarea';
import {
  ModalFormularioReunion,
  type ResultadoGuardadoReunion,
} from '../../components/tasks/ModalFormularioReunion';
import { estilosFormTasks as form } from '../../components/tasks/estilosTasks';
import { SelectorDesplegable, type OpcionDesplegable } from '../../components/SelectorDesplegable';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';
import {
  ROLES_PROYECTO,
  TIPOS_VINCULO,
  type Proyecto,
  type ProyectoDetalle,
  type ProyectoMiembro,
  type Reunion,
  type RolProyecto,
  type Tarea,
  type TipoVinculo,
  type Vinculo,
} from '../../types/tasks';

/** Cabecera del proyecto tal como la devuelve el detalle: los gastos son opcionales. */
type ProyectoFicha = Proyecto & Partial<Pick<ProyectoDetalle, 'gasto_comprometido' | 'gasto_real'>>;

const CERRADAS: readonly string[] = ['hecha', 'cancelada'];
const LIMITE_TAREAS = 100;
const LIMITE_REUNIONES = 50;

export default function FichaProyectoScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const idProyecto = Array.isArray(params.id) ? params.id[0] : params.id ?? '';

  const acceso = useAccesoTasks();
  const { shouldStackPanels, isCompact } = useBreakpoint();
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();

  const [proyecto, setProyecto] = useState<ProyectoFicha | null>(null);
  const [miembros, setMiembros] = useState<ProyectoMiembro[]>([]);
  const [vinculos, setVinculos] = useState<Vinculo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noDisponible, setNoDisponible] = useState(false);

  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [cursorTareas, setCursorTareas] = useState<string | null>(null);
  const [cargandoTareas, setCargandoTareas] = useState(false);
  const [cargandoMasTareas, setCargandoMasTareas] = useState(false);
  const [errorTareas, setErrorTareas] = useState<string | null>(null);
  const [verCerradas, setVerCerradas] = useState(false);

  const [editarVisible, setEditarVisible] = useState(false);
  const [nuevaTareaVisible, setNuevaTareaVisible] = useState(false);
  const [nuevaReunionVisible, setNuevaReunionVisible] = useState(false);
  const [avisoCalendario, setAvisoCalendario] = useState<string | null>(null);

  const [reuniones, setReuniones] = useState<Reunion[]>([]);
  const [cargandoReuniones, setCargandoReuniones] = useState(false);
  const [errorReuniones, setErrorReuniones] = useState<string | null>(null);

  const [miembroNuevo, setMiembroNuevo] = useState('');
  const [rolNuevo, setRolNuevo] = useState<RolProyecto>('miembro');
  const [formMiembroVisible, setFormMiembroVisible] = useState(false);
  const [guardandoMiembro, setGuardandoMiembro] = useState(false);
  const [errorMiembros, setErrorMiembros] = useState<string | null>(null);

  const [formVinculoVisible, setFormVinculoVisible] = useState(false);
  const [tipoVinculo, setTipoVinculo] = useState<TipoVinculo>('local');
  const [idVinculo, setIdVinculo] = useState('');
  const [etiquetaVinculo, setEtiquetaVinculo] = useState('');
  const [guardandoVinculo, setGuardandoVinculo] = useState(false);
  const [errorVinculos, setErrorVinculos] = useState<string | null>(null);

  const actividad = useActividadTasks(
    idProyecto ? `/api/proyectos/${encodeURIComponent(idProyecto)}/actividad` : null,
  );

  const puedeVer = puedeVerProyectos(acceso);
  // Lo que se puede hacer con esta fila lo dice el servidor, no la pantalla.
  const puedeEditar = proyecto?.permisos_fila?.editar === true;
  const puedeBorrar = proyecto?.permisos_fila?.borrar === true;
  const puedeVerReu = puedeVerReuniones(acceso);
  const puedeGestionarReu = puedeGestionarReuniones(acceso);
  // Informativo: la fila de miembro de quien mira, si está entre los miembros.
  const miRol = useMemo(
    () => miembros.find((m) => m.usuario_id === acceso.usuarioId)?.rol_proyecto ?? null,
    [miembros, acceso.usuarioId],
  );

  const cargarFicha = useCallback(async () => {
    if (!idProyecto || !puedeVer) return;
    setCargando(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/proyectos/${encodeURIComponent(idProyecto)}`);
      const data = (await res.json().catch(() => ({}))) as {
        proyecto?: ProyectoFicha;
        miembros?: ProyectoMiembro[];
        vinculos?: Vinculo[];
        error?: string;
      };
      if (res.status === 404) {
        setNoDisponible(true);
        return;
      }
      if (!res.ok || !data.proyecto) {
        setError(data.error || 'No se pudo cargar el proyecto');
        return;
      }
      setProyecto(data.proyecto);
      setMiembros(Array.isArray(data.miembros) ? data.miembros : []);
      setVinculos(Array.isArray(data.vinculos) ? data.vinculos : []);
    } catch (e) {
      console.error('[tasks] fallo al leer la ficha del proyecto', e);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setCargando(false);
    }
  }, [idProyecto, puedeVer]);

  /**
   * El índice devuelve las abiertas antes que las cerradas, así que la primera
   * página basta casi siempre; aun así se sigue el cursor para que un proyecto
   * grande no deje tareas fuera sin decirlo.
   */
  const cargarTareas = useCallback(
    async (desde?: string | null) => {
      if (!idProyecto || !puedeVer) return;
      if (desde) setCargandoMasTareas(true);
      else setCargandoTareas(true);
      setErrorTareas(null);
      try {
        const query = new URLSearchParams({ proyecto: idProyecto, limite: String(LIMITE_TAREAS) });
        if (desde) query.set('cursor', desde);
        const res = await apiFetch(`/api/tareas?${query.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          tareas?: Tarea[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setErrorTareas(data.error || 'No se pudieron cargar las tareas del proyecto');
          return;
        }
        const lote = Array.isArray(data.tareas) ? data.tareas : [];
        setTareas((previas) => (desde ? [...previas, ...lote] : lote));
        setCursorTareas(data.cursor ?? null);
      } catch (e) {
        console.error('[tasks] fallo al listar las tareas del proyecto', e);
        setErrorTareas(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setCargandoTareas(false);
        setCargandoMasTareas(false);
      }
    },
    [idProyecto, puedeVer],
  );

  const cargarReuniones = useCallback(async () => {
    if (!idProyecto || !puedeVer || !puedeVerReu) return;
    setCargandoReuniones(true);
    setErrorReuniones(null);
    try {
      const query = new URLSearchParams({
        proyecto: idProyecto,
        limite: String(LIMITE_REUNIONES),
      });
      const res = await apiFetch(`/api/reuniones?${query.toString()}`);
      const data = (await res.json().catch(() => ({}))) as {
        reuniones?: Reunion[];
        error?: string;
      };
      if (!res.ok) {
        setErrorReuniones(data.error || 'No se pudieron cargar las reuniones del proyecto');
        return;
      }
      setReuniones(Array.isArray(data.reuniones) ? data.reuniones : []);
    } catch (e) {
      console.error('[tasks] fallo al listar las reuniones del proyecto', e);
      setErrorReuniones(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setCargandoReuniones(false);
    }
  }, [idProyecto, puedeVer, puedeVerReu]);

  useEffect(() => {
    void cargarFicha();
  }, [cargarFicha]);

  useEffect(() => {
    void cargarTareas();
  }, [cargarTareas]);

  useEffect(() => {
    void cargarReuniones();
  }, [cargarReuniones]);

  const onTareaCambiada = useCallback((actualizada: Tarea) => {
    setTareas((previas) =>
      previas.map((t) => (t.id_tarea === actualizada.id_tarea ? actualizada : t)),
    );
  }, []);

  const onTareaNoDisponible = useCallback((idTarea: string) => {
    setTareas((previas) => previas.filter((t) => t.id_tarea !== idTarea));
  }, []);

  const cambio = useCambioEstadoTarea({
    onCambiada: onTareaCambiada,
    onNoDisponible: onTareaNoDisponible,
  });

  const tareasVisibles = useMemo(
    () => (verCerradas ? tareas : tareas.filter((t) => !CERRADAS.includes(t.estado))),
    [tareas, verCerradas],
  );
  const cerradas = useMemo(() => tareas.filter((t) => CERRADAS.includes(t.estado)).length, [tareas]);

  const opcionesMiembro = useMemo<OpcionDesplegable[]>(
    () => usuarios.opciones.filter((o) => !miembros.some((m) => m.usuario_id === o.id)),
    [usuarios.opciones, miembros],
  );

  const opcionesTipoVinculo = useMemo<OpcionDesplegable[]>(
    () => TIPOS_VINCULO.map((t) => ({ id: t, titulo: ETIQUETA_TIPO_VINCULO[t] })),
    [],
  );

  const guardarMiembro = useCallback(async () => {
    if (!idProyecto) return;
    if (!miembroNuevo.trim()) {
      setErrorMiembros('Elige la persona que entra en el proyecto');
      return;
    }
    setGuardandoMiembro(true);
    setErrorMiembros(null);
    try {
      const res = await apiFetch(`/api/proyectos/${encodeURIComponent(idProyecto)}/miembros`, {
        method: 'POST',
        body: JSON.stringify({ usuario_id: miembroNuevo.trim(), rol_proyecto: rolNuevo }),
      });
      const data = (await res.json().catch(() => ({}))) as { miembro?: ProyectoMiembro; error?: string };
      if (!res.ok || !data.miembro) {
        setErrorMiembros(data.error || 'No se pudo añadir el miembro');
        return;
      }
      const guardado = data.miembro;
      setMiembros((previos) => {
        const resto = previos.filter((m) => m.usuario_id !== guardado.usuario_id);
        return [...resto, guardado];
      });
      setMiembroNuevo('');
      setRolNuevo('miembro');
      setFormMiembroVisible(false);
      actividad.recargar();
    } catch (e) {
      console.error('[tasks] fallo al añadir el miembro', e);
      setErrorMiembros(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardandoMiembro(false);
    }
  }, [idProyecto, miembroNuevo, rolNuevo, actividad]);

  const quitarMiembro = useCallback(
    async (miembro: ProyectoMiembro) => {
      if (!idProyecto) return;
      setGuardandoMiembro(true);
      setErrorMiembros(null);
      try {
        const res = await apiFetch(
          `/api/proyectos/${encodeURIComponent(idProyecto)}/miembros/${encodeURIComponent(miembro.usuario_id)}`,
          { method: 'DELETE' },
        );
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setErrorMiembros(data.error || 'No se pudo retirar el miembro');
          return;
        }
        setMiembros((previos) => previos.filter((m) => m.usuario_id !== miembro.usuario_id));
        actividad.recargar();
      } catch (e) {
        console.error('[tasks] fallo al retirar el miembro', e);
        setErrorMiembros(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setGuardandoMiembro(false);
      }
    },
    [idProyecto, actividad],
  );

  const guardarVinculo = useCallback(async () => {
    if (!idProyecto) return;
    const id = idVinculo.trim();
    const etiqueta = etiquetaVinculo.trim();
    if (!id || !etiqueta) {
      setErrorVinculos('Hacen falta la referencia y su etiqueta: la etiqueta es lo que se ve en la ficha');
      return;
    }
    setGuardandoVinculo(true);
    setErrorVinculos(null);
    try {
      const res = await apiFetch(`/api/proyectos/${encodeURIComponent(idProyecto)}/vinculos`, {
        method: 'POST',
        body: JSON.stringify({ tipo: tipoVinculo, id, etiqueta }),
      });
      const data = (await res.json().catch(() => ({}))) as { vinculo?: Vinculo; error?: string };
      if (!res.ok || !data.vinculo) {
        setErrorVinculos(data.error || 'No se pudo añadir el vínculo');
        return;
      }
      const guardado = data.vinculo;
      setVinculos((previos) => [
        ...previos.filter((v) => !(v.tipo === guardado.tipo && v.id === guardado.id)),
        guardado,
      ]);
      setIdVinculo('');
      setEtiquetaVinculo('');
      setFormVinculoVisible(false);
      actividad.recargar();
    } catch (e) {
      console.error('[tasks] fallo al añadir el vínculo', e);
      setErrorVinculos(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardandoVinculo(false);
    }
  }, [idProyecto, tipoVinculo, idVinculo, etiquetaVinculo, actividad]);

  const quitarVinculo = useCallback(
    async (vinculo: Vinculo) => {
      if (!idProyecto) return;
      setGuardandoVinculo(true);
      setErrorVinculos(null);
      try {
        const res = await apiFetch(
          `/api/proyectos/${encodeURIComponent(idProyecto)}/vinculos/${encodeURIComponent(vinculo.tipo)}/${encodeURIComponent(vinculo.id)}`,
          { method: 'DELETE' },
        );
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setErrorVinculos(data.error || 'No se pudo retirar el vínculo');
          return;
        }
        setVinculos((previos) =>
          previos.filter((v) => !(v.tipo === vinculo.tipo && v.id === vinculo.id)),
        );
        actividad.recargar();
      } catch (e) {
        console.error('[tasks] fallo al retirar el vínculo', e);
        setErrorVinculos(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setGuardandoVinculo(false);
      }
    },
    [idProyecto, actividad],
  );

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
        <Text style={styles.centroTexto}>No tienes permiso para ver los proyectos.</Text>
      </View>
    );
  }

  if (noDisponible) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="search-off" size={36} color="#94a3b8" />
        <Text style={styles.centroTexto}>
          Este proyecto no existe o ya no está disponible.
        </Text>
        <TouchableOpacity style={styles.volverBtn} onPress={() => router.push('/proyectos/listado' as never)}>
          <MaterialIcons name="arrow-back" size={18} color="#0ea5e9" />
          <Text style={styles.volverTexto}>Volver al listado</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (cargando && !proyecto) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator size="large" color="#0ea5e9" />
        <Text style={styles.centroTexto}>Cargando el proyecto…</Text>
      </View>
    );
  }

  if (!proyecto) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="error-outline" size={36} color="#f87171" />
        <Text style={styles.centroError}>{error ?? 'No se pudo cargar el proyecto'}</Text>
        <TouchableOpacity style={styles.volverBtn} onPress={() => void cargarFicha()}>
          <MaterialIcons name="refresh" size={18} color="#0ea5e9" />
          <Text style={styles.volverTexto}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const muestraPresupuesto =
    proyecto.presupuesto_asignado != null ||
    proyecto.gasto_comprometido != null ||
    proyecto.gasto_real != null;

  const columnaIzquierda = (
    <View style={styles.columna}>
      <SeccionFicha titulo="Datos del proyecto" icono="info-outline">
        <View style={styles.datosGrid}>
          <Dato etiqueta="Departamento" valor={departamentos.nombrePorId(proyecto.departamento_id)} />
          <Dato
            etiqueta="Responsable"
            valor={nombreUsuario(proyecto.responsable_id, proyecto.responsable_nombre)}
          />
          <Dato etiqueta="Inicio" valor={formatFecha(proyecto.fecha_inicio)} />
          <Dato etiqueta="Fin previsto" valor={formatFecha(proyecto.fecha_fin_prevista)} />
          {proyecto.fecha_cierre ? (
            <Dato etiqueta="Cierre" valor={formatFecha(proyecto.fecha_cierre)} />
          ) : null}
          <Dato etiqueta="Creado por" valor={usuarios.nombrePorId(proyecto.creado_por)} />
        </View>
        {proyecto.descripcion ? (
          <Text style={styles.descripcion}>{proyecto.descripcion}</Text>
        ) : (
          <Text style={styles.sinDescripcion}>Sin descripción.</Text>
        )}
      </SeccionFicha>

      {muestraPresupuesto ? (
        <SeccionFicha titulo="Presupuesto" icono="euro">
          <View style={styles.datosGrid}>
            {proyecto.presupuesto_asignado != null ? (
              <Dato etiqueta="Asignado" valor={formatEuros(proyecto.presupuesto_asignado)} />
            ) : null}
            {proyecto.gasto_comprometido != null ? (
              <Dato etiqueta="Comprometido" valor={formatEuros(proyecto.gasto_comprometido)} />
            ) : null}
            {proyecto.gasto_real != null ? (
              <Dato etiqueta="Gasto real" valor={formatEuros(proyecto.gasto_real)} />
            ) : null}
          </View>
          <Text style={styles.notaSeccion}>
            El comprometido y el real se calculan a partir de las líneas de compra, que llegan en una fase
            posterior.
          </Text>
        </SeccionFicha>
      ) : null}

      <SeccionFicha
        titulo="Miembros"
        icono="group"
        contador={miembros.length}
        accion={
          puedeEditar
            ? {
                etiqueta: formMiembroVisible ? 'Cerrar' : 'Añadir',
                icono: formMiembroVisible ? 'close' : 'person-add',
                onPress: () => {
                  setErrorMiembros(null);
                  setFormMiembroVisible((v) => !v);
                },
              }
            : undefined
        }
        vacio="Todavía no hay miembros además del responsable."
      >
        {miembros.length > 0 || formMiembroVisible || errorMiembros ? (
          <View style={styles.lista}>
            {miembros.map((miembro) => (
              <View key={miembro.usuario_id} style={styles.filaLista}>
                <View style={styles.filaTexto}>
                  <Text style={styles.filaTitulo}>
                    {nombreUsuario(miembro.usuario_id, miembro.usuario_nombre)}
                  </Text>
                </View>
                <BadgeRolProyecto rol={miembro.rol_proyecto} />
                {puedeEditar ? (
                  <TouchableOpacity
                    style={[styles.iconoBtn, isCompact && styles.iconoBtnTactil]}
                    onPress={() => void quitarMiembro(miembro)}
                    disabled={guardandoMiembro}
                    accessibilityLabel={`Retirar a ${nombreUsuario(miembro.usuario_id, miembro.usuario_nombre)}`}
                  >
                    <MaterialIcons name="person-remove" size={16} color="#d97706" />
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}

            {formMiembroVisible ? (
              <View style={styles.formEmbebido}>
                <SelectorDesplegable
                  label="Persona"
                  icono="person"
                  placeholder="Selecciona una persona"
                  tituloLista="Añadir al proyecto"
                  iconoLista="person-add"
                  buscador
                  buscadorPlaceholder="Buscar usuario…"
                  valorId={miembroNuevo}
                  opciones={opcionesMiembro}
                  vacioTexto="No queda nadie por añadir"
                  disabled={guardandoMiembro || usuarios.noDisponibles}
                  loading={usuarios.cargando}
                  onSeleccionar={setMiembroNuevo}
                />
                {usuarios.noDisponibles ? (
                  <View style={form.aviso}>
                    <MaterialIcons name="info-outline" size={14} color="#d97706" />
                    <Text style={form.avisoTexto}>
                      No se pueden añadir miembros sin el permiso de usuarios.
                    </Text>
                  </View>
                ) : null}
                <Text style={form.label}>Rol en el proyecto</Text>
                <View style={form.chipsRow}>
                  {ROLES_PROYECTO.map((rol) => (
                    <TouchableOpacity
                      key={rol}
                      style={[form.chip, isCompact && form.chipTactil, rolNuevo === rol && form.chipActivo]}
                      onPress={() => setRolNuevo(rol)}
                      disabled={guardandoMiembro}
                    >
                      <Text style={[form.chipTexto, rolNuevo === rol && form.chipTextoActivo]}>
                        {ETIQUETA_ROL_PROYECTO[rol]}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={form.help}>
                  Volver a añadir a alguien que ya está solo le cambia el rol. El observador nunca edita.
                </Text>
                <TouchableOpacity
                  style={[styles.primarioBtn, isCompact && styles.primarioBtnTactil]}
                  onPress={() => void guardarMiembro()}
                  disabled={guardandoMiembro}
                >
                  {guardandoMiembro ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.primarioTexto}>Guardar miembro</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}

            {errorMiembros ? <Text style={styles.errorSeccion}>{errorMiembros}</Text> : null}
          </View>
        ) : null}
      </SeccionFicha>

      <SeccionFicha
        titulo="Vínculos"
        icono="link"
        contador={vinculos.length}
        accion={
          puedeEditar
            ? {
                etiqueta: formVinculoVisible ? 'Cerrar' : 'Añadir',
                icono: formVinculoVisible ? 'close' : 'add-link',
                onPress: () => {
                  setErrorVinculos(null);
                  setFormVinculoVisible((v) => !v);
                },
              }
            : undefined
        }
        vacio="Sin entidades de negocio vinculadas."
      >
        {vinculos.length > 0 || formVinculoVisible || errorVinculos ? (
          <View style={styles.lista}>
            {vinculos.map((vinculo) => (
              <View key={`${vinculo.tipo}-${vinculo.id}`} style={styles.filaLista}>
                <MaterialIcons name="link" size={16} color="#94a3b8" />
                <View style={styles.filaTexto}>
                  <Text style={styles.filaTitulo}>{vinculo.etiqueta?.trim() || 'Sin etiqueta'}</Text>
                  <Text style={styles.filaSub}>{ETIQUETA_TIPO_VINCULO[vinculo.tipo] ?? vinculo.tipo}</Text>
                </View>
                {puedeEditar ? (
                  <TouchableOpacity
                    style={[styles.iconoBtn, isCompact && styles.iconoBtnTactil]}
                    onPress={() => void quitarVinculo(vinculo)}
                    disabled={guardandoVinculo}
                    accessibilityLabel="Retirar el vínculo"
                  >
                    <MaterialIcons name="link-off" size={16} color="#d97706" />
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}

            {formVinculoVisible ? (
              <View style={styles.formEmbebido}>
                <SelectorDesplegable
                  label="Tipo"
                  icono="category"
                  tituloLista="Tipo de entidad"
                  iconoLista="category"
                  valorId={tipoVinculo}
                  opciones={opcionesTipoVinculo}
                  disabled={guardandoVinculo}
                  onSeleccionar={(id) => setTipoVinculo(id as TipoVinculo)}
                />
                <Text style={form.label}>Referencia de la entidad</Text>
                <TextInput
                  style={form.input}
                  value={idVinculo}
                  onChangeText={setIdVinculo}
                  placeholder="Identificador de la entidad en su módulo"
                  placeholderTextColor="#94a3b8"
                  editable={!guardandoVinculo}
                />
                <Text style={form.label}>Etiqueta *</Text>
                <TextInput
                  style={form.input}
                  value={etiquetaVinculo}
                  onChangeText={setEtiquetaVinculo}
                  placeholder="Nombre con el que se verá aquí"
                  placeholderTextColor="#94a3b8"
                  editable={!guardandoVinculo}
                />
                <Text style={form.help}>
                  La etiqueta es lo que se muestra en la ficha, así que conviene que se entienda sola.
                </Text>
                <TouchableOpacity
                  style={[styles.primarioBtn, isCompact && styles.primarioBtnTactil]}
                  onPress={() => void guardarVinculo()}
                  disabled={guardandoVinculo}
                >
                  {guardandoVinculo ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.primarioTexto}>Guardar vínculo</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}

            {errorVinculos ? <Text style={styles.errorSeccion}>{errorVinculos}</Text> : null}
          </View>
        ) : null}
      </SeccionFicha>
    </View>
  );

  const columnaDerecha = (
    <View style={styles.columna}>
      <SeccionFicha
        titulo="Tareas del proyecto"
        icono="checklist"
        contador={tareasVisibles.length}
        cargando={cargandoTareas && tareas.length === 0}
        error={tareas.length === 0 ? errorTareas : null}
        onReintentar={() => void cargarTareas()}
        accion={
          puedeEditar
            ? { etiqueta: 'Nueva tarea', icono: 'add', onPress: () => setNuevaTareaVisible(true) }
            : undefined
        }
        vacio="Este proyecto no tiene tareas todavía."
      >
        {tareas.length > 0 ? (
          <View style={styles.lista}>
            {cerradas > 0 ? (
              <TouchableOpacity
                style={[styles.toggleCerradas, isCompact && styles.toggleCerradasTactil]}
                onPress={() => setVerCerradas((v) => !v)}
              >
                <MaterialIcons
                  name={verCerradas ? 'visibility-off' : 'visibility'}
                  size={15}
                  color="#0ea5e9"
                />
                <Text style={styles.toggleCerradasTexto}>
                  {verCerradas
                    ? 'Ocultar las cerradas'
                    : `Ver también las cerradas (${cerradas})`}
                </Text>
              </TouchableOpacity>
            ) : null}
            {cambio.error ? <Text style={styles.errorSeccion}>{cambio.error}</Text> : null}
            {tareasVisibles.map((tarea) => (
              <TarjetaTarea
                key={tarea.id_tarea}
                tarea={tarea}
                mostrarResponsable
                onAbrir={() =>
                  router.push(`/proyectos/tarea/${encodeURIComponent(tarea.id_tarea)}` as never)
                }
                onCambiarEstado={
                  tarea.permisos_fila?.editar
                    ? (destino) => cambio.pedirCambio(tarea, destino)
                    : undefined
                }
                ocupado={cambio.enCurso?.idTarea === tarea.id_tarea}
                estadoEnCurso={
                  cambio.enCurso?.idTarea === tarea.id_tarea ? cambio.enCurso.destino : null
                }
              />
            ))}
            {cursorTareas ? (
              <TouchableOpacity
                style={[styles.masBtn, isCompact && styles.masBtnTactil]}
                onPress={() => void cargarTareas(cursorTareas)}
                disabled={cargandoMasTareas}
              >
                {cargandoMasTareas ? (
                  <ActivityIndicator size="small" color="#0ea5e9" />
                ) : (
                  <>
                    <MaterialIcons name="expand-more" size={16} color="#0ea5e9" />
                    <Text style={styles.masTexto}>Cargar más tareas</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}
            {errorTareas ? <Text style={styles.errorSeccion}>{errorTareas}</Text> : null}
          </View>
        ) : null}
      </SeccionFicha>

      {puedeVerReu ? (
        <SeccionFicha
          titulo="Reuniones del proyecto"
          icono="event"
          contador={reuniones.length}
          cargando={cargandoReuniones && reuniones.length === 0}
          error={reuniones.length === 0 ? errorReuniones : null}
          onReintentar={() => void cargarReuniones()}
          accion={
            puedeGestionarReu
              ? {
                  etiqueta: 'Nueva reunión',
                  icono: 'add',
                  onPress: () => {
                    setAvisoCalendario(null);
                    setNuevaReunionVisible(true);
                  },
                }
              : undefined
          }
          vacio="Este proyecto no tiene reuniones todavía."
        >
          {reuniones.length > 0 ? (
            <View style={styles.lista}>
              {avisoCalendario ? (
                <View style={styles.avisoCalendario}>
                  <MaterialIcons name="event-busy" size={15} color="#b45309" />
                  <Text style={styles.avisoCalendarioTexto}>{avisoCalendario}</Text>
                  <TouchableOpacity
                    onPress={() => setAvisoCalendario(null)}
                    accessibilityLabel="Cerrar aviso de calendario"
                  >
                    <MaterialIcons name="close" size={16} color="#b45309" />
                  </TouchableOpacity>
                </View>
              ) : null}
              {reuniones.map((reunion) => (
                <TouchableOpacity
                  key={reunion.id_reunion}
                  style={[styles.filaLista, isCompact && styles.filaReunionTactil]}
                  onPress={() =>
                    router.push(`/reuniones/${encodeURIComponent(reunion.id_reunion)}` as never)
                  }
                  accessibilityLabel={`Abrir reunión ${reunion.titulo}`}
                >
                  <MaterialIcons name="event" size={16} color="#94a3b8" />
                  <View style={styles.filaTexto}>
                    <Text style={styles.filaTitulo} numberOfLines={1}>
                      {reunion.titulo?.trim() || 'Sin título'}
                    </Text>
                    <Text style={styles.filaSub}>{formatFecha(reunion.fecha)}</Text>
                  </View>
                  <BadgeEstadoReunion estado={reunion.estado} />
                </TouchableOpacity>
              ))}
              {errorReuniones ? <Text style={styles.errorSeccion}>{errorReuniones}</Text> : null}
            </View>
          ) : avisoCalendario ? (
            <View style={styles.avisoCalendario}>
              <MaterialIcons name="event-busy" size={15} color="#b45309" />
              <Text style={styles.avisoCalendarioTexto}>{avisoCalendario}</Text>
              <TouchableOpacity
                onPress={() => setAvisoCalendario(null)}
                accessibilityLabel="Cerrar aviso de calendario"
              >
                <MaterialIcons name="close" size={16} color="#b45309" />
              </TouchableOpacity>
            </View>
          ) : null}
        </SeccionFicha>
      ) : null}

      <HistorialActividad actividad={actividad} nombrePorId={usuarios.nombrePorId} />
    </View>
  );

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.cabecera}>
          <View style={styles.cabeceraFila}>
            <TouchableOpacity
              onPress={() => router.push('/proyectos/listado' as never)}
              style={styles.backBtn}
              accessibilityLabel="Volver al listado de proyectos"
            >
              <MaterialIcons name="arrow-back" size={22} color="#334155" />
            </TouchableOpacity>
            <View style={styles.cabeceraTexto}>
              <Text style={styles.titulo}>{proyecto.nombre}</Text>
              <View style={styles.cabeceraBadges}>
                <BadgeEstadoProyecto estado={proyecto.estado} grande />
                <BadgePrioridad prioridad={proyecto.prioridad} grande />
                {miRol ? <BadgeRolProyecto rol={miRol} /> : null}
              </View>
            </View>
            {puedeEditar ? (
              <TouchableOpacity
                style={[styles.editarBtn, isCompact && styles.editarBtnTactil]}
                onPress={() => setEditarVisible(true)}
                accessibilityLabel="Editar el proyecto"
              >
                <MaterialIcons name="edit" size={16} color="#ffffff" />
                <Text style={styles.editarTexto}>Editar</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {!puedeEditar ? (
            <View style={styles.avisoSoloLectura}>
              <MaterialIcons name="lock-outline" size={15} color="#64748b" />
              <Text style={styles.avisoSoloLecturaTexto}>
                Solo lectura: para cambiar este proyecto hay que ser su responsable o miembro con permiso
                de edición.
              </Text>
            </View>
          ) : null}
          {puedeBorrar && puedeEditar && proyecto.estado !== 'cancelado' ? (
            <Text style={styles.notaCancelar}>
              Para retirar el proyecto sin perder su historial, cámbialo a «Cancelado» desde Editar.
            </Text>
          ) : null}
        </View>

        {error ? <Text style={styles.errorGeneral}>{error}</Text> : null}

        <View style={[styles.cuerpo, shouldStackPanels && styles.cuerpoApilado]}>
          {columnaIzquierda}
          {columnaDerecha}
        </View>
      </ScrollView>

      <ModalFormularioProyecto
        visible={editarVisible}
        modo="editar"
        proyecto={proyecto}
        puedeVerPresupuesto={puedeVerPresupuesto(acceso)}
        usuarios={usuarios}
        departamentos={departamentos}
        onCerrar={() => setEditarVisible(false)}
        onGuardado={(guardado) => {
          setEditarVisible(false);
          setProyecto((previo) => ({ ...(previo ?? {}), ...guardado }) as ProyectoFicha);
          actividad.recargar();
        }}
      />

      <ModalFormularioTarea
        visible={nuevaTareaVisible}
        modo="crear"
        proyectoId={idProyecto}
        departamentoPorDefecto={proyecto.departamento_id}
        responsablePorDefecto={acceso.usuarioId}
        usuarios={usuarios}
        departamentos={departamentos}
        onCerrar={() => setNuevaTareaVisible(false)}
        onGuardada={() => {
          setNuevaTareaVisible(false);
          void cargarTareas();
          actividad.recargar();
        }}
      />

      {nuevaReunionVisible ? (
        <ModalFormularioReunion
          visible
          modo="crear"
          proyectoId={idProyecto}
          usuarios={usuarios}
          departamentos={departamentos}
          onCerrar={() => setNuevaReunionVisible(false)}
          onGuardado={(resultado: ResultadoGuardadoReunion) => {
            setNuevaReunionVisible(false);
            if (resultado.avisoCalendario) setAvisoCalendario(resultado.avisoCalendario);
            else if (resultado.calendarioSincronizado === false) {
              setAvisoCalendario(
                'La reunión se guardó, pero no se pudo sincronizar con Google Calendar.',
              );
            }
            void cargarReuniones();
            actividad.recargar();
          }}
        />
      ) : null}

      <ModalMotivoBloqueo
        visible={cambio.tareaBloqueo != null}
        titulo={cambio.tareaBloqueo?.titulo}
        guardando={cambio.enCurso?.destino === 'bloqueada'}
        onCancelar={cambio.cancelarBloqueo}
        onConfirmar={cambio.confirmarBloqueo}
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
  container: { flex: 1, backgroundColor: '#f8fafc' },
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
  cabeceraBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
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
  titulo: { fontSize: 19, fontWeight: '700', color: '#0f172a' },
  editarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  editarBtnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  editarTexto: { fontSize: 13, fontWeight: '700', color: '#ffffff' },
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
  notaCancelar: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
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
  notaSeccion: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },

  lista: { gap: 8 },
  filaLista: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  filaTexto: { flex: 1, minWidth: 0 },
  filaTitulo: { fontSize: 13, fontWeight: '600', color: '#334155' },
  filaSub: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  filaReunionTactil: { minHeight: MIN_TOUCH },
  avisoCalendario: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  avisoCalendarioTexto: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 17 },
  iconoBtn: {
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  iconoBtnTactil: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },

  formEmbebido: {
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  primarioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0ea5e9',
    paddingVertical: 9,
    borderRadius: 8,
  },
  primarioBtnTactil: { minHeight: MIN_TOUCH },
  primarioTexto: { fontSize: 13, fontWeight: '700', color: '#ffffff' },
  errorSeccion: { fontSize: 12, color: '#ef4444', lineHeight: 17 },

  toggleCerradas: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  toggleCerradasTactil: { minHeight: MIN_TOUCH },
  toggleCerradasTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },

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
