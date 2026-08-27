/**
 * Pastilla compacta de una tarea en el calendario de «Mis tareas».
 *
 * El cuerpo abre la ficha de la tarea. La flecha abre el vistazo del proyecto
 * (si la tarea tiene uno alcanzable). La franja de color es el departamento.
 */
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { grupoVencimiento, proyectoDeTareaAlcanzable } from '../../lib/tasksUi';
import { abreviaturaDepartamento, colorDepartamento } from '../../lib/tasksDepartamentoColor';
import type { Tarea } from '../../types/tasks';

export function PastillaTareaCalendario({
  tarea,
  nombreDepartamento,
  compacta = false,
  onAbrirTarea,
  onAbrirProyecto,
}: {
  tarea: Tarea;
  nombreDepartamento: (id?: string | null) => string;
  /** En el grid del mes las pastillas van más apretadas. */
  compacta?: boolean;
  onAbrirTarea: () => void;
  onAbrirProyecto?: () => void;
}) {
  const vencida = grupoVencimiento(tarea.fecha_limite) === 'vencidas';
  const color = colorDepartamento(tarea.departamento_id);
  const nombreDpto = (tarea.departamento_id ?? '').trim()
    ? nombreDepartamento(tarea.departamento_id)
    : '';
  const abrev = abreviaturaDepartamento(nombreDpto === '—' ? '' : nombreDpto);
  const hayProyecto = proyectoDeTareaAlcanzable(tarea) && onAbrirProyecto;

  return (
    <View style={[styles.pill, vencida && styles.pillVencida]}>
      <View style={[styles.franja, { backgroundColor: color }]} />
      <TouchableOpacity
        style={styles.cuerpo}
        onPress={onAbrirTarea}
        activeOpacity={0.75}
        accessibilityLabel={`Abrir la tarea ${tarea.titulo}`}
      >
        <Text style={styles.titulo} numberOfLines={compacta ? 1 : 2}>
          {tarea.titulo}
        </Text>
        <View style={styles.meta}>
          {abrev ? <Text style={[styles.abrev, { color }]}>{abrev}</Text> : null}
          {vencida ? <Text style={styles.alerta}>!</Text> : null}
        </View>
      </TouchableOpacity>
      {hayProyecto ? (
        <TouchableOpacity
          style={styles.proyectoBtn}
          onPress={onAbrirProyecto}
          accessibilityLabel={`Ver el proyecto ${tarea.proyecto_nombre}`}
        >
          <MaterialIcons name="north-east" size={14} color="#64748b" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    minHeight: 36,
  },
  pillVencida: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  franja: { width: 4 },
  cuerpo: { flex: 1, minWidth: 0, paddingHorizontal: 7, paddingVertical: 5, gap: 2 },
  titulo: { fontSize: 12, fontWeight: '600', color: '#0f172a', lineHeight: 16 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  abrev: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  alerta: { fontSize: 12, fontWeight: '800', color: '#dc2626' },
  proyectoBtn: {
    width: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
});
