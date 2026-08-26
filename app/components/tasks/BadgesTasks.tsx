/**
 * Etiquetas de estado y prioridad del módulo de dirección. Mismo aspecto que el
 * badge de `app/(app)/departamentos.tsx` para que las pantallas del módulo se
 * vean como el resto del ERP.
 */
import { View, Text, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
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

export function BadgeTasks({
  etiqueta,
  tono,
  icono,
  grande = false,
}: {
  etiqueta: string;
  tono: Tono;
  icono?: NombreIcono;
  grande?: boolean;
}) {
  return (
    <View style={[styles.badge, grande && styles.badgeGrande, { backgroundColor: tono.bg }]}>
      {icono ? <MaterialIcons name={icono} size={grande ? 14 : 11} color={tono.fg} /> : null}
      <Text style={[styles.texto, grande && styles.textoGrande, { color: tono.fg }]}>{etiqueta}</Text>
    </View>
  );
}

export function BadgeEstadoProyecto({ estado, grande }: { estado?: EstadoProyecto; grande?: boolean }) {
  if (!estado) return null;
  return (
    <BadgeTasks etiqueta={ETIQUETA_ESTADO_PROYECTO[estado] ?? estado} tono={TONO_ESTADO_PROYECTO[estado]} grande={grande} />
  );
}

export function BadgeEstadoTarea({ estado, grande }: { estado?: EstadoTarea; grande?: boolean }) {
  if (!estado) return null;
  return (
    <BadgeTasks etiqueta={ETIQUETA_ESTADO_TAREA[estado] ?? estado} tono={TONO_ESTADO_TAREA[estado]} grande={grande} />
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
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_PRIORIDAD[prioridad] ?? prioridad}
      tono={TONO_PRIORIDAD[prioridad]}
      icono={prioridad === 'alta' ? 'priority-high' : undefined}
      grande={grande}
    />
  );
}

export function BadgeRolProyecto({ rol }: { rol: RolProyecto }) {
  const tono: Tono =
    rol === 'responsable'
      ? { bg: '#dcfce7', fg: '#15803d' }
      : rol === 'miembro'
        ? { bg: '#e0f2fe', fg: '#0369a1' }
        : { bg: '#f1f5f9', fg: '#64748b' };
  return <BadgeTasks etiqueta={ETIQUETA_ROL_PROYECTO[rol] ?? rol} tono={tono} icono={ICONO_ROL_PROYECTO[rol]} />;
}

export function BadgeEstadoReunion({ estado, grande }: { estado?: EstadoReunion; grande?: boolean }) {
  if (!estado) return null;
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ESTADO_REUNION[estado] ?? estado}
      tono={TONO_ESTADO_REUNION[estado]}
      grande={grande}
    />
  );
}

export function BadgeEstadoAcuerdo({ estado, grande }: { estado?: EstadoAcuerdo; grande?: boolean }) {
  if (!estado) return null;
  return (
    <BadgeTasks
      etiqueta={ETIQUETA_ESTADO_ACUERDO[estado] ?? estado}
      tono={TONO_ESTADO_ACUERDO[estado]}
      grande={grande}
    />
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  badgeGrande: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, gap: 4 },
  texto: { fontSize: 10, fontWeight: '600' },
  textoGrande: { fontSize: 12, fontWeight: '700' },
});
