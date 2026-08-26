/**
 * Vista personal de tareas: la pantalla que la gente abre cada día.
 *
 * El backend ya devuelve **solo las abiertas y ordenadas por vencimiento**, así
 * que aquí no se reordena ni se filtra: únicamente se reparten en grupos
 * legibles conservando el orden que llegó. Las acciones (marcar hecha, empezar,
 * bloquear) se resuelven sin entrar en la ficha, y en pantalla estrecha todo son
 * tarjetas con zonas táctiles de `MIN_TOUCH` para poder usarla con una mano.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useAccesoTasks } from '../../hooks/useAccesoTasks';
import { useNombresUsuarios } from '../../hooks/useNombresUsuarios';
import { useDepartamentos } from '../../hooks/useDepartamentos';
import { puedeEditarProyectos, puedeVerProyectos } from '../../lib/tasksAcceso';
import {
  ETIQUETA_GRUPO_VENCIMIENTO,
  ICONO_GRUPO_VENCIMIENTO,
  TONO_GRUPO_VENCIMIENTO,
  agruparPorVencimiento,
  grupoVencimiento,
} from '../../lib/tasksUi';
import { TarjetaTarea } from '../../components/tasks/TarjetaTarea';
import { ModalMotivoBloqueo } from '../../components/tasks/ModalMotivoBloqueo';
import { ModalFormularioTarea } from '../../components/tasks/ModalFormularioTarea';
import { useCambioEstadoTarea } from '../../hooks/useCambioEstadoTarea';
import { apiFetch, errorMessage } from '../../utils/api';
import type { Tarea } from '../../types/tasks';

const LIMITE = 50;

export default function MisTareasScreen() {
  const router = useRouter();
  const acceso = useAccesoTasks();
  const { isCompact } = useBreakpoint();

  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [vencidas, setVencidas] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [crearVisible, setCrearVisible] = useState(false);

  const puedeVer = puedeVerProyectos(acceso);
  const puedeCrear = puedeEditarProyectos(acceso);

  const cargar = useCallback(
    async (modo: 'inicial' | 'refrescar' | 'mas', desde?: string | null) => {
      if (!puedeVer) return;
      if (modo === 'mas') setCargandoMas(true);
      else if (modo === 'refrescar') setRefrescando(true);
      else setCargando(true);
      setError(null);
      try {
        const query = new URLSearchParams({ limite: String(LIMITE) });
        if (modo === 'mas' && desde) query.set('cursor', desde);
        const res = await apiFetch(`/api/tareas/mias?${query.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          tareas?: Tarea[];
          vencidas?: number;
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setError(data.error || 'No se pudieron cargar tus tareas');
          return;
        }
        const lote = Array.isArray(data.tareas) ? data.tareas : [];
        setTareas((previas) => (modo === 'mas' ? [...previas, ...lote] : lote));
        setVencidas(Number(data.vencidas) || 0);
        setCursor(data.cursor ?? null);
      } catch (e) {
        console.error('[tasks] fallo al leer la vista personal', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        setCargando(false);
        setCargandoMas(false);
        setRefrescando(false);
      }
    },
    [puedeVer],
  );

  useFocusEffect(
    useCallback(() => {
      void cargar('inicial');
    }, [cargar]),
  );

  const grupos = useMemo(() => agruparPorVencimiento(tareas), [tareas]);

  // Al cerrar una tarea desaparece de la vista personal —el índice del backend
  // solo tiene abiertas—, así que se quita de la lista en vez de recargar: la
  // pantalla se usa a diario y con una mano, y recargar perdería el sitio.
  const onCambiada = useCallback(
    (actualizada: Tarea, contexto: { terminal: boolean; anterior: Tarea }) => {
      if (contexto.terminal) {
        setTareas((previas) => previas.filter((t) => t.id_tarea !== actualizada.id_tarea));
        if (grupoVencimiento(contexto.anterior.fecha_limite) === 'vencidas') {
          setVencidas((v) => Math.max(0, v - 1));
        }
        return;
      }
      setTareas((previas) =>
        previas.map((t) => (t.id_tarea === actualizada.id_tarea ? actualizada : t)),
      );
    },
    [],
  );

  const onNoDisponible = useCallback((idTarea: string) => {
    setTareas((previas) => previas.filter((t) => t.id_tarea !== idTarea));
  }, []);

  const cambio = useCambioEstadoTarea({ onCambiada, onNoDisponible });

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
        <Text style={styles.centroTexto}>No tienes permiso para ver tus tareas de proyecto.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          onPress={() => router.push('/proyectos' as never)}
          style={styles.backBtn}
          accessibilityLabel="Volver"
        >
          <MaterialIcons name="arrow-back" size={22} color="#334155" />
        </TouchableOpacity>
        <View style={styles.headerTexto}>
          <Text style={styles.title}>Mis tareas</Text>
          <Text style={styles.subtitle}>Abiertas y ordenadas por vencimiento</Text>
        </View>
        {puedeCrear ? (
          <TouchableOpacity
            style={[styles.nuevaBtn, isCompact && styles.nuevaBtnTactil]}
            onPress={() => setCrearVisible(true)}
            accessibilityLabel="Nueva tarea"
          >
            <MaterialIcons name="add" size={18} color="#ffffff" />
            <Text style={styles.nuevaTexto}>Nueva</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.resumen}>
        <View style={[styles.stat, vencidas > 0 && styles.statAlerta]}>
          <Text style={[styles.statNumero, vencidas > 0 && styles.statNumeroAlerta]}>{vencidas}</Text>
          <Text style={[styles.statEtiqueta, vencidas > 0 && styles.statEtiquetaAlerta]}>
            {vencidas === 1 ? 'vencida' : 'vencidas'}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statNumero}>
            {tareas.length}
            {cursor ? '+' : ''}
          </Text>
          <Text style={styles.statEtiqueta}>{tareas.length === 1 ? 'abierta' : 'abiertas'}</Text>
        </View>
      </View>

      {cambio.error ? (
        <TouchableOpacity style={styles.avisoAccion} onPress={cambio.descartarError}>
          <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
          <Text style={styles.avisoAccionTexto}>{cambio.error}</Text>
          <MaterialIcons name="close" size={16} color="#b91c1c" />
        </TouchableOpacity>
      ) : null}

      {cargando && tareas.length === 0 ? (
        <View style={styles.centro}>
          <ActivityIndicator size="large" color="#0ea5e9" />
          <Text style={styles.centroTexto}>Cargando tus tareas…</Text>
        </View>
      ) : error && tareas.length === 0 ? (
        <View style={styles.centro}>
          <MaterialIcons name="error-outline" size={36} color="#f87171" />
          <Text style={styles.centroError}>{error}</Text>
          <TouchableOpacity style={styles.reintentar} onPress={() => void cargar('inicial')}>
            <MaterialIcons name="refresh" size={18} color="#0ea5e9" />
            <Text style={styles.reintentarTexto}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refrescando}
              onRefresh={() => void cargar('refrescar')}
              tintColor="#0ea5e9"
            />
          }
        >
          {tareas.length === 0 ? (
            <View style={styles.vacio}>
              <MaterialIcons name="check-circle-outline" size={40} color="#16a34a" />
              <Text style={styles.vacioTitulo}>No tienes nada pendiente</Text>
              <Text style={styles.vacioTexto}>
                Cuando alguien te asigne una tarea aparecerá aquí, con su fecha límite.
              </Text>
            </View>
          ) : (
            grupos.map(({ grupo, tareas: delGrupo }) => {
              const tono = TONO_GRUPO_VENCIMIENTO[grupo];
              return (
                <View key={grupo} style={styles.grupo}>
                  <View style={styles.grupoHeader}>
                    <MaterialIcons name={ICONO_GRUPO_VENCIMIENTO[grupo]} size={16} color={tono.fg} />
                    <Text style={[styles.grupoTitulo, { color: tono.fg }]}>
                      {ETIQUETA_GRUPO_VENCIMIENTO[grupo]}
                    </Text>
                    <Text style={[styles.grupoContador, { backgroundColor: tono.bg, color: tono.fg }]}>
                      {delGrupo.length}
                    </Text>
                  </View>
                  <View style={styles.grupoLista}>
                    {delGrupo.map((tarea) => (
                      <TarjetaTarea
                        key={tarea.id_tarea}
                        tarea={tarea}
                        mostrarProyecto
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
                  </View>
                </View>
              );
            })
          )}

          {cursor ? (
            <TouchableOpacity
              style={[styles.masBtn, isCompact && styles.masBtnTactil]}
              onPress={() => void cargar('mas', cursor)}
              disabled={cargandoMas}
            >
              {cargandoMas ? (
                <ActivityIndicator size="small" color="#0ea5e9" />
              ) : (
                <>
                  <MaterialIcons name="expand-more" size={18} color="#0ea5e9" />
                  <Text style={styles.masTexto}>Cargar más tareas</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}

          {error && tareas.length > 0 ? <Text style={styles.errorPie}>{error}</Text> : null}
        </ScrollView>
      )}

      <ModalMotivoBloqueo
        visible={cambio.tareaBloqueo != null}
        titulo={cambio.tareaBloqueo?.titulo}
        guardando={cambio.enCurso?.destino === 'bloqueada'}
        onCancelar={cambio.cancelarBloqueo}
        onConfirmar={cambio.confirmarBloqueo}
      />

      {crearVisible ? (
        <ModalNuevaTareaPersonal
          responsablePorDefecto={acceso.usuarioId}
          onCerrar={() => setCrearVisible(false)}
          onCreada={() => {
            setCrearVisible(false);
            void cargar('inicial');
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * Envoltorio del alta para que los maestros de usuarios y departamentos solo se
 * pidan cuando alguien abre el formulario: esta pantalla se abre muchas veces al
 * día y no debe arrastrar dos lecturas que casi nunca se usan.
 */
function ModalNuevaTareaPersonal({
  responsablePorDefecto,
  onCerrar,
  onCreada,
}: {
  responsablePorDefecto: string;
  onCerrar: () => void;
  onCreada: () => void;
}) {
  const usuarios = useNombresUsuarios();
  const departamentos = useDepartamentos();
  return (
    <ModalFormularioTarea
      visible
      modo="crear"
      responsablePorDefecto={responsablePorDefecto}
      usuarios={usuarios}
      departamentos={departamentos}
      onCerrar={onCerrar}
      onGuardada={onCreada}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#e2e8f0' },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  centroError: { fontSize: 13, color: '#ef4444', textAlign: 'center' },
  reintentar: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: MIN_TOUCH },
  reintentarTexto: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  headerTexto: { flex: 1, minWidth: 0 },
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
  title: { fontSize: 20, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  nuevaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  nuevaBtnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  nuevaTexto: { fontSize: 13, fontWeight: '700', color: '#ffffff' },

  resumen: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  stat: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  statAlerta: { borderColor: '#fecaca', backgroundColor: '#fef2f2' },
  statNumero: { fontSize: 20, fontWeight: '800', color: '#334155' },
  statNumeroAlerta: { color: '#b91c1c' },
  statEtiqueta: { fontSize: 12, color: '#64748b' },
  statEtiquetaAlerta: { color: '#b91c1c', fontWeight: '600' },

  avisoAccion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
    minHeight: MIN_TOUCH,
  },
  avisoAccionTexto: { flex: 1, fontSize: 12, color: '#b91c1c', lineHeight: 17 },

  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24, gap: 16 },
  grupo: { gap: 8 },
  grupoHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  grupoTitulo: { fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  grupoContador: {
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 999,
    overflow: 'hidden',
  },
  grupoLista: { gap: 8 },

  vacio: { alignItems: 'center', gap: 8, paddingVertical: 48, paddingHorizontal: 24 },
  vacioTitulo: { fontSize: 15, fontWeight: '700', color: '#334155' },
  vacioTexto: { fontSize: 13, color: '#64748b', textAlign: 'center', lineHeight: 19 },

  masBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  masBtnTactil: { minHeight: MIN_TOUCH },
  masTexto: { fontSize: 13, fontWeight: '600', color: '#0ea5e9' },
  errorPie: { fontSize: 12, color: '#ef4444', textAlign: 'center' },
});
