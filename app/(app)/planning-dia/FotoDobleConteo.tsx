/**
 * Las dos tomas de una foto del conteo: de frente y desde arriba.
 * El visor ocupa la ventana; en el paso de arriba, el sensor de orientación
 * marca la inclinación (solo en el móvil: en web no hay sensor).
 */
import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ActivityIndicator,
  Image,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { DeviceMotion } from 'expo-sensors';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { colors, fontFamily, fontSizes, radius, MIN_TOUCH, SPACING } from '../../constants/theme';
import type { PosicionFoto } from './colaFotosConteo';

const MAX_LADO = 1600;
const ANGULO_MIN = 35;
const ANGULO_MAX = 55;
/** Ancho que necesitan las tres pastillas y la ✕ sin partirse. */
const ANCHO_PASTILLAS = 400;
const ARCO_RADIO = 46;
const ARCO_MARCAS = Array.from({ length: 19 }, (_, i) => i * 5);

export type FotoLista = {
  uri: string;
  nombre: string;
  contentType: string;
  tamano: number;
  posicion: PosicionFoto;
};

type Props = {
  visible: boolean;
  /** Número de la foto que se va a hacer (1–6). */
  numero: number | null;
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

/** Grados que la cámara mira hacia abajo: 0 de frente, 90 mirando al suelo. */
function anguloDesde(beta: number, gamma: number): number {
  const s = Math.max(-1, Math.min(1, Math.cos(beta) * Math.cos(gamma)));
  return Math.round((Math.asin(s) * 180) / Math.PI);
}

function useInclinacion(activo: boolean): number | null {
  const [angulo, setAngulo] = useState<number | null>(null);
  useEffect(() => {
    if (!activo || Platform.OS === 'web') {
      setAngulo(null);
      return;
    }
    let sub: { remove: () => void } | null = null;
    let vivo = true;
    void DeviceMotion.isAvailableAsync()
      .then((ok) => {
        if (!ok || !vivo) return;
        DeviceMotion.setUpdateInterval(150);
        sub = DeviceMotion.addListener((m) => {
          if (!m.rotation) return;
          setAngulo(anguloDesde(m.rotation.beta, m.rotation.gamma));
        });
      })
      .catch(() => {});
    return () => {
      vivo = false;
      sub?.remove();
      setAngulo(null);
    };
  }, [activo]);
  return angulo;
}

function DibujoBotellas() {
  return (
    <View style={styles.botellasDibujo}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.botellaDibujo}>
          <View style={styles.botellaCuello} />
          <View style={styles.botellaCuerpo}>
            <View style={styles.botellaEtiqueta} />
          </View>
        </View>
      ))}
    </View>
  );
}

function ArcoInclinacion({ angulo }: { angulo: number }) {
  const visible = Math.max(0, Math.min(90, angulo));
  const bien = angulo >= ANGULO_MIN && angulo <= ANGULO_MAX;
  return (
    <View style={styles.arco}>
      {ARCO_MARCAS.map((g) => {
        const rad = (g * Math.PI) / 180;
        const enBanda = g >= ANGULO_MIN && g <= ANGULO_MAX;
        return (
          <View
            key={g}
            style={[
              styles.arcoMarca,
              {
                left: ARCO_RADIO * Math.cos(rad) - 2,
                bottom: ARCO_RADIO * Math.sin(rad) - 2,
                backgroundColor: bien ? colors.success : enBanda ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
              },
              enBanda && styles.arcoMarcaBanda,
            ]}
          />
        );
      })}
      <View
        style={[
          styles.aguja,
          { backgroundColor: bien ? colors.success : colors.surface, transform: [{ rotate: `${-visible}deg` }] },
        ]}
      />
      <View style={styles.agujaEje} />
      <Text style={[styles.arcoGrados, bien && styles.textoBien]}>{`${angulo}°`}</Text>
    </View>
  );
}

export function FotoDobleConteo({ visible, numero, onCerrar, onPar }: Props) {
  const { isPhone, width } = useBreakpoint();
  const insets = useSafeAreaInsets();
  const [permiso, pedirPermiso] = useCameraPermissions();
  const camara = useRef<CameraView | null>(null);
  const [paso, setPaso] = useState<PosicionFoto>('frente');
  const [frente, setFrente] = useState<FotoLista | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [lista, setLista] = useState(false);
  const [sinCamara, setSinCamara] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const segunda = paso === 'superior';
  const angulo = useInclinacion(visible && segunda);

  useEffect(() => {
    if (!visible) return;
    setPaso('frente');
    setFrente(null);
    setLista(false);
    setError(null);
    setSinCamara(false);
    let vivo = true;
    void (async () => {
      if (Platform.OS === 'web') {
        const hay = await CameraView.isAvailableAsync().catch(() => false);
        if (!hay) {
          if (vivo) setSinCamara(true);
          return;
        }
      }
      const actual = permiso?.granted ? permiso : await pedirPermiso().catch(() => null);
      if (vivo && !actual?.granted) setSinCamara(true);
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function cerrar() {
    setPaso('frente');
    setFrente(null);
    onCerrar();
  }

  async function guardarToma(uri: string, ancho?: number, alto?: number, bytes?: number) {
    const reducida = await reducir(uri, ancho, alto);
    const foto: FotoLista = {
      uri: reducida.uri,
      nombre: paso === 'frente' ? 'frente.jpg' : 'superior.jpg',
      contentType: 'image/jpeg',
      tamano: reducida.tamano || bytes || 1,
      posicion: paso,
    };
    if (paso === 'frente') {
      setFrente(foto);
      setPaso('superior');
      return;
    }
    const par = frente ? [frente, foto] : [foto];
    setPaso('frente');
    setFrente(null);
    onPar(par);
  }

  async function disparar() {
    if (ocupado || !lista || !camara.current) return;
    setOcupado(true);
    setError(null);
    try {
      const foto = await camara.current.takePictureAsync({ quality: 0.85 });
      if (!foto?.uri) throw new Error('sin foto');
      await guardarToma(foto.uri, foto.width, foto.height);
    } catch {
      setError('No se ha podido hacer la foto. Prueba otra vez.');
    } finally {
      setOcupado(false);
    }
  }

  async function desdeGaleria() {
    if (ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const permisoGaleria = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permisoGaleria.granted) {
        setError('Sin permiso para abrir la galería.');
        return;
      }
      const resultado = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
      });
      if (resultado.canceled || !resultado.assets?.[0]) return;
      const asset = resultado.assets[0];
      await guardarToma(asset.uri, asset.width, asset.height, asset.fileSize);
    } catch {
      setError('No se ha podido usar esa foto.');
    } finally {
      setOcupado(false);
    }
  }

  function repetirFrente() {
    if (ocupado) return;
    setFrente(null);
    setPaso('frente');
  }

  const ventana = !isPhone;
  const compacto = isPhone && width < ANCHO_PASTILLAS;
  const n = numero ?? 1;
  const bien = angulo != null && angulo >= ANGULO_MIN && angulo <= ANGULO_MAX;

  let aviso: string | null = null;
  if (!sinCamara) {
    if (!segunda) aviso = 'Encuadra la balda dentro del marco';
    else if (angulo != null) {
      if (bien) aviso = '✓ Inclinación buena, haz la foto';
      else if (angulo < ANGULO_MIN) aviso = 'Sube un poco más';
      else aviso = 'Inclina un poco menos';
    }
  }

  const contenido = (
    <View style={[styles.visor, ventana && styles.visorVentana]}>
      {sinCamara ? (
        <View style={styles.sinCamara}>
          <MaterialIcons name="no-photography" size={40} color="rgba(255,255,255,0.8)" />
          <Text style={styles.sinCamaraTexto}>
            {Platform.OS === 'web'
              ? 'Este navegador no tiene cámara o no se ha dado permiso. Elige la foto de la galería.'
              : 'No hay permiso para usar la cámara. Dale permiso o elige la foto de la galería.'}
          </Text>
          {Platform.OS !== 'web' && permiso?.canAskAgain ? (
            <Pressable
              style={styles.botonPermiso}
              onPress={() => void pedirPermiso().then((r) => r.granted && setSinCamara(false))}
              accessibilityRole="button"
            >
              <Text style={styles.botonPermisoTexto}>Dar permiso</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.botonPermiso} onPress={() => void desdeGaleria()} accessibilityRole="button">
            <MaterialIcons name="photo-library" size={18} color={colors.textStrong} />
            <Text style={styles.botonPermisoTexto}>Elegir de la galería</Text>
          </Pressable>
        </View>
      ) : permiso?.granted ? (
        <CameraView
          ref={camara}
          style={StyleSheet.absoluteFill}
          facing="back"
          onCameraReady={() => setLista(true)}
          onMountError={() => setSinCamara(true)}
        />
      ) : (
        <View style={styles.sinCamara}>
          <ActivityIndicator color={colors.surface} />
        </View>
      )}

      {!sinCamara && !segunda ? <View pointerEvents="none" style={styles.marco} /> : null}

      <LinearGradient
        colors={['rgba(0,0,0,0.75)', 'rgba(0,0,0,0)']}
        style={[styles.barraArriba, { paddingTop: (ventana ? 0 : insets.top) + SPACING.md }]}
      >
        {compacto ? (
          <View style={[styles.pastilla, styles.pastillaActual]}>
            <Text style={styles.pastillaTexto}>
              {segunda ? `${n}/6 · ✓ · Arriba` : `${n}/6 · Frente`}
            </Text>
          </View>
        ) : (
          <View style={styles.pastillas}>
            <View style={styles.pastilla}>
              <Text style={styles.pastillaTexto}>{`Foto ${n}/6`}</Text>
            </View>
            <View style={[styles.pastilla, segunda ? styles.pastillaHecha : styles.pastillaActual]}>
              <Text style={styles.pastillaTexto}>{segunda ? '✓ 1 · De frente' : '1 · De frente'}</Text>
            </View>
            <View style={[styles.pastilla, segunda && styles.pastillaActual]}>
              <Text style={styles.pastillaTexto}>2 · Desde arriba</Text>
            </View>
          </View>
        )}
        <Pressable
          style={styles.cerrar}
          onPress={cerrar}
          accessibilityRole="button"
          accessibilityLabel="Cancelar la foto"
          hitSlop={8}
        >
          <MaterialIcons name="close" size={22} color={colors.surface} />
        </Pressable>
      </LinearGradient>

      <View
        pointerEvents="none"
        style={[styles.ayuda, { top: (ventana ? 0 : insets.top) + SPACING.md + MIN_TOUCH + SPACING.sm }]}
      >
        {segunda ? (
          <>
            {angulo != null ? <ArcoInclinacion angulo={angulo} /> : null}
            <Text style={styles.ayudaTexto}>Sube el móvil por encima de la balda</Text>
          </>
        ) : (
          <>
            <DibujoBotellas />
            <Text style={styles.ayudaTexto}>De frente, que se lean las etiquetas</Text>
          </>
        )}
      </View>

      {aviso || error ? (
        <View pointerEvents="none" style={[styles.aviso, { bottom: (ventana ? 0 : insets.bottom) + 120 }]}>
          <Text style={[styles.avisoTexto, bien && segunda && !error && styles.textoBien, error && styles.textoError]}>
            {error || aviso}
          </Text>
        </View>
      ) : null}

      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.75)']}
        style={[styles.barraAbajo, { paddingBottom: (ventana ? 0 : insets.bottom) + SPACING.lg }]}
      >
        <Pressable
          style={styles.lateral}
          onPress={() => void desdeGaleria()}
          disabled={ocupado}
          accessibilityRole="button"
          accessibilityLabel="Elegir de la galería"
        >
          <MaterialIcons name="photo-library" size={26} color={colors.surface} />
        </Pressable>
        <Pressable
          style={[styles.disparador, (!lista || sinCamara) && styles.disparadorOff]}
          onPress={() => void disparar()}
          disabled={ocupado || !lista || sinCamara}
          accessibilityRole="button"
          accessibilityLabel={segunda ? 'Hacer la foto desde arriba' : 'Hacer la foto de frente'}
        >
          {ocupado ? <ActivityIndicator color={colors.accent} /> : <View style={styles.disparadorCentro} />}
        </Pressable>
        {segunda && frente ? (
          <Pressable
            style={styles.miniatura}
            onPress={repetirFrente}
            accessibilityRole="button"
            accessibilityLabel="Repetir la foto de frente"
          >
            <Image source={{ uri: frente.uri }} style={styles.miniaturaImagen} />
            <View style={styles.miniaturaCheck}>
              <MaterialIcons name="check" size={14} color={colors.surface} />
            </View>
          </Pressable>
        ) : (
          <View style={styles.lateral} />
        )}
      </LinearGradient>
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType={ventana ? 'fade' : 'slide'}
      transparent={ventana}
      statusBarTranslucent
      onRequestClose={cerrar}
    >
      {ventana ? (
        <View style={styles.fondo}>
          <View style={styles.ventana}>{contenido}</View>
        </View>
      ) : (
        contenido
      )}
    </Modal>
  );
}

const sombraTexto = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
};

const styles = StyleSheet.create({
  fondo: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.lg,
  },
  ventana: {
    width: 480,
    height: 560,
    maxWidth: '100%',
    maxHeight: '100%',
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  visor: { flex: 1, backgroundColor: '#000' },
  visorVentana: { borderRadius: 20, overflow: 'hidden' },
  sinCamara: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  sinCamaraTexto: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[14],
    color: colors.surface,
    textAlign: 'center',
    maxWidth: 300,
  },
  botonPermiso: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  botonPermisoTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[14], color: colors.textStrong },
  marco: {
    position: 'absolute',
    left: '8%',
    right: '8%',
    top: '24%',
    bottom: '30%',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: radius.lg,
  },
  barraArriba: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  pastillas: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flex: 1 },
  pastilla: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  pastillaActual: { backgroundColor: colors.accent },
  pastillaHecha: { backgroundColor: colors.success },
  pastillaTexto: { fontFamily: fontFamily.semibold, fontSize: fontSizes[12], color: colors.surface },
  cerrar: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ayuda: {
    position: 'absolute',
    right: SPACING.md,
    width: 130,
    padding: SPACING.sm,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(15,23,42,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    gap: 6,
  },
  ayudaTexto: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes[12],
    lineHeight: 16,
    color: colors.surface,
    textAlign: 'center',
  },
  botellasDibujo: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 48 },
  botellaDibujo: { alignItems: 'center' },
  botellaCuello: {
    width: 6,
    height: 12,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  botellaCuerpo: {
    width: 18,
    height: 34,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  botellaEtiqueta: { width: 14, height: 10, borderRadius: 2, backgroundColor: colors.accent },
  arco: { width: ARCO_RADIO + 14, height: ARCO_RADIO + 14, alignSelf: 'flex-start', marginLeft: 18 },
  arcoMarca: { position: 'absolute', width: 4, height: 4, borderRadius: 2 },
  arcoMarcaBanda: { width: 5, height: 5, borderRadius: 3 },
  aguja: {
    position: 'absolute',
    left: 0,
    bottom: -1,
    width: ARCO_RADIO - 6,
    height: 3,
    borderRadius: 2,
    transformOrigin: 'left center',
  },
  agujaEje: {
    position: 'absolute',
    left: -4,
    bottom: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  arcoGrados: {
    position: 'absolute',
    right: -6,
    top: 0,
    fontFamily: fontFamily.bold,
    fontSize: fontSizes[14],
    color: colors.surface,
  },
  aviso: { position: 'absolute', left: SPACING.md, right: SPACING.md, alignItems: 'center' },
  avisoTexto: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes[14],
    color: colors.surface,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: SPACING.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    overflow: 'hidden',
    ...sombraTexto,
  },
  textoBien: { color: '#4ade80' },
  textoError: { color: '#fca5a5' },
  barraAbajo: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: SPACING.xl,
    paddingHorizontal: SPACING.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  lateral: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  disparador: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disparadorOff: { opacity: 0.4 },
  disparadorCentro: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.surface },
  miniatura: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.success,
  },
  miniaturaImagen: { width: '100%', height: '100%', borderRadius: radius.md - 2 },
  miniaturaCheck: {
    position: 'absolute',
    right: -6,
    top: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
