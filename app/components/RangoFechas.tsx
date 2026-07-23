/**
 * Rango de fechas Desde / Hasta con el diseño estándar de la app
 * (el mismo de "Facturas de gasto"): dos campos compactos en fila, con fondo
 * suave, borde redondeado y sin etiqueta externa (placeholder Desde/Hasta).
 *
 * Úsalo como patrón por defecto para cualquier filtro/rango de fechas.
 * Para un único campo de fecha con el mismo aspecto, usa `InputFecha` con
 * `compact` y el estilo exportado `estiloCampoFechaCompacto`.
 */
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { InputFecha } from './InputFecha';

export const CAMPO_FECHA_ALTO = 32;

/** Estilo compartido para un campo de fecha compacto (single o rango). */
export const estiloCampoFechaCompacto = {
  width: '100%' as const,
  height: CAMPO_FECHA_ALTO,
  minHeight: CAMPO_FECHA_ALTO,
  fontSize: 12,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: '#e2e8f0',
  backgroundColor: '#f8fafc',
};

type Props = {
  desdeIso: string;
  hastaIso: string;
  onChangeDesde: (iso: string) => void;
  onChangeHasta: (iso: string) => void;
  placeholderDesde?: string;
  placeholderHasta?: string;
  /** Ancho de cada celda. Por defecto 130 (como en Facturas de gasto). */
  cellWidth?: number;
  /** Si es true, cada celda ocupa el espacio disponible (flex:1) en vez de ancho fijo. */
  fill?: boolean;
  /** Campos con aspecto de trigger toolbar (coherente con desplegable Local). */
  modoToolbar?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function RangoFechas({
  desdeIso,
  hastaIso,
  onChangeDesde,
  onChangeHasta,
  placeholderDesde = 'Desde',
  placeholderHasta = 'Hasta',
  cellWidth = 130,
  fill = false,
  modoToolbar = false,
  style,
}: Props) {
  const cellStyle: StyleProp<ViewStyle> = fill
    ? { flex: 1, minWidth: modoToolbar ? 128 : 130 }
    : { width: cellWidth, minWidth: modoToolbar ? Math.max(cellWidth, 128) : cellWidth };
  return (
    <View style={[styles.row, style]}>
      <View style={cellStyle}>
        <InputFecha
          compact
          modoToolbar={modoToolbar}
          valueIso={desdeIso}
          onChangeIso={onChangeDesde}
          placeholder={placeholderDesde}
          style={modoToolbar ? undefined : estiloCampoFechaCompacto}
        />
      </View>
      <View style={cellStyle}>
        <InputFecha
          compact
          modoToolbar={modoToolbar}
          valueIso={hastaIso}
          onChangeIso={onChangeHasta}
          placeholder={placeholderHasta}
          style={modoToolbar ? undefined : estiloCampoFechaCompacto}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
