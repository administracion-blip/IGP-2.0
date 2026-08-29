/**
 * Vistazo flotante de un proyecto desde el calendario de «Mis tareas».
 *
 * No sustituye la ficha: solo resume lo ya cargado (mis tareas de esa lista) y
 * pide la cabecera a `GET /api/proyectos/:id`. Un 404 se trata como «ya no
 * está disponible», igual que en la ficha completa.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { estilosModalTasks as modal } from './estilosTasks';
import { BadgeEstadoProyecto, BadgeEstadoTarea } from './BadgesTasks';
import { colorDepartamento } from '../../lib/tasksDepartamentoColor';
import { grupoVencimiento, nombreUsuario } from '../../lib/tasksUi';
import { formatFecha } from '../../utils/formatFecha';
import { apiFetch, errorMessage } from '../../utils/api';
import type { Proyecto, Tarea } from '../../types/tasks';

export function ModalVistazoProyecto({
  visible,
  proyectoId,
  tareasMias,
  nombreDepartamento,
  onCerrar,
  onVerCompleto,
  onAbrirTarea,
}: {
  visible: boolean;
  proyectoId: string | null;
  /** Tareas de la lista personal que pertenecen a este proyecto. */
  tareasMias: Tarea[];
  nombreDepartamento: (id?: string | null) => string;
  onCerrar: () => void;
  onVerCompleto: (id: string) => void;
  onAbrirTarea: (tarea: Tarea) => void;
}) {
  const { isCompact } = useBreakpoint();
  const [proyecto, setProyecto] = useState<Proyecto | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noDisponible, setNoDisponible] = useState(false);

  useEffect(() => {
    if (!visible || !proyectoId) {
      setProyecto(null);
      setError(null);
      setNoDisponible(false);
      return;
    }
    let cancelado = false;
    setCargando(true);
    setError(null);
    setNoDisponible(false);
    apiFetch(`/api/proyectos/${encodeURIComponent(proyectoId)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { proyecto?: Proyecto; error?: string };
        if (cancelado) return;
        if (res.status === 404) {
          setNoDisponible(true);
          return;
        }
        if (!res.ok || !data.proyecto) {
          setError(data.error || 'No se pudo cargar el proyecto');
          return;
        }
        setProyecto(data.proyecto);
      })
      .catch((e) => {
        if (cancelado) return;
        console.error('[tasks] fallo al leer el vistazo del proyecto', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      })
      .finally(() => {
        if (!cancelado) setCargando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [visible, proyectoId]);

  const resumenTareas = useMemo(() => {
    const abiertas = tareasMias.length;
    const estaSemana = tareasMias.filter((t) => {
      const g = grupoVencimiento(t.fecha_limite);
      return g === 'hoy' || g === 'semana';
    }).length;
    return { abiertas, estaSemana };
  }, [tareasMias]);

  if (!visible || !proyectoId) return null;

  const dpto = proyecto ? nombreDepartamento(proyecto.departamento_id) : '';
  const fechas =
    proyecto && (proyecto.fecha_inicio || proyecto.fecha_fin_prevista)
      ? `${formatFecha(proyecto.fecha_inicio)} → ${formatFecha(proyecto.fecha_fin_prevista)}`
      : null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={[modal.overlay, isCompact && styles.overlaySheet]} onPress={onCerrar}>
        <Pressable
          style={[modal.cardWrap, modal.cardWrapEstrecho, isCompact && styles.cardWrapMovil]}
          onPress={(e) => e.stopPropagation?.()}
        >
          <View style={[modal.card, styles.card, isCompact && styles.cardMovil]}>
          <View style={modal.header}>
            <View style={styles.headerTexto}>
              <Text style={modal.title} numberOfLines={2}>
                {proyecto?.nombre ?? (noDisponible ? 'Proyecto no disponible' : 'Proyecto')}
              </Text>
              {proyecto ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {[dpto !== '—' ? dpto : null, fechas].filter(Boolean).join(' · ')}
                </Text>
              ) : null}
            </View>
            {proyecto ? <BadgeEstadoProyecto estado={proyecto.estado} /> : null}
            <TouchableOpacity
              style={modal.close}
              onPress={onCerrar}
              accessibilityLabel="Cerrar"
            >
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {cargando ? (
              <View style={styles.centro}>
                <ActivityIndicator size="small" color="#0ea5e9" />
                <Text style={styles.centroTexto}>Cargando el proyecto…</Text>
              </View>
            ) : noDisponible ? (
              <Text style={styles.centroTexto}>
                Este proyecto ya no está disponible o no puedes verlo.
              </Text>
            ) : error ? (
              <Text style={modal.error}>{error}</Text>
            ) : proyecto ? (
              <>
                <View style={styles.fila}>
                  <Text style={styles.label}>Responsable</Text>
                  <Text style={styles.valor}>
                    {nombreUsuario(proyecto.responsable_id, proyecto.responsable_nombre)}
                  </Text>
                </View>
                <View style={styles.fila}>
                  <Text style={styles.label}>Mis tareas</Text>
                  <Text style={styles.valor}>
                    {resumenTareas.abiertas === 0
                      ? 'Ninguna abierta en esta lista'
                      : `${resumenTareas.abiertas} ${resumenTareas.abiertas === 1 ? 'abierta' : 'abiertas'}${
                          resumenTareas.estaSemana > 0
                            ? ` · ${resumenTareas.estaSemana} esta semana`
                            : ''
                        }`}
                  </Text>
                </View>

                {tareasMias.length > 0 ? (
                  <View style={styles.listaTareas}>
                    {tareasMias.map((tarea) => (
                      <TouchableOpacity
                        key={tarea.id_tarea}
                        style={styles.lineaTarea}
                        onPress={() => onAbrirTarea(tarea)}
                        accessibilityLabel={`Abrir la tarea ${tarea.titulo}`}
                      >
                        <View
                          style={[
                            styles.punto,
                            { backgroundColor: colorDepartamento(tarea.departamento_id) },
                          ]}
                        />
                        <View style={styles.lineaTexto}>
                          <Text style={styles.lineaTitulo} numberOfLines={1}>
                            {tarea.titulo}
                          </Text>
                          <Text style={styles.lineaMeta}>
                            {grupoVencimiento(tarea.fecha_limite) === 'sin_fecha'
                              ? 'Sin fecha'
                              : formatFecha(tarea.fecha_limite)}
                          </Text>
                        </View>
                        <BadgeEstadoTarea estado={tarea.estado} />
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}
          </ScrollView>

          {proyecto && !noDisponible ? (
            <View style={modal.footer}>
              <TouchableOpacity
                style={[modal.btn, modal.btnPrimario, styles.btnFila, isCompact && modal.btnTactil]}
                onPress={() => onVerCompleto(proyecto.id_proyecto)}
              >
                <Text style={modal.btnTextPrimario}>Ver proyecto completo</Text>
                <MaterialIcons name="arrow-forward" size={16} color="#ffffff" />
              </TouchableOpacity>
            </View>
          ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlaySheet: { justifyContent: 'flex-end' },
  cardWrapMovil: { maxWidth: '100%' },
  card: { maxHeight: '88%' },
  cardMovil: {
    width: '100%',
    maxWidth: '100%',
    maxHeight: '94%',
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  btnFila: { flexDirection: 'row', gap: 6 },
  headerTexto: { flex: 1, minWidth: 0, gap: 4, marginRight: 8 },
  meta: { fontSize: 12, color: '#64748b' },
  body: { maxHeight: 420 },
  bodyContent: { paddingHorizontal: 20, paddingVertical: 16, gap: 12 },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  fila: { gap: 2 },
  label: { fontSize: 11, fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 },
  valor: { fontSize: 13, color: '#334155' },
  listaTareas: { gap: 6, marginTop: 4 },
  lineaTarea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    minHeight: MIN_TOUCH,
  },
  punto: { width: 8, height: 8, borderRadius: 4 },
  lineaTexto: { flex: 1, minWidth: 0 },
  lineaTitulo: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  lineaMeta: { fontSize: 11, color: '#64748b', marginTop: 1 },
});
