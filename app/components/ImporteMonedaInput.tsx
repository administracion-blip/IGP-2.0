import { useEffect, useState } from 'react';
import { TextInput, type StyleProp, type TextStyle } from 'react-native';

type Props = {
  valor: number;
  onChangeValor: (n: number) => void;
  editable?: boolean;
  placeholder?: string;
  placeholderTextColor?: string;
  /** Máximo de decimales admitidos (2 para moneda). */
  maxDecimales?: number;
  style?: StyleProp<TextStyle>;
};

/**
 * Formatea lo tecleado a formato español en vivo: puntos de miles automáticos
 * y coma decimal (se acepta tanto ',' como '.' al teclear el decimal).
 */
function formatearVivo(raw: string, maxDec: number): { texto: string; valor: number } {
  let s = raw.replace(/[^\d.,-]/g, '');
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');
  if (!s) return { texto: neg ? '-' : '', valor: 0 };

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart: string;
  let decPart: string | null = null;

  if (lastComma > -1) {
    // La coma siempre actúa de separador decimal (los miles se insertan con punto).
    intPart = s.slice(0, lastComma).replace(/[.,]/g, '');
    decPart = s.slice(lastComma + 1).replace(/[.,]/g, '').slice(0, maxDec);
  } else if (lastDot > -1) {
    const digitosDetras = s.length - lastDot - 1;
    if (digitosDetras <= maxDec) {
      // Punto tecleado como decimal ("1.5") → se convierte en coma.
      intPart = s.slice(0, lastDot).replace(/[.,]/g, '');
      decPart = s.slice(lastDot + 1).slice(0, maxDec);
    } else {
      // Puntos de miles (p. ej. "1.2345" al añadir un dígito tras "1.234").
      intPart = s.replace(/[.,]/g, '');
    }
  } else {
    intPart = s;
  }

  intPart = intPart.replace(/^0+(?=\d)/, '');
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const texto = (neg ? '-' : '') + intFmt + (decPart !== null ? ',' + decPart : '');
  const n = parseFloat((neg ? '-' : '') + (intPart || '0') + (decPart ? '.' + decPart : ''));
  return { texto, valor: Number.isFinite(n) ? n : 0 };
}

/** Número → texto español sin decimales de relleno (12 → "12", 12.5 → "12,5"). */
function desdeNumero(n: number, maxDec: number): string {
  if (!Number.isFinite(n)) return '0';
  const neg = n < 0;
  const [intRaw, decRaw = ''] = Math.abs(n).toFixed(maxDec).split('.');
  const dec = decRaw.replace(/0+$/, '');
  const intFmt = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + intFmt + (dec ? ',' + dec : '');
}

/**
 * Input para importes/cantidades en formato español: admite ',' y '.' como
 * separador decimal al teclear, inserta puntos de miles automáticamente y
 * entrega al padre el valor numérico ya parseado.
 */
export function ImporteMonedaInput({
  valor,
  onChangeValor,
  editable = true,
  placeholder,
  placeholderTextColor,
  maxDecimales = 2,
  style,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [texto, setTexto] = useState(() => desdeNumero(valor, maxDecimales));

  // Sincroniza con el valor externo cuando el usuario no está escribiendo.
  useEffect(() => {
    if (focused) return;
    setTexto(desdeNumero(valor, maxDecimales));
  }, [valor, focused, maxDecimales]);

  const handleChange = (raw: string) => {
    const { texto: t, valor: n } = formatearVivo(raw, maxDecimales);
    setTexto(t);
    if (n !== valor) onChangeValor(n);
  };

  return (
    <TextInput
      style={style}
      value={texto}
      onChangeText={handleChange}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setTexto(desdeNumero(valor, maxDecimales));
      }}
      keyboardType="decimal-pad"
      editable={editable}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
    />
  );
}
