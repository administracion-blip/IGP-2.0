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
import {
  tasksColor,
  tasksIcono,
  tasksRadius,
  tasksSpace,
  tasksTipo,
} from '../../constants/tasksUiTokens';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import type { NombreIcono } from '../../lib/tasksUi';

export type AccionSeccion = {
  etiqueta: string;
  icono: NombreIcono;
  onPress: () => void;
  deshabilitada?: boolean;
};

export type VarianteSeccionFicha = 'normal' | 'destacada';

export function SeccionFicha({
  titulo,
  icono,
  contador,
  accion,
  cargando = false,
  error = null,
  onReintentar,
  vacio,
  variante = 'normal',
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
  /** `destacada`: título más marcado y acento lateral (fichas densas). */
  variante?: VarianteSeccionFicha;
  children?: ReactNode;
}) {
  const { isCompact } = useBreakpoint();
  const sinContenido = children == null || (Array.isArray(children) && children.length === 0);
  const destacada = variante === 'destacada';

  return (
    <View style={[styles.card, destacada && styles.cardDestacada]}>
      <View style={[styles.header, destacada && styles.headerDestacada]}>
        <MaterialIcons name={icono} size={tasksIcono.size} color={tasksColor.acento} />
        <Text style={[styles.titulo, destacada && styles.tituloDestacada]}>{titulo}</Text>
        {contador != null ? <Text style={styles.contador}>{contador}</Text> : null}
        <View style={styles.headerEspacio} />
        {accion ? (
          <TouchableOpacity
            style={[styles.accion, isCompact && styles.accionTactil, accion.deshabilitada && styles.accionDeshabilitada]}
            onPress={accion.onPress}
            disabled={accion.deshabilitada}
            accessibilityLabel={accion.etiqueta}
          >
            <MaterialIcons
              name={accion.icono}
              size={tasksIcono.sizeSm}
              color={accion.deshabilitada ? tasksColor.textoTerciario : tasksColor.acento}
            />
            <Text style={[styles.accionTexto, accion.deshabilitada && styles.accionTextoDeshabilitado]}>
              {accion.etiqueta}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {cargando ? (
        <View style={styles.centro}>
          <ActivityIndicator size="small" color={tasksColor.acento} />
        </View>
      ) : error ? (
        <View style={styles.centro}>
          <Text style={styles.error}>{error}</Text>
          {onReintentar ? (
            <TouchableOpacity style={styles.reintentar} onPress={onReintentar}>
              <MaterialIcons name="refresh" size={tasksIcono.sizeSm} color={tasksColor.acento} />
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
    backgroundColor: tasksColor.superficie,
    borderRadius: tasksRadius.contenedor,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    padding: tasksSpace[3] + 2,
    gap: 10,
  },
  cardDestacada: {
    borderLeftWidth: 3,
    borderLeftColor: tasksColor.acento,
    paddingLeft: tasksSpace[3],
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: tasksSpace[2] },
  headerDestacada: {
    marginHorizontal: -6,
    marginTop: -4,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: tasksRadius.contenedor,
    backgroundColor: tasksColor.superficieHundida,
  },
  titulo: { ...tasksTipo.tituloSeccion },
  tituloDestacada: { color: tasksColor.textoPrimario },
  contador: {
    ...tasksTipo.micro,
    color: tasksColor.textoSecundario,
    backgroundColor: tasksColor.superficieHundida,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: tasksRadius.pildora,
    overflow: 'hidden',
  },
  headerEspacio: { flex: 1 },
  accion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: tasksRadius.control,
    borderWidth: 1,
    borderColor: tasksColor.bordeSutil,
    backgroundColor: tasksColor.superficieHundida,
  },
  accionTactil: { minHeight: MIN_TOUCH, paddingHorizontal: tasksSpace[3] },
  accionDeshabilitada: { opacity: 0.6 },
  accionTexto: {
    ...tasksTipo.etiqueta,
    color: tasksColor.acento,
  },
  accionTextoDeshabilitado: { color: tasksColor.textoTerciario },
  centro: { alignItems: 'center', gap: tasksSpace[2], paddingVertical: tasksSpace[4] },
  error: {
    ...tasksTipo.etiqueta,
    color: tasksColor.peligro,
    textAlign: 'center',
  },
  reintentar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reintentarTexto: {
    ...tasksTipo.etiqueta,
    color: tasksColor.acento,
  },
  vacio: {
    ...tasksTipo.micro,
    paddingVertical: 6,
  },
});
