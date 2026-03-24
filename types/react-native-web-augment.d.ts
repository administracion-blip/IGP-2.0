/**
 * Propiedades que usa react-native-web en DOM pero no vienen en los tipos base de RN.
 * Evita errores TS en View (onMouseEnter, etc.) y TextStyle (whiteSpace).
 */
import 'react-native';

declare module 'react-native' {
  interface TextStyle {
    whiteSpace?: 'nowrap' | 'normal' | 'pre' | 'pre-wrap' | 'pre-line' | string;
  }

  interface ViewStyle {
    /** En web, cursor CSS puede ser cualquier valor válido */
    cursor?: string;
  }

  interface ViewProps {
    onMouseEnter?: (e?: any) => void;
    onMouseLeave?: (e?: any) => void;
    onMouseDown?: (e?: any) => void;
    onMouseUp?: (e?: any) => void;
    onMouseMove?: (e?: any) => void;
  }
}
