/**
 * Bloque de una ficha (proyecto o tarea): título, acción opcional y su propio
 * estado de carga y de error.
 *
 * El estado es **por sección** a propósito: la ficha no se bloquea entera
 * porque el historial tarde o porque los comentarios fallen.
 */
import type { ReactNode } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import type { NombreIcono } from '../../lib/tasksUi';

export type AccionSeccion = {
  etiqueta: string;
  icono: NombreIcono;
  onPress: () => void;
  deshabilitada?: boolean;
};

export function SeccionFicha({
  titulo,
  icono,
  contador,
  accion,
  cargando = false,
  error = null,
  onReintentar,
  vacio,
  children,
}: {
  titulo: string;
  icono: NombreIcono;
  contador?: number;
  accion?: AccionSeccion;
  cargando?: boolean;
  error?: string | null;
  onReintentar?: () => void;
  /** Texto cuando no hay contenido y no hay error ni carga. */
  vacio?: string;
  children?: ReactNode;
}) {
  const { isCompact } = useBreakpoint();
  const sinContenido = children == null || (Array.isArray(children) && children.length === 0);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <MaterialIcons name={icono} size={18} color="#0ea5e9" />
        <Text style={styles.titulo}>{titulo}</Text>
        {contador != null ? <Text style={styles.contador}>{contador}</Text> : null}
        <View style={styles.headerEspacio} />
        {accion ? (
          <TouchableOpacity
            style={[styles.accion, isCompact && styles.accionTactil, accion.deshabilitada && styles.accionDeshabilitada]}
            onPress={accion.onPress}
            disabled={accion.deshabilitada}
            accessibilityLabel={accion.etiqueta}
          >
            <MaterialIcons name={accion.icono} size={16} color={accion.deshabilitada ? '#94a3b8' : '#0ea5e9'} />
            <Text style={[styles.accionTexto, accion.deshabilitada && styles.accionTextoDeshabilitado]}>
              {accion.etiqueta}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {cargando ? (
        <View style={styles.centro}>
          <ActivityIndicator size="small" color="#0ea5e9" />
        </View>
      ) : error ? (
        <View style={styles.centro}>
          <Text style={styles.error}>{error}</Text>
          {onReintentar ? (
            <TouchableOpacity style={styles.reintentar} onPress={onReintentar}>
              <MaterialIcons name="refresh" size={16} color="#0ea5e9" />
              <Text style={styles.reintentarTexto}>Reintentar</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : sinContenido && vacio ? (
        <Text style={styles.vacio}>{vacio}</Text>
      ) : (
        children
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titulo: { fontSize: 14, fontWeight: '700', color: '#334155' },
  contador: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  headerEspacio: { flex: 1 },
  accion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  accionTactil: { minHeight: MIN_TOUCH, paddingHorizontal: 12 },
  accionDeshabilitada: { opacity: 0.6 },
  accionTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  accionTextoDeshabilitado: { color: '#94a3b8' },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 16 },
  error: { fontSize: 12, color: '#ef4444', textAlign: 'center' },
  reintentar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reintentarTexto: { fontSize: 12, fontWeight: '600', color: '#0ea5e9' },
  vacio: { fontSize: 12, color: '#94a3b8', paddingVertical: 6, lineHeight: 18 },
});
