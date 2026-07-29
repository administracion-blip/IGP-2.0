import React from 'react';
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { Borrador, DuplicadoLote } from '../../types/registroMasivo';
import { formatFecha } from '../../utils/formatFecha';
import { formatMoneda } from '../../utils/facturacion';
import { formatId6 } from '../../utils/idFormat';

type Dup = Borrador['duplicados'][number];

function celda(val: string | number | undefined | null, fallback = '—') {
  if (val == null || String(val).trim() === '') return fallback;
  return String(val);
}

function FilaComparativa({
  etiqueta,
  valorBorrador,
  valorExistente,
}: {
  etiqueta: string;
  valorBorrador: string;
  valorExistente: string;
}) {
  const coincide = valorBorrador !== '—' && valorBorrador === valorExistente;
  return (
    <View style={styles.compRow}>
      <Text style={styles.compLabel}>{etiqueta}</Text>
      <Text style={styles.compCell}>{valorBorrador}</Text>
      <Text style={[styles.compCell, coincide && styles.compCellMatch]}>{valorExistente}</Text>
    </View>
  );
}

function tablaComparativa(borrador: Borrador, dup: Dup) {
  const fechaB = borrador.fecha_emision ? formatFecha(borrador.fecha_emision) : '—';
  const fechaE = dup.fecha_emision ? formatFecha(dup.fecha_emision) : '—';
  const totalB = borrador.total_factura ? formatMoneda(borrador.total_factura) : '—';
  const totalE = dup.total_factura != null ? formatMoneda(dup.total_factura) : '—';

  return (
    <View style={styles.compTable}>
      <View style={[styles.compRow, styles.compHead]}>
        <Text style={styles.compHeadLabel}>Campo</Text>
        <Text style={styles.compHeadCell}>Este borrador</Text>
        <Text style={styles.compHeadCell}>En sistema</Text>
      </View>
      <FilaComparativa
        etiqueta="Proveedor"
        valorBorrador={celda(borrador.proveedor_nombre)}
        valorExistente={celda(dup.empresa_nombre)}
      />
      <FilaComparativa
        etiqueta="CIF"
        valorBorrador={celda(borrador.proveedor_cif)}
        valorExistente={celda(dup.empresa_cif)}
      />
      <FilaComparativa
        etiqueta="Nº factura"
        valorBorrador={celda(borrador.numero_factura_proveedor)}
        valorExistente={celda(dup.numero_factura_proveedor || dup.numero_factura)}
      />
      <FilaComparativa etiqueta="Fecha" valorBorrador={fechaB} valorExistente={fechaE} />
      <FilaComparativa etiqueta="Total" valorBorrador={totalB} valorExistente={totalE} />
    </View>
  );
}

/** Modal intersticial al detectar posible factura duplicada (registro masivo). */
export function DuplicadoFacturaModal({
  visible,
  borrador,
  duplicadosLote,
  onDescartar,
  onSeguirEditando,
  onVerFactura,
}: {
  visible: boolean;
  borrador: Borrador | null;
  duplicadosLote: DuplicadoLote[];
  onDescartar: () => void;
  onSeguirEditando: () => void;
  onVerFactura: (idFactura: string) => void;
}) {
  if (!borrador) return null;

  const principal: Dup | undefined = borrador.duplicados[0];
  const mas = Math.max(0, borrador.duplicados.length - 1);
  if (!principal && duplicadosLote.length === 0) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onSeguirEditando}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.iconRow}>
            <View style={styles.iconCircle}>
              <MaterialIcons name="content-copy" size={22} color="#b91c1c" />
            </View>
            <View style={styles.titleWrap}>
              <Text style={styles.title}>Posible factura duplicada</Text>
              <Text style={styles.subtitle}>
                {principal
                  ? 'Ya existe un registro muy similar en facturas recibidas. Revisa antes de importar.'
                  : 'Has subido esta misma factura más de una vez en este lote. Revisa antes de importar.'}
              </Text>
            </View>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {principal ? tablaComparativa(borrador, principal) : null}
            {principal && mas > 0 ? (
              <Text style={styles.masHint}>Y {mas} coincidencia{mas === 1 ? '' : 's'} más en el sistema.</Text>
            ) : null}
            {duplicadosLote.length > 0 ? (
              <View style={principal ? styles.loteBloqueConTabla : undefined}>
                <Text style={styles.loteTitulo}>También en este lote</Text>
                {duplicadosLote.map((l) => (
                  <Text key={l.idx} style={styles.loteItem}>
                    • {l.archivo || `Documento ${l.idx + 1}`}
                    {l.numero_factura_proveedor ? ` · Nº ${l.numero_factura_proveedor}` : ''}
                  </Text>
                ))}
              </View>
            ) : null}
          </ScrollView>

          {principal ? (
            <TouchableOpacity
              style={styles.linkBtn}
              onPress={() => onVerFactura(principal.id_factura)}
              activeOpacity={0.7}
            >
              <MaterialIcons name="open-in-new" size={16} color="#0ea5e9" />
              <Text style={styles.linkText}>
                Ver factura existente {formatId6(principal.id_factura)}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.linkSpacer} />
          )}

          <View style={styles.actions}>
            <TouchableOpacity style={styles.btnDescartar} onPress={onDescartar} activeOpacity={0.85}>
              <MaterialIcons name="delete-outline" size={18} color="#b91c1c" />
              <Text style={styles.btnDescartarText}>Descartar y siguiente</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnSeguir} onPress={onSeguirEditando} activeOpacity={0.85}>
              <Text style={styles.btnSeguirText}>Seguir editando</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Segundo aviso al confirmar lote con borradores duplicados sin acuse. */
export function ConfirmarDuplicadoModal({
  visible,
  cantidad,
  onCancelar,
  onConfirmar,
}: {
  visible: boolean;
  cantidad: number;
  onCancelar: () => void;
  onConfirmar: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancelar}>
      <View style={styles.overlay}>
        <View style={[styles.card, { maxWidth: 440 }]}>
          <View style={styles.iconRow}>
            <View style={styles.iconCircle}>
              <MaterialIcons name="warning-amber" size={22} color="#b45309" />
            </View>
            <View style={styles.titleWrap}>
              <Text style={styles.title}>Importar con duplicados</Text>
              <Text style={styles.subtitle}>
                {cantidad === 1
                  ? 'Hay 1 borrador activo que parece duplicado de una factura ya registrada.'
                  : `Hay ${cantidad} borradores activos que parecen duplicados.`}{' '}
                ¿Quieres importarlos igualmente?
              </Text>
            </View>
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.btnDescartar} onPress={onCancelar} activeOpacity={0.85}>
              <Text style={styles.btnDescartarText}>Cancelar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnConfirmarDup} onPress={onConfirmar} activeOpacity={0.85}>
              <Text style={styles.btnConfirmarDupText}>Importar igualmente</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Banner persistente mientras el borrador sigue marcado como duplicado. */
export function DuplicadoFacturaBanner({
  borrador,
  duplicadosLote,
  onDescartar,
  onVerFactura,
}: {
  borrador: Borrador;
  duplicadosLote: DuplicadoLote[];
  onDescartar: () => void;
  onVerFactura: (idFactura: string) => void;
}) {
  if (borrador.descartado) return null;
  const dup: Dup | undefined = borrador.duplicados[0];
  if (!dup && duplicadosLote.length === 0) return null;

  return (
    <View style={styles.banner}>
      <MaterialIcons name="content-copy" size={18} color="#b91c1c" />
      <View style={styles.bannerBody}>
        <Text style={styles.bannerTitle}>Duplicado detectado</Text>
        {dup ? (
          <Text style={styles.bannerText}>
            Coincide con {dup.empresa_nombre || 'factura existente'}
            {dup.numero_factura_proveedor || dup.numero_factura
              ? ` · Nº ${dup.numero_factura_proveedor || dup.numero_factura}`
              : ''}
            {dup.total_factura != null ? ` · ${formatMoneda(dup.total_factura)}` : ''}
            {borrador.duplicados.length > 1 ? ` (+${borrador.duplicados.length - 1} más)` : ''}
          </Text>
        ) : null}
        {duplicadosLote.length > 0 ? (
          <Text style={styles.bannerText}>
            Repetida en este lote:{' '}
            {duplicadosLote
              .map((l) => l.archivo || `documento ${l.idx + 1}`)
              .join(', ')}
          </Text>
        ) : null}
        <View style={styles.bannerActions}>
          {dup ? (
            <TouchableOpacity style={styles.bannerBtn} onPress={() => onVerFactura(dup.id_factura)}>
              <Text style={styles.bannerBtnTextPrimary}>Ver factura</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.bannerBtnOutline} onPress={onDescartar}>
            <Text style={styles.bannerBtnTextDanger}>Descartar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 12px 40px rgba(0,0,0,0.15)' } as object)
      : {
          elevation: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
        }),
  },
  iconRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fef2f2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: { flex: 1 },
  title: { fontSize: 16, fontWeight: '700', color: '#1e293b', marginBottom: 4 },
  subtitle: { fontSize: 12, color: '#64748b', lineHeight: 17 },
  scroll: { maxHeight: 280 },
  scrollContent: { paddingBottom: 4 },
  compTable: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
  },
  compRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  compHead: { backgroundColor: '#f8fafc' },
  compHeadLabel: {
    width: 88,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
  },
  compHeadCell: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
  },
  compLabel: {
    width: 88,
    paddingVertical: 8,
    paddingHorizontal: 10,
    fontSize: 11,
    color: '#64748b',
    fontWeight: '500',
  },
  compCell: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
    fontSize: 12,
    color: '#334155',
    fontWeight: '500',
  },
  compCellMatch: { color: '#b91c1c', fontWeight: '700' },
  masHint: { fontSize: 11, color: '#94a3b8', marginTop: 8, fontStyle: 'italic' },
  loteBloqueConTabla: { marginTop: 12 },
  loteTitulo: { fontSize: 11, fontWeight: '700', color: '#991b1b', marginBottom: 4 },
  loteItem: { fontSize: 12, color: '#334155', lineHeight: 18 },
  linkSpacer: { height: 16 },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    marginBottom: 16,
    alignSelf: 'flex-start',
  },
  linkText: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' },
  btnDescartar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  btnDescartarText: { fontSize: 13, fontWeight: '600', color: '#b91c1c' },
  btnSeguir: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnSeguirText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  btnConfirmarDup: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#d97706',
  },
  btnConfirmarDupText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#fecaca',
    borderLeftWidth: 4,
    borderLeftColor: '#dc2626',
    marginBottom: 8,
  },
  bannerBody: { flex: 1, gap: 6 },
  bannerTitle: { fontSize: 12, fontWeight: '700', color: '#991b1b' },
  bannerText: { fontSize: 11, color: '#7f1d1d', lineHeight: 16 },
  bannerActions: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  bannerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 5,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#0ea5e9',
  },
  bannerBtnTextPrimary: { fontSize: 11, fontWeight: '600', color: '#0369a1' },
  bannerBtnOutline: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 5,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  bannerBtnTextDanger: { fontSize: 11, fontWeight: '600', color: '#b91c1c' },
});
