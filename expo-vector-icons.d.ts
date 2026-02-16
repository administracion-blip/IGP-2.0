declare module '@expo/vector-icons' {
  import type { ComponentType } from 'react';
  type IconProps = { name: string; size?: number; color?: string; style?: unknown };
  export const MaterialIcons: ComponentType<IconProps>;
}
