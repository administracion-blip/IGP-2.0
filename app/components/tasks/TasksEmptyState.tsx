/**
 * Empty state del piloto Proyectos: icono + título + descripción + CTA opcional.
 */
import { type ComponentProps } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import {
  tasksColor,
  tasksIcono,
  tasksRadius,
  tasksSpace,
  tasksTipo,
} from '../../constants/tasksUiTokens';

type NombreIcono = ComponentProps<typeof MaterialIcons>['name'];

export type TasksEmptyStateProps = {
  /** Icono MaterialIcons a la izquierda del mensaje. */
  icono?: NombreIcono;
  /** Color del icono; por defecto el token terciario. */
  colorIcono?: string;
  /** Título breve (estilo sección). */
  titulo: string;
  /** Texto de apoyo opcional. */
  descripcion?: string;
  /** Etiqueta del botón primario; si falta, no se muestra CTA. */
  actionLabel?: string;
  /** Callback del CTA. */
  onAction?: () => void;
};

export function TasksEmptyState({
  icono = 'inbox',
  colorIcono = tasksIcono.color,
  titulo,
  descripcion,
  actionLabel,
  onAction,
}: TasksEmptyStateProps) {
  const { isCompact } = useBreakpoint();
  const mostrarCta = Boolean(actionLabel && onAction);

  return (
    <View
      style={styles.wrap}
      accessibilityLabel={descripcion ? `${titulo}. ${descripcion}` : titulo}
    >
      <MaterialIcons name={icono} size={40} color={colorIcono} />
      <Text style={styles.titulo}>{titulo}</Text>
      {descripcion ? <Text style={styles.descripcion}>{descripcion}</Text> : null}
      {mostrarCta ? (
        <TouchableOpacity
          style={[styles.cta, isCompact && styles.ctaTactil]}
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <MaterialIcons name="add" size={18} color={tasksColor.textoInverso} />
          <Text style={styles.ctaTexto}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: tasksSpace[2],
    paddingVertical: tasksSpace[6],
    paddingHorizontal: tasksSpace[5],
  },
  titulo: {
    ...tasksTipo.tituloSeccion,
    textAlign: 'center',
  },
  descripcion: {
    ...tasksTipo.cuerpo,
    textAlign: 'center',
    maxWidth: 420,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tasksSpace[1],
    marginTop: tasksSpace[2],
    paddingVertical: tasksSpace[2],
    paddingHorizontal: tasksSpace[4],
    backgroundColor: tasksColor.acento,
    borderRadius: tasksRadius.control,
  },
  ctaTactil: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: tasksSpace[5],
  },
  ctaTexto: {
    fontSize: 13,
    fontWeight: '600',
    color: tasksColor.textoInverso,
  },
});
