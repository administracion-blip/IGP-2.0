import { Platform, TextInput } from 'react-native';
import { colors } from '../constants/theme';

const STYLE_ID = 'igp-input-cursor';

/** Aplica cursor/selección visibles en todos los TextInput (web vía CSS, nativo vía defaultProps). */
export function setupInputCursor(): void {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      input, textarea {
        caret-color: ${colors.inputCursor};
      }
      input::selection, textarea::selection {
        background-color: ${colors.inputSelection};
      }
    `;
    document.head.appendChild(style);
    return;
  }

  TextInput.defaultProps = {
    ...(TextInput.defaultProps ?? {}),
    cursorColor: colors.inputCursor,
    selectionColor: colors.inputSelection,
  };
}
