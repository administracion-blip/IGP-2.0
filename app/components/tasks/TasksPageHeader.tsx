/**
 * Cabecera común de pantallas del módulo de dirección (piloto UI).
 *
 * Atrás · título · subtítulo/contador · acciones a la derecha.
 * Slot opcional `below` para filtros que quedan bajo el título.
 */
import type { ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import {
  tasksColor,
  tasksIcono,
  tasksRadius,
  tasksSpace,
  tasksTipo,
} from '../../constants/tasksUiTokens';

export type TasksPageHeaderProps = {
  title: string;
  subtitle?: string;
  /** Contador contextual junto al subtítulo (p. ej. «12 proyectos»). */
  countLabel?: string;
  onBack?: () => void;
  backAccessibilityLabel?: string;
  /** Botones / controles a la derecha del título. */
  actions?: ReactNode;
  /** Fila bajo la cabecera (filtros). */
  below?: ReactNode;
  /** Si true, el botón atrás cumple zona táctil mínima. */
  compact?: boolean;
};

export function TasksPageHeader({
  title,
  subtitle,
  countLabel,
  onBack,
  backAccessibilityLabel = 'Volver',
  actions,
  below,
  compact = false,
}: TasksPageHeaderProps) {
  const meta = [subtitle, countLabel].filter(Boolean).join(' · ');

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {onBack ? (
          <TouchableOpacity
            onPress={onBack}
            style={[styles.backBtn, compact && styles.backBtnTactil]}
            accessibilityLabel={backAccessibilityLabel}
            accessibilityRole="button"
            hitSlop={8}
          >
            <MaterialIcons name="arrow-back" size={tasksIcono.size} color={tasksColor.textoSecundario} />
          </TouchableOpacity>
        ) : null}
        <View style={styles.texto}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {meta ? (
            <Text style={styles.subtitle} numberOfLines={2}>
              {meta}
            </Text>
          ) : null}
        </View>
        {actions ? <View style={styles.actions}>{actions}</View> : null}
      </View>
      {below ? <View style={styles.below}>{below}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: tasksSpace[4],
    gap: tasksSpace[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.superficie,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
  },
  backBtnTactil: {
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
  },
  texto: { flex: 1, minWidth: 0 },
  title: {
    ...tasksTipo.tituloPantalla,
  },
  subtitle: {
    ...tasksTipo.micro,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tasksSpace[2],
    flexShrink: 0,
  },
  below: {
    paddingLeft: 0,
  },
});
