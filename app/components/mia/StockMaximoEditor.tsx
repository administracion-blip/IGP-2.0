/**
 * Tabla (escritorio y tablet) o tarjetas (móvil) del stock máximo.
 * El máximo y el formato se escriben; la unidad se elige de las de Ágora.
 */

import { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH, SPACING } from '../../constants/layout';

export type UnidadAgora = { id: string; nombre: string };

export type BorradorStock = {
  maximo: string;
  formato: string;
  unidadId: string;
};

export type FilaStockMaximo = BorradorStock & {
  productId: string;
  nombre: string;
  familiaNombre: string;
  stock: number | null;
  unidades: UnidadAgora[];
  sucia: boolean;
};

type Props = {
  filas: FilaStockMaximo[];
  errores: Record<string, string>;
  puedeEditar: boolean;
  hayMas: boolean;
  cargandoMas: boolean;
  onCambio: (productId: string, campo: keyof BorradorStock, valor: string) => void;
  onMas: () => void;
  enTarjetas: boolean;
};

const ROSA = '#ec4899';
const ROSA_SUAVE = '#fdf2f8';
const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';

function nombreUnidad(fila: FilaStockMaximo, unidadId: string) {
  if (!unidadId) return '';
  return fila.unidades.find((u) => u.id === unidadId)?.nombre || unidadId;
}

export function StockMaximoEditor({
  filas,
  errores,
  puedeEditar,
  hayMas,
  cargandoMas,
  onCambio,
  onMas,
  enTarjetas,
}: Props) {
  const [unidadAbierta, setUnidadAbierta] = useState<FilaStockMaximo | null>(null);
  const unidadElegida = unidadAbierta?.unidadId || '';

  const fila = (item: FilaStockMaximo) => {
    const error = errores[item.productId];
    const campos = (
      <View style={enTarjetas ? styles.camposTarjeta : styles.campos}>
        <Campo
          etiqueta="Máximo"
          valor={item.maximo}
          editable={puedeEditar}
          onChangeText={(v) => onCambio(item.productId, 'maximo', v)}
          ancho={88}
        />
        <Campo
          etiqueta="Formato"
          valor={item.formato}
          editable={puedeEditar}
          onChangeText={(v) => onCambio(item.productId, 'formato', v)}
          ancho={88}
        />
        <View style={styles.unidad}>
          <Text style={styles.etiqueta}>Unidad</Text>
          {item.unidades.length === 0 ? (
            <Text style={styles.sinUnidad}>Sin unidad en Ágora</Text>
          ) : (
            <Pressable
              style={styles.unidadBtn}
              disabled={!puedeEditar}
              onPress={() => setUnidadAbierta(item)}
              accessibilityRole="button"
              accessibilityLabel={`Unidad de ${item.nombre}`}
            >
              <Text style={styles.unidadTexto} numberOfLines={1}>
                {nombreUnidad(item, item.unidadId) || 'Elegir unidad'}
              </Text>
              <MaterialIcons name="arrow-drop-down" size={22} color={SECUNDARIO} />
            </Pressable>
          )}
        </View>
      </View>
    );
    return (
      <View style={[enTarjetas ? styles.tarjeta : styles.fila, item.sucia && styles.sucia]}>
        <View style={enTarjetas ? undefined : styles.identidad}>
          <Text style={styles.nombre} numberOfLines={2}>{item.nombre}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {item.familiaNombre || 'Sin familia'}
            {item.stock == null ? '' : ` · Stock ${item.stock}`}
          </Text>
        </View>
        {campos}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  };

  return (
    <View style={styles.lista}>
      {!enTarjetas ? (
        <View style={styles.cabecera}>
          <Text style={[styles.cabCol, styles.identidad]}>Producto</Text>
          <Text style={[styles.cabCol, { width: 88 }]}>Máximo</Text>
          <Text style={[styles.cabCol, { width: 88 }]}>Formato</Text>
          <Text style={[styles.cabCol, styles.unidadCab]}>Unidad</Text>
        </View>
      ) : null}
      <FlatList
        data={filas}
        keyExtractor={(item) => item.productId}
        renderItem={({ item }) => fila(item)}
        initialNumToRender={20}
        windowSize={8}
        contentContainerStyle={filas.length === 0 ? styles.vacioCont : undefined}
        ListEmptyComponent={<Text style={styles.vacio}>No hay productos con este filtro.</Text>}
        ListFooterComponent={hayMas ? (
          <Pressable style={styles.mas} onPress={onMas} disabled={cargandoMas}>
            <Text style={styles.masTexto}>{cargandoMas ? 'Cargando…' : 'Cargar más'}</Text>
          </Pressable>
        ) : null}
      />
      <Modal visible={!!unidadAbierta} transparent animationType="fade" onRequestClose={() => setUnidadAbierta(null)}>
        <Pressable style={styles.overlay} onPress={() => setUnidadAbierta(null)}>
          <Pressable style={styles.dialogo} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.dialogoTitulo}>Unidad de compra</Text>
            <Text style={styles.dialogoSub}>{unidadAbierta?.nombre}</Text>
            <Pressable
              style={styles.opcion}
              onPress={() => {
                if (unidadAbierta) onCambio(unidadAbierta.productId, 'unidadId', '');
                setUnidadAbierta(null);
              }}
            >
              <Text style={styles.opcionTexto}>Sin unidad</Text>
              {unidadElegida === '' ? <MaterialIcons name="check" size={18} color={ROSA} /> : null}
            </Pressable>
            {(unidadAbierta?.unidades || []).map((u) => (
              <Pressable
                key={u.id}
                style={styles.opcion}
                onPress={() => {
                  if (unidadAbierta) onCambio(unidadAbierta.productId, 'unidadId', u.id);
                  setUnidadAbierta(null);
                }}
              >
                <Text style={styles.opcionTexto}>{u.nombre}</Text>
                {unidadElegida === u.id ? <MaterialIcons name="check" size={18} color={ROSA} /> : null}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Campo({
  etiqueta,
  valor,
  editable,
  onChangeText,
  ancho,
}: {
  etiqueta: string;
  valor: string;
  editable: boolean;
  onChangeText: (v: string) => void;
  ancho: number;
}) {
  return (
    <View style={{ width: ancho }}>
      <Text style={styles.etiqueta}>{etiqueta}</Text>
      <TextInput
        value={valor}
        editable={editable}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        placeholder="—"
        placeholderTextColor="#94a3b8"
        style={[styles.input, !editable && styles.inputOff]}
        accessibilityLabel={etiqueta}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  lista: { flex: 1, minHeight: 0 },
  cabecera: {
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.xs,
  },
  cabCol: { fontSize: 12, fontWeight: '700', color: SECUNDARIO },
  identidad: { flex: 1, minWidth: 140 },
  unidadCab: { width: 160 },
  fila: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  tarjeta: {
    marginHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    padding: SPACING.md,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sucia: { backgroundColor: ROSA_SUAVE },
  nombre: { fontSize: 15, fontWeight: '700', color: TEXTO },
  meta: { fontSize: 12, color: SECUNDARIO, marginTop: 2 },
  campos: { flexDirection: 'row', gap: SPACING.sm, alignItems: 'flex-start' },
  camposTarjeta: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.sm },
  etiqueta: { fontSize: 11, fontWeight: '600', color: SECUNDARIO, marginBottom: 4 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: '#fff',
    color: TEXTO,
    fontSize: 15,
  },
  inputOff: { backgroundColor: '#f8fafc', color: SECUNDARIO },
  unidad: { width: 160 },
  unidadBtn: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  unidadTexto: { flex: 1, color: TEXTO, fontSize: 14 },
  sinUnidad: { minHeight: MIN_TOUCH, color: SECUNDARIO, fontSize: 13, textAlignVertical: 'center' },
  error: { color: '#b91c1c', fontSize: 12, marginTop: 4 },
  vacioCont: { flexGrow: 1, justifyContent: 'center' },
  vacio: { textAlign: 'center', color: SECUNDARIO, padding: SPACING.xl },
  mas: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center', padding: SPACING.md },
  masTexto: { color: ROSA, fontWeight: '700' },
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: SPACING.lg },
  dialogo: { backgroundColor: '#fff', borderRadius: 16, padding: SPACING.lg, maxWidth: 420, alignSelf: 'center', width: '100%' },
  dialogoTitulo: { fontSize: 18, fontWeight: '700', color: TEXTO },
  dialogoSub: { color: SECUNDARIO, marginBottom: SPACING.md, marginTop: 4 },
  opcion: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  opcionTexto: { fontSize: 15, color: TEXTO },
});
