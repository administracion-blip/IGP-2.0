/**
 * Contador `2/5` de la lista de comprobación de una tarea.
 * Azul mientras falte alguna casilla; verde cuando están todas hechas.
 */
import { Text, StyleSheet } from 'react-native';
import { tasksColor } from '../../constants/tasksUiTokens';
import { checklistCompletada, textoProgresoChecklist } from '../../lib/tasksUi';

export function ContadorChecklist({
  checklist,
  compacto = false,
}: {
  checklist?: ReadonlyArray<{ hecho?: boolean }> | null;
  compacto?: boolean;
}) {
  const texto = textoProgresoChecklist(checklist);
  if (!texto) return null;
  const completo = checklistCompletada(checklist);
  return (
    <Text
      style={[
        styles.base,
        compacto && styles.compacto,
        completo ? styles.completo : styles.parcial,
      ]}
    >
      {texto}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    fontSize: 12,
    fontWeight: '700',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  compacto: {
    fontSize: 10,
    lineHeight: 14,
    paddingHorizontal: 5,
    paddingVertical: 0,
  },
  parcial: {
    color: tasksColor.acentoTexto,
    backgroundColor: tasksColor.acentoSuave,
  },
  completo: {
    color: '#15803d',
    backgroundColor: tasksColor.exitoSuave,
  },
});
