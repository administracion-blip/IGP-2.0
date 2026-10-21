import { Platform, StyleSheet, Text, TextInput, View, type TextStyle } from 'react-native';
import {
  colors,
  fontFamily,
  fontSizes,
  inputCursorProps,
  inputCursorStyle,
  radius,
  typography,
  MIN_TOUCH,
  SPACING,
} from '../../constants/theme';

type Props = {
  value: string;
  onChangeText: (texto: string) => void;
  etiqueta?: string;
  placeholder?: string;
  error?: string;
  editable?: boolean;
  secureTextEntry?: boolean;
  multiline?: boolean;
  accessibilityLabel?: string;
};

export function Campo({
  value,
  onChangeText,
  etiqueta,
  placeholder,
  error,
  editable = true,
  secureTextEntry,
  multiline,
  accessibilityLabel,
}: Props) {
  return (
    <View style={styles.bloque}>
      {etiqueta ? <Text style={styles.etiqueta}>{etiqueta}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        editable={editable}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        accessibilityLabel={accessibilityLabel ?? etiqueta}
        {...inputCursorProps}
        style={[
          styles.input,
          Platform.OS === 'web' ? (inputCursorStyle as TextStyle) : null,
          multiline && styles.inputMulti,
          error ? styles.inputError : null,
          !editable && styles.inputOff,
        ]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bloque: { gap: SPACING.xs },
  etiqueta: { ...typography.etiqueta },
  input: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.textStrong,
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[14],
  },
  inputMulti: { minHeight: MIN_TOUCH * 2, textAlignVertical: 'top' },
  inputError: { borderColor: colors.danger },
  inputOff: { backgroundColor: colors.bg },
  error: {
    fontFamily: fontFamily.regular,
    fontSize: fontSizes[12],
    color: colors.danger,
  },
});
