import React, { useCallback } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatMoneda, round2 } from '../../utils/facturacion';
import { LINEA_VACIA, type LineaDesglose } from '../../types/registroMasivo';
import { calcularTotalesDesdeDesglose, type DesgloseTotales } from '../../lib/registroMasivo';
import { useRegistroMasivoFocus } from '../../hooks/useRegistroMasivoFocusChain';
import { useDesgloseTabTeclado } from '../../hooks/useDesgloseTabTeclado';
import { DesgloseNumInput } from './DesgloseNumInput';

const btnFueraTabProps =
  Platform.OS === 'web' ? ({ focusable: false, tabIndex: -1 } as object) : {};

/**
 * Editor controlado del desglose fiscal de una factura: lista de líneas
 * IVA / retención con base, %, cuota derivada y un resumen de totales.
 *
 * Patrón controlado: recibe `lineas` y emite `onChange(nuevasLineas, totales)`
 * con los totales recalculados internamente. El padre nunca tiene que conocer
 * la lógica fiscal — solo aplica el merge sobre el borrador correspondiente.
 *
 * Si el array entrante está vacío se muestra una línea por defecto (`LINEA_VACIA`)
 * para que el usuario pueda empezar a teclear sin tener que pulsar "añadir".
 * Esa línea inicial se considera parte de las líneas activas y se propaga al
 * `onChange` cuando se modifica.
 */
export function DesgloseFiscalEditor({
  lineas,
  onChange,
}: {
  lineas: LineaDesglose[];
  onChange: (lineas: LineaDesglose[], totales: DesgloseTotales) => void;
}) {
  const focusCtx = useRegistroMasivoFocus();
  const linesEffective: LineaDesglose[] =
    lineas.length > 0 ? lineas : [{ ...LINEA_VACIA }];

  const emit = useCallback((nuevas: LineaDesglose[]) => {
    onChange(nuevas, calcularTotalesDesdeDesglose(nuevas));
  }, [onChange]);

  useDesgloseTabTeclado(linesEffective, emit, focusCtx);

  const addLinea = () => {
    emit([...linesEffective, { ...LINEA_VACIA }]);
  };

  const removeLinea = (i: number) => {
    if (linesEffective.length <= 1) return;
    const nuevas = [...linesEffective];
    nuevas.splice(i, 1);
    emit(nuevas);
  };

  const updateLinea = (
    i: number,
    field: 'tipo' | 'base' | 'porcentaje',
    value: LineaDesglose['tipo'] | number,
  ) => {
    const nuevas = linesEffective.map((L, idx) => {
      if (idx !== i) return L;
      const updated: LineaDesglose = { ...L, [field]: value, origen: 'manual' };
      if (field === 'tipo' && value === 'retencion' && i > 0) {
        const baseAnterior = round2(Number(linesEffective[i - 1].base) || 0);
        if (baseAnterior > 0) {
          updated.base = baseAnterior;
        }
      }
      const bVal = round2(Number(field === 'base' ? value : updated.base) || 0);
      const pct = Number(field === 'porcentaje' ? value : updated.porcentaje) || 0;
      updated.cuota = round2((bVal * pct) / 100);
      return updated;
    });
    emit(nuevas);
  };

  const totales = calcularTotalesDesdeDesglose(linesEffective);
  const mostrarResumen = linesEffective.some((l) => l.base > 0 || l.cuota > 0);

  return (
    <View style={styles.desgloseBlock}>
      <View style={styles.desgloseHeader}>
        <Text style={styles.desgloseTitle}>Desglose fiscal</Text>
        <TouchableOpacity onPress={addLinea} style={styles.desgloseAddBtn} {...btnFueraTabProps}>
          <MaterialIcons name="add-circle-outline" size={15} color="#0369a1" />
          <Text style={styles.desgloseAddText}>Añadir línea</Text>
        </TouchableOpacity>
      </View>

      {linesEffective.map((L, i) => {
        const numLineas = linesEffective.length;
        const esRet = L.tipo === 'retencion';
        return (
          <View key={`dsg-${i}`} style={[styles.desgloseCard, esRet && { borderColor: '#fca5a5' }]}>
            <View style={styles.desgloseCardRow}>
              <TouchableOpacity
                onPress={() => {
                  const next: LineaDesglose['tipo'] = esRet ? 'iva' : 'retencion';
                  updateLinea(i, 'tipo', next);
                }}
                style={[
                  styles.desgloseTipoBadge,
                  esRet && { backgroundColor: '#fef2f2', borderColor: '#fca5a5' },
                ]}
                {...btnFueraTabProps}
              >
                <Text style={[styles.desgloseTipoText, esRet && { color: '#dc2626' }]}>
                  {esRet ? 'Retención' : 'IVA'}
                </Text>
                <MaterialIcons name="swap-horiz" size={12} color={esRet ? '#dc2626' : '#0369a1'} />
              </TouchableOpacity>
              <View style={styles.desgloseCardFields}>
                <View style={styles.desgloseFieldGroup}>
                  <Text style={styles.desgloseFieldLabel}>
                    {esRet ? 'Base retención' : 'Base imponible'}
                  </Text>
                  <DesgloseNumInput
                    initial={L.base}
                    placeholder="0,00"
                    onCommit={(n) => updateLinea(i, 'base', n)}
                    focusFieldId={`desglose_${i}_base`}
                    desgloseCampo={`${i}_base`}
                  />
                </View>
                <View style={[styles.desgloseFieldGroup, { flex: 0.5 }]}>
                  <Text style={styles.desgloseFieldLabel}>% {esRet ? 'Ret.' : 'IVA'}</Text>
                  <DesgloseNumInput
                    initial={L.porcentaje ?? 0}
                    placeholder="0"
                    onCommit={(n) => updateLinea(i, 'porcentaje', n)}
                    focusFieldId={`desglose_${i}_pct`}
                    desgloseCampo={`${i}_pct`}
                  />
                </View>
                <View style={styles.desgloseFieldGroup}>
                  <Text style={styles.desgloseFieldLabel}>Cuota</Text>
                  <Text style={styles.desgloseCuotaReadonly}>
                    {L.cuota ? formatMoneda(L.cuota) : '0,00 €'}
                  </Text>
                </View>
              </View>
              {numLineas > 1 && (
                <TouchableOpacity onPress={() => removeLinea(i)} style={styles.desgloseRemoveBtn} {...btnFueraTabProps}>
                  <MaterialIcons name="delete-outline" size={16} color="#ef4444" />
                </TouchableOpacity>
              )}
            </View>
          </View>
        );
      })}

      {mostrarResumen && (
        <View style={styles.desgloseTotales}>
          <Text style={styles.desgloseTotalLine}>
            Base: {formatMoneda(totales.base_imponible)}
            {'  ·  '}IVA: {formatMoneda(totales.total_iva)}
            {totales.retencion > 0 ? `  ·  Ret.: −${formatMoneda(totales.retencion)}` : ''}
            {'  ·  '}Total: {formatMoneda(totales.total_factura)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  desgloseBlock: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  desgloseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  desgloseTitle: { fontSize: 13, fontWeight: '700', color: '#1e293b' },
  desgloseAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#7dd3fc',
  },
  desgloseAddText: { fontSize: 11, color: '#0369a1', fontWeight: '600' },
  desgloseCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
  },
  desgloseCardRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    flexWrap: 'nowrap',
  },
  desgloseTipoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#7dd3fc',
    flexShrink: 0,
    alignSelf: 'flex-end',
  },
  desgloseTipoText: { fontSize: 11, fontWeight: '700', color: '#0369a1' },
  desgloseRemoveBtn: { padding: 4, flexShrink: 0, alignSelf: 'flex-end' },
  desgloseCardFields: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 8,
    alignItems: 'flex-end',
  },
  desgloseFieldGroup: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  desgloseFieldLabel: { fontSize: 10, color: '#64748b', fontWeight: '600' },
  desgloseCuotaReadonly: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
    color: '#475569',
    backgroundColor: '#f1f5f9',
    textAlign: 'right',
    fontWeight: '600',
  },
  desgloseTotales: { paddingTop: 6, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  desgloseTotalLine: { fontSize: 11, color: '#0f172a', fontWeight: '600', lineHeight: 16 },
});
