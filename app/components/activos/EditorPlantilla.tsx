import { createElement, useEffect, useRef, type ComponentProps } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors, inputCursorProps, radius } from '../../constants/theme';
import { cuerpoAHtml, HUECOS_PLANTILLA, sanitizarHtmlPlantilla } from '../../lib/activosPlantilla';

const COLORES = [
  { id: 'negro', hex: '#0f172a' },
  { id: 'azul', hex: '#0ea5e9' },
  { id: 'rojo', hex: '#dc2626' },
  { id: 'verde', hex: '#16a34a' },
  { id: 'gris', hex: '#64748b' },
] as const;

type Props = {
  html: string;
  onChange: (html: string) => void;
  /** Cambia al abrir crear/editar para no perder el cursor al teclear. */
  revision: string;
};

export function EditorPlantilla({ html, onChange, revision }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || !ref.current) return;
    ref.current.innerHTML = cuerpoAHtml(html);
    // Solo al abrir crear/editar: si dependemos de html, el cursor salta al teclear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const emitir = () => {
    if (!ref.current) return;
    onChange(sanitizarHtmlPlantilla(ref.current.innerHTML));
  };

  const cmd = (command: string, value?: string) => {
    if (Platform.OS !== 'web') return;
    ref.current?.focus();
    document.execCommand(command, false, value);
    emitir();
  };

  const insertarHueco = (clave: string) => {
    if (Platform.OS !== 'web') {
      onChange(`${html}{{${clave}}}`);
      return;
    }
    ref.current?.focus();
    document.execCommand('insertText', false, `{{${clave}}}`);
    emitir();
  };

  if (Platform.OS !== 'web') {
    return (
      <TextInput
        style={styles.fallback}
        value={html}
        onChangeText={onChange}
        multiline
        textAlignVertical="top"
        {...inputCursorProps}
      />
    );
  }

  return (
    <View>
      <View style={styles.barra}>
        <Btn icon="format-bold" label="Negrita" onPress={() => cmd('bold')} />
        <Btn icon="format-italic" label="Cursiva" onPress={() => cmd('italic')} />
        <Btn icon="format-underlined" label="Subrayado" onPress={() => cmd('underline')} />
        <Btn icon="format-list-bulleted" label="Lista" onPress={() => cmd('insertUnorderedList')} />
        <View style={styles.sep} />
        <Btn texto="T" label="Título" onPress={() => cmd('formatBlock', '<h2>')} />
        <Btn texto="G" label="Grande" onPress={() => cmd('formatBlock', '<h3>')} />
        <Btn texto="N" label="Normal" onPress={() => cmd('formatBlock', '<p>')} />
        <View style={styles.sep} />
        {COLORES.map((c) => (
          <TouchableOpacity
            key={c.id}
            style={[styles.colorBtn, { backgroundColor: c.hex }]}
            onPress={() => cmd('foreColor', c.hex)}
            accessibilityLabel={`Color ${c.id}`}
          />
        ))}
      </View>
      <View style={styles.huecos}>
        {HUECOS_PLANTILLA.map((h) => (
          <TouchableOpacity key={h.clave} style={styles.hueco} onPress={() => insertarHueco(h.clave)}>
            <Text style={styles.huecoTxt}>{`{{${h.clave}}}`}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {createElement('div', {
        ref,
        contentEditable: true,
        suppressContentEditableWarning: true,
        onInput: emitir,
        onBlur: emitir,
        style: {
          minHeight: 180,
          padding: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: colors.borderStrong,
          borderRadius: 8,
          backgroundColor: colors.bgSubtle,
          color: colors.textPrimary,
          fontSize: 14,
          lineHeight: 1.45,
          outline: 'none',
        },
      })}
    </View>
  );
}

export function VistaHtmlPlantilla({ html }: { html: string }) {
  if (Platform.OS !== 'web') {
    return <Text style={styles.previewPlano}>{html.replace(/<[^>]+>/g, ' ')}</Text>;
  }
  return createElement('div', {
    dangerouslySetInnerHTML: { __html: html },
    style: {
      fontSize: 14,
      color: colors.textPrimary,
      lineHeight: 1.45,
    },
  });
}

function Btn({
  icon,
  texto,
  label,
  onPress,
}: {
  icon?: ComponentProps<typeof MaterialIcons>['name'];
  texto?: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.btn}
      onPress={onPress}
      accessibilityLabel={label}
      // Evita que el editor pierda la selección al pulsar la barra.
      {...(Platform.OS === 'web' ? { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } : {})}
    >
      {icon ? <MaterialIcons name={icon} size={18} color={colors.textPrimary} /> : <Text style={styles.btnLetra}>{texto}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  barra: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 8 },
  btn: {
    minWidth: 36,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 6,
  },
  btnLetra: { fontSize: 13, fontWeight: '800', color: colors.textPrimary },
  sep: { width: 1, height: 22, backgroundColor: colors.border, marginHorizontal: 4 },
  colorBtn: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong },
  huecos: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  hueco: {
    minHeight: 32,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.accentMuted,
    justifyContent: 'center',
  },
  huecoTxt: { fontSize: 12, fontWeight: '700', color: colors.accentPressed },
  fallback: {
    minHeight: 180,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    padding: 10,
    textAlignVertical: 'top',
    color: colors.textPrimary,
    backgroundColor: colors.bgSubtle,
  },
  previewPlano: { fontSize: 13, color: colors.textPrimary, lineHeight: 20 },
});
