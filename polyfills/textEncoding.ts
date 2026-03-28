/**
 * Debe cargarse antes que expo-router (ver index.js). Expo en RN usa un
 * TextDecoder solo UTF-8; jsPDF → fast-png necesita latin1 (ISO-8859-1).
 *
 * No importar react-native aquí: puede cargar Expo/router antes de que se
 * ejecute la asignación y dispare el fallo en fast-png al evaluar el módulo.
 */
import { TextDecoder, TextEncoder } from 'text-encoding';

const isWebBrowser =
  typeof globalThis.document !== 'undefined' &&
  typeof (globalThis as unknown as { document?: { createElement?: unknown } }).document
    ?.createElement === 'function';

const isReactNative =
  typeof navigator !== 'undefined' &&
  (navigator as { product?: string }).product === 'ReactNative';

if (!isWebBrowser || isReactNative) {
  globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;
  globalThis.TextEncoder = TextEncoder as typeof globalThis.TextEncoder;
}
