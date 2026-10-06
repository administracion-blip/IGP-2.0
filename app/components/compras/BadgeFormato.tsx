import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

/** Nombre del formato base indexado por id de producto. Vacío si Ágora no lo trae. */
export function mapaFormatosBase(
  productos: ReadonlyArray<Record<string, unknown>>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of productos) {
    const id = String(p.Id ?? p.id ?? '').trim();
    const nombre = String(p.FormatoBaseNombre ?? '').trim();
    if (id && nombre) map.set(id, nombre);
  }
  return map;
}

export function useMapaFormatosBase(productos: ReadonlyArray<Record<string, unknown>>) {
  return useMemo(() => mapaFormatosBase(productos), [productos]);
}

/** Badge gris del formato. No pinta nada si no hay nombre. */
export function BadgeFormato({ nombre }: { nombre?: string | null }) {
  const texto = String(nombre ?? '').trim();
  if (!texto) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.texto} numberOfLines={1}>
        {texto}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: '#f1f5f9',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  texto: {
    color: '#475569',
    fontSize: 11,
    fontWeight: '600',
  },
});
