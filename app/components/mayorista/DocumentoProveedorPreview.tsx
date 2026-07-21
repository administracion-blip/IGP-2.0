import { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  buildDocumentoProveedorData,
  descargarPdfDocumentoProveedor,
  type DocumentoProveedorData,
} from '../../lib/mayoristaDocumentoProveedor';

type Props = {
  neg: {
    cliente_nombre?: string;
    nombre?: string;
    fecha?: string;
    recogida_empresa_nombre?: string;
    recogida_fecha?: string;
    recogida_hora?: string;
  } | null;
  lineas: {
    product_name?: string;
    producto_id?: string;
    cantidad?: number;
    pvp_unitario?: number;
  }[];
  puedeExportar?: boolean;
};

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export function DocumentoProveedorPreview({ neg, lineas, puedeExportar }: Props) {
  const [descargando, setDescargando] = useState(false);
  const data: DocumentoProveedorData = useMemo(
    () => buildDocumentoProveedorData(neg, lineas),
    [neg, lineas],
  );

  const descargar = async () => {
    setDescargando(true);
    try {
      const ref = (neg?.nombre || 'operacion').replace(/[^\w\s-]/g, '').slice(0, 40);
      await descargarPdfDocumentoProveedor(data, `pedido-proveedor-${ref || 'doc'}.pdf`);
    } finally {
      setDescargando(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>Vista previa — envío a proveedor</Text>
        {puedeExportar ? (
          <TouchableOpacity style={styles.downloadBtn} onPress={() => { void descargar(); }} disabled={descargando}>
            {descargando ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <MaterialIcons name="picture-as-pdf" size={14} color="#fff" />
                <Text style={styles.downloadBtnText}>PDF</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView style={styles.docScroll} contentContainerStyle={styles.docPaper}>
        <Text style={styles.docTitle}>Pedido para proveedor</Text>

        <InfoRow label="Cliente" value={data.cliente} />
        <InfoRow label="Referencia" value={data.referencia} />
        <InfoRow label="Fecha" value={data.fecha} />

        <View style={styles.recogidaBox}>
          <Text style={styles.recogidaTitle}>DATOS DE RECOGIDA</Text>
          <InfoRow label="Recogida en" value={data.recogidaEn} />
          <InfoRow label="Fecha recogida" value={data.fechaRecogida} />
          <InfoRow label="Hora" value={data.horaRecogida} />
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.colProd]}>Producto</Text>
            <Text style={[styles.th, styles.colCant]}>Cant.</Text>
            <Text style={[styles.th, styles.colPvp]}>PVP</Text>
          </View>
          {data.lineas.length === 0 ? (
            <View style={styles.tableRow}>
              <Text style={[styles.td, styles.colProd, styles.emptyTd]}>Sin líneas</Text>
            </View>
          ) : data.lineas.map((l, i) => (
            <View key={`${l.producto}-${i}`} style={styles.tableRow}>
              <Text style={[styles.td, styles.colProd]} numberOfLines={2}>{l.producto}</Text>
              <Text style={[styles.td, styles.colCant]}>{l.cantidad}</Text>
              <Text style={[styles.td, styles.colPvp]}>{l.pvp}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minWidth: 0, backgroundColor: '#f1f5f9' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#fff',
    gap: 8,
  },
  toolbarTitle: { fontSize: 12, fontWeight: '700', color: '#0f172a', flex: 1 },
  downloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#dc2626',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  downloadBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  docScroll: { flex: 1 },
  docPaper: {
    margin: 12,
    padding: 14,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 6,
  },
  docTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  infoRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  infoLabel: { width: 72, fontSize: 10, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', paddingTop: 1 },
  infoValue: { flex: 1, fontSize: 12, color: '#334155' },
  recogidaBox: {
    marginTop: 6,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    gap: 4,
  },
  recogidaTitle: { fontSize: 9, fontWeight: '700', color: '#b45309', marginBottom: 4 },
  table: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    overflow: 'hidden',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  th: { fontSize: 9, fontWeight: '700', color: '#475569', textTransform: 'uppercase' },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    alignItems: 'center',
  },
  td: { fontSize: 11, color: '#334155' },
  colProd: { flex: 1, minWidth: 0, paddingRight: 6 },
  colCant: { width: 36, textAlign: 'center' },
  colPvp: { width: 64, textAlign: 'right' },
  emptyTd: { fontStyle: 'italic', color: '#94a3b8' },
});
