/**
 * Listado de plantillas de proyecto con `TablaBasica`.
 *
 * - Ver: `proyectos.ver`
 * - CRUD: `proyectos.plantillas` (`puedeGestionarPlantillas`)
 * - Usar plantilla → instanciar: `proyectos.crear` (`puedeCrearProyectos`)
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
import { ModalFormularioPlantilla } from '../../components/tasks/ModalFormularioPlantilla';
import { ModalInstanciarPlantilla } from '../../components/tasks/ModalInstanciarPlantilla';
import { TasksPageHeader } from '../../components/tasks/TasksPageHeader';
import { estilosModalTasks as modal } from '../../components/tasks/estilosTasks';
import { MIN_TOUCH } from '../../constants/layout';
import { tasksColor } from '../../constants/tasksUiTokens';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import {
  puedeCrearProyectos,
  puedeGestionarPlantillas,
  puedeVerProyectos,
} from '../../lib/tasksAcceso';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatCreadoEn } from '../../utils/formatFecha';
import type { PlantillaProyecto } from '../../types/tasks';

const COLUMNAS = ['Nombre', 'Departamento', 'Tareas', 'Actualizado'];
const LIMITE = 100;

export default function PlantillasProyectoScreen() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isCompact } = useBreakpoint();
  const departamentos = useDepartamentos();

  const [plantillas, setPlantillas] = useState<PlantillaProyecto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [filtroBusqueda, setFiltroBusqueda] = useState('');
  const [filaSeleccionada, setFilaSeleccionada] = useState<number | null>(null);

  const [formVisible, setFormVisible] = useState(false);
  const [plantillaEdicion, setPlantillaEdicion] = useState<PlantillaProyecto | null>(null);
  const [plantillaBaja, setPlantillaBaja] = useState<PlantillaProyecto | null>(null);
  const [errorBaja, setErrorBaja] = useState<string | null>(null);
  const [plantillaUsar, setPlantillaUsar] = useState<PlantillaProyecto | null>(null);

  const puedeVer = puedeVerProyectos(acceso);
  const puedeGestionar = puedeGestionarPlantillas(acceso);
  const puedeCrear = puedeCrearProyectos(acceso);

  const cargar = useCallback(
    async (desde?: string | null) => {
      if (!puedeVer) return;
      const esMas = desde != null;
      if (esMas) setCargandoMas(true);
      else setCargando(true);
      setError(null);
      try {
        const query = new URLSearchParams({ limite: String(LIMITE) });
        if (desde) query.set('cursor', desde);
        const res = await apiFetch(`/api/proyectos/plantillas?${query.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          plantillas?: PlantillaProyecto[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setError(data.error || 'No se pudieron cargar las plantillas');
          return;
        }
        const lote = Array.isArray(data.plantillas) ? data.plantillas : [];
        setPlantillas((previos) => (esMas ? [...previos, ...lote] : lote));
        setCursor(data.cursor ?? null);
      } catch (e) {
        console.error('[tasks] fallo al listar plantillas', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setCargando(false);
        setCargandoMas(false);
      }
    },
    [puedeVer],
  );

  useEffect(() => {
    setFilaSeleccionada(null);
    void cargar();
  }, [cargar]);

  const getValorCelda = useCallback(
    (item: PlantillaProyecto, col: string): string => {
      switch (col) {
        case 'Nombre':
          return item.nombre || '—';
        case 'Departamento':
          return item.departamento_id
            ? departamentos.nombrePorId(item.departamento_id)
            : '—';
        case 'Tareas':
          return String(Array.isArray(item.tareas) ? item.tareas.length : 0);
        case 'Actualizado':
          return formatCreadoEn(item.actualizado_en);
        default:
          return '—';
      }
    },
    [departamentos],
  );

  const filtrados = useMemo(() => {
    const q = filtroBusqueda.trim().toLowerCase();
    if (!q) return plantillas;
    return plantillas.filter((p) =>
      COLUMNAS.some((col) => getValorCelda(p, col).toLowerCase().includes(q)),
    );
  }, [plantillas, filtroBusqueda, getValorCelda]);

  const solicitarBaja = useCallback(
    (item: PlantillaProyecto) => {
      if (!puedeGestionar) {
        setError('No tienes permiso para borrar plantillas.');
        return;
      }
      setPlantillaBaja(item);
      setErrorBaja(null);
    },
    [puedeGestionar],
  );

  const confirmarBaja = useCallback(async () => {
    if (!plantillaBaja) return;
    setGuardando(true);
    setErrorBaja(null);
    try {
      const res = await apiFetch(
        `/api/proyectos/plantillas/${encodeURIComponent(plantillaBaja.id_plantilla)}`,
        { method: 'DELETE' },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorBaja(data.error || 'No se pudo borrar la plantilla');
        return;
      }
      setPlantillaBaja(null);
      setFilaSeleccionada(null);
      void cargar();
    } catch (e) {
      console.error('[tasks] fallo al borrar plantilla', e);
      setErrorBaja(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setGuardando(false);
    }
  }, [plantillaBaja, cargar]);

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
        <Text style={styles.centroTexto}>No tienes permiso para ver las plantillas.</Text>
      </View>
    );
  }

  const seleccionado = filaSeleccionada != null ? filtrados[filaSeleccionada] : null;

  return (
    <View style={styles.container}>
      <View style={styles.pageHeader}>
        <TasksPageHeader
          title="Plantillas de proyecto"
          subtitle="Modelos reutilizables"
          countLabel={`${filtrados.length} ${filtrados.length === 1 ? 'plantilla' : 'plantillas'}`}
          onBack={() => router.push('/proyectos' as never)}
          compact={isCompact}
        />
      </View>
      <TablaBasica<PlantillaProyecto>
        variant="tasks"
        title="Plantillas de proyecto"
        hideHeader
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
            setError('No tienes permiso para crear plantillas.');
            return;
          }
          setPlantillaEdicion(null);
          setFormVisible(true);
        }}
        onEditar={(item) => {
          if (!puedeGestionar) {
            setError('No tienes permiso para editar plantillas.');
            return;
          }
          setPlantillaEdicion(item);
          setFormVisible(true);
        }}
        onBorrar={solicitarBaja}
        guardando={guardando}
        hideToolbarActions={!puedeGestionar}
        toolbarCrearLabel="Crear plantilla"
        emptyMessage={
          puedeGestionar
            ? 'No hay plantillas'
            : 'No hay plantillas. Pide a quien gestione el módulo.'
        }
        emptyFilterMessage="Ninguna plantilla coincide con la búsqueda"
        emptyActionLabel={puedeGestionar ? 'Crear plantilla' : undefined}
        onEmptyAction={
          puedeGestionar
            ? () => {
                setPlantillaEdicion(null);
                setFormVisible(true);
              }
            : undefined
        }
        defaultColWidth={140}
        getRowKey={(item) => item.id_plantilla}
        extraToolbarRight={
          <View style={styles.accionesDerecha}>
            {puedeCrear ? (
              <TouchableOpacity
                style={[
                  styles.btnAccion,
                  isCompact && styles.btnAccionTactil,
                  !seleccionado && styles.btnDeshabilitado,
                ]}
                onPress={() => seleccionado && setPlantillaUsar(seleccionado)}
                disabled={!seleccionado}
                accessibilityLabel="Usar la plantilla seleccionada"
              >
                <MaterialIcons
                  name="playlist-add-check"
                  size={16}
                  color={seleccionado ? '#16a34a' : '#94a3b8'}
                />
                <Text
                  style={[styles.btnAccionTextoVerde, !seleccionado && styles.btnTextoDeshabilitado]}
                >
                  Usar plantilla
                </Text>
              </TouchableOpacity>
            ) : null}
            {cursor ? (
              <TouchableOpacity
                style={[styles.btnAccion, isCompact && styles.btnAccionTactil]}
                onPress={() => void cargar(cursor)}
                disabled={cargandoMas}
              >
                {cargandoMas ? (
                  <ActivityIndicator size="small" color="#0ea5e9" />
                ) : (
                  <>
                    <MaterialIcons name="expand-more" size={16} color="#0ea5e9" />
                    <Text style={styles.btnAccionTexto}>Cargar más</Text>
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
            {puedeCrear
              ? 'Puedes usar plantillas para crear proyectos. Para crear o editar plantillas hace falta el permiso de plantillas.'
              : 'Solo lectura: necesitas permiso de plantillas para gestionarlas, o de creación de proyectos para usarlas.'}
          </Text>
        </View>
      ) : null}

      {formVisible ? (
        <ModalFormularioPlantilla
          visible
          modo={plantillaEdicion ? 'editar' : 'crear'}
          plantilla={plantillaEdicion}
          departamentos={departamentos}
          onCerrar={() => setFormVisible(false)}
          onGuardado={() => {
            setFormVisible(false);
            setFilaSeleccionada(null);
            void cargar();
          }}
        />
      ) : null}

      {plantillaUsar ? (
        <ModalInstanciarConUsuarios
          plantilla={plantillaUsar}
          departamentos={departamentos}
          onCerrar={() => setPlantillaUsar(null)}
          onCreado={(proyecto) => {
            setPlantillaUsar(null);
            if (proyecto?.id_proyecto) {
              router.push(`/proyectos/${encodeURIComponent(proyecto.id_proyecto)}` as never);
            }
          }}
        />
      ) : null}

      <Modal
        visible={plantillaBaja != null}
        transparent
        animationType="fade"
        onRequestClose={() => setPlantillaBaja(null)}
      >
        <Pressable style={modal.overlay} onPress={() => !guardando && setPlantillaBaja(null)}>
          <Pressable style={modal.confirmCard}>
            <MaterialIcons name="warning" size={36} color="#d97706" style={modal.confirmIcono} />
            <Text style={modal.confirmTitle}>Borrar la plantilla</Text>
            <Text style={modal.confirmText}>
              <Text style={modal.confirmDestacado}>{plantillaBaja?.nombre}</Text> se borrará
              definitivamente. Los proyectos ya creados a partir de ella no se modifican.
            </Text>
            {errorBaja ? <Text style={styles.errorBaja}>{errorBaja}</Text> : null}
            <View style={modal.confirmBotones}>
              <TouchableOpacity
                style={[modal.btn, isCompact && modal.btnTactil]}
                onPress={() => setPlantillaBaja(null)}
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

/** Los usuarios solo hacen falta al abrir «Usar plantilla». */
function ModalInstanciarConUsuarios(
  props: Omit<ComponentProps<typeof ModalInstanciarPlantilla>, 'visible' | 'usuarios'>,
) {
  const usuarios = useNombresUsuarios();
  return <ModalInstanciarPlantilla visible usuarios={usuarios} {...props} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: tasksColor.fondoApp },
  pageHeader: { paddingHorizontal: 10, paddingTop: 10 },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },

  accionesDerecha: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btnAccion: {
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
  btnAccionTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 12 },
  btnDeshabilitado: { opacity: 0.6 },
  btnAccionTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  btnAccionTextoVerde: { fontSize: 12, fontWeight: '600', color: '#16a34a' },
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
