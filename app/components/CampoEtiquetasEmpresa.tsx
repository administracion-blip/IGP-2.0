import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SelectorDesplegableMulti } from './SelectorDesplegableMulti';
import {
  listEtiquetasUnicasEmpresas,
  type EmpresaConTipoRecibo,
} from '../utils/empresaTipoRecibo';

type Props = {
  value: string[];
  onChange: (tags: string[]) => void;
  empresas?: EmpresaConTipoRecibo[] | null;
  disabled?: boolean;
  compact?: boolean;
  inputStyle?: StyleProp<ViewStyle>;
};

/**
 * Selector multiselección con buscador para etiquetas del maestro igp_Empresas.
 * Permite elegir etiquetas existentes y añadir otras nuevas con el campo inferior.
 */
export function CampoEtiquetasEmpresa({
  value,
  onChange,
  empresas,
  disabled = false,
  compact = false,
  inputStyle,
}: Props) {
  const [draft, setDraft] = useState('');

  const opciones = useMemo(() => {
    const delMaestro = listEtiquetasUnicasEmpresas(empresas).map((et) => ({
      id: et,
      titulo: et,
    }));
    const idsMaestro = new Set(delMaestro.map((o) => o.id.toLowerCase()));
    const extras = value
      .filter((t) => t.trim() && !idsMaestro.has(t.trim().toLowerCase()))
      .map((t) => ({ id: t, titulo: t }));
    return [...delMaestro, ...extras].sort((a, b) =>
      a.titulo.localeCompare(b.titulo, 'es'),
    );
  }, [empresas, value]);

  const agregarNueva = () => {
    const t = draft.trim();
    if (!t) return;
    const ya = value.some((x) => x.trim().toLowerCase() === t.toLowerCase());
    if (!ya) onChange([...value, t]);
    setDraft('');
  };

  return (
    <View style={styles.wrap}>
      <SelectorDesplegableMulti
        compact={compact}
        placeholder="Selecciona etiquetas…"
        icono="label"
        tituloLista="Etiquetas"
        iconoLista="label"
        buscador
        buscadorPlaceholder="Buscar etiqueta…"
        valorIds={value}
        opciones={opciones}
        onChange={onChange}
        disabled={disabled}
        vacioTexto={
          opciones.length === 0
            ? 'No hay etiquetas en el maestro. Añade una abajo.'
            : 'No hay coincidencias.'
        }
        style={inputStyle}
      />
      <View style={styles.nuevaRow}>
        <TextInput
          style={[styles.nuevaInput, compact && styles.nuevaInputCompact, inputStyle]}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={agregarNueva}
          placeholder="Nueva etiqueta (Enter)"
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          editable={!disabled}
        />
        <TouchableOpacity
          style={[styles.nuevaBtn, disabled && styles.nuevaBtnDisabled]}
          onPress={agregarNueva}
          disabled={disabled || !draft.trim()}
          accessibilityLabel="Añadir etiqueta"
        >
          <MaterialIcons name="add" size={18} color={draft.trim() && !disabled ? '#0ea5e9' : '#cbd5e1'} />
        </TouchableOpacity>
      </View>
      {value.length > 0 ? (
        <Text style={styles.resumen} numberOfLines={2}>
          {value.join(', ')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  nuevaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nuevaInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  nuevaInputCompact: { minHeight: 36 },
  nuevaBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
  },
  nuevaBtnDisabled: { opacity: 0.6 },
  resumen: { fontSize: 10, color: '#64748b', lineHeight: 14 },
});
