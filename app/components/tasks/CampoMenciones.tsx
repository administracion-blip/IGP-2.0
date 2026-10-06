/**
 * Personas de una tarea, al estilo de una mención: se escribe el nombre,
 * se elige y queda una pastilla que se puede quitar.
 */
import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { OpcionDesplegable } from '../SelectorDesplegable';
import { MAX_PARTICIPANTES_TAREA } from '../../types/tasks';

export function CampoMenciones({
  opciones,
  valorIds,
  onChange,
  nombreDe,
  disabled,
  loading,
}: {
  opciones: OpcionDesplegable[];
  valorIds: string[];
  onChange: (ids: string[]) => void;
  nombreDe: (id: string) => string;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [texto, setTexto] = useState('');
  const [abierto, setAbierto] = useState(false);
  const seleccion = useMemo(() => new Set(valorIds), [valorIds]);
  const q = texto.trim().toLowerCase();
  const sugerencias = useMemo(() => {
    if (!q) return [];
    return opciones
      .filter((o) => !seleccion.has(o.id))
      .filter((o) => `${o.titulo} ${o.subtitulo ?? ''}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [opciones, q, seleccion]);

  const anadir = (id: string) => {
    if (disabled || seleccion.has(id) || valorIds.length >= MAX_PARTICIPANTES_TAREA) return;
    onChange([...valorIds, id]);
    setTexto('');
    setAbierto(false);
  };

  const quitar = (id: string) => {
    if (disabled) return;
    onChange(valorIds.filter((x) => x !== id));
  };

  return (
    <View>
      <View style={[styles.caja, disabled && styles.cajaOff]}>
        {valorIds.map((id) => (
          <View key={id} style={styles.pastilla}>
            <Text style={styles.pastillaTexto} numberOfLines={1}>
              @{nombreDe(id)}
            </Text>
            <TouchableOpacity
              onPress={() => quitar(id)}
              disabled={disabled}
              accessibilityLabel={`Quitar a ${nombreDe(id)}`}
              hitSlop={6}
            >
              <MaterialIcons name="close" size={14} color="#0369a1" />
            </TouchableOpacity>
          </View>
        ))}
        <TextInput
          style={styles.input}
          value={texto}
          onChangeText={(t) => {
            setTexto(t);
            setAbierto(true);
          }}
          onFocus={() => setAbierto(true)}
          onSubmitEditing={() => {
            if (sugerencias[0]) anadir(sugerencias[0].id);
          }}
          placeholder={valorIds.length === 0 ? 'Escribe un nombre…' : ''}
          placeholderTextColor="#94a3b8"
          editable={!disabled && valorIds.length < MAX_PARTICIPANTES_TAREA}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {loading ? <ActivityIndicator size="small" color="#0ea5e9" /> : null}
      </View>
      {abierto && q && !disabled ? (
        <View style={styles.lista}>
          {sugerencias.length === 0 ? (
            <Text style={styles.vacio}>Nadie coincide con «{texto.trim()}»</Text>
          ) : (
            sugerencias.map((o) => (
              <TouchableOpacity
                key={o.id}
                style={styles.opcion}
                onPress={() => anadir(o.id)}
                accessibilityRole="button"
                accessibilityLabel={`Añadir a ${o.titulo}`}
              >
                <MaterialIcons name="alternate-email" size={16} color="#64748b" />
                <Text style={styles.opcionTexto} numberOfLines={1}>
                  {o.titulo}
                </Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      ) : null}
      {valorIds.length >= MAX_PARTICIPANTES_TAREA ? (
        <Text style={styles.tope}>Máximo {MAX_PARTICIPANTES_TAREA} personas además del responsable.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  caja: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  cajaOff: { backgroundColor: '#f8fafc' },
  pastilla: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
    backgroundColor: '#e0f2fe',
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
  },
  pastillaTexto: { color: '#0369a1', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 120,
    fontSize: 14,
    color: '#0f172a',
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  lista: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  opcion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 12,
  },
  opcionTexto: { flex: 1, fontSize: 14, color: '#0f172a' },
  vacio: { fontSize: 13, color: '#64748b', paddingHorizontal: 12, paddingVertical: 10 },
  tope: { marginTop: 4, fontSize: 12, color: '#b45309' },
});
