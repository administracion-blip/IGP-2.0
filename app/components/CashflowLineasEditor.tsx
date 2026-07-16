import { View, Text, TextInput, TouchableOpacity, StyleSheet, type TextStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { ImporteMonedaInput } from './ImporteMonedaInput';
import { cashflowCampoStyle } from '../constants/cashflowFormStyles';
import { importeTotalLineas, type CashflowLinea, type CashflowTipo, formatImporteCashflow } from '../types/cashflow';

export type LineaEditable = CashflowLinea & { id: string };

type Props = {
  lineas: LineaEditable[];
  onChange: (lineas: LineaEditable[]) => void;
  tipo: CashflowTipo;
  campoStyle?: TextStyle;
};

export function CashflowLineasEditor({ lineas, onChange, tipo, campoStyle }: Props) {
  const campo = campoStyle ?? cashflowCampoStyle;
  const total = importeTotalLineas(lineas);

  function updateLinea(id: string, patch: Partial<LineaEditable>) {
    onChange(lineas.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function removeLinea(id: string) {
    if (lineas.length <= 1) return;
    onChange(lineas.filter((l) => l.id !== id));
  }

  function addLinea() {
    onChange([
      ...lineas,
      { id: `ln-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, descripcion: '', importe: 0 },
    ]);
  }

  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>Concepto — líneas</Text>
      {lineas.map((ln) => (
        <View key={ln.id} style={styles.row}>
          <View style={styles.descCol}>
            <TextInput
              style={campo}
              value={ln.descripcion}
              onChangeText={(t) => updateLinea(ln.id, { descripcion: t })}
              placeholder="Descripción"
              placeholderTextColor="#94a3b8"
            />
          </View>
          <View style={styles.impCol}>
            <ImporteMonedaInput
              valor={ln.importe}
              onChangeValor={(n) => updateLinea(ln.id, { importe: n })}
              placeholder="0,00"
              style={campo}
            />
          </View>
          <TouchableOpacity
            style={[styles.delBtn, lineas.length <= 1 && styles.delBtnDisabled]}
            onPress={() => removeLinea(ln.id)}
            disabled={lineas.length <= 1}
          >
            <MaterialIcons name="delete-outline" size={20} color={lineas.length <= 1 ? '#cbd5e1' : '#b91c1c'} />
          </TouchableOpacity>
        </View>
      ))}

      <View style={styles.footerRow}>
        <TouchableOpacity style={styles.addBtn} onPress={addLinea}>
          <MaterialIcons name="add" size={16} color="#0369a1" />
          <Text style={styles.addBtnText}>Añadir línea</Text>
        </TouchableOpacity>
        <View style={styles.totalWrap}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={[styles.totalVal, tipo === 'pago' ? styles.totalPago : styles.totalCobro]}>
            {total > 0 ? formatImporteCashflow(total, tipo) : '0,00 €'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: 4 },
  blockTitle: { fontSize: 12, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  descCol: { flex: 1, minWidth: 0 },
  impCol: { width: 108 },
  delBtn: { width: 32, height: 46, alignItems: 'center', justifyContent: 'center' },
  delBtnDisabled: { opacity: 0.35 },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    gap: 8,
    flexWrap: 'wrap',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  addBtnText: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  totalWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  totalLabel: { fontSize: 13, fontWeight: '700', color: '#334155' },
  totalVal: { fontSize: 18, fontWeight: '800' },
  totalPago: { color: '#b91c1c' },
  totalCobro: { color: '#15803d' },
});
