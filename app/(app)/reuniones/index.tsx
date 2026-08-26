/**
 * Listado de reuniones con `TablaBasica`: filtros de fecha, estado y proyecto.
 *
 * Los filtros de negocio van al servidor (`desde`, `hasta`, `estado`, `proyecto`).
 * La búsqueda de la toolbar solo acota el texto de lo ya cargado.
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
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { TablaBasica } from '../../components/TablaBasica';
import { SelectorDesplegable, type OpcionDesplegable } from '../../components/SelectorDesplegable';
import { RangoFechas } from '../../components/RangoFechas';
import { BadgeEstadoReunion } from '../../components/tasks/BadgesTasks';
import {
  ModalFormularioReunion,
  type ResultadoGuardadoReunion,
} from '../../components/tasks/ModalFormularioReunion';
import { estilosModalTasks as modal } from '../../components/tasks/estilosTasks';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import { puedeGestionarReuniones, puedeVerReuniones } from '../../lib/tasksAcceso';
import {
  ETIQUETA_ESTADO_REUNION,
  ETIQUETA_VISIBILIDAD_REUNION,
} from '../../lib/tasksUi';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';
import { ESTADOS_REUNION, type Reunion } from '../../types/tasks';

const COLUMNAS = ['Título', 'Fecha', 'Hora', 'Estado', 'Visibilidad', 'Modalidad'];
const LIMITE = 100;
const TODOS = '';

/**
 * Si el backend aún no manda `permisos_fila` en reuniones, las escrituras se
 * ocultan con `reuniones.gestionar`. TODO: quitar el fallback cuando el contrato
 * deje de omitirlo.
 */
function puedeEditarFila(item: Reunion, puedeGestionar: boolean): boolean {
  if (item.permisos_fila) return item.permisos_fila.editar === true;
  return puedeGestionar;
}

function puedeBorrarFila(item: Reunion, puedeGestionar: boolean): boolean {
  if (item.permisos_fila) return item.permisos_fila.borrar === true;
  return puedeGestionar;
}

export default function ListadoReunionesScreen() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isCompact } = useBreakpoint();
  const departamentos = useDepartamentos();

  const [reuniones, setReuniones] = useState<Reunion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avisoCalendario, setAvisoCalendario] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [filtroDesde, setFiltroDesde] = useState('');
  const [filtroHasta, setFiltroHasta] = useState('');
  const [filtroEstado, setFiltroEstado] = useState<string>(TODOS);
  const [filtroProyecto, setFiltroProyecto] = useState('');
  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filaSeleccionada, setFilaSeleccionada] = useState<number | null>(null);

  const [formVisible, setFormVisible] = useState(false);
  const [reunionBaja, setReunionBaja] = useState<Reunion | null>(null);
  const [errorBaja, setErrorBaja] = useState<string | null>(null);

  const puedeVer = puedeVerReuniones(acceso);
  const puedeGestionar = puedeGestionarReuniones(acceso);

  const cargar = useCallback(
    async (desde?: string | null) => {
      if (!puedeVer) return;
      const esMas = desde != null;
      if (esMas) setCargandoMas(true);
      else setCargando(true);
      setError(null);
      try {
        const query = new URLSearchParams({ limite: String(LIMITE) });
        if (filtroDesde) query.set('desde', filtroDesde);
        if (filtroHasta) query.set('hasta', filtroHasta);
        if (filtroEstado) query.set('estado', filtroEstado);
        if (filtroProyecto.trim()) query.set('proyecto', filtroProyecto.trim());
        if (desde) query.set('cursor', desde);
        const res = await apiFetch(`/api/reuniones?${query.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          reuniones?: Reunion[];
          items?: Reunion[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setError(data.error || 'No se pudieron cargar las reuniones');
          return;
        }
        const lote = Array.isArray(data.reuniones)
          ? data.reuniones
          : Array.isArray(data.items)
            ? data.items
            : [];
        setReuniones((previos) => (esMas ? [...previos, ...lote] : lote));
        setCursor(data.cursor ?? null);
      } catch (e) {
        console.error('[reuniones] fallo al listar', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setCargando(false);
        setCargandoMas(false);
      }
    },
    [puedeVer, filtroDesde, filtroHasta, filtroEstado, filtroProyecto],
  );

  useEffect(() => {
    setFilaSeleccionada(null);
    void cargar();
  }, [cargar]);

  const opcionesEstado = useMemo<OpcionDesplegable[]>(
    () => [
      { id: TODOS, titulo: 'Todos los estados' },
      ...ESTADOS_REUNION.map((e) => ({ id: e, titulo: ETIQUETA_ESTADO_REUNION[e] })),
    ],
    [],
  );

  const getValorCelda = useCallback((item: Reunion, col: string): string => {
    switch (col) {
      case 'Título':
        return item.titulo || '—';
      case 'Fecha':
        return formatFecha(item.fecha);
      case 'Hora': {
        const ini = (item.hora_inicio ?? '').trim();
        const fin = (item.hora_fin ?? '').trim();
        if (ini && fin) return `${ini} – ${fin}`;
        return ini || fin || '—';
      }
      case 'Estado':
        return ETIQUETA_ESTADO_REUNION[item.estado] ?? item.estado ?? '—';
      case 'Visibilidad':
        return ETIQUETA_VISIBILIDAD_REUNION[item.visibilidad] ?? item.visibilidad ?? '—';
      case 'Modalidad':
        return item.modalidad ?? '—';
      default:
        return '—';
    }
  }, []);

  const filtrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return reuniones;
    return reuniones.filter((r) => COLUMNAS.some((col) => getValorCelda(r, col).toLowerCase().includes(q)));
  }, [reuniones, filtroBusqueda, getValorCelda]);

  const abrirFicha = useCallback(
    (item: Reunion) => router.push(`/reuniones/${encodeURIComponent(item.id_reunion)}` as never),
    [router],
  );

  const solicitarBaja = useCallback(
    (item: Reunion) => {
      if (!puedeBorrarFila(item, puedeGestionar)) {
        setError('No puedes borrar esta reunión.');
        return;
      }
      setReunionBaja(item);
      setErrorBaja(null);
    },
    [puedeGestionar],
  );

  const confirmarBaja = useCallback(async () => {
    if (!reunionBaja) return;
    setGuardando(true);
    setErrorBaja(null);
    try {
      const res = await apiFetch(`/api/reuniones/${encodeURIComponent(reunionBaja.id_reunion)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorBaja(data.error || 'No se pudo borrar la reunión');
        return;
      }
      setReunionBaja(null);
      setFilaSeleccionada(null);
      void cargar();
    } catch (e) {
      console.error('[reuniones] fallo al borrar', e);
      setErrorBaja(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }, [reunionBaja, cargar]);

  const trasGuardado = useCallback(
    (resultado: ResultadoGuardadoReunion) => {
      setFormVisible(false);
      setFilaSeleccionada(null);
      if (resultado.avisoCalendario) setAvisoCalendario(resultado.avisoCalendario);
      else if (resultado.calendarioSincronizado === false) {
        setAvisoCalendario(
          'La reunión se guardó, pero no se pudo sincronizar con Google Calendar.',
        );
      }
      void cargar();
      if (resultado.reunion?.id_reunion) {
        router.push(`/reuniones/${encodeURIComponent(resultado.reunion.id_reunion)}` as never);
      }
    },
    [cargar, router],
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
        <Text style={styles.centroTexto}>No tienes permiso para ver las reuniones.</Text>
      </View>
    );
  }

  const seleccionado = filaSeleccionada != null ? filtrados[filaSeleccionada] : null;

  return (
    <View style={styles.container}>
      {avisoCalendario ? (
        <View style={styles.bannerCalendario}>
          <MaterialIcons name="event-busy" size={18} color="#b45309" />
          <Text style={styles.bannerCalendarioTexto}>{avisoCalendario}</Text>
          <TouchableOpacity onPress={() => setAvisoCalendario(null)} accessibilityLabel="Cerrar aviso">
            <MaterialIcons name="close" size={18} color="#b45309" />
          </TouchableOpacity>
        </View>
      ) : null}

      <TablaBasica<Reunion>
        title="Reuniones"
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
          if (!puedeGestionar) {
            setError('No tienes permiso para convocar reuniones.');
            return;
          }
          setFormVisible(true);
        }}
        onEditar={(item) => {
          if (!puedeEditarFila(item, puedeGestionar)) {
            setError('No puedes editar esta reunión.');
            return;
          }
          // La edición completa (asistentes, acta) vive en la ficha.
          abrirFicha(item);
        }}
        onBorrar={solicitarBaja}
        guardando={guardando}
        hideToolbarActions={!puedeGestionar}
        toolbarCrearLabel="Convocar"
        emptyMessage="No hay reuniones que puedas ver con estos filtros"
        emptyFilterMessage="Ninguna reunión coincide con la búsqueda"
        defaultColWidth={130}
        getRowKey={(item) => item.id_reunion}
        getRowStyle={(item) =>
          item.estado === 'cancelada' || item.estado === 'acta_validada'
            ? styles.filaCerrada
            : undefined
        }
        renderCell={(item, col) => {
          if (col !== 'Estado') return null;
          return <BadgeEstadoReunion estado={item.estado} />;
        }}
        extraToolbarLeft={
          <View style={styles.filtros}>
            <RangoFechas
              desdeIso={filtroDesde}
              hastaIso={filtroHasta}
              onChangeDesde={setFiltroDesde}
              onChangeHasta={setFiltroHasta}
              cellWidth={118}
              modoToolbar
            />
            <SelectorDesplegable
              sinIconoTrigger
              tituloLista="Estado"
              iconoLista="flag"
              valorId={filtroEstado}
              opciones={opcionesEstado}
              onSeleccionar={setFiltroEstado}
              style={styles.filtroCampo}
            />
            <TextInput
              style={[styles.filtroProyecto, isCompact && styles.filtroProyectoTactil]}
              value={filtroProyecto}
              onChangeText={setFiltroProyecto}
              placeholder="Proyecto…"
              placeholderTextColor="#94a3b8"
              autoCapitalize="none"
            />
          </View>
        }
        extraToolbarRight={
          <View style={styles.accionesDerecha}>
            <TouchableOpacity
              style={[styles.btnFicha, isCompact && styles.btnFichaTactil, !seleccionado && styles.btnDeshabilitado]}
              onPress={() => seleccionado && abrirFicha(seleccionado)}
              disabled={!seleccionado}
              accessibilityLabel="Abrir la ficha de la reunión seleccionada"
            >
              <MaterialIcons name="open-in-new" size={16} color={seleccionado ? '#0ea5e9' : '#94a3b8'} />
              <Text style={[styles.btnFichaTexto, !seleccionado && styles.btnTextoDeshabilitado]}>
                Abrir ficha
              </Text>
            </TouchableOpacity>
            {cursor ? (
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

      {!puedeGestionar ? (
        <View style={styles.avisoSoloLectura}>
          <MaterialIcons name="lock-outline" size={16} color="#64748b" />
          <Text style={styles.avisoSoloLecturaTexto}>
            Solo lectura: necesitas permiso de gestión de reuniones para convocar o editar.
          </Text>
        </View>
      ) : null}

      {formVisible ? (
        <ModalReunionConUsuarios
          modo="crear"
          departamentos={departamentos}
          onCerrar={() => setFormVisible(false)}
          onGuardado={trasGuardado}
        />
      ) : null}

      <Modal
        visible={reunionBaja != null}
        transparent
        animationType="fade"
        onRequestClose={() => setReunionBaja(null)}
      >
        <Pressable style={modal.overlay} onPress={() => !guardando && setReunionBaja(null)}>
          <Pressable style={modal.confirmCard}>
            <MaterialIcons name="warning" size={36} color="#d97706" style={modal.confirmIcono} />
            <Text style={modal.confirmTitle}>Borrar la reunión</Text>
            <Text style={modal.confirmText}>
              <Text style={modal.confirmDestacado}>{reunionBaja?.titulo}</Text> se borrará
              definitivamente, junto con el evento de Calendar y el audio si los hubiera.
            </Text>
            {errorBaja ? <Text style={styles.errorBaja}>{errorBaja}</Text> : null}
            <View style={modal.confirmBotones}>
              <TouchableOpacity
                style={[modal.btn, isCompact && modal.btnTactil]}
                onPress={() => setReunionBaja(null)}
                disabled={guardando}
              >
                <Text style={modal.btnText}>Cancelar</Text>
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

function ModalReunionConUsuarios(
  props: Omit<ComponentProps<typeof ModalFormularioReunion>, 'visible' | 'usuarios'>,
) {
  const usuarios = useNombresUsuarios();
  return <ModalFormularioReunion visible usuarios={usuarios} {...props} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },

  bannerCalendario: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginHorizontal: 10,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  bannerCalendarioTexto: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 17 },

  filaCerrada: { backgroundColor: '#f8fafc', opacity: 0.75 },

  filtros: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  filtroCampo: { minWidth: 140 },
  filtroProyecto: {
    minWidth: 120,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#ffffff',
    color: '#334155',
  },
  filtroProyectoTactil: { minHeight: MIN_TOUCH },

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
