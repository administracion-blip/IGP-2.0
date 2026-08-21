import React from 'react';
import { Text, Pressable, StyleSheet, type GestureResponderEvent } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { SugerenciasDeFactura } from '../../types/conciliacion';
import { estiloNivel, resumenSugerenciaFactura } from '../../lib/conciliacion';

/**
 * Marca en una fila de factura que hay movimientos bancarios que podrían
 * corresponderle, y abre la conciliación al pulsarlo.
 *
 * Vive aparte porque las dos pantallas de facturas (gasto y venta) tienen su
 * propia tabla escrita a mano y ninguna usa `TablaBasica`: sin este componente,
 * el criterio de color y el texto de ayuda acabarían duplicados y divergiendo.
 *
 * El color dice cuánto fiarse (verde alta, ámbar media, gris baja) y el número
 * en la esquina, cuántos movimientos candidatos hay.
 */
type Props = {
  entrada: SugerenciasDeFactura | undefined;
  /**
   * Recibe también el evento porque las filas de las tablas de facturas son
   * pulsables: sin él, pulsar el icono seleccionaría además la fila. El padre lo
   * pasa por su `absorberClickFila`, igual que hace con los demás iconos de fila.
   */
  onPress: (entrada: SugerenciasDeFactura, evento: GestureResponderEvent) => void;
  /** Zona táctil ampliada en móvil/tablet. */
  comodo?: boolean;
};

export default function IconoSugerenciaConciliacion({ entrada, onPress, comodo = false }: Props) {
  const total = entrada?.sugerencias?.length ?? 0;
  if (!entrada || total === 0) return null;

  const colores = estiloNivel(entrada.mejorNivel);
  const ayuda = resumenSugerenciaFactura(entrada);

  return (
    <Pressable
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={ayuda}
      // En web el título nativo es la única forma de explicar el icono sin ocupar sitio.
      {...({ title: ayuda } as object)}
      onPress={(evento) => onPress(entrada, evento)}
      style={[
        styles.boton,
        comodo && styles.botonComodo,
        { backgroundColor: colores.fondo, borderColor: colores.borde },
      ]}
    >
      <MaterialIcons name="account-balance" size={15} color={colores.texto} />
      {total > 1 ? (
        <Text style={[styles.contador, { color: colores.texto }]}>{total}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  boton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minWidth: 26,
    height: 24,
    paddingHorizontal: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  botonComodo: {
    minWidth: 34,
    height: 32,
    paddingHorizontal: 8,
  },
  contador: {
    fontSize: 11,
    fontWeight: '700',
  },
});
