import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SelectorDesplegable } from '../SelectorDesplegable';
import {
  colores,
  estiloEtiqueta,
  familia,
  peso,
  radios,
} from '../prevision/tokens';

type SelectorProps = ComponentProps<typeof SelectorDesplegable>;

type Props = Omit<
  SelectorProps,
  'label' | 'icono' | 'compact' | 'sinIconoTrigger' | 'triggerStyle' | 'triggerTextStyle'
> & {
  etiqueta?: string;
  alto: number;
  /** Radio del disparador. Los filtros usan 8; la línea de conteo pide 10. */
  radio?: number;
};

/** Filtro con etiqueta encima y disparador rectangular, como CampoPlantilla. */
export function CampoSelector({ etiqueta, alto, radio = radios.control, ...resto }: Props) {
  return (
    <View style={styles.campo}>
      {etiqueta ? <Text style={styles.etiqueta}>{etiqueta}</Text> : null}
      <SelectorDesplegable
        {...resto}
        compact
        sinIconoTrigger
        triggerStyle={[
          styles.trigger,
          { minHeight: alto, height: alto, width: '100%', borderRadius: radio },
        ]}
        triggerTextStyle={styles.triggerTexto}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  campo: { minWidth: 0, width: '100%' },
  etiqueta: { ...estiloEtiqueta, marginBottom: 6 },
  trigger: {
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.control,
    paddingHorizontal: 10,
  },
  triggerTexto: {
    fontSize: 13,
    fontFamily: familia.medio,
    fontWeight: peso.medio,
    color: colores.texto,
  },
});
