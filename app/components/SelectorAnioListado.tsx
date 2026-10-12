import { useMemo } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SelectorDesplegable } from './SelectorDesplegable';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { opcionesAnioListado } from '../lib/rangoAnioListado';

type Props = {
  valorId: string;
  onChange: (id: string) => void;
  /** Añade «Todos los años» (rango histórico acotado). */
  incluirTodos?: boolean;
  label?: string;
  /** En una fila apilada, el control ocupa el ancho del contenedor. */
  estirar?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * Selector de año para listados que ya no traen el histórico completo.
 * No es un día: CampoFecha / InputFecha no aplican.
 */
export function SelectorAnioListado({
  valorId,
  onChange,
  incluirTodos = false,
  label,
  estirar = false,
  style,
}: Props) {
  const { isCompact } = useBreakpoint();
  const opciones = useMemo(() => opcionesAnioListado(incluirTodos), [incluirTodos]);

  return (
    <SelectorDesplegable
      style={[
        styles.base,
        incluirTodos && styles.conTodos,
        isCompact && styles.compacto,
        estirar && styles.estirado,
        style,
      ]}
      label={label}
      placeholder="Año"
      icono="calendar-today"
      tituloLista="Selecciona el año"
      iconoLista="calendar-today"
      valorId={valorId}
      opciones={opciones}
      onSeleccionar={onChange}
    />
  );
}

const styles = StyleSheet.create({
  base: { width: 132, minWidth: 120, maxWidth: 160 },
  conTodos: { width: 200, minWidth: 168, maxWidth: 240 },
  compacto: { minWidth: 140 },
  estirado: { width: '100%', maxWidth: '100%', alignSelf: 'stretch' },
});
