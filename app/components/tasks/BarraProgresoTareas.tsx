/**
 * Barra fina de avance de tareas (hechas / total, excluyendo canceladas).
 * Solo frontend: el padre pasa el array ya cargado (puede ser una página).
 */
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
  tasksColor,
  tasksRadius,
  tasksSpace,
  tasksTabularNums,
  tasksTipo,
} from '../../constants/tasksUiTokens';
import type { EstadoTarea } from '../../types/tasks';

export type TareaConEstado = { estado: EstadoTarea | string };

export type ProgresoTareas = {
  hechas: number;
  total: number;
  pct: number;
};

/** Excluye canceladas; hechas = estado === 'hecha'. */
export function calcularProgresoTareas(tareas: readonly TareaConEstado[]): ProgresoTareas {
  let hechas = 0;
  let total = 0;
  for (const t of tareas) {
    if (t.estado === 'cancelada') continue;
    total += 1;
    if (t.estado === 'hecha') hechas += 1;
  }
  return { hechas, total, pct: total === 0 ? 0 : hechas / total };
}

type Props = {
  tareas: readonly TareaConEstado[];
  /**
   * Si hay más páginas sin cargar, muestra nota «sobre las N cargadas»
   * para no fingir el total del proyecto.
   */
  incompleto?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function BarraProgresoTareas({ tareas, incompleto = false, style }: Props) {
  const { hechas, total, pct } = calcularProgresoTareas(tareas);
  const pctEntero = Math.round(pct * 100);
  const completo = total > 0 && pct >= 1;

  const accessibilityLabel =
    total === 0
      ? 'Sin tareas'
      : incompleto
        ? `${hechas} de ${total} tareas hechas, sobre las ${tareas.length} cargadas`
        : `${hechas} de ${total} tareas hechas, ${pctEntero} por ciento`;

  return (
    <View
      style={[styles.wrap, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: pctEntero }}
    >
      {total === 0 ? (
        <Text style={styles.etiqueta}>Sin tareas</Text>
      ) : (
        <Text style={styles.etiqueta}>
          <Text style={styles.cifra}>{hechas}</Text>
          {' de '}
          <Text style={styles.cifra}>{total}</Text>
          {' tareas hechas'}
        </Text>
      )}
      <View style={styles.track} importantForAccessibility="no">
        <View
          style={[
            styles.fill,
            {
              width: `${pctEntero}%`,
              backgroundColor: completo ? tasksColor.exito : tasksColor.acento,
            },
          ]}
        />
      </View>
      {incompleto && total > 0 ? (
        <Text style={styles.nota}>sobre las {tareas.length} cargadas</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: tasksSpace[1],
    maxWidth: 360,
  },
  etiqueta: {
    ...tasksTipo.etiqueta,
  },
  cifra: {
    ...tasksTipo.etiqueta,
    ...tasksTabularNums,
    color: tasksColor.textoSecundario,
    fontWeight: '600',
  },
  track: {
    height: 5,
    borderRadius: tasksRadius.pildora,
    backgroundColor: tasksColor.superficieHundida,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: tasksRadius.pildora,
  },
  nota: {
    ...tasksTipo.micro,
  },
});
