/**
 * Modal flotante dividido en dos para el detalle de una factura:
 * - Izquierda: `FacturaVentaDetallePanel` (detalle editable, líneas, adjuntos…).
 * - Derecha: previsualización del documento adjunto (iframe en web).
 *
 * Se abre desde el botón de acción por fila en los listados de facturas de
 * venta y gasto. Reutiliza el panel existente (que ya carga los adjuntos) y
 * recibe la lista vía `onAdjuntos` para mostrar la previsualización sin
 * repetir la petición.
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Linking,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { FacturaVentaDetallePanel } from './FacturaVentaDetallePanel';
import { descargarAdjuntoFacturaRecibida } from '../lib/descargarAdjuntoFactura';

type AdjuntoItem = {
  id: string;
  nombre: string;
  tipo?: string;
  url?: string;
};

type Props = {
  apiUrl: string;
  /** null = modal cerrado */
  facturaId: string | null;
  tipoFactura?: 'IN' | 'OUT';
  puedeEditar: boolean;
  usuarioId?: string;
  usuarioNombre?: string;
  onClose: () => void;
  onGuardado: () => void;
  onAbrirCompleto: (id: string) => void;
  /** Tras editar empresa/proveedor en maestro y volver al listado. */
  resyncMaestroToken?: number;
};

export function FacturaDetalleModal({
  apiUrl,
  facturaId,
  tipoFactura = 'OUT',
  puedeEditar,
  usuarioId,
  usuarioNombre,
  onClose,
  onGuardado,
  onAbrirCompleto,
  resyncMaestroToken = 0,
}: Props) {
  const { width: winW, height: winH } = useWindowDimensions();
  const apilado = winW < 900;

  // null = adjuntos aún cargando; [] = sin adjuntos.
  const [adjuntos, setAdjuntos] = useState<AdjuntoItem[] | null>(null);
  const [selIdx, setSelIdx] = useState(0);
  const [descargando, setDescargando] = useState(false);
  const [descargaOk, setDescargaOk] = useState(false);

  useEffect(() => {
    setAdjuntos(null);
    setSelIdx(0);
    setDescargando(false);
    setDescargaOk(false);
  }, [facturaId]);

  const adjSel =
    adjuntos && adjuntos.length > 0 ? adjuntos[Math.min(selIdx, adjuntos.length - 1)] : null;

  const descargarDocumento = async () => {
    if (!facturaId || !adjSel?.id || tipoFactura !== 'IN') return;
    setDescargando(true);
    setDescargaOk(false);
    try {
      await descargarAdjuntoFacturaRecibida(facturaId, adjSel.id);
      setDescargaOk(true);
      setTimeout(() => setDescargaOk(false), 2000);
    } catch {
      // El panel de detalle ya gestiona errores en su modal de adjuntos; aquí feedback mínimo.
    } finally {
      setDescargando(false);
    }
  };

  const renderPreview = () => {
    if (adjuntos === null) {
      return (
        <View style={styles.previewCentro}>
          <ActivityIndicator size="large" color="#0ea5e9" />
        </View>
      );
    }
    if (adjuntos.length === 0 || !adjSel?.url) {
      return (
        <View style={styles.previewCentro}>
          <MaterialIcons name="description" size={44} color="#cbd5e1" />
          <Text style={styles.previewVacio}>Esta factura no tiene documento adjunto.</Text>
          {facturaId ? (
            <TouchableOpacity style={styles.abrirBtn} onPress={() => onAbrirCompleto(facturaId)}>
              <Text style={styles.abrirBtnText}>Abrir ficha completa</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      );
    }
    if (Platform.OS === 'web') {
      return (
        <iframe
          src={adjSel.url}
          style={{ width: '100%', height: '100%', border: 'none' } as React.CSSProperties}
          title="Documento de la factura"
        />
      );
    }
    return (
      <View style={styles.previewCentro}>
        <MaterialIcons name="description" size={44} color="#cbd5e1" />
        <Text style={styles.previewVacio}>Previsualización disponible solo en web.</Text>
        <TouchableOpacity style={styles.abrirBtn} onPress={() => adjSel.url && Linking.openURL(adjSel.url)}>
          <Text style={styles.abrirBtnText}>Abrir documento</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <Modal visible={facturaId !== null} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[styles.wrap, { maxHeight: winH * 0.94 }]}>
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>Detalle de factura</Text>
              <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="Cerrar">
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>

            <View style={[styles.body, apilado && styles.bodyApilado]}>
              {/* Izquierda: detalle editable */}
              <View style={[styles.panelDetalle, apilado && styles.panelApilado]}>
                <FacturaVentaDetallePanel
                  apiUrl={apiUrl}
                  facturaId={facturaId}
                  tipoFactura={tipoFactura}
                  compactPanel
                  puedeEditar={puedeEditar}
                  usuarioId={usuarioId}
                  usuarioNombre={usuarioNombre}
                  onGuardado={onGuardado}
                  onAbrirCompleto={onAbrirCompleto}
                  onAdjuntos={setAdjuntos}
                  resyncMaestroToken={resyncMaestroToken}
                />
              </View>

              {/* Derecha: previsualización del documento */}
              <View style={[styles.panelPreview, apilado && styles.panelApilado]}>
                {tipoFactura === 'IN' && adjSel?.url && facturaId ? (
                  <View style={styles.previewToolbar}>
                    <TouchableOpacity
                      style={styles.descargarBtn}
                      onPress={descargarDocumento}
                      disabled={descargando}
                    >
                      {descargando ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <MaterialIcons name="download" size={16} color="#fff" />
                      )}
                      <Text style={styles.descargarBtnText}>
                        {descargaOk ? 'Descargado' : 'Descargar (id_Documento)'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {adjuntos && adjuntos.length > 1 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
                    <View style={styles.chipsRow}>
                      {adjuntos.map((a, i) => (
                        <TouchableOpacity
                          key={a.id}
                          style={[styles.chip, i === selIdx && styles.chipActivo]}
                          onPress={() => setSelIdx(i)}
                        >
                          <MaterialIcons
                            name={a.tipo?.includes('pdf') ? 'picture-as-pdf' : a.tipo?.startsWith('image') ? 'image' : 'insert-drive-file'}
                            size={13}
                            color={i === selIdx ? '#0369a1' : '#64748b'}
                          />
                          <Text style={[styles.chipText, i === selIdx && styles.chipTextActivo]} numberOfLines={1}>
                            {a.nombre || `Adjunto ${i + 1}`}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                ) : null}
                <View style={styles.previewBox}>{renderPreview()}</View>
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  wrap: { width: '96%', maxWidth: 1400, flex: 1, alignSelf: 'center' },
  card: { flex: 1, backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#e2e8f0' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: { fontSize: 15, fontWeight: '700', color: '#0f172a' },

  body: { flex: 1, flexDirection: 'row' },
  bodyApilado: { flexDirection: 'column' },
  panelDetalle: { flex: 1.2, minWidth: 0, borderRightWidth: 1, borderRightColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  panelPreview: { flex: 1, minWidth: 0, padding: 10 },
  panelApilado: { borderRightWidth: 0 },
  previewToolbar: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 8 },
  descargarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#059669',
  },
  descargarBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },

  chipsRow: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 180,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#7dd3fc' },
  chipText: { fontSize: 12, color: '#475569', fontWeight: '500' },
  chipTextActivo: { color: '#0369a1', fontWeight: '700' },

  previewBox: { flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden', backgroundColor: '#f8fafc' },
  previewCentro: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20 },
  previewVacio: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
  abrirBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0ea5e9' },
  abrirBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
});
