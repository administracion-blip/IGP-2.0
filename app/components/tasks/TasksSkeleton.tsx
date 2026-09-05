/**
 * Skeletons de carga del piloto Proyectos (variant tasks).
 * Barras estáticas con tokens; sin spinners a pantalla completa.
 */
import { View, StyleSheet } from 'react-native';
import {
  tasksColor,
  tasksRadius,
  tasksSpace,
  tasksTabla,
} from '../../constants/tasksUiTokens';

const ANCHOS_FILA = ['42%', '18%', '22%', '16%', '14%', '14%', '12%'] as const;
const ANCHOS_CARD = ['72%', '48%', '36%'] as const;

type TasksTableSkeletonProps = {
  /** Número de filas fantasma. Por defecto 8. */
  filas?: number;
};

/** Filas tipo tabla: barras grises de distinto ancho (simulan celdas). */
export function TasksTableSkeleton({ filas = 8 }: TasksTableSkeletonProps) {
  return (
    <View
      style={styles.tablaWrap}
      accessibilityRole="progressbar"
      accessibilityLabel="Cargando listado"
    >
      {Array.from({ length: filas }, (_, i) => (
        <View key={i} style={styles.fila}>
          {ANCHOS_FILA.map((ancho, j) => (
            <View
              key={j}
              style={[
                styles.barra,
                styles.barraFila,
                { width: ancho as `${number}%`, opacity: 0.55 + ((i + j) % 3) * 0.12 },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

type TasksCardsSkeletonProps = {
  /** Número de tarjetas fantasma. Por defecto 4. */
  tarjetas?: number;
};

/** Tarjetas fantasma para Mis tareas. */
export function TasksCardsSkeleton({ tarjetas = 4 }: TasksCardsSkeletonProps) {
  return (
    <View
      style={styles.cardsWrap}
      accessibilityRole="progressbar"
      accessibilityLabel="Cargando tareas"
    >
      {Array.from({ length: tarjetas }, (_, i) => (
        <View key={i} style={styles.card}>
          {ANCHOS_CARD.map((ancho, j) => (
            <View
              key={j}
              style={[
                styles.barra,
                j === 0 ? styles.barraCardTitulo : styles.barraCardMeta,
                { width: ancho as `${number}%`, opacity: 0.5 + ((i + j) % 3) * 0.15 },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tablaWrap: {
    paddingVertical: tasksSpace[2],
    paddingHorizontal: tasksSpace[3],
    gap: tasksSpace[1],
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tasksSpace[3],
    minHeight: tasksTabla.filaMinHeight,
    paddingHorizontal: tasksSpace[2],
    borderBottomWidth: 1,
    borderBottomColor: tasksColor.bordeSutil,
  },
  barra: {
    backgroundColor: tasksColor.superficieHundida,
    borderRadius: tasksRadius.control,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
  },
  barraFila: {
    height: 12,
  },
  cardsWrap: {
    gap: tasksSpace[3],
    paddingVertical: tasksSpace[2],
  },
  card: {
    backgroundColor: tasksColor.superficie,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    borderRadius: tasksRadius.contenedor,
    padding: tasksSpace[4],
    gap: tasksSpace[2],
  },
  barraCardTitulo: {
    height: 14,
  },
  barraCardMeta: {
    height: 10,
  },
});
