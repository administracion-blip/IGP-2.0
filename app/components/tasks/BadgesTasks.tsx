/**
 * Etiquetas de estado y prioridad del módulo de dirección.
 *
 * Piloto UI: por defecto punto de color + texto (sin pastilla). Fondo relleno
 * solo en estados que exigen acción (bloqueada, prioridad alta, acuerdo
 * incumplido, proyecto en pausa).
 */
import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { tasksColor, tasksRadius, tasksSpace, tasksTipo } from '../../constants/tasksUiTokens';
import {
  ETIQUETA_ESTADO_ACUERDO,
  ETIQUETA_ESTADO_PROYECTO,
  ETIQUETA_ESTADO_REUNION,
  ETIQUETA_ESTADO_TAREA,
  ETIQUETA_PRIORIDAD,
  ETIQUETA_ROL_PROYECTO,
  ICONO_ROL_PROYECTO,
  TONO_ESTADO_ACUERDO,
  TONO_ESTADO_PROYECTO,
  TONO_ESTADO_REUNION,
  TONO_ESTADO_TAREA,
  TONO_PRIORIDAD,
  type NombreIcono,
  type Tono,
} from '../../lib/tasksUi';
import type {
  EstadoAcuerdo,
  EstadoProyecto,
  EstadoReunion,
  EstadoTarea,
  Prioridad,
  RolProyecto,
} from '../../types/tasks';

type VarianteBadge = 'punto' | 'relleno';

export function BadgeTasks({
  etiqueta,
  tono,
  icono,
  grande = false,
  variante = 'punto',
}: {
  etiqueta: string;
  tono: Tono;
  icono?: NombreIcono;
  grande?: boolean;
  /** `punto` = pilota (default). `relleno` = alerta que exige acción. */
  variante?: VarianteBadge;
}) {
  if (variante === 'relleno') {
    return (
      <View
        style={[
          styles.badgeRelleno,
          grande && styles.badgeRellenoGrande,
          { backgroundColor: tono.bg },
        ]}
      >
        {icono ? <MaterialIcons name={icono} size={grande ? 14 : 11} color={tono.fg} /> : null}
        <Text style={[styles.textoRelleno, grande && styles.textoRellenoGrande, { color: tono.fg }]}>
          {etiqueta}
        </Text>
      </View>
    );
  }

  const dot = grande ? 7 : 6;
  return (
    <View style={[styles.badgePunto, grande && styles.badgePuntoGrande]}>
      <View
        style={[
          styles.punto,
          { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: tono.fg },
        ]}
      />
      {icono ? (
        <MaterialIcons name={icono} size={grande ? 14 : 12} color={tasksColor.textoSecundario} />
      ) : null}
      <Text style={[styles.textoPunto, grande && styles.textoPuntoGrande]}>{etiqueta}</Text>
    </View>
  );
}

export function BadgeEstadoProyecto({ estado, grande }: { estado?: EstadoProyecto; grande?: boolean }) {
  if (!estado) return null;
  const relleno = estado === 'en_pausa';
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ESTADO_PROYECTO[estado] ?? estado}
      tono={TONO_ESTADO_PROYECTO[estado]}
      grande={grande}
      variante={relleno ? 'relleno' : 'punto'}
    />
  );
}

export function BadgeEstadoTarea({ estado, grande }: { estado?: EstadoTarea; grande?: boolean }) {
  if (!estado) return null;
  const relleno = estado === 'bloqueada';
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ESTADO_TAREA[estado] ?? estado}
      tono={TONO_ESTADO_TAREA[estado]}
      grande={grande}
      variante={relleno ? 'relleno' : 'punto'}
    />
  );
}

/** La prioridad media no se pinta: es la de casi todo y solo añade ruido. */
export function BadgePrioridad({
  prioridad,
  siempre = false,
  grande,
}: {
  prioridad?: Prioridad;
  siempre?: boolean;
  grande?: boolean;
}) {
  if (!prioridad || (prioridad === 'media' && !siempre)) return null;
  const relleno = prioridad === 'alta';
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_PRIORIDAD[prioridad] ?? prioridad}
      tono={TONO_PRIORIDAD[prioridad]}
      icono={prioridad === 'alta' ? 'priority-high' : undefined}
      grande={grande}
      variante={relleno ? 'relleno' : 'punto'}
    />
  );
}

export function BadgeRolProyecto({ rol }: { rol: RolProyecto }) {
  const tono: Tono =
    rol === 'responsable'
      ? { bg: tasksColor.exitoSuave, fg: '#15803d' }
      : rol === 'miembro'
        ? { bg: tasksColor.acentoSuave, fg: tasksColor.acentoTexto }
        : { bg: tasksColor.bordeFuerte, fg: tasksColor.textoSecundario };
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ROL_PROYECTO[rol] ?? rol}
      tono={tono}
      icono={ICONO_ROL_PROYECTO[rol]}
      variante="punto"
    />
  );
}

export function BadgeEstadoReunion({ estado, grande }: { estado?: EstadoReunion; grande?: boolean }) {
  if (!estado) return null;
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ESTADO_REUNION[estado] ?? estado}
      tono={TONO_ESTADO_REUNION[estado]}
      grande={grande}
      variante="punto"
    />
  );
}

export function BadgeEstadoAcuerdo({ estado, grande }: { estado?: EstadoAcuerdo; grande?: boolean }) {
  if (!estado) return null;
  const relleno = estado === 'incumplido';
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ESTADO_ACUERDO[estado] ?? estado}
      tono={TONO_ESTADO_ACUERDO[estado]}
      grande={grande}
      variante={relleno ? 'relleno' : 'punto'}
    />
  );
}

const styles = StyleSheet.create({
  badgePunto: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingVertical: 1,
  },
  badgePuntoGrande: { gap: 6, paddingVertical: 2 },
  punto: { flexShrink: 0 },
  textoPunto: {
    ...tasksTipo.etiqueta,
    fontSize: 12,
    color: tasksColor.textoPrimario,
    fontWeight: '500',
  },
  textoPuntoGrande: {
    fontSize: 13,
    fontWeight: '600',
    color: tasksColor.textoPrimario,
  },

  badgeRelleno: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: tasksSpace[2],
    paddingVertical: 2,
    borderRadius: tasksRadius.control,
    alignSelf: 'flex-start',
  },
  badgeRellenoGrande: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: tasksRadius.contenedor,
    gap: 4,
  },
  textoRelleno: { fontSize: 10, fontWeight: '600' },
  textoRellenoGrande: { fontSize: 12, fontWeight: '700' },
});
