import type { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SPACING } from '../../constants/layout';

type Props = {
  /** Texto o dato a la izquierda, por ejemplo el paso o el total. */
  inicio?: ReactNode;
  children: ReactNode;
};

/**
 * Barra de acciones al pie. El padre la deja fuera del scroll para que no se vaya con el contenido.
 * Respeta el área segura inferior.
 */
export function BarraAcciones({ inicio, children }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.barra, { paddingBottom: Math.max(insets.bottom, SPACING.md) }]}>
      {inicio ? <View style={styles.inicio}>{inicio}</View> : null}
      <View style={styles.acciones}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  barra: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 -6px 16px rgba(15,23,42,0.08)' } as object)
      : {
          shadowColor: '#0f172a',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.08,
          shadowRadius: 12,
          elevation: 8,
        }),
  },
  inicio: { flexShrink: 1, minWidth: 0 },
  acciones: { flex: 1, minWidth: 0, alignItems: 'stretch' },
});
