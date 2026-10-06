/**
 * Recuento y sumas de la selección múltiple, más el acceso a conciliarlas
 * contra un solo movimiento.
 */
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatMoneda } from '../../utils/facturacion';
import type { FacturaListado } from '../../types/factura';
import { motivoNoConciliar, sumaSeleccion } from '../../lib/seleccionFacturasConciliacion';

type Props = {
  facturas: FacturaListado[];
  puedeConciliar: boolean;
  onConciliar: () => void;
};

export function BarraSeleccionFacturas({ facturas, puedeConciliar, onConciliar }: Props) {
  const suma = sumaSeleccion(facturas);
  const motivo = motivoNoConciliar(facturas);
  if (suma.n === 0) return null;
  return (
    <View style={styles.fila}>
      <Text style={styles.texto}>
        {suma.n} factura{suma.n === 1 ? '' : 's'} · Total {formatMoneda(suma.total)} · Pendiente {formatMoneda(suma.pendiente)}
      </Text>
      {puedeConciliar && !motivo ? (
        <TouchableOpacity style={styles.btn} onPress={onConciliar} accessibilityLabel="Conciliar selección">
          <MaterialIcons name="account-balance" size={16} color="#fff" />
          <Text style={styles.btnText}>Conciliar</Text>
        </TouchableOpacity>
      ) : puedeConciliar && motivo ? (
        <Text style={styles.motivo}>{motivo}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  texto: { fontSize: 12, fontWeight: '600', color: '#334155' },
  motivo: { fontSize: 11, color: '#b45309' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0369a1',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  btnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
