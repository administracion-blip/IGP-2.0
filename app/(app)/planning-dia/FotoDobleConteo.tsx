/**
 * Las dos tomas de una foto del conteo: de frente y desde arriba.
 * En esta fase no hay sensor de inclinación: solo el texto de ayuda.
 */
import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Modal, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { colors, fontFamily, fontSizes, radius, MIN_TOUCH, SPACING } from '../../constants/theme';
import type { PosicionFoto } from './colaFotosConteo';

const MAX_LADO = 1600;

export type FotoLista = {
  uri: string;
  nombre: string;
  contentType: string;
  tamano: number;
  posicion: PosicionFoto;
};

type Props = {
  visible: boolean;
  onCerrar: () => void;
  onPar: (fotos: FotoLista[]) => void;
};

async function reducir(uri: string, ancho?: number, alto?: number): Promise<{ uri: string; tamano: number }> {
  const largo = Math.max(ancho || 0, alto || 0);
  const acciones = largo > MAX_LADO && ancho && alto
    ? [{ resize: { width: Math.max(1, Math.round(ancho * (MAX_LADO / largo))) } }]
    : [];
  const resultado = await ImageManipulator.manipulateAsync(uri, acciones, {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  let tamano = 0;
  if (resultado.base64) tamano = Math.ceil((resultado.base64.length * 3) / 4);
  return { uri: resultado.uri, tamano };
}

export function FotoDobleConteo({ visible, onCerrar, onPar }: Props) {
  const [paso, setPaso] = useState<PosicionFoto>('frente');
  const [tomadas, setTomadas] = useState<FotoLista[]>([]);
  const [ocupado, setOcupado] = useState(false);

  function cerrar() {
    setPaso('frente');
    setTomadas([]);
    onCerrar();
  }

  async function tomar(desdeCamara: boolean) {
    if (ocupado) return;
    setOcupado(true);
    try {
      const permiso = desdeCamara
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permiso.granted) return;
      const resultado = desdeCamara
        ? await ImagePicker.launchCameraAsync({ quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.85,
          });
      if (resultado.canceled || !resultado.assets?.[0]) return;
      const asset = resultado.assets[0];
      const reducida = await reducir(asset.uri, asset.width, asset.height);
      const foto: FotoLista = {
        uri: reducida.uri,
        nombre: paso === 'frente' ? 'frente.jpg' : 'superior.jpg',
        contentType: 'image/jpeg',
        tamano: reducida.tamano || asset.fileSize || 1,
        posicion: paso,
      };
      const siguientes = [...tomadas, foto];
      if (paso === 'frente') {
        setTomadas(siguientes);
        setPaso('superior');
        return;
      }
      setPaso('frente');
      setTomadas([]);
      onPar(siguientes);
    } finally {
      setOcupado(false);
    }
  }

  const segunda = paso === 'superior';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={cerrar}>
      <View style={styles.pagina}>
        <Text style={styles.titulo}>{segunda ? 'Desde arriba' : 'De frente'}</Text>
        <Text style={styles.ayuda}>
          {segunda
            ? 'Ahora desde arriba, en ángulo superior, unos 45°. Así se ve lo que la foto de frente tapa.'
            : 'De frente a las botellas, para poder identificarlas.'}
        </Text>
        {ocupado ? <ActivityIndicator color={colors.accent} /> : null}
        <Pressable style={styles.boton} onPress={() => void tomar(true)} disabled={ocupado} accessibilityRole="button">
          <MaterialIcons name="photo-camera" size={20} color={colors.surface} />
          <Text style={styles.botonTexto}>Hacer foto</Text>
        </Pressable>
        <Pressable style={styles.botonSec} onPress={() => void tomar(false)} disabled={ocupado} accessibilityRole="button">
          <MaterialIcons name="photo-library" size={20} color={colors.accent} />
          <Text style={styles.botonSecTexto}>Elegir de la galería</Text>
        </Pressable>
        <Pressable onPress={cerrar} accessibilityRole="button" accessibilityLabel="Cancelar la foto">
          <Text style={styles.cancelar}>Cancelar</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  pagina: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: SPACING.xl,
    justifyContent: 'center',
    gap: SPACING.md,
  },
  titulo: { fontFamily: fontFamily.bold, fontSize: fontSizes[22], color: colors.textStrong },
  ayuda: { fontFamily: fontFamily.regular, fontSize: fontSizes[16], color: colors.textSecondary },
  boton: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  botonTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.surface },
  botonSec: {
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  botonSecTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[16], color: colors.accentPressed },
  cancelar: {
    textAlign: 'center',
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[16],
    color: colors.textSecondary,
    minHeight: MIN_TOUCH,
    textAlignVertical: 'center',
  },
});
