import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import { useMemo } from 'react';
import {
  type CashflowLinea,
  type CashflowTipo,
  CATEGORIA_CASHFLOW_LABEL,
  type CashflowCategoria,
} from '../types/cashflow';
import { importeLetraEur } from '../lib/cashflow/importeLetra';

type Props = {
  tipo: CashflowTipo;
  fecha: string;
  empresaNombre?: string;
  empresaCif?: string;
  localNombre?: string;
  categoria?: CashflowCategoria;
  lineas: CashflowLinea[];
  importeTotal: number;
  contraparteNombre: string;
  contraparteNif?: string;
  creadoPorNombre?: string;
};

function formatMoneda(n: number): string {
  return (Number(n) || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function formatFechaJornada(iso: string): string {
  if (!iso || iso.length < 10) return '—';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

function resumenConceptos(lineas: CashflowLinea[]): string {
  const valid = lineas.filter((l) => l.descripcion.trim());
  if (!valid.length) return '—';
  if (valid.length === 1) return valid[0].descripcion;
  return valid.map((l) => l.descripcion).join('; ');
}

export function CashflowReciboPreview({
  tipo,
  fecha,
  empresaNombre,
  empresaCif,
  localNombre,
  categoria,
  lineas,
  importeTotal,
  contraparteNombre,
  contraparteNif,
  creadoPorNombre,
}: Props) {
  const esPago = tipo === 'pago';
  const titulo = esPago ? 'RECIBÍ' : 'RECIBO DE ENTREGA';
  const lineasValidas = useMemo(
    () => lineas.filter((l) => l.descripcion.trim() && l.importe > 0),
    [lineas],
  );
  const conceptoResumen = resumenConceptos(lineas);
  const importeLetra = importeTotal > 0 ? importeLetraEur(importeTotal) : '—';

  const cuerpoLegal = esPago
    ? `D./Dña. ${contraparteNombre || '—'}${contraparteNif ? ` (NIF/CIF: ${contraparteNif})` : ''} declara haber RECIBIDO la cantidad indicada en concepto de: ${conceptoResumen}.`
    : `El abajo firmante, ${creadoPorNombre || '—'}, en representación de ${empresaNombre || 'la empresa'}, certifica haber RECIBIDO en efectivo la cantidad indicada de D./Dña. ${contraparteNombre || '—'}${contraparteNif ? ` (NIF/CIF: ${contraparteNif})` : ''}, en concepto de: ${conceptoResumen}.`;

  return (
    <View style={styles.outer}>
      <Text style={styles.previewLabel}>Vista previa del documento</Text>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.sheet}>
          <Text style={styles.docTitle}>{titulo}</Text>
          <Text style={styles.docMeta}>N.º — (se asignará al firmar)</Text>
          <Text style={styles.docMeta}>Fecha (jornada): {formatFechaJornada(fecha)}</Text>

          <Text style={styles.empresa}>{empresaNombre || '—'}</Text>
          {empresaCif ? <Text style={styles.docMeta}>CIF: {empresaCif}</Text> : null}
          {localNombre ? <Text style={styles.docMeta}>Local: {localNombre}</Text> : null}

          <Text style={styles.detalleTitle}>Detalle</Text>
          <View style={styles.tablaHead}>
            <Text style={[styles.th, styles.thConcepto]}>Concepto</Text>
            <Text style={[styles.th, styles.thImporte]}>Importe</Text>
          </View>
          {lineasValidas.length === 0 ? (
            <Text style={styles.lineaVacia}>Añade líneas de concepto…</Text>
          ) : (
            lineasValidas.map((ln, i) => (
              <View key={`${ln.descripcion}-${i}`} style={styles.tablaRow}>
                <Text style={styles.tdConcepto}>{ln.descripcion}</Text>
                <Text style={styles.tdImporte}>{formatMoneda(ln.importe)}</Text>
              </View>
            ))
          )}
          <View style={styles.tablaFoot}>
            <Text style={styles.totalLabel}>TOTAL</Text>
            <Text style={styles.totalVal}>{importeTotal > 0 ? formatMoneda(importeTotal) : '—'}</Text>
          </View>
          <Text style={styles.importeLetra}>{importeLetra}</Text>

          {categoria ? (
            <Text style={styles.docMeta}>
              Categoría: {CATEGORIA_CASHFLOW_LABEL[categoria] ?? categoria}
            </Text>
          ) : null}

          <Text style={styles.cuerpoLegal}>{cuerpoLegal}</Text>

          <Text style={styles.firmaLabel}>Firma:</Text>
          <View style={styles.firmaBox}>
            <Text style={styles.firmaPlaceholder}>Espacio para firma</Text>
          </View>

          {creadoPorNombre ? (
            <Text style={styles.pie}>Registrado por: {creadoPorNombre}</Text>
          ) : null}
          <Text style={styles.pieMuted}>Vista previa · el PDF definitivo se genera al firmar</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, minHeight: 0 },
  previewLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  sheet: {
    backgroundColor: '#fff',
    borderRadius: 4,
    padding: 20,
    minHeight: 420,
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 4px 24px rgba(15,23,42,0.12)' } as object)
      : {
          shadowColor: '#0f172a',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.12,
          shadowRadius: 12,
          elevation: 4,
        }),
  },
  docTitle: { fontSize: 22, fontWeight: '800', color: '#0f172a', marginBottom: 8 },
  docMeta: { fontSize: 11, color: '#475569', marginBottom: 4, lineHeight: 16 },
  empresa: { fontSize: 14, fontWeight: '700', color: '#0f172a', marginTop: 10, marginBottom: 4 },
  detalleTitle: { fontSize: 12, fontWeight: '700', color: '#334155', marginTop: 14, marginBottom: 6 },
  tablaHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#cbd5e1', paddingBottom: 4 },
  th: { fontSize: 9, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  thConcepto: { flex: 1 },
  thImporte: { width: 80, textAlign: 'right' },
  tablaRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 8,
  },
  tdConcepto: { flex: 1, fontSize: 11, color: '#334155', lineHeight: 15 },
  tdImporte: { width: 80, fontSize: 11, fontWeight: '600', color: '#334155', textAlign: 'right' },
  lineaVacia: { fontSize: 11, color: '#94a3b8', fontStyle: 'italic', paddingVertical: 8 },
  tablaFoot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    marginTop: 4,
    paddingTop: 8,
    paddingBottom: 4,
  },
  totalLabel: { fontSize: 12, fontWeight: '800', color: '#0f172a' },
  totalVal: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
  importeLetra: {
    fontSize: 10,
    fontStyle: 'italic',
    color: '#475569',
    lineHeight: 14,
    marginBottom: 10,
  },
  cuerpoLegal: { fontSize: 10, color: '#334155', lineHeight: 15, marginTop: 8, marginBottom: 12 },
  firmaLabel: { fontSize: 11, fontWeight: '600', color: '#334155', marginBottom: 4 },
  firmaBox: {
    height: 72,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  firmaPlaceholder: { fontSize: 10, color: '#94a3b8' },
  pie: { fontSize: 9, color: '#64748b', marginBottom: 2 },
  pieMuted: { fontSize: 8, color: '#94a3b8', fontStyle: 'italic' },
});
