/**
 * Cuadro de mando de dirección: KPIs por estado, proyectos activos, acuerdos
 * incumplidos y carga por persona / departamento.
 *
 * Permiso: `proyectos.cuadro_mando` (`puedeVerCuadroMando`). No basta `proyectos.ver`.
 */
import { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { SeccionFicha } from '../../components/tasks/SeccionFicha';
import { TasksPageHeader } from '../../components/tasks/TasksPageHeader';
import { MIN_TOUCH } from '../../constants/layout';
import {
  tasksColor,
  tasksRadius,
  tasksTabularNums,
  tasksTipo,
} from '../../constants/tasksUiTokens';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import { puedeVerCuadroMando } from '../../lib/tasksAcceso';
import {
  ETIQUETA_ESTADO_PROYECTO,
  TONO_ESTADO_PROYECTO,
} from '../../lib/tasksUi';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatCreadoEn, formatFecha } from '../../utils/formatFecha';
import { ESTADOS_PROYECTO, type EstadoProyecto } from '../../types/tasks';

type ProyectoActivoResumen = {
  id_proyecto: string;
  nombre: string;
  responsable_id?: string | null;
  responsable_nombre?: string | null;
  departamento_id?: string | null;
  estado: EstadoProyecto;
};

type AcuerdoIncumplidoResumen = {
  id_reunion: string;
  reunion_titulo?: string | null;
  id_acuerdo: string;
  texto?: string | null;
  responsable_id?: string | null;
  responsable_nombre?: string | null;
  fecha_limite?: string | null;
  tarea_id?: string | null;
};

type CargaFila = {
  abiertas: number;
  vencidas: number;
  bloqueadas: number;
  nombre?: string | null;
};

type CargaPersona = CargaFila & { usuario_id: string };
type CargaDepartamento = CargaFila & { departamento_id: string };

type CuadroMandoRespuesta = {
  generado_en?: string;
  proyectos?: {
    por_estado?: Partial<Record<EstadoProyecto, number>>;
    activos?: ProyectoActivoResumen[];
  };
  acuerdos_incumplidos?: AcuerdoIncumplidoResumen[];
  acuerdos_incumplidos_truncado?: boolean;
  acuerdos_incumplidos_aviso?: string;
  carga_personas?: CargaPersona[];
  carga_departamentos?: CargaDepartamento[];
  error?: string;
};

export default function CuadroMandoProyectosScreen() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isCompact, shouldStackPanels } = useBreakpoint();
  const departamentos = useDepartamentos();

  const puedeVer = puedeVerCuadroMando(acceso);

  const [datos, setDatos] = useState<CuadroMandoRespuesta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!puedeVer) {
      setCargando(false);
      return;
    }
    setCargando(true);
    setError(null);
    try {
      const res = await apiFetch('/api/proyectos/cuadro-mando');
      const body = (await res.json().catch(() => ({}))) as CuadroMandoRespuesta;
      if (!res.ok) {
        setDatos(null);
        setError(body.error || 'No se pudo cargar el cuadro de mando');
        return;
      }
      setDatos(body);
    } catch (e) {
      console.error('[tasks] fallo al cargar cuadro de mando', e);
      setDatos(null);
      setError(errorMessage(e, 'No se pudo conectar con el servidor'));
    } finally {
      setCargando(false);
    }
  }, [puedeVer]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  if (acceso.permisosCargando) {
    return (
      <View style={styles.centro}>
        <ActivityIndicator size="large" color={tasksColor.acento} />
        <Text style={styles.centroTexto}>Cargando permisos…</Text>
      </View>
    );
  }

  if (!puedeVer) {
    return (
      <View style={styles.container}>
        <TasksPageHeader
          title="Cuadro de mando"
          onBack={() => router.push('/proyectos' as never)}
          backAccessibilityLabel="Volver a Proyectos"
          compact={isCompact}
        />
        <View style={styles.centro}>
          <MaterialIcons name="lock-outline" size={30} color={tasksColor.textoTerciario} />
          <Text style={styles.centroTexto}>
            No tienes permiso para ver el cuadro de mando de dirección.
          </Text>
        </View>
      </View>
    );
  }

  const porEstado = datos?.proyectos?.por_estado ?? {};
  const activos = Array.isArray(datos?.proyectos?.activos) ? datos!.proyectos!.activos! : [];
  const incumplidos = Array.isArray(datos?.acuerdos_incumplidos) ? datos!.acuerdos_incumplidos! : [];
  const personas = Array.isArray(datos?.carga_personas) ? datos!.carga_personas! : [];
  const depsCarga = Array.isArray(datos?.carga_departamentos) ? datos!.carga_departamentos! : [];

  return (
    <View style={styles.container}>
      <TasksPageHeader
        title="Cuadro de mando"
        subtitle={
          datos?.generado_en
            ? `Actualizado ${formatCreadoEn(datos.generado_en)}`
            : 'Estado de proyectos, acuerdos y carga'
        }
        onBack={() => router.push('/proyectos' as never)}
        backAccessibilityLabel="Volver a Proyectos"
        compact={isCompact}
        actions={
          <TouchableOpacity
            onPress={() => void cargar()}
            style={[styles.refreshBtn, isCompact && { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH }]}
            disabled={cargando}
            accessibilityLabel="Actualizar"
          >
            {cargando ? (
              <ActivityIndicator size="small" color={tasksColor.acento} />
            ) : (
              <MaterialIcons name="refresh" size={22} color={tasksColor.textoSecundario} />
            )}
          </TouchableOpacity>
        }
      />

      {error && !datos ? (
        <View style={styles.centro}>
          <Text style={styles.errorTexto}>{error}</Text>
          <TouchableOpacity onPress={() => void cargar()} style={styles.reintentarBtn}>
            <Text style={styles.reintentarTexto}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {error ? (
            <View style={styles.avisoError}>
              <MaterialIcons name="error-outline" size={18} color={tasksColor.peligro} />
              <Text style={styles.avisoErrorTexto}>{error}</Text>
            </View>
          ) : null}

          <SeccionFicha
            titulo="Proyectos por estado"
            icono="pie-chart"
            cargando={cargando && !datos}
          >
            <View style={[styles.kpiGrid, isCompact ? styles.kpiGridWrap : styles.kpiGridLinea]}>
              {ESTADOS_PROYECTO.map((estado) => {
                const tono = TONO_ESTADO_PROYECTO[estado];
                const valor = Number(porEstado[estado]) || 0;
                return (
                  <View
                    key={estado}
                    style={[styles.kpiCard, !isCompact && styles.kpiCardFlex]}
                  >
                    <Text style={[styles.kpiValor, { color: tono.fg }]}>{valor}</Text>
                    <Text style={[styles.kpiLabel, { color: tono.fg }]}>
                      {ETIQUETA_ESTADO_PROYECTO[estado]}
                    </Text>
                  </View>
                );
              })}
            </View>
          </SeccionFicha>

          <SeccionFicha
            titulo="Proyectos activos"
            icono="folder-open"
            contador={activos.length}
            cargando={cargando && !datos}
            vacio={activos.length === 0 ? 'No hay proyectos activos visibles.' : undefined}
          >
            {activos.length > 0 ? (
              <View style={styles.tabla}>
                {!isCompact ? (
                  <View style={[styles.fila, styles.filaCabecera]}>
                    <Text style={[styles.celda, styles.celdaNombre, styles.celdaCab]}>Nombre</Text>
                    <Text style={[styles.celda, styles.celdaMedia, styles.celdaCab]}>Responsable</Text>
                    <Text style={[styles.celda, styles.celdaMedia, styles.celdaCab]}>Departamento</Text>
                  </View>
                ) : null}
                {activos.map((p) => (
                  <Pressable
                    key={p.id_proyecto}
                    onPress={() => router.push(`/proyectos/${p.id_proyecto}` as never)}
                    style={({ pressed }) => [
                      styles.fila,
                      styles.filaEnlace,
                      pressed && styles.filaPressed,
                      isCompact && { minHeight: MIN_TOUCH },
                    ]}
                  >
                    <Text style={[styles.celda, styles.celdaNombre, styles.enlace]} numberOfLines={2}>
                      {p.nombre || '—'}
                    </Text>
                    <Text style={[styles.celda, styles.celdaMedia]} numberOfLines={1}>
                      {p.responsable_nombre || '—'}
                    </Text>
                    <Text style={[styles.celda, styles.celdaMedia]} numberOfLines={1}>
                      {p.departamento_id
                        ? departamentos.nombrePorId(p.departamento_id)
                        : '—'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </SeccionFicha>

          <SeccionFicha
            titulo="Acuerdos incumplidos"
            icono="report"
            contador={incumplidos.length}
            cargando={cargando && !datos}
            vacio={incumplidos.length === 0 ? 'No hay acuerdos incumplidos.' : undefined}
          >
            {datos?.acuerdos_incumplidos_truncado ? (
              <View style={styles.avisoTruncado}>
                <MaterialIcons name="info-outline" size={16} color={tasksColor.aviso} />
                <Text style={styles.avisoTruncadoTexto}>
                  {datos.acuerdos_incumplidos_aviso ||
                    'El listado puede estar incompleto: solo se revisaron las reuniones visibles más recientes.'}
                </Text>
              </View>
            ) : null}
            {incumplidos.length > 0 ? (
              <View style={styles.tabla}>
                {!isCompact ? (
                  <View style={[styles.fila, styles.filaCabecera]}>
                    <Text style={[styles.celda, styles.celdaFlex, styles.celdaCab]}>Acuerdo</Text>
                    <Text style={[styles.celda, styles.celdaMedia, styles.celdaCab]}>Reunión</Text>
                    <Text style={[styles.celda, styles.celdaMedia, styles.celdaCab]}>Responsable</Text>
                    <Text style={[styles.celda, styles.celdaCorta, styles.celdaCab]}>Límite</Text>
                  </View>
                ) : null}
                {incumplidos.map((a) => (
                  <Pressable
                    key={`${a.id_reunion}-${a.id_acuerdo}`}
                    onPress={() => router.push(`/reuniones/${a.id_reunion}` as never)}
                    style={({ pressed }) => [
                      styles.fila,
                      styles.filaEnlace,
                      pressed && styles.filaPressed,
                      isCompact && { minHeight: MIN_TOUCH },
                    ]}
                  >
                    <Text style={[styles.celda, styles.celdaFlex, styles.enlace]} numberOfLines={2}>
                      {a.texto || '—'}
                    </Text>
                    <Text style={[styles.celda, styles.celdaMedia]} numberOfLines={1}>
                      {a.reunion_titulo || '—'}
                    </Text>
                    <Text style={[styles.celda, styles.celdaMedia]} numberOfLines={1}>
                      {a.responsable_nombre || '—'}
                    </Text>
                    <Text style={[styles.celda, styles.celdaCorta]} numberOfLines={1}>
                      {formatFecha(a.fecha_limite)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </SeccionFicha>

          <View style={[styles.cargaRow, shouldStackPanels && styles.cargaRowStack]}>
            <View style={[styles.cargaCol, shouldStackPanels && styles.cargaColStack]}>
              <SeccionFicha
                titulo="Carga por persona"
                icono="person"
                contador={personas.length}
                cargando={cargando && !datos}
                vacio={personas.length === 0 ? 'Sin tareas abiertas en proyectos visibles.' : undefined}
              >
                {personas.length > 0 ? (
                  <TablaCarga
                    filas={personas.map((p) => ({
                      id: p.usuario_id,
                      nombre: p.nombre || '—',
                      abiertas: p.abiertas,
                      vencidas: p.vencidas,
                      bloqueadas: p.bloqueadas,
                    }))}
                    isCompact={isCompact}
                  />
                ) : null}
              </SeccionFicha>
            </View>
            <View style={[styles.cargaCol, shouldStackPanels && styles.cargaColStack]}>
              <SeccionFicha
                titulo="Carga por departamento"
                icono="apartment"
                contador={depsCarga.length}
                cargando={cargando && !datos}
                vacio={
                  depsCarga.length === 0 ? 'Sin tareas abiertas agrupadas por departamento.' : undefined
                }
              >
                {depsCarga.length > 0 ? (
                  <TablaCarga
                    filas={depsCarga.map((d) => ({
                      id: d.departamento_id,
                      nombre:
                        d.nombre ||
                        (d.departamento_id
                          ? departamentos.nombrePorId(d.departamento_id)
                          : '—'),
                      abiertas: d.abiertas,
                      vencidas: d.vencidas,
                      bloqueadas: d.bloqueadas,
                    }))}
                    isCompact={isCompact}
                  />
                ) : null}
              </SeccionFicha>
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function TablaCarga({
  filas,
  isCompact,
}: {
  filas: { id: string; nombre: string; abiertas: number; vencidas: number; bloqueadas: number }[];
  isCompact: boolean;
}) {
  return (
    <View style={styles.tabla}>
      {!isCompact ? (
        <View style={[styles.fila, styles.filaCabecera]}>
          <Text style={[styles.celda, styles.celdaFlex, styles.celdaCab]}>Nombre</Text>
          <Text style={[styles.celda, styles.celdaNum, styles.celdaCab]}>Abiertas</Text>
          <Text style={[styles.celda, styles.celdaNum, styles.celdaCab]}>Vencidas</Text>
          <Text style={[styles.celda, styles.celdaNum, styles.celdaCab]}>Bloqueadas</Text>
        </View>
      ) : null}
      {filas.map((f) => (
        <View key={f.id} style={[styles.fila, isCompact && { minHeight: MIN_TOUCH }]}>
          <Text style={[styles.celda, styles.celdaFlex]} numberOfLines={2}>
            {f.nombre}
            {isCompact ? (
              <Text style={styles.metaCompacta}>
                {'\n'}
                {f.abiertas} abiertas · {f.vencidas} venc. · {f.bloqueadas} bloq.
              </Text>
            ) : null}
          </Text>
          {!isCompact ? (
            <>
              <Text style={[styles.celda, styles.celdaNum]}>{f.abiertas}</Text>
              <Text
                style={[
                  styles.celda,
                  styles.celdaNum,
                  f.vencidas > 0 && styles.numAlerta,
                ]}
              >
                {f.vencidas}
              </Text>
              <Text
                style={[
                  styles.celda,
                  styles.celdaNum,
                  f.bloqueadas > 0 && styles.numAviso,
                ]}
              >
                {f.bloqueadas}
              </Text>
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: tasksColor.fondoApp },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { ...tasksTipo.cuerpo, textAlign: 'center' },
  errorTexto: { ...tasksTipo.cuerpo, color: tasksColor.peligro, textAlign: 'center' },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: tasksRadius.control,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: tasksColor.bordeFuerte,
    backgroundColor: tasksColor.superficie,
  },
  scroll: { flex: 1, position: 'relative', zIndex: 0 },
  scrollContent: { paddingBottom: 32, gap: 14 },
  reintentarBtn: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: tasksRadius.control,
    backgroundColor: tasksColor.acentoSuave,
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
  },
  reintentarTexto: { ...tasksTipo.dato, color: tasksColor.acentoTexto, fontWeight: '600' },
  avisoError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.peligroSuave,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  avisoErrorTexto: { flex: 1, ...tasksTipo.cuerpo, color: tasksColor.peligro },
  avisoTruncado: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    marginBottom: 10,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.avisoSuave,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  avisoTruncadoTexto: { flex: 1, ...tasksTipo.etiqueta, color: '#92400e' },
  kpiGrid: { flexDirection: 'row', gap: 10 },
  kpiGridLinea: { flexWrap: 'nowrap' },
  kpiGridWrap: { flexWrap: 'wrap' },
  kpiCard: {
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    backgroundColor: tasksColor.superficie,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minWidth: 120,
    flexGrow: 1,
  },
  kpiCardFlex: { flex: 1, minWidth: 0 },
  kpiValor: { ...tasksTipo.tituloSeccion, ...tasksTabularNums },
  kpiLabel: { ...tasksTipo.micro, marginTop: 2 },
  tabla: {
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    borderRadius: tasksRadius.contenedor,
    overflow: 'hidden',
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tasksColor.bordeSutil,
    backgroundColor: tasksColor.superficie,
  },
  filaCabecera: { backgroundColor: tasksColor.superficieHundida },
  filaEnlace: {},
  filaPressed: { backgroundColor: tasksColor.superficieHundida },
  celda: { ...tasksTipo.dato },
  celdaCab: { ...tasksTipo.etiqueta, textTransform: 'uppercase' },
  celdaNombre: { flex: 1.4, minWidth: 0 },
  celdaFlex: { flex: 1, minWidth: 0 },
  celdaMedia: { flex: 1, minWidth: 0 },
  celdaCorta: { width: 88, textAlign: 'right' },
  celdaNum: { width: 72, textAlign: 'right', ...tasksTabularNums },
  enlace: { color: tasksColor.acentoTexto, fontWeight: '600' },
  numAlerta: { color: tasksColor.peligro, fontWeight: '700' },
  numAviso: { color: tasksColor.aviso, fontWeight: '700' },
  metaCompacta: { ...tasksTipo.micro, fontWeight: '400' },
  cargaRow: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  cargaRowStack: { flexDirection: 'column' },
  cargaCol: { flex: 1, minWidth: 0 },
  cargaColStack: { width: '100%' },
});
