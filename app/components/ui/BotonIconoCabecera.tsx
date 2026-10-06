/**
 * Icono de la barra superior: trazo fino sobre un cuadrado redondeado.
 * En reposo va limpio; al pasar el ratón o pulsar, fondo gris suave.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

type Icono = ComponentProps<typeof Feather>['name'];

const LADO = 36;

export function BotonIconoCabecera({
  nombre,
  etiqueta,
  onPress,
  children,
}: {
  nombre: Icono;
  etiqueta: string;
  onPress: () => void;
  children?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={etiqueta}
      hitSlop={4}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.btn,
        (pressed || hovered) && styles.btnHover,
      ]}
    >
      <Feather name={nombre} size={18} color="#334155" />
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    position: 'relative',
    width: LADO,
    height: LADO,
    marginHorizontal: 2,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  btnHover: {
    backgroundColor: '#f1f5f9',
  },
});
