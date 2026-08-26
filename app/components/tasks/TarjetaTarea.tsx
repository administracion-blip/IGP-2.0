/**
 * Tarjeta de una tarea con acciones directas.
 *
 * Es la pieza de la vista personal, la pantalla que la gente abre cada día, y
 * por eso tiene que servirse **con una mano en un móvil**: en pantalla estrecha
 * se apila y los botones ocupan `MIN_TOUCH`; en escritorio se pone en una fila
 * densa. Las vencidas se marcan con franja y fecha en rojo.
 */
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  grupoVencimiento,
  nombreProyectoDeTarea,
  nombreUsuario,
  textoVencimiento,
} from '../../lib/tasksUi';
import { BadgeEstadoTarea, BadgePrioridad } from './BadgesTasks';
import { AccionesEstadoTarea } from './AccionesEstadoTarea';
import type { EstadoTarea, Tarea } from '../../types/tasks';

export function TarjetaTarea({
  tarea,
  onAbrir,
  onCambiarEstado,
  mostrarProyecto = false,
  mostrarResponsable = false,
  ocupado = false,
  estadoEnCurso = null,
  soloRapidas = true,
}: {
  tarea: Tarea;
  onAbrir: () => void;
  /** Sin este callback la tarjeta es de solo lectura (sin permiso de edición). */
  onCambiarEstado?: (destino: EstadoTarea) => void;
  /** En la ficha del proyecto sobra: todas las tareas son de ese proyecto. */
  mostrarProyecto?: boolean;
  /** En la vista personal sobra: todas son de quien mira. */
  mostrarResponsable?: boolean;
  ocupado?: boolean;
  estadoEnCurso?: EstadoTarea | null;
  soloRapidas?: boolean;
}) {
  const { isDesktop, isCompact } = useBreakpoint();
  const vencida = grupoVencimiento(tarea.fecha_limite) === 'vencidas';
  const cerrada = tarea.estado === 'hecha' || tarea.estado === 'cancelada';

  const meta = [
    mostrarProyecto ? nombreProyectoDeTarea(tarea) : null,
    mostrarResponsable ? nombreUsuario(tarea.responsable_id, tarea.responsable_nombre) : null,
  ]
    .filter((texto) => texto && texto !== '—')
    .join(' · ');

  return (
    <View style={[styles.card, vencida && !cerrada && styles.cardVencida, !isDesktop && styles.cardApilada]}>
      <TouchableOpacity
        style={[styles.cuerpo, isDesktop && styles.cuerpoFila]}
        onPress={onAbrir}
        activeOpacity={0.75}
        accessibilityLabel={`Abrir la tarea ${tarea.titulo}`}
      >
        <View style={styles.textoWrap}>
          <Text style={[styles.titulo, cerrada && styles.tituloCerrado]} numberOfLines={2}>
            {tarea.titulo}
          </Text>
          <View style={styles.metaFila}>
            <MaterialIcons
              name="event"
              size={13}
              color={vencida && !cerrada ? '#b91c1c' : '#94a3b8'}
            />
            <Text style={[styles.metaTexto, vencida && !cerrada && styles.metaVencida]}>
              {textoVencimiento(tarea.fecha_limite)}
            </Text>
            {meta ? <Text style={styles.metaTexto} numberOfLines={1}>{`· ${meta}`}</Text> : null}
          </View>
          {tarea.estado === 'bloqueada' && tarea.bloqueo_motivo ? (
            <View style={styles.bloqueoFila}>
              <MaterialIcons name="block" size={13} color="#b45309" />
              <Text style={styles.bloqueoTexto} numberOfLines={2}>
                {tarea.bloqueo_motivo}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={[styles.badges, isDesktop && styles.badgesFila]}>
          <BadgePrioridad prioridad={tarea.prioridad} />
          <BadgeEstadoTarea estado={tarea.estado} />
          {isDesktop ? <MaterialIcons name="chevron-right" size={20} color="#cbd5e1" /> : null}
        </View>
      </TouchableOpacity>

      {onCambiarEstado ? (
        <View style={[styles.acciones, !isDesktop && styles.accionesApiladas]}>
          <AccionesEstadoTarea
            estado={tarea.estado}
            onCambiar={onCambiarEstado}
            ocupado={ocupado}
            estadoEnCurso={estadoEnCurso}
            soloRapidas={soloRapidas}
            tactil={isCompact}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  cardApilada: { gap: 10 },
  cardVencida: { borderLeftWidth: 4, borderLeftColor: '#dc2626' },
  cuerpo: { gap: 6, minHeight: MIN_TOUCH, justifyContent: 'center' },
  cuerpoFila: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  textoWrap: { flex: 1, minWidth: 0, gap: 4 },
  titulo: { fontSize: 14, fontWeight: '600', color: '#0f172a', lineHeight: 19 },
  tituloCerrado: { color: '#64748b', textDecorationLine: 'line-through' },
  metaFila: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  metaTexto: { fontSize: 12, color: '#64748b' },
  metaVencida: { color: '#b91c1c', fontWeight: '700' },
  bloqueoFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  bloqueoTexto: { flex: 1, fontSize: 12, color: '#b45309', lineHeight: 17 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  badgesFila: { flexShrink: 0 },
  acciones: { borderTopWidth: 1, borderTopColor: '#f1f5f9', paddingTop: 8 },
  accionesApiladas: { paddingTop: 10 },
});
