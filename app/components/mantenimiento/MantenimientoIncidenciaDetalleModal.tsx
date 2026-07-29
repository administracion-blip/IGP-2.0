import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  Image,
  Platform,
  useWindowDimensions,
  type ImageStyle,
} from 'react-native';
import { createElement } from 'react';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { PrioridadIncidenciaBadge } from './PrioridadIncidenciaBadge';
import { formatearFechaIncidencia } from '../../lib/mantenimientoIncidenciaUi';
import {
  labelPeriodo,
  type CierreSinFacturaParte,
  type FacturaMantenimientoParte,
} from '../../lib/mantenimientoFacturacion';
import { formatId6 } from '../../utils/idFormat';

export type LineaValoracionDetalle = {
  tipo?: 'material' | 'mano_obra' | 'desplazamiento';
  articulo?: string;
  cantidad?: number;
  precio?: number;
  tipo_iva?: number;
  base_linea?: number;
  iva_linea?: number;
  total_linea?: number;
  /** Kilómetros del viaje completo antes de repartirlo (solo desplazamiento). */
  km_totales?: number;
  /** Partes del día entre los que se repartió el viaje (solo desplazamiento). */
  reparto_partes?: number;
};

export type MantenimientoIncidenciaDetalle = {
  titulo: string;
  descripcion?: string;
  categoria?: string;
  zona?: string;
  localNombre?: string;
  prioridad?: string;
  estado?: string;
  estadoValoracion?: string;
  fechaCreacion?: string;
  fechaProgramada?: string;
  fechaCompletada?: string;
  idIncidencia?: string;
  fotos: string[];
  valoracionLineas?: LineaValoracionDetalle[];
  valoracionBase?: number | null;
  valoracionIva?: number | null;
  valoracionTotal?: number | null;
  /** Marca de la facturación mensual; si viene, el importe está congelado. */
  factura?: FacturaMantenimientoParte | null;
  /** Cierre sin factura: el parte no tiene nada que facturar (por ahora). */
  cierre?: CierreSinFacturaParte | null;
};

type Props = {
  visible: boolean;
  detalle: MantenimientoIncidenciaDetalle | null;
  onClose: () => void;
  resolverUriFoto: (uri: string) => string;
  onFotoPress?: (uri: string) => void;
};

/**
 * Explica de dónde salen los kilómetros de una línea de desplazamiento: el
 * viaje del técnico se cobra una vez por local y día, así que la cantidad de la
 * línea es la parte que le toca a este parte, no el trayecto completo. Sin esta
 * nota parece un error y alguien podría «corregirla» a mano. Las valoraciones
 * anteriores al reparto no traen los campos y no muestran nada.
 */
function notaReparto(linea: LineaValoracionDetalle): string | null {
  if (linea.tipo !== 'desplazamiento') return null;
  const partes = Number(linea.reparto_partes);
  const kmTotales = Number(linea.km_totales);
  if (!Number.isFinite(partes) || partes <= 1) return null;
  if (!Number.isFinite(kmTotales) || kmTotales <= 0) return null;
  const km = kmTotales.toLocaleString('es-ES', { maximumFractionDigits: 3 });
  return `Viaje de ${km} km repartido entre ${Math.round(partes)} partes de ese día`;
}

function MetaCell({ label, value, compact }: { label: string; value: string; compact?: boolean }) {
  if (!value || value === '—') return null;
  if (compact) {
    return (
      <View style={[styles.metaCell, styles.metaCellCompact]}>
        <Text style={styles.metaCellLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.metaCellValue, styles.metaCellValueCompact]} numberOfLines={2}>
          {value}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaCellLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.metaCellValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function MetaGrid({ compact, children }: { compact?: boolean; children: React.ReactNode }) {
  return <View style={[styles.metaGrid, compact && styles.metaGridCompact]}>{children}</View>;
}

function FotoDetalle({
  uri,
  width,
  height,
  onPress,
}: {
  uri: string;
  width: number;
  height: number;
  onPress: () => void;
}) {
  if (Platform.OS === 'web') {
    return createElement(
      'div',
      {
        onClick: (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          onPress();
        },
        style: {
          width,
          height,
          borderRadius: 8,
          overflow: 'hidden',
          cursor: 'pointer',
          backgroundColor: '#f1f5f9',
        },
        role: 'button',
        'aria-label': 'Ampliar foto',
      },
      createElement('img', {
        src: uri,
        alt: 'Foto incidencia',
        style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
      }),
    );
  }
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityLabel="Ampliar foto">
      <Image source={{ uri }} style={{ width, height, borderRadius: 8, backgroundColor: '#f1f5f9' } as ImageStyle} resizeMode="cover" />
    </TouchableOpacity>
  );
}

export function MantenimientoIncidenciaDetalleModal({
  visible,
  detalle,
  onClose,
  resolverUriFoto,
  onFotoPress,
}: Props) {
  const { width } = useWindowDimensions();
  const { isCompact } = useBreakpoint();
  const [fotoAmpliada, setFotoAmpliada] = useState<string | null>(null);

  const uris = useMemo(
    () => (detalle?.fotos ?? []).map((f) => resolverUriFoto(f)).filter(Boolean),
    [detalle?.fotos, resolverUriFoto],
  );

  const imgSize = useMemo(() => {
    const maxW = Math.min(width - 80, isCompact ? width - 48 : 520);
    const cols = uris.length > 1 && !isCompact ? 2 : 1;
    const cell = (maxW - (cols - 1) * 10) / cols;
    return { width: cell, height: Math.min(cell * 0.72, 220) };
  }, [width, isCompact, uris.length]);

  if (!visible || !detalle) return null;

  const handleFotoPress = (uri: string) => {
    if (onFotoPress) onFotoPress(uri);
    else setFotoAmpliada(uri);
  };

  const fmt = (iso?: string) => (iso ? formatearFechaIncidencia(iso) || iso : '');
  const fmtEur = (n?: number | null) =>
    n != null && Number.isFinite(n)
      ? `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
      : '';
  const fmtNum = (n?: number) =>
    n != null && Number.isFinite(n)
      ? n.toLocaleString('es-ES', { maximumFractionDigits: 3 })
      : '';
  const lineasValoracion = detalle.valoracionLineas ?? [];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={[styles.card, isCompact && styles.cardCompact]}
        >
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>Detalle de reparación</Text>
              <View style={styles.titleRow}>
                <Text style={[styles.title, styles.titleFlex]} numberOfLines={2}>
                  {detalle.titulo?.trim() || '—'}
                </Text>
                {detalle.prioridad ? (
                  <PrioridadIncidenciaBadge prioridad={detalle.prioridad} compact />
                ) : null}
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Cerrar">
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <MetaGrid compact={isCompact}>
              <MetaCell compact={isCompact} label="Local" value={detalle.localNombre?.trim() || '—'} />
              <MetaCell
                compact={isCompact}
                label="ID"
                value={detalle.idIncidencia ? formatId6(detalle.idIncidencia) : '—'}
              />
              <MetaCell compact={isCompact} label="Estado" value={detalle.estado?.trim() || '—'} />
              <MetaCell compact={isCompact} label="Valoración" value={detalle.estadoValoracion?.trim() || '—'} />
              <MetaCell compact={isCompact} label="Categoría" value={detalle.categoria?.trim() || '—'} />
              <MetaCell compact={isCompact} label="Zona" value={detalle.zona?.trim() || '—'} />
              <MetaCell compact={isCompact} label="Creación" value={fmt(detalle.fechaCreacion) || '—'} />
              <MetaCell compact={isCompact} label="Programada" value={fmt(detalle.fechaProgramada) || '—'} />
              <MetaCell compact={isCompact} label="Completada" value={fmt(detalle.fechaCompletada) || '—'} />
            </MetaGrid>

            {detalle.factura ? (
              <View style={styles.facturadoBlock}>
                <MaterialIcons name="receipt-long" size={18} color="#0f766e" />
                <View style={styles.facturadoBody}>
                  <Text style={styles.facturadoTitulo}>
                    {detalle.factura.periodo
                      ? `Facturado · periodo de ${labelPeriodo(detalle.factura.periodo)}`
                      : 'Facturado'}
                  </Text>
                  {detalle.factura.fechaFacturacion || detalle.factura.idEmpresa ? (
                    <Text style={styles.facturadoTexto}>
                      {[
                        detalle.factura.fechaFacturacion
                          ? `Factura generada el ${fmt(detalle.factura.fechaFacturacion)}`
                          : '',
                        detalle.factura.idEmpresa
                          ? `sociedad ${detalle.factura.idEmpresa}`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  ) : null}
                  <Text style={styles.facturadoNota}>
                    El importe está congelado en la factura: esta reparación ya no se puede volver a
                    valorar, ni cambiar de fecha, ni borrar.
                  </Text>
                </View>
              </View>
            ) : detalle.cierre ? (
              <View style={styles.sinFacturaBlock}>
                <MaterialIcons name="money-off" size={18} color="#475569" />
                <View style={styles.facturadoBody}>
                  <Text style={styles.sinFacturaTitulo}>
                    {detalle.cierre.periodo
                      ? `Sin factura · cerrada en ${labelPeriodo(detalle.cierre.periodo)}`
                      : 'Sin factura'}
                  </Text>
                  <Text style={styles.sinFacturaTexto}>{detalle.cierre.texto}</Text>
                  {detalle.cierre.fechaCierre ? (
                    <Text style={styles.sinFacturaMeta}>
                      {`Cerrada el ${fmt(detalle.cierre.fechaCierre)}`}
                    </Text>
                  ) : null}
                  <Text style={styles.sinFacturaNota}>
                    No es definitivo: si el importe de la reparación vuelve a cambiar —por ejemplo,
                    si el reparto del desplazamiento le devuelve kilómetros—, entrará otra vez en la
                    facturación del mes.
                  </Text>
                </View>
              </View>
            ) : null}

            <View style={styles.descBlock}>
              <Text style={styles.sectionLabel}>Descripción</Text>
              <Text style={styles.descText}>
                {detalle.descripcion?.trim() ? detalle.descripcion.trim() : '—'}
              </Text>
            </View>

            {lineasValoracion.length > 0 ? (
              <View style={styles.valBlock}>
                <Text style={styles.sectionLabel}>Valoración</Text>
                {lineasValoracion.map((l, i) => {
                  const reparto = notaReparto(l);
                  return (
                    <View key={i} style={styles.valLinea}>
                      <View style={styles.valLineaMain}>
                        <Text style={styles.valArticulo} numberOfLines={1}>
                          {l.articulo ?? '—'}
                        </Text>
                        <Text style={styles.valTotalLinea}>{fmtEur(l.total_linea)}</Text>
                      </View>
                      <Text style={styles.valDetalle} numberOfLines={1}>
                        {fmtNum(l.cantidad)} × {fmtEur(l.precio)} · IVA {l.tipo_iva ?? 0}%
                      </Text>
                      {reparto ? <Text style={styles.valDetalle}>{reparto}</Text> : null}
                    </View>
                  );
                })}
                <View style={styles.valTotales}>
                  <View style={styles.valTotalRow}>
                    <Text style={styles.valTotalLabel}>Total sin IVA</Text>
                    <Text style={styles.valTotalValue}>{fmtEur(detalle.valoracionBase)}</Text>
                  </View>
                  <View style={styles.valTotalRow}>
                    <Text style={styles.valTotalLabel}>IVA</Text>
                    <Text style={styles.valTotalValue}>{fmtEur(detalle.valoracionIva)}</Text>
                  </View>
                  <View style={[styles.valTotalRow, styles.valTotalRowFinal]}>
                    <Text style={styles.valTotalLabelFinal}>Total (IVA incl.)</Text>
                    <Text style={styles.valTotalValueFinal}>{fmtEur(detalle.valoracionTotal)}</Text>
                  </View>
                </View>
              </View>
            ) : null}

            {uris.length > 0 ? (
              <View style={styles.fotosBlock}>
                <Text style={styles.sectionLabel}>
                  Fotos ({uris.length})
                </Text>
                <View style={styles.fotosGrid}>
                  {uris.map((uri, index) => (
                    <View key={`${uri}-${index}`}>
                      <FotoDetalle
                        uri={uri}
                        width={imgSize.width}
                        height={imgSize.height}
                        onPress={() => handleFotoPress(uri)}
                      />
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>

      {fotoAmpliada && !onFotoPress ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setFotoAmpliada(null)}>
          <TouchableOpacity style={styles.fotoOverlay} activeOpacity={1} onPress={() => setFotoAmpliada(null)}>
            {Platform.OS === 'web' ? (
              createElement('img', {
                src: fotoAmpliada,
                alt: 'Foto ampliada',
                style: { maxWidth: '92vw', maxHeight: '85vh', objectFit: 'contain' },
              })
            ) : (
              <Image source={{ uri: fotoAmpliada }} style={styles.fotoAmpliada as ImageStyle} resizeMode="contain" />
            )}
            <TouchableOpacity style={styles.fotoCloseBtn} onPress={() => setFotoAmpliada(null)}>
              <MaterialIcons name="close" size={26} color="#fff" />
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '88%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  cardCompact: { maxWidth: '100%', maxHeight: '92%' },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 },
  headerText: { flex: 1, minWidth: 0, gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' },
  titleFlex: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 11, fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 },
  title: { fontSize: 16, fontWeight: '700', color: '#334155', lineHeight: 21 },
  closeBtn: { padding: 4 },
  scroll: { flexGrow: 0 },
  scrollContent: { gap: 10, paddingBottom: 8 },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  metaGridCompact: { gap: 4, padding: 8 },
  metaCell: {
    width: '48%',
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 130,
    gap: 1,
    paddingVertical: 2,
  },
  metaCellCompact: {
    width: '100%',
    flexBasis: '100%',
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  metaCellLabel: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.2 },
  metaCellValue: { fontSize: 12, fontWeight: '600', color: '#334155', lineHeight: 16 },
  metaCellValueCompact: { flex: 1, textAlign: 'right' as const },
  facturadoBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#99f6e4',
    backgroundColor: '#f0fdfa',
  },
  facturadoBody: { flex: 1, minWidth: 0, gap: 2 },
  facturadoTitulo: { fontSize: 13, fontWeight: '700', color: '#0f766e' },
  facturadoTexto: { fontSize: 11, color: '#0d9488' },
  facturadoNota: { fontSize: 11, color: '#0f766e', lineHeight: 16 },
  sinFacturaBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  sinFacturaTitulo: { fontSize: 13, fontWeight: '700', color: '#334155' },
  sinFacturaTexto: { fontSize: 12, color: '#475569', lineHeight: 17 },
  sinFacturaMeta: { fontSize: 11, color: '#94a3b8' },
  sinFacturaNota: { fontSize: 11, color: '#64748b', lineHeight: 16 },
  descBlock: {
    gap: 6,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    minHeight: 72,
  },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 },
  descText: { fontSize: 14, color: '#475569', lineHeight: 22 },
  valBlock: {
    gap: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  valLinea: {
    gap: 2,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  valLineaMain: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  valArticulo: { flex: 1, fontSize: 13, fontWeight: '600', color: '#334155', minWidth: 0 },
  valDetalle: { fontSize: 11, color: '#94a3b8' },
  valTotalLinea: { fontSize: 12, fontWeight: '700', color: '#0f766e', flexShrink: 0 },
  valTotales: {
    marginTop: 4,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    gap: 4,
  },
  valTotalRow: { flexDirection: 'row', justifyContent: 'space-between' },
  valTotalLabel: { fontSize: 13, color: '#64748b' },
  valTotalValue: { fontSize: 13, fontWeight: '600', color: '#334155' },
  valTotalRowFinal: { borderTopWidth: 1, borderTopColor: '#cbd5e1', paddingTop: 5, marginTop: 2 },
  valTotalLabelFinal: { fontSize: 14, fontWeight: '700', color: '#334155' },
  valTotalValueFinal: { fontSize: 15, fontWeight: '800', color: '#0f766e' },
  fotosBlock: {
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  fotosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  fotoOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fotoAmpliada: { width: '90%', height: '85%', maxWidth: 900 },
  fotoCloseBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 24,
  },
});
