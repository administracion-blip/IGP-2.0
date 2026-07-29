import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import {
  formatearCronometro,
  formatearDuracionTrabajo,
  segundosTrabajo,
} from '../../lib/mantenimientoIncidenciaUi';

export type MantenimientoCronometroFilaProps = {
  /** Segundos de trabajo de los tramos ya cerrados. */
  segundosAcumulados?: number;
  /** ISO de inicio del tramo abierto; vacío si el cronómetro está parado. */
  enCursoDesde?: string;
  /** Petición en vuelo: bloquea el botón. */
  ocupado?: boolean;
  onIniciar?: () => void;
  onFinalizar?: () => void;
};

/**
 * Fila de cronómetro de una reparación. Lleva su propio tick para que el
 * segundero no obligue a repintar la lista de tarjetas entera; el temporizador
 * solo existe mientras ese tramo está abierto.
 */
export function MantenimientoCronometroFila({
  segundosAcumulados,
  enCursoDesde,
  ocupado = false,
  onIniciar,
  onFinalizar,
}: MantenimientoCronometroFilaProps) {
  const inicio = (enCursoDesde ?? '').trim();
  const enCurso = inicio !== '';
  const [ahoraMs, setAhoraMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enCurso) return;
    setAhoraMs(Date.now());
    const id = setInterval(() => setAhoraMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enCurso, inicio]);

  const segundos = segundosTrabajo(segundosAcumulados, inicio, ahoraMs);
  const onPulsar = enCurso ? onFinalizar : onIniciar;
  const texto = enCurso
    ? formatearCronometro(segundos)
    : segundos > 0
      ? formatearDuracionTrabajo(segundos)
      : 'Sin cronometrar';
  const accion = enCurso
    ? 'Parar cronómetro'
    : segundos > 0
      ? 'Reanudar cronómetro'
      : 'Iniciar cronómetro';

  return (
    <View style={[styles.row, enCurso && styles.rowActivo]}>
      <MaterialIcons
        name={enCurso || segundos > 0 ? 'timer' : 'timer-off'}
        size={16}
        color={enCurso ? '#b45309' : '#94a3b8'}
      />
      <Text style={[styles.texto, enCurso && styles.textoActivo]} numberOfLines={1}>
        {texto}
      </Text>
      <TouchableOpacity
        onPress={onPulsar}
        disabled={ocupado || !onPulsar}
        style={styles.btn}
        activeOpacity={0.7}
        accessibilityLabel={accion}
      >
        {ocupado ? (
          <ActivityIndicator size="small" color={enCurso ? '#b45309' : '#0f766e'} />
        ) : (
          <MaterialIcons
            name={enCurso ? 'pause' : 'play-arrow'}
            size={20}
            color={enCurso ? '#b45309' : '#0f766e'}
          />
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
    paddingLeft: 8,
    paddingRight: 2,
    minHeight: MIN_TOUCH,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    minWidth: 0,
  },
  rowActivo: { backgroundColor: '#fffbeb', borderColor: '#fcd34d' },
  texto: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    fontWeight: '700',
    color: '#64748b',
    fontVariant: ['tabular-nums'],
  },
  textoActivo: { color: '#b45309' },
  btn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    flexShrink: 0,
  },
});
