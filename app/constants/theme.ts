import { Platform, type TextStyle, type ViewStyle } from 'react-native';
import { FONT, MIN_TOUCH, SPACING } from './layout';

/** Tokens semánticos de color — paleta Slate + sky (IGP 2.0). */
export const colors = {
  bg: '#e2e8f0',
  bgSubtle: '#f8fafc',
  surface: '#ffffff',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  textPrimary: '#334155',
  textSecondary: '#64748b',
  textMuted: '#94a3b8',
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
  pill: 999,
} as const;

export const typography = {
  titulo: {
    fontSize: 20,
    fontWeight: '700' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  subtitulo: {
    fontSize: 16,
    fontWeight: '600' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  cuerpo: {
    fontSize: 14,
    fontWeight: '400' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  etiqueta: {
    fontSize: 11,
    fontWeight: '600' as TextStyle['fontWeight'],
    color: colors.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase' as TextStyle['textTransform'],
  },
  boton: {
    fontSize: 14,
    fontWeight: '600' as TextStyle['fontWeight'],
  },
  tabla: {
    fontSize: 13,
    fontWeight: '400' as TextStyle['fontWeight'],
    color: colors.textPrimary,
  },
  nav: {
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
