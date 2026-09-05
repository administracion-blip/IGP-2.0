/**
 * Franja de KPIs accionables del hub de Proyectos (home de dirección).
 * Chips ligeros con tokens del piloto; no sustituye HubNavCard.
 */
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MIN_TOUCH } from '../../constants/layout';
import {
  tasksColor,
  tasksRadius,
  tasksSpace,
  tasksTabularNums,
  tasksTipo,
} from '../../constants/tasksUiTokens';

export type TasksHubKpiItem = {
  id: string;
  /** `null` → muestra "—" (fallo de red / sin dato fiable). */
  valor: number | null;
  etiqueta: string;
  /** Aviso/peligro solo cuando el valor es > 0. */
  tono?: 'normal' | 'aviso' | 'peligro';
  accessibilityLabel: string;
  onPress: () => void;
  /** Pie opcional (p. ej. listado truncado). */
  nota?: string;
};

type Props = {
  items: TasksHubKpiItem[];
  /** Apilar / wrap en layouts compactos (`shouldStackToolbar`). */
  stacked?: boolean;
};

export function TasksHubKpis({ items, stacked = false }: Props) {
  if (!items.length) return null;

  return (
    <View style={[styles.fila, stacked ? styles.filaWrap : styles.filaLinea]}>
      {items.map((item) => {
        const n = item.valor;
        const alerta = typeof n === 'number' && n > 0 && (item.tono === 'aviso' || item.tono === 'peligro');
        const esPeligro = alerta && item.tono === 'peligro';
        const esAviso = alerta && item.tono === 'aviso';

        return (
          <TouchableOpacity
            key={item.id}
            onPress={item.onPress}
            style={[
              styles.chip,
              stacked ? styles.chipStacked : styles.chipFlex,
              esPeligro && styles.chipPeligro,
              esAviso && styles.chipAviso,
            ]}
            accessibilityRole="button"
            accessibilityLabel={item.accessibilityLabel}
            activeOpacity={0.75}
          >
            <Text
              style={[
                styles.valor,
                esPeligro && styles.valorPeligro,
                esAviso && styles.valorAviso,
              ]}
            >
              {n === null ? '—' : n}
            </Text>
            <Text
              style={[
                styles.etiqueta,
                esPeligro && styles.etiquetaPeligro,
                esAviso && styles.etiquetaAviso,
              ]}
              numberOfLines={2}
            >
              {item.etiqueta}
            </Text>
            {item.nota ? (
              <Text style={styles.nota} numberOfLines={2}>
                {item.nota}
              </Text>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: {
    gap: tasksSpace[2],
    marginBottom: tasksSpace[4],
  },
  filaLinea: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  filaWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
  },
  chip: {
    backgroundColor: tasksColor.superficie,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    borderRadius: tasksRadius.contenedor,
    paddingHorizontal: tasksSpace[3],
    paddingVertical: tasksSpace[3],
    minHeight: MIN_TOUCH,
    justifyContent: 'center',
  },
  chipFlex: {
    flex: 1,
    minWidth: 0,
  },
  chipStacked: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 140,
  },
  chipAviso: {
    backgroundColor: tasksColor.avisoSuave,
    borderColor: '#fde68a',
  },
  chipPeligro: {
    backgroundColor: tasksColor.peligroSuave,
    borderColor: '#fecaca',
  },
  valor: {
    ...tasksTipo.tituloPantalla,
    ...tasksTabularNums,
  },
  valorAviso: {
    color: tasksColor.aviso,
  },
  valorPeligro: {
    color: tasksColor.peligro,
  },
  etiqueta: {
    ...tasksTipo.etiqueta,
    marginTop: 2,
  },
  etiquetaAviso: {
    color: tasksColor.aviso,
  },
  etiquetaPeligro: {
    color: tasksColor.peligro,
  },
  nota: {
    ...tasksTipo.micro,
    marginTop: tasksSpace[1],
    color: tasksColor.aviso,
  },
});

export default TasksHubKpis;
