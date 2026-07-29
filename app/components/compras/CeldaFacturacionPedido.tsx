/**
 * Celda «Facturación» de los listados de pedidos.
 *
 * Un pedido facturado no se puede modificar ni borrar: el backend lo rechaza
 * nombrando la factura. Si el usuario no lo sabe hasta que le salta el error,
 * la culpa parece de la aplicación, así que el estado se ve en la propia lista
 * y el motivo completo en el tooltip.
 */
import { View, Text, StyleSheet, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { estadoFacturacionPedido } from '../../lib/comprasFacturacion';

/** Nombre de la columna en los listados; también es la clave de `getValorCelda`. */
export const COLUMNA_FACTURACION = 'Facturación';

type Props = {
  pedido: Record<string, unknown>;
  /**
   * Modo cómodo de `TablaBasica` (móvil y tablet vertical). Llega como prop y no
   * de `useBreakpoint()` porque esto se pinta una vez por fila: la pantalla ya
   * tiene el dato y así no se monta un hook por celda.
   */
  comodo?: boolean;
};

export function CeldaFacturacionPedido({ pedido, comodo = false }: Props) {
  const estado = estadoFacturacionPedido(pedido);
  return (
    <View
      style={styles.wrap}
      accessibilityLabel={estado.detalle ? `${estado.texto}. ${estado.detalle}` : estado.texto}
      {...(Platform.OS === 'web' && estado.detalle ? { title: estado.detalle } : {})}
    >
      {/* El periodo por sí solo no dice que esté cerrado: el candado sí. */}
      {estado.estado === 'facturado' ? (
        <MaterialIcons name="lock-outline" size={comodo ? 16 : 12} color="#047857" />
      ) : null}
      <Text
        style={[
          styles.texto,
          comodo && styles.textoComodo,
          estado.estado === 'facturado'
            ? styles.facturado
            : estado.estado === 'pendiente'
              ? styles.pendiente
              : styles.noAplica,
        ]}
        numberOfLines={1}
      >
        {estado.texto}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 3 },
  // Mismos tamaños que el texto por defecto de `TablaBasica`, para que la
  // columna no se quede pequeña cuando el resto de la tabla crece en móvil.
  texto: { fontSize: 10, lineHeight: 13, flexShrink: 1 },
  textoComodo: { fontSize: 14, lineHeight: 18 },
  facturado: { color: '#047857', fontWeight: '700' },
  pendiente: { color: '#b45309', fontWeight: '600' },
  noAplica: { color: '#94a3b8' },
});
