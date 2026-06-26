/**
 * Selector rápido de rango por semana natural (lunes → domingo).
 *
 * Muestra chips "Esta semana", "Semana anterior" y "Semana próxima" que escriben
 * el rango en el padre vía `onChange(from, to)`. Un chip "Personalizado" se
 * resalta automáticamente cuando el rango no coincide con ninguna semana (p. ej.
 * al editar las fechas a mano); es solo indicativo.
 *
 * No gestiona estado de fechas: el padre mantiene `from`/`to` (ISO yyyy-mm-dd) y
 * sus `InputFecha`. Pensado para reutilizar en pantallas con filtro de rango.
 */
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { fechaJornadaNegocioIso } from '../lib/jornadaNegocio';
import { rangoSemana, detectarPresetSemana, type PresetSemana } from '../lib/semana';

type Props = {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
};

const OPCIONES: { preset: Exclude<PresetSemana, 'custom'>; label: string; offset: number }[] = [
  { preset: 'anterior', label: 'Semana anterior', offset: -1 },
  { preset: 'esta', label: 'Esta semana', offset: 0 },
  { preset: 'proxima', label: 'Semana próxima', offset: 1 },
];

export function SelectorRangoSemana({ from, to, onChange }: Props) {
  const hoy = fechaJornadaNegocioIso();
  const activo = detectarPresetSemana(hoy, from, to);

  return (
    <View style={styles.row}>
      {OPCIONES.map((o) => {
        const on = activo === o.preset;
        return (
          <TouchableOpacity
            key={o.preset}
            style={[styles.chip, on && styles.chipOn]}
            onPress={() => {
              const r = rangoSemana(hoy, o.offset);
              onChange(r.from, r.to);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
      <View style={[styles.chip, styles.chipCustom, activo === 'custom' && styles.chipOn]}>
        <Text style={[styles.chipText, activo === 'custom' && styles.chipTextOn]}>Personalizado</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: 14,
    borderWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#fff',
  },
  chipOn: { backgroundColor: '#0ea5e9', borderColor: '#0ea5e9' },
  chipCustom: { borderStyle: 'dashed' as const },
  chipText: { fontSize: 11, color: '#334155', fontWeight: '600' },
  chipTextOn: { color: '#fff' },
});
