import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Pressable,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors, inputCursorProps, radius } from '../../constants/theme';
import { MIN_TOUCH } from '../../constants/layout';

type Props = {
  visible: boolean;
  onClose: () => void;
  onDetect: (codigo: string) => void;
  titulo?: string;
  ayuda?: string;
};

const FORMATOS = [
  'code_128',
  'code_39',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'itf',
  'codabar',
  'qr_code',
];

function esQrIgp(valor: string): boolean {
  const v = valor.trim().toLowerCase();
  return v.includes('/a/') && (v.startsWith('http') || v.startsWith('/a/'));
}

export function EscanerCodigo({
  visible,
  onClose,
  onDetect,
  titulo = 'Escanear número de serie',
  ayuda = 'Apunta al código de barras de la caja o de la placa. Si no se lee, escríbelo.',
}: Props) {
  const [manual, setManual] = useState('');
  const [camaraOk, setCamaraOk] = useState<boolean | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vivoRef = useRef(false);
  const onDetectRef = useRef(onDetect);
  const onCloseRef = useRef(onClose);
  onDetectRef.current = onDetect;
  onCloseRef.current = onClose;

  const entregar = useCallback((raw: string) => {
    const codigo = raw.trim();
    if (!codigo) return;
    if (esQrIgp(codigo)) {
      setAviso('Eso es una etiqueta IGP. Aquí hace falta el número de serie del fabricante.');
      return;
    }
    onDetectRef.current(codigo);
    setManual('');
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!visible) {
      vivoRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setManual('');
      setAviso(null);
      setCamaraOk(null);
      return;
    }
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCamaraOk(false);
      return;
    }
    const Detector = (window as Window & { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (src: HTMLVideoElement) => Promise<{ rawValue?: string }[]> } }).BarcodeDetector;
    if (!Detector) {
      setCamaraOk(false);
      setAviso('Este navegador no lee códigos. Usa Chrome o escribe el número.');
      return;
    }

    vivoRef.current = true;
    let detector: { detect: (src: HTMLVideoElement) => Promise<{ rawValue?: string }[]> };
    try {
      detector = new Detector({ formats: FORMATOS });
    } catch {
      setCamaraOk(false);
      setAviso('No se pudo iniciar el lector. Escribe el número.');
      return;
    }

    const arrancar = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!vivoRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setCamaraOk(true);

        const tick = async () => {
          if (!vivoRef.current) return;
          const el = videoRef.current;
          if (el && el.readyState >= 2) {
            try {
              const codes = await detector.detect(el);
              const raw = codes.find((c) => c.rawValue)?.rawValue;
              if (raw) {
                entregar(raw);
                return;
              }
            } catch {
              /* el vídeo aún no está listo */
            }
          }
          requestAnimationFrame(() => {
            void tick();
          });
        };
        void tick();
      } catch {
        if (vivoRef.current) {
          setCamaraOk(false);
          setAviso('No hay permiso de cámara. Escribe el número de serie.');
        }
      }
    };
    void arrancar();

    return () => {
      vivoRef.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [visible, entregar]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.titulo}>{titulo}</Text>
          <TouchableOpacity onPress={onClose} style={styles.cerrar} accessibilityLabel="Cerrar escáner">
            <MaterialIcons name="close" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
        <Text style={styles.ayuda}>{ayuda}</Text>

        <View style={styles.visor}>
          {Platform.OS === 'web'
            ? createElement('video', {
                ref: videoRef,
                autoPlay: true,
                playsInline: true,
                muted: true,
                style: {
                  width: '100%',
                  height: 260,
                  objectFit: 'cover',
                  backgroundColor: '#0f172a',
                  borderRadius: 10,
                },
              })
            : (
              <View style={styles.sinCamara}>
                <MaterialIcons name="keyboard" size={36} color={colors.textMuted} />
                <Text style={styles.sinCamaraTxt}>En este dispositivo escribe el número</Text>
              </View>
            )}
          {camaraOk === false && Platform.OS === 'web' ? (
            <View style={styles.sinCamaraOverlay}>
              <Text style={styles.sinCamaraTxt}>Cámara no disponible</Text>
            </View>
          ) : null}
        </View>

        {aviso ? <Text style={styles.aviso}>{aviso}</Text> : null}

        <Text style={styles.label}>O escríbelo</Text>
        <TextInput
          style={styles.input}
          value={manual}
          onChangeText={setManual}
          placeholder="Número de serie del fabricante"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          onSubmitEditing={() => entregar(manual)}
          {...inputCursorProps}
        />
        <TouchableOpacity
          style={[styles.usarBtn, !manual.trim() && styles.usarBtnOff]}
          onPress={() => entregar(manual)}
          disabled={!manual.trim()}
        >
          <Text style={styles.usarTxt}>Usar este número</Text>
        </TouchableOpacity>
        <Pressable onPress={onClose} style={styles.cancelar}>
          <Text style={styles.cancelarTxt}>Cancelar</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.surface, padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  titulo: { flex: 1, fontSize: 18, fontWeight: '700', color: '#0f172a' },
  cerrar: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ayuda: { fontSize: 14, color: colors.textSecondary, marginBottom: 12 },
  visor: { position: 'relative', marginBottom: 12 },
  sinCamara: {
    height: 180,
    borderRadius: radius.md,
    backgroundColor: colors.bgSubtle,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  sinCamaraOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.45)',
    borderRadius: radius.md,
  },
  sinCamaraTxt: { color: colors.textSecondary, textAlign: 'center', paddingHorizontal: 16 },
  aviso: { color: '#b45309', marginBottom: 10, fontSize: 13 },
  label: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.bgSubtle,
    marginBottom: 10,
  },
  usarBtn: {
    minHeight: MIN_TOUCH,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  usarBtnOff: { opacity: 0.45 },
  usarTxt: { color: '#fff', fontWeight: '700', fontSize: 15 },
  cancelar: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  cancelarTxt: { color: colors.textSecondary, fontWeight: '600' },
});
