/**
 * Botonera de cambio de estado de una tarea.
 *
 * Solo ofrece los destinos que admite el estado actual (espejo de las
 * transiciones del backend): un botón que devolvería `422` no se pinta. El
 * bloqueo necesita motivo, así que el componente no lo pide: avisa al padre con
 * `bloqueada` y quien lo usa abre `ModalMotivoBloqueo`.
 */
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { ACCION_ESTADO_TAREA, ACCIONES_RAPIDAS_TAREA, transicionesDesde } from '../../lib/tasksUi';
import type { EstadoTarea } from '../../types/tasks';

export function AccionesEstadoTarea({
  estado,
  onCambiar,
  ocupado = false,
  soloRapidas = false,
  tactil = false,
  estadoEnCurso = null,
}: {
  estado: EstadoTarea;
  onCambiar: (destino: EstadoTarea) => void;
  ocupado?: boolean;
  /** Vista personal: solo cerrar, arrancar y bloquear. */
  soloRapidas?: boolean;
  /** Zonas táctiles de `MIN_TOUCH` (móvil/tablet). */
  tactil?: boolean;
  /** Destino cuyo cambio está en vuelo, para poner el indicador en su botón. */
  estadoEnCurso?: EstadoTarea | null;
}) {
  const destinos = transicionesDesde(estado).filter(
    (d) => !soloRapidas || ACCIONES_RAPIDAS_TAREA.includes(d),
  );
  if (destinos.length === 0) return null;

  return (
    <View style={styles.fila}>
      {destinos.map((destino) => {
        const accion = ACCION_ESTADO_TAREA[destino];
        const esCerrar = destino === 'hecha';
        const enVuelo = ocupado && estadoEnCurso === destino;
        return (
          <TouchableOpacity
            key={destino}
            style={[
              styles.btn,
              tactil && styles.btnTactil,
              { backgroundColor: accion.tono.bg, borderColor: accion.tono.bg },
              esCerrar && styles.btnCerrar,
              ocupado && styles.btnOcupado,
            ]}
            onPress={() => onCambiar(destino)}
            disabled={ocupado}
            accessibilityLabel={accion.etiqueta}
          >
            {enVuelo ? (
              <ActivityIndicator size="small" color={esCerrar ? '#ffffff' : accion.tono.fg} />
            ) : (
              <MaterialIcons name={accion.icono} size={16} color={esCerrar ? '#ffffff' : accion.tono.fg} />
            )}
            <Text style={[styles.btnTexto, { color: esCerrar ? '#ffffff' : accion.tono.fg }]}>
              {accion.etiqueta}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 34,
  },
  btnTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 14, flexGrow: 1 },
  btnCerrar: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  btnOcupado: { opacity: 0.7 },
  btnTexto: { fontSize: 12, fontWeight: '700' },
});
