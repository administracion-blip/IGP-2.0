import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { colors, radius } from '../../constants/theme';
import { urlQrEtiqueta } from '../../lib/activosEtiqueta';
import type { PreviewEtiquetaActivo } from '../../types/activos';

type Props = {
  etiqueta: PreviewEtiquetaActivo;
  puedeImprimir: boolean;
  imprimiendo?: boolean;
  onImprimir: () => void;
};

export function EtiquetaPreview({ etiqueta, puedeImprimir, imprimiendo, onImprimir }: Props) {
  const modelo = [etiqueta.marca, etiqueta.nombre_modelo].filter(Boolean).join(' ');
  const minima = etiqueta.formato_etiqueta === 'minima';
  const reducida = etiqueta.formato_etiqueta === 'reducida';
  const qr = urlQrEtiqueta(etiqueta.qr_url, 140);

  return (
    <View style={styles.wrap}>
      <View style={styles.tag}>
        {minima ? null : <Image source={{ uri: qr }} style={styles.qr} />}
        <View style={{ flex: 1 }}>
          <Text style={styles.id}>{etiqueta.etiqueta_legible}</Text>
          {!minima && !reducida && modelo ? (
            <Text style={styles.meta} numberOfLines={1}>
              {modelo}
            </Text>
          ) : null}
          {!minima && !reducida && etiqueta.numero_serie ? (
            <Text style={styles.meta} numberOfLines={1}>
              S/N {etiqueta.numero_serie}
            </Text>
          ) : null}
          <Text style={styles.estado}>
            {etiqueta.ya_impresa ? 'Ya impresa' : 'Pendiente de imprimir'}
          </Text>
        </View>
      </View>
      {puedeImprimir ? (
        <TouchableOpacity
          style={styles.btn}
          onPress={onImprimir}
          disabled={imprimiendo}
          accessibilityLabel="Imprimir etiqueta"
        >
          {imprimiendo ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <MaterialIcons name="print" size={20} color="#fff" />
              <Text style={styles.btnTxt}>{etiqueta.ya_impresa ? 'Reimprimir' : 'Imprimir'}</Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12, gap: 8 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: '#0f172a',
    backgroundColor: '#fff',
  },
  qr: { width: 72, height: 72, backgroundColor: '#fff' },
  id: { fontSize: 18, fontWeight: '800', color: '#0f172a', letterSpacing: 0.4 },
  meta: { fontSize: 13, color: colors.textPrimary, marginTop: 3 },
  estado: { fontSize: 11, color: colors.textSecondary, marginTop: 6, fontWeight: '600' },
  btn: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  btnTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
