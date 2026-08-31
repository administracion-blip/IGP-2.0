/**
 * Listado de proyectos con `TablaBasica`: filtros de estado y departamento, alta
 * y acceso a la ficha.
 *
 * Los filtros de estado y departamento se resuelven **en el servidor** (son
 * parámetros del contrato); la búsqueda de la toolbar es solo un acotado de texto
 * sobre lo que ya está cargado y no sustituye a ningún filtro de visibilidad.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../../components/TablaBasica';
import { SelectorDesplegable, type OpcionDesplegable } from '../../components/SelectorDesplegable';
import { BadgeEstadoProyecto } from '../../components/tasks/BadgesTasks';
import { ModalFormularioProyecto } from '../../components/tasks/ModalFormularioProyecto';
import { estilosModalTasks as modal } from '../../components/tasks/estilosTasks';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import {
  puedeBorrarProyectos,
  puedeCrearProyectos,
  puedeEditarProyectos,
  puedeVerPresupuesto,
  puedeVerProyectos,
} from '../../lib/tasksAcceso';
import { ETIQUETA_ESTADO_PROYECTO, ETIQUETA_PRIORIDAD, nombreUsuario } from '../../lib/tasksUi';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';
import { ESTADOS_PROYECTO, type Proyecto } from '../../types/tasks';

const COLUMNAS = ['Nombre', 'Estado', 'Departamento', 'Responsable', 'Inicio', 'Fin previsto', 'Prioridad'];
const LIMITE = 100;
const TODOS = '';

export default function ListadoProyectosScreen() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isCompact } = useBreakpoint();
  const departamentos = useDepartamentos();

  const [proyectos, setProyectos] = useState<Proyecto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [filtroEstado, setFiltroEstado] = useState<string>(TODOS);
  const [filtroDepartamento, setFiltroDepartamento] = useState<string>(TODOS);
  const [soloMios, setSoloMios] = useState(false);
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filaSeleccionada, setFilaSeleccionada] = useState<number | null>(null);

  const [formVisible, setFormVisible] = useState(false);
  const [proyectoEdicion, setProyectoEdicion] = useState<Proyecto | null>(null);
  const [proyectoBaja, setProyectoBaja] = useState<Proyecto | null>(null);
  const [errorBaja, setErrorBaja] = useState<string | null>(null);

  const puedeVer = puedeVerProyectos(acceso);
  const puedeCrear = puedeCrearProyectos(acceso);
  const puedeEditar = puedeEditarProyectos(acceso);
  const puedeBorrar = puedeBorrarProyectos(acceso);
  const verPresupuesto = puedeVerPresupuesto(acceso);

  const cargar = useCallback(
    async (desde?: string | null) => {
      if (!puedeVer) return;
      const esMas = desde != null;
      if (esMas) setCargandoMas(true);
      else setCargando(true);
      setError(null);
      try {
        let ruta: string;
        if (soloMios) {
          ruta = '/api/proyectos/mios';
        } else {
          const query = new URLSearchParams({ limite: String(LIMITE) });
          if (filtroEstado) query.set('estado', filtroEstado);
          if (filtroDepartamento) query.set('departamento', filtroDepartamento);
          if (desde) query.set('cursor', desde);
          ruta = `/api/proyectos?${query.toString()}`;
        }
        const res = await apiFetch(ruta);
        const data = (await res.json().catch(() => ({}))) as {
          proyectos?: Proyecto[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setError(data.error || 'No se pudieron cargar los proyectos');
          return;
        }
        const lote = Array.isArray(data.proyectos) ? data.proyectos : [];
        setProyectos((previos) => (esMas ? [...previos, ...lote] : lote));
        setCursor(data.cursor ?? null);
      } catch (e) {
        console.error('[tasks] fallo al listar proyectos', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setCargando(false);
        setCargandoMas(false);
      }
    },
    [puedeVer, soloMios, filtroEstado, filtroDepartamento],
  );

  useEffect(() => {
    setFilaSeleccionada(null);
    void cargar();
  }, [cargar]);

  const opcionesEstado = useMemo<OpcionDesplegable[]>(
    () => [
      { id: TODOS, titulo: 'Todos los estados' },
      ...ESTADOS_PROYECTO.map((e) => ({ id: e, titulo: ETIQUETA_ESTADO_PROYECTO[e] })),
    ],
    [],
  );

  const opcionesDepartamento = useMemo<OpcionDesplegable[]>(
    () => [{ id: TODOS, titulo: 'Todos los departamentos' }, ...departamentos.opciones],
    [departamentos.opciones],
  );

  const getValorCelda = useCallback(
    (item: Proyecto, col: string): string => {
      switch (col) {
        case 'Nombre':
          return item.nombre || '—';
        case 'Estado':
          return ETIQUETA_ESTADO_PROYECTO[item.estado] ?? item.estado ?? '—';
        case 'Departamento':
          return item.departamento_id ? departamentos.nombrePorId(item.departamento_id) : '—';
        case 'Responsable':
          return nombreUsuario(item.responsable_id, item.responsable_nombre);
        case 'Inicio':
          return formatFecha(item.fecha_inicio);
        case 'Fin previsto':
          return formatFecha(item.fecha_fin_prevista);
        case 'Prioridad':
          return item.prioridad ? ETIQUETA_PRIORIDAD[item.prioridad] : '—';
        default:
          return '—';
      }
    },
    [departamentos],
  );

  // Filtro local de texto: solo acota lo ya cargado. Los filtros de negocio
  // (estado, departamento) los aplica el servidor.
  const filtrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    const base = soloMios
      ? proyectos.filter((p) => {
          if (filtroEstado && p.estado !== filtroEstado) return false;
          if (filtroDepartamento && (p.departamento_id ?? '') !== filtroDepartamento) return false;
          return true;
        })
      : proyectos;
    if (!q) return base;
    return base.filter((p) => COLUMNAS.some((col) => getValorCelda(p, col).toLowerCase().includes(q)));
  }, [proyectos, filtroBusqueda, getValorCelda, soloMios, filtroEstado, filtroDepartamento]);

  const abrirFicha = useCallback(
    (item: Proyecto) => router.push(`/proyectos/${encodeURIComponent(item.id_proyecto)}` as never),
    [router],
  );

  // Decide `permisos_fila`, no la pantalla: un observador con `proyectos.borrar`
  // puede borrar el proyecto aunque no pueda editarlo.
  const solicitarBaja = useCallback((item: Proyecto) => {
    if (!item.permisos_fila?.borrar) {
      setError('No puedes borrar este proyecto.');
      return;
    }
    setProyectoBaja(item);
    setErrorBaja(null);
  }, []);

  const confirmarBaja = useCallback(async () => {
    if (!proyectoBaja) return;
    setGuardando(true);
    setErrorBaja(null);
    try {
      const res = await apiFetch(`/api/proyectos/${encodeURIComponent(proyectoBaja.id_proyecto)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorBaja(data.error || 'No se pudo borrar el proyecto');
        return;
      }
      setProyectoBaja(null);
      setFilaSeleccionada(null);
      void cargar();
    } catch (e) {
      console.error('[tasks] fallo al borrar el proyecto', e);
      setErrorBaja(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }, [proyectoBaja, cargar]);

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

  const seleccionado = filaSeleccionada != null ? filtrados[filaSeleccionada] : null;

  return (
    <View style={styles.container}>
      <TablaBasica<Proyecto>
        title="Proyectos"
        onBack={() => router.push('/proyectos' as never)}
        columnas={COLUMNAS}
        datos={filtrados}
        getValorCelda={getValorCelda}
        loading={cargando}
        error={error}
        onRetry={() => void cargar()}
        filtroBusqueda={filtroBusqueda}
        onFiltroChange={setFiltroBusqueda}
        selectedRowIndex={filaSeleccionada}
        onSelectRow={setFilaSeleccionada}
        onCrear={() => {
          // La toolbar de `TablaBasica` es un bloque: si alguien puede editar
          // pero no crear, el botón sigue ahí y hay que frenarlo aquí para no
          // abrir un formulario que el servidor va a rechazar.
          if (!puedeCrear) {
            setError('No tienes permiso para crear proyectos.');
            return;
          }
          setProyectoEdicion(null);
          setFormVisible(true);
        }}
        onEditar={(item) => {
          if (!item.permisos_fila?.editar) {
            setError('No puedes editar este proyecto: hay que ser su responsable o miembro.');
            return;
          }
          setProyectoEdicion(item);
          setFormVisible(true);
        }}
        onBorrar={solicitarBaja}
        guardando={guardando}
        hideToolbarActions={!puedeCrear && !puedeEditar && !puedeBorrar}
        toolbarCrearLabel="Crear proyecto"
        emptyMessage="No hay proyectos que puedas ver con estos filtros"
        emptyFilterMessage="Ningún proyecto coincide con la búsqueda"
        defaultColWidth={130}
        getRowKey={(item) => item.id_proyecto}
        getRowStyle={(item) =>
          item.estado === 'cancelado' || item.estado === 'cerrado' ? styles.filaCerrada : undefined
        }
        renderCell={(item, col) => {
          if (col !== 'Estado') return null;
          return <BadgeEstadoProyecto estado={item.estado} />;
        }}
        extraToolbarLeft={
          <View style={styles.filtros}>
            <SelectorDesplegable
              sinIconoTrigger
              tituloLista="Estado"
              iconoLista="flag"
              valorId={filtroEstado}
              opciones={opcionesEstado}
              onSeleccionar={setFiltroEstado}
              style={styles.filtroCampo}
            />
            <SelectorDesplegable
              sinIconoTrigger
              tituloLista="Departamento"
              iconoLista="account-tree"
              valorId={filtroDepartamento}
              opciones={opcionesDepartamento}
              loading={departamentos.cargando}
              onSeleccionar={setFiltroDepartamento}
              style={styles.filtroCampo}
            />
            <TouchableOpacity
              style={[styles.chip, isCompact && styles.chipTactil, soloMios && styles.chipActivo]}
              onPress={() => setSoloMios((v) => !v)}
              accessibilityLabel="Ver solo mis proyectos"
            >
              <MaterialIcons name="person" size={14} color={soloMios ? '#0369a1' : '#64748b'} />
              <Text style={[styles.chipTexto, soloMios && styles.chipTextoActivo]}>Mis proyectos</Text>
            </TouchableOpacity>
          </View>
        }
        extraToolbarRight={
          <View style={styles.accionesDerecha}>
            <TouchableOpacity
              style={[styles.btnFicha, isCompact && styles.btnFichaTactil, !seleccionado && styles.btnDeshabilitado]}
              onPress={() => seleccionado && abrirFicha(seleccionado)}
              disabled={!seleccionado}
              accessibilityLabel="Abrir la ficha del proyecto seleccionado"
            >
              <MaterialIcons name="open-in-new" size={16} color={seleccionado ? '#0ea5e9' : '#94a3b8'} />
              <Text style={[styles.btnFichaTexto, !seleccionado && styles.btnTextoDeshabilitado]}>
                Abrir ficha
              </Text>
            </TouchableOpacity>
            {cursor && !soloMios ? (
              <TouchableOpacity
                style={[styles.btnFicha, isCompact && styles.btnFichaTactil]}
                onPress={() => void cargar(cursor)}
                disabled={cargandoMas}
              >
                {cargandoMas ? (
                  <ActivityIndicator size="small" color="#0ea5e9" />
                ) : (
                  <>
                    <MaterialIcons name="expand-more" size={16} color="#0ea5e9" />
                    <Text style={styles.btnFichaTexto}>Cargar más</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        }
      />

      {!puedeCrear && !puedeEditar && !puedeBorrar ? (
        <View style={styles.avisoSoloLectura}>
          <MaterialIcons name="lock-outline" size={16} color="#64748b" />
          <Text style={styles.avisoSoloLecturaTexto}>
            Solo lectura: necesitas permiso de creación o edición para dar de alta y cambiar proyectos.
          </Text>
        </View>
      ) : null}

      {formVisible ? (
        <ModalProyectoConUsuarios
          modo={proyectoEdicion ? 'editar' : 'crear'}
          proyecto={proyectoEdicion}
          puedeVerPresupuesto={verPresupuesto}
          departamentos={departamentos}
          onCerrar={() => setFormVisible(false)}
          onGuardado={(guardado) => {
            setFormVisible(false);
            setFilaSeleccionada(null);
            // Tras crear, ir a la ficha; tras editar, refrescar el listado.
            if (!proyectoEdicion && guardado?.id_proyecto) {
              router.push(`/proyectos/${encodeURIComponent(guardado.id_proyecto)}` as never);
              return;
            }
            void cargar();
          }}
        />
      ) : null}

      <Modal
        visible={proyectoBaja != null}
        transparent
        animationType="fade"
        onRequestClose={() => setProyectoBaja(null)}
      >
        <Pressable style={modal.overlay} onPress={() => !guardando && setProyectoBaja(null)}>
          <Pressable style={modal.confirmCard}>
            <MaterialIcons name="warning" size={36} color="#d97706" style={modal.confirmIcono} />
            <Text style={modal.confirmTitle}>Borrar el proyecto</Text>
            <Text style={modal.confirmText}>
              <Text style={modal.confirmDestacado}>{proyectoBaja?.nombre}</Text> se borrará
              definitivamente, junto con sus tareas asignadas. El historial se conserva. Si
              prefieres retirarlo sin borrar el trabajo, cámbialo a «Cancelado» desde Editar.
            </Text>
            {errorBaja ? <Text style={styles.errorBaja}>{errorBaja}</Text> : null}
            <View style={modal.confirmBotones}>
              <TouchableOpacity
                style={[modal.btn, isCompact && modal.btnTactil]}
                onPress={() => setProyectoBaja(null)}
                disabled={guardando}
              >
                <Text style={modal.btnText}>Cerrar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[modal.btn, modal.btnPeligro, isCompact && modal.btnTactil]}
                onPress={() => void confirmarBaja()}
                disabled={guardando}
              >
                {guardando ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text style={modal.btnTextPeligro}>Borrar</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * El maestro de usuarios ya no hace falta para pintar la columna de responsable
 * —el nombre llega resuelto—, solo para el selector de asignación. Y
 * `GET /api/usuarios` exige `usuarios.ver`, que no tiene todo el que entra aquí:
 * se pide al abrir el formulario, no al abrir el listado.
 */
function ModalProyectoConUsuarios(
  props: Omit<ComponentProps<typeof ModalFormularioProyecto>, 'visible' | 'usuarios'>,
) {
  const usuarios = useNombresUsuarios();
  return <ModalFormularioProyecto visible usuarios={usuarios} {...props} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },

  filaCerrada: { backgroundColor: '#f8fafc', opacity: 0.75 },

  filtros: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  filtroCampo: { minWidth: 150 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  chipTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 12 },
  chipActivo: { borderColor: '#0ea5e9', backgroundColor: '#e0f2fe' },
  chipTexto: { fontSize: 12, color: '#64748b' },
  chipTextoActivo: { color: '#0369a1', fontWeight: '700' },

  accionesDerecha: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btnFicha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  btnFichaTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 12 },
  btnDeshabilitado: { opacity: 0.6 },
  btnFichaTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  btnTextoDeshabilitado: { color: '#94a3b8' },

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

  errorBaja: { fontSize: 12, color: '#ef4444', textAlign: 'center' },
});
