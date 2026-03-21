import type { StyleProp, ViewStyle } from 'react-native';

export type SignaturePadProps = {
  value?: string | null;
  onChange?: (dataUrl: string | null) => void;
  onSave?: (dataUrl: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  title?: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
};
