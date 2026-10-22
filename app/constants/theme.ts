import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import { FONT, MIN_TOUCH, SPACING } from './layout';

/** Tokens semánticos de color — paleta Slate + sky (IGP 2.0). */
export const colors = {
  bg: '#f8fafc',
  bgSubtle: '#f8fafc',
  surface: '#ffffff',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  textPrimary: '#334155',
  /** Títulos y cifras que deben leerse antes que el cuerpo. */
  textStrong: '#0f172a',
  textSecondary: '#64748b',
  textMuted: '#64748b',
  accent: '#0ea5e9',
  accentMuted: '#e0f2fe',
  accentPressed: '#0284c7',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  /** Fondo ítem sidebar activo / hover equivalente */
  navActive: '#f1f5f9',
  /** Fondo ítem sidebar al pulsar */
  navPressed: '#e2e8f0',
  overlay: 'rgba(15, 23, 42, 0.35)',
  /** Cursor/caret en TextInput (visible sobre fondo claro). */
  inputCursor: '#7c3aed',
  /** Fondo al seleccionar texto en inputs. */
  inputSelection: '#ede9fe',
} as const;

/** Props globales de cursor/selección para TextInput (nativo). */
export const inputCursorProps = {
  cursorColor: colors.inputCursor,
  selectionColor: colors.inputSelection,
} as const;

/** Estilo web: caret-color en StyleSheet de inputs. */
export const inputCursorStyle = {
  caretColor: colors.inputCursor,
} as const;

/** Mapa de estados semánticos (badges, alertas). Texto tono oscuro del mismo matiz. */
export const statusColors = {
  neutral: { bg: '#f1f5f9', text: '#64748b' },
  info: { bg: '#e0f2fe', text: '#0369a1' },
  success: { bg: '#dcfce7', text: '#15803d' },
  warning: { bg: '#fef3c7', text: '#b45309' },
  danger: { bg: '#fee2e2', text: '#b91c1c' },
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

/** Escala única de tamaños de letra. `badge` (10) solo en etiquetas pequeñas. */
export const fontSizes = {
  badge: 10,
  12: 12,
  13: 13,
  14: 14,
  16: 16,
  18: 18,
  20: 20,
  24: 24,
  30: 30,
} as const;

/** Anillo de foco. En web lo aplica `:focus-visible` en `app/+html.tsx`. */
export const focus = {
  width: 2,
  color: colors.accent,
  offset: 2,
} as const;

/** Nombres que registra `useFonts` en `app/_layout.tsx`. Un nombre por peso. */
export const fontFamily = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

export const typography = {
  titulo: {
    fontFamily: fontFamily.bold,
    fontSize: 20,
    fontWeight: '700' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  subtitulo: {
    fontFamily: fontFamily.semibold,
    fontSize: 16,
    fontWeight: '600' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  cuerpo: {
    fontFamily: fontFamily.regular,
    fontSize: 14,
    fontWeight: '400' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  etiqueta: {
    fontFamily: fontFamily.semibold,
    fontSize: 11,
    fontWeight: '600' as TextStyle['fontWeight'],
    color: colors.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase' as TextStyle['textTransform'],
  },
  boton: {
    fontFamily: fontFamily.semibold,
    fontSize: 14,
    fontWeight: '600' as TextStyle['fontWeight'],
  },
  tabla: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    fontWeight: '400' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  nav: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    fontWeight: '500' as TextStyle['fontWeight'],
  },
} as const;

export const iconSize = {
  nav: 20,
  button: 20,
  tab: 22,
  chip: 18,
} as const;

export const sidebar = {
  widthExpanded: 220,
  widthCollapsed: 52,
  itemHeight: 36,
} as const;

export const duration = {
  fast: 150,
  normal: 200,
} as const;

/**
 * Sombra de tarjeta del diseño 2026. En nativo solo cabe una capa:
 * se aproxima la segunda (desplazamiento 4, radio 12).
 */
export const shadow = {
  card: Platform.select({
    web: {
      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.06)',
    },
    default: {
      elevation: 2,
      shadowColor: '#0f172a',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.06,
      shadowRadius: 12,
    },
  }) as ViewStyle,
};

/** Elevación sutil para cards y dropdowns. */
export function shadowCard(): ViewStyle {
  return Platform.select({
    web: {
      boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
    },
    default: {
      elevation: 2,
      shadowColor: '#0f172a',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 3,
    },
  }) as ViewStyle;
}

export { FONT, MIN_TOUCH, SPACING };

export {
  tasksColor,
  tasksIcono,
  tasksRadius,
  tasksSombraFlotante,
  tasksSpace,
  tasksTabla,
  tasksTabularNums,
  tasksTipo,
  tasksUi,
} from './tasksUiTokens';
