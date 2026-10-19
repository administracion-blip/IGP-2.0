/**
 * Informe «Albaranes que faltan»: albaranes citados en factura que no están en
 * Ágora, agrupados por sociedad → proveedor, con descarga Excel / PDF.
 * Trabaja solo con las facturas ya cargadas en la conciliación.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Modal,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { RangoFechas } from '../RangoFechas';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { formatMoneda } from '../../utils/formatMoneda';
import type { FacturaListado } from '../../types/factura';
import {
  type FiltroEstadoInforme,
  SOCIEDAD_TODAS,
  agruparFilasInforme,
  construirFilasInforme,
} from '../../lib/albaranesFaltantes';
import { formatFecha } from '../../utils/formatFecha';
import { exportarExcelAlbaranesFaltantes, exportarPdfAlbaranesFaltantes } from '../../lib/albaranesFaltantesExport';
import { PastillaAlbaranFaltante } from './PastillaAlbaranFaltante';

const ESTADOS: { id: FiltroEstadoInforme; label: string }[] = [
  { id: 'pendiente', label: 'Pendientes' },
  { id: 'resuelta', label: 'Resueltas' },
  { id: 'todas', label: 'Todas' },
];

type Props = {
  visible: boolean;
  onClose: () => void;
  facturas: FacturaListado[];
  /** Rango de la pantalla (puede venir vacío). */
  fechaDesde: string;
  fechaHasta: string;
  /** Rango realmente cargado de facturas. */
  rangoCargado: { desde: string; hasta: string };
  sociedadOpciones: OpcionDesplegable[];
  cifSociedadDeFactura: (f: FacturaListado) => string;
  nombreSociedad: (cif: string) => string;
  onError: (msg: string) => void;
};

export function InformeAlbaranesFaltantesModal({
  visible,
  onClose,
  facturas,
  fechaDesde,
  fechaHasta,
  rangoCargado,
  sociedadOpciones,
  cifSociedadDeFactura,
  nombreSociedad,
  onError,
}: Props) {
  const { isPhone } = useBreakpoint();
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [sociedad, setSociedad] = useState<string>(SOCIEDAD_TODAS);
  const [estado, setEstado] = useState<FiltroEstadoInforme>('pendiente');
  const [menuDescarga, setMenuDescarga] = useState(false);
  const [exportando, setExportando] = useState<'excel' | 'pdf' | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDesde(fechaDesde || rangoCargado.desde);
    setHasta(fechaHasta || rangoCargado.hasta);
    setMenuDescarga(false);
    // Solo al abrir: después el usuario manda en los filtros.
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const fueraDeRango =
    (!desde || desde < rangoCargado.desde) || (!hasta || hasta > rangoCargado.hasta);

  const filas = useMemo(
    () =>
      construirFilasInforme({
        facturas,
        desde,
        hasta,
        sociedad,
        estado,
        cifSociedadDeFactura,
        nombreSociedad,
      }),
    [facturas, desde, hasta, sociedad, estado, cifSociedadDeFactura, nombreSociedad],
  );
  const grupos = useMemo(() => agruparFilasInforme(filas), [filas]);

  const sociedadLabel = sociedadOpciones.find((o) => o.id === sociedad)?.titulo ?? 'Todas';
  const estadoLabel = ESTADOS.find((e) => e.id === estado)?.label ?? '';
  const sinFilas = filas.length === 0;

  const descargar = async (tipo: 'excel' | 'pdf') => {
    setMenuDescarga(false);
    if (sinFilas || exportando) return;
    setExportando(tipo);
    const ctx = { desde, hasta, sociedadLabel, estadoLabel };
    try {
      if (tipo === 'excel') await exportarExcelAlbaranesFaltantes(filas, ctx);
      else await exportarPdfAlbaranesFaltantes(filas, ctx);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : `No se pudo generar el ${tipo === 'excel' ? 'Excel' : 'PDF'}`);
    } finally {
      setExportando(null);
    }
  };

  const touch = isPhone ? { minHeight: MIN_TOUCH } : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, isPhone && styles.overlayPhone]}>
        <View style={[styles.card, isPhone && styles.cardPhone]}>
          <View style={styles.header}>
            <MaterialIcons name="assignment-late" size={22} color="#d97706" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.title}>Albaranes que faltan</Text>
              <Text style={styles.subtitle} numberOfLines={2}>Albaranes citados en factura que no están en Ágora</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={8} style={isPhone ? { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' } : null} accessibilityLabel="Cerrar">
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          {/* Filtros + descarga: fila elevada para que el menú quede sobre el cuerpo */}
          <View style={[styles.toolbar, isPhone && styles.toolbarPhone]}>
            <View style={[styles.filtro, isPhone && { width: '100%' }]}>
              <Text style={styles.filtroLabel}>Fecha de factura</Text>
              <RangoFechas desdeIso={desde} hastaIso={hasta} onChangeDesde={setDesde} onChangeHasta={setHasta} fill={isPhone} />
            </View>
            <SelectorDesplegable
              label="Sociedad"
              placeholder="Todas"
              icono="business"
              opciones={sociedadOpciones}
              valorId={sociedad}
              onSeleccionar={setSociedad}
              tituloLista="Sociedad del grupo"
              iconoLista="business"
              buscador
              buscadorPlaceholder="Buscar sociedad…"
              compact
              style={isPhone ? { width: '100%' } : { minWidth: 200 }}
            />
            <View style={styles.filtro}>
              <Text style={styles.filtroLabel}>Estado</Text>
              <View style={styles.chips}>
                {ESTADOS.map((e) => {
                  const activo = estado === e.id;
                  return (
                    <TouchableOpacity
                      key={e.id}
                      style={[styles.chip, activo && styles.chipActivo, touch]}
                      onPress={() => setEstado(e.id)}
                    >
                      <Text style={[styles.chipText, activo && styles.chipTextActivo]}>{e.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={styles.flexSpacer} />
            <View style={[styles.descargaWrap, isPhone && { width: '100%' }]}>
              <TouchableOpacity
                style={[styles.btnDescargar, touch, (sinFilas || !!exportando) && styles.btnDescargarDisabled]}
                onPress={() => setMenuDescarga((v) => !v)}
                disabled={sinFilas || !!exportando}
                accessibilityLabel="Descargar informe"
              >
                {exportando ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <MaterialIcons name="file-download" size={18} color="#fff" />
                )}
                <Text style={styles.btnDescargarText}>Descargar</Text>
                <MaterialIcons name={menuDescarga ? 'expand-less' : 'expand-more'} size={18} color="#fff" />
              </TouchableOpacity>
              {menuDescarga ? (
                <View style={styles.menu}>
                  <TouchableOpacity style={[styles.menuItem, touch]} onPress={() => void descargar('excel')}>
                    <MaterialIcons name="table-chart" size={18} color="#16a34a" />
                    <Text style={styles.menuItemText}>Excel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.menuItem, touch]} onPress={() => void descargar('pdf')}>
                    <MaterialIcons name="picture-as-pdf" size={18} color="#dc2626" />
                    <Text style={styles.menuItemText}>PDF</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {sinFilas ? <Text style={styles.descargaHint}>No hay albaranes que faltan en este periodo</Text> : null}
            </View>
          </View>

          {fueraDeRango ? (
            <View style={styles.avisoRango}>
              <MaterialIcons name="info-outline" size={16} color="#b45309" />
              <Text style={styles.avisoRangoText}>
                Amplía el periodo de la conciliación para incluir esas fechas (cargadas: {formatFecha(rangoCargado.desde)} – {formatFecha(rangoCargado.hasta)}).
              </Text>
            </View>
          ) : null}

          <ScrollView style={styles.cuerpo} contentContainerStyle={{ padding: 16, gap: 18 }}>
            {sinFilas ? (
              <View style={styles.vacioWrap}>
                <MaterialIcons name="task-alt" size={40} color="#cbd5e1" />
                <Text style={styles.vacio}>No hay albaranes que faltan en este periodo</Text>
              </View>
            ) : (
              grupos.map((soc) => (
                <View key={soc.key} style={{ gap: 10 }}>
                  <Text style={styles.sociedad}>
                    {soc.nombre}
                    {soc.cif ? <Text style={styles.sociedadCif}>  {soc.cif}</Text> : null}
                  </Text>
                  {soc.proveedores.map((prov) => (
                    <View key={prov.key} style={styles.provBlock}>
                      <Text style={styles.proveedor}>
                        {prov.nombre}
                        <Text style={styles.proveedorMeta}>
                          {prov.cif ? `  ·  ${prov.cif}` : ''}  ·  {prov.filas.length} albarán{prov.filas.length !== 1 ? 'es' : ''}
                        </Text>
                      </Text>
                      {!isPhone ? (
                        <View style={[styles.tr, styles.th]}>
                          <Text style={[styles.thText, styles.colNum]}>Nº doc. prov.</Text>
                          <Text style={[styles.thText, styles.colFecha]}>Fecha alb.</Text>
                          <Text style={[styles.thText, styles.colImporte]}>Importe</Text>
                          <Text style={[styles.thText, styles.colFactura]}>Factura</Text>
                          <Text style={[styles.thText, styles.colNota]}>Nota</Text>
                          <Text style={[styles.thText, styles.colEstado]}>Estado</Text>
                        </View>
                      ) : null}
                      {prov.filas.map((f, i) =>
                        isPhone ? (
                          <View key={f.key} style={[styles.card2, i % 2 === 1 && styles.trAlt]}>
                            <View style={styles.card2Linea}>
                              <Text style={styles.tdNum}>{f.numeroDoc}</Text>
                              <Text style={styles.td}>{formatFecha(f.fechaAlbaran)}</Text>
                              <Text style={styles.td}>{f.importe != null ? formatMoneda(f.importe) : '—'}</Text>
                            </View>
                            <Text style={styles.tdSec}>
                              Factura {f.facturaNumero} · {formatFecha(f.facturaFecha)}
                            </Text>
                            {f.nota ? <Text style={styles.tdSec}>{f.nota}</Text> : null}
                            <PastillaAlbaranFaltante estado={f.estado} resueltaPor={f.resueltaPor} enOtraEmpresa={f.enOtraEmpresa} />
                          </View>
                        ) : (
                          <View key={f.key} style={[styles.tr, i % 2 === 1 && styles.trAlt]}>
                            <Text style={[styles.tdNum, styles.colNum]} numberOfLines={1}>{f.numeroDoc}</Text>
                            <Text style={[styles.td, styles.colFecha]}>{formatFecha(f.fechaAlbaran)}</Text>
                            <Text style={[styles.td, styles.colImporte]}>{f.importe != null ? formatMoneda(f.importe) : '—'}</Text>
                            <Text style={[styles.td, styles.colFactura]} numberOfLines={1}>
                              {f.facturaNumero} <Text style={styles.tdSec}>· {formatFecha(f.facturaFecha)}</Text>
                            </Text>
                            <Text style={[styles.td, styles.colNota]} numberOfLines={2}>{f.nota || '—'}</Text>
                            <View style={styles.colEstado}>
                              <PastillaAlbaranFaltante estado={f.estado} resueltaPor={f.resueltaPor} enOtraEmpresa={f.enOtraEmpresa} />
                            </View>
                          </View>
                        ),
                      )}
                    </View>
                  ))}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  overlayPhone: { padding: 0 },
  card: {
    width: '100%',
    maxWidth: 1180,
    height: '92%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...(Platform.OS === 'web' ? { boxShadow: '0 12px 32px rgba(15,23,42,0.18)' } : { elevation: 12 }),
  },
  cardPhone: { maxWidth: '100%', height: '100%', borderRadius: 0, borderWidth: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  subtitle: { fontSize: 12, color: '#64748b', marginTop: 2 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    position: 'relative',
    zIndex: 30,
    elevation: 30,
  },
  toolbarPhone: { flexDirection: 'column', alignItems: 'stretch' },
  filtro: { gap: 3 },
  filtroLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
  },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  chipText: { fontSize: 12, color: '#475569', fontWeight: '500' },
  chipTextActivo: { color: '#0369a1', fontWeight: '700' },
  flexSpacer: { flexGrow: 1 },
  descargaWrap: { position: 'relative', zIndex: 31, elevation: 31, alignItems: 'flex-end' },
  btnDescargar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    alignSelf: 'stretch',
  },
  btnDescargarDisabled: { backgroundColor: '#cbd5e1' },
  btnDescargarText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  descargaHint: { fontSize: 11, color: '#94a3b8', marginTop: 3 },
  menu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 4,
    minWidth: 160,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 4,
    zIndex: 32,
    ...(Platform.OS === 'web' ? { boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } : { elevation: 12 }),
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  menuItemText: { fontSize: 13, fontWeight: '600', color: '#0f172a' },
  avisoRango: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: 8,
    position: 'relative',
    zIndex: 0,
  },
  avisoRangoText: { flex: 1, fontSize: 12, color: '#92400e' },
  cuerpo: { flex: 1, position: 'relative', zIndex: 0 },
  vacioWrap: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 48 },
  vacio: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
  sociedad: { fontSize: 16, fontWeight: '600', color: '#0f172a' },
  sociedadCif: { fontSize: 12, fontWeight: '400', color: '#94a3b8' },
  provBlock: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, overflow: 'hidden', backgroundColor: '#fff' },
  proveedor: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  proveedorMeta: { fontSize: 12, fontWeight: '400', color: '#64748b' },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
  th: { backgroundColor: '#f1f5f9', paddingVertical: 6 },
  thText: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  trAlt: { backgroundColor: '#f8fafc' },
  td: { fontSize: 12.5, color: '#334155' },
  tdNum: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  tdSec: { fontSize: 12, color: '#64748b' },
  colNum: { width: 130 },
  colFecha: { width: 86 },
  colImporte: { width: 96, textAlign: 'right' },
  colFactura: { width: 180 },
  colNota: { flex: 1, minWidth: 120 },
  colEstado: { width: 220 },
  card2: { paddingHorizontal: 12, paddingVertical: 10, gap: 4, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  card2Linea: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
});
