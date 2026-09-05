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
import {
  tasksColor,
  tasksRadius,
  tasksTipo,
} from '../../constants/tasksUiTokens';
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
              color={vencida && !cerrada ? tasksColor.peligro : tasksColor.textoTerciario}
            />
            <Text style={[styles.metaTexto, vencida && !cerrada && styles.metaVencida]}>
              {textoVencimiento(tarea.fecha_limite)}
            </Text>
            {meta ? <Text style={styles.metaTexto} numberOfLines={1}>{`· ${meta}`}</Text> : null}
          </View>
          {tarea.estado === 'bloqueada' && tarea.bloqueo_motivo ? (
            <View style={styles.bloqueoFila}>
              <MaterialIcons name="block" size={13} color={tasksColor.aviso} />
              <Text style={styles.bloqueoTexto} numberOfLines={2}>
                {tarea.bloqueo_motivo}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={[styles.badges, isDesktop && styles.badgesFila]}>
          <BadgePrioridad prioridad={tarea.prioridad} />
          <BadgeEstadoTarea estado={tarea.estado} />
          {isDesktop ? (
            <MaterialIcons name="chevron-right" size={20} color={tasksColor.bordeFuerte} />
          ) : null}
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
    backgroundColor: tasksColor.superficie,
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  cardApilada: { gap: 10 },
  cardVencida: { borderLeftWidth: 4, borderLeftColor: tasksColor.peligro },
  cuerpo: { gap: 6, minHeight: MIN_TOUCH, justifyContent: 'center' },
  cuerpoFila: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  textoWrap: { flex: 1, minWidth: 0, gap: 4 },
  titulo: { ...tasksTipo.dato, fontWeight: '600' },
  tituloCerrado: {
    color: tasksColor.textoSecundario,
    textDecorationLine: 'line-through',
  },
  metaFila: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  metaTexto: { ...tasksTipo.micro },
  metaVencida: { color: tasksColor.peligro, fontWeight: '700' },
  bloqueoFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  bloqueoTexto: { flex: 1, ...tasksTipo.micro, color: tasksColor.aviso },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  badgesFila: { flexShrink: 0 },
  acciones: {
    borderTopWidth: 1,
    borderTopColor: tasksColor.bordeSutil,
    paddingTop: 8,
  },
  accionesApiladas: { paddingTop: 10 },
});
