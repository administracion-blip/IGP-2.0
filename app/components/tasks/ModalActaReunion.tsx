/**
 * Modal con el acta/resumen completo de una reunión: cabecera meta + cuerpo.
 * Intenta pintar lista numerada si el texto trae `1.` / `2.` o bloques claros.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { estilosModalTasks as modal } from './estilosTasks';
import { formatFecha } from '../../utils/formatFecha';

export type MetaActaReunion = {
  titulo: string;
  fecha?: string | null;
  horaInicio?: string | null;
  horaFin?: string | null;
  duracion?: string | null;
  asistentes: string[];
};

/** Parte el acta en ítems numerados si el patrón es claro; si no, en párrafos. */
export function parsearCuerpoActa(texto: string): { modo: 'lista' | 'parrafos'; items: string[] } {
  const limpio = texto.replace(/\r\n/g, '\n').trim();
  if (!limpio) return { modo: 'parrafos', items: [] };

  const porNumero = limpio.split(/(?=^\s*\d+[\.\)]\s+)/m).map((s) => s.trim()).filter(Boolean);
  const parecenNumerados =
    porNumero.length >= 2 &&
    porNumero.every((p) => /^\d+[\.\)]\s+\S/.test(p));

  if (parecenNumerados) {
    return {
      modo: 'lista',
      items: porNumero.map((p) => p.replace(/^\d+[\.\)]\s+/, '').trim()).filter(Boolean),
    };
  }

  const porSaltos = limpio
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (porSaltos.length >= 2) {
    return { modo: 'parrafos', items: porSaltos };
  }

  const porLinea = limpio
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (porLinea.length >= 3) {
    return { modo: 'parrafos', items: porLinea };
  }

  return { modo: 'parrafos', items: [limpio] };
}

export function CabeceraMetaActa({ meta }: { meta: MetaActaReunion }) {
  const horas =
    meta.horaInicio || meta.horaFin
      ? `${meta.horaInicio || '—'}${meta.horaFin ? `–${meta.horaFin}` : ''}`
      : null;
  const partesMeta = [
    meta.fecha ? formatFecha(meta.fecha) : null,
    horas,
    meta.duracion || null,
  ].filter(Boolean);

  return (
    <View style={styles.metaBloque}>
      <Text style={styles.metaTitulo}>{meta.titulo}</Text>
      {partesMeta.length > 0 ? (
        <Text style={styles.metaLinea}>{partesMeta.join(' · ')}</Text>
      ) : null}
      {meta.asistentes.length > 0 ? (
        <Text style={styles.metaAsistentes} numberOfLines={3}>
          Asistentes: {meta.asistentes.join(', ')}
        </Text>
      ) : null}
    </View>
  );
}

export function CuerpoActaParseado({ texto }: { texto: string }) {
  const { modo, items } = parsearCuerpoActa(texto);
  if (items.length === 0) {
    return <Text style={styles.vacio}>Sin contenido.</Text>;
  }
  if (modo === 'lista') {
    return (
      <View style={styles.lista}>
        {items.map((item, i) => (
          <View key={i} style={styles.itemLista}>
            <Text style={styles.itemNum}>{i + 1}.</Text>
            <Text style={styles.itemTexto}>{item}</Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.lista}>
      {items.map((item, i) => (
        <Text key={i} style={styles.parrafo}>
          {item}
        </Text>
      ))}
    </View>
  );
}

export function ModalActaReunion({
  visible,
  onCerrar,
  meta,
  resumen,
}: {
  visible: boolean;
  onCerrar: () => void;
  meta: MetaActaReunion;
  resumen: string;
}) {
  const { isCompact } = useBreakpoint();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCerrar}>
      <Pressable style={modal.overlay} onPress={onCerrar}>
        <Pressable
          style={[modal.cardWrap, { maxWidth: 640 }, isCompact && modal.cardWrapAncho]}
          onPress={(e) => e?.stopPropagation?.()}
        >
          <View style={modal.card}>
            <View style={modal.header}>
              <Text style={modal.title}>Acta / resumen</Text>
              <TouchableOpacity
                style={[modal.close, isCompact && { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH }]}
                onPress={onCerrar}
                accessibilityLabel="Cerrar"
              >
                <MaterialIcons name="close" size={22} color="#64748b" />
              </TouchableOpacity>
            </View>
            <ScrollView style={modal.body} contentContainerStyle={styles.cuerpo}>
              <CabeceraMetaActa meta={meta} />
              <CuerpoActaParseado texto={resumen} />
            </ScrollView>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  cuerpo: { gap: 14, paddingBottom: 8 },
  metaBloque: {
    gap: 4,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  metaTitulo: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  metaLinea: { fontSize: 12, color: '#64748b' },
  metaAsistentes: { fontSize: 12, color: '#475569', lineHeight: 17, marginTop: 2 },
  lista: { gap: 10 },
  itemLista: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  itemNum: { fontSize: 13, fontWeight: '700', color: '#0ea5e9', minWidth: 22 },
  itemTexto: { flex: 1, fontSize: 13, color: '#334155', lineHeight: 20 },
  parrafo: { fontSize: 13, color: '#334155', lineHeight: 20 },
  vacio: { fontSize: 12, color: '#94a3b8' },
});
