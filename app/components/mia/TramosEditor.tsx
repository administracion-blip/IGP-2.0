/**
 * Filas de tramos de importe. El error de una fila se pinta en esa fila.
 */

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SelectorDesplegable } from '../SelectorDesplegable';
import { MIN_TOUCH, SPACING } from '../../constants/layout';

const MULTIPLICADORES = ['1', '2', '3', '4', '5'];

export type FilaTramo = {
  clave: string;
  desde: string;
  hasta: string;
  multiplicador: string;
};

type Campo = 'desde' | 'hasta' | 'multiplicador';

type Props = {
  filas: FilaTramo[];
  errores: Record<string, string>;
  puedeEditar: boolean;
  enTarjetas: boolean;
  onCambio: (clave: string, campo: Campo, valor: string) => void;
  onQuitarFila: (clave: string) => void;
  onAnadir: () => void;
};

const TEXTO = '#0f172a';
const SECUNDARIO = '#64748b';
const ROJO = '#b91c1c';

export function TramosEditor({
  filas,
  errores,
  puedeEditar,
  enTarjetas,
  onCambio,
  onQuitarFila,
  onAnadir,
}: Props) {
  return (
    <View style={styles.lista}>
      {filas.map((fila, i) => {
        const error = errores[fila.clave];
        const campos = (
          <View style={enTarjetas ? styles.camposTarjeta : styles.campos}>
            <Campo
              etiqueta="Desde"
              valor={fila.desde}
              placeholder="0 €"
              editable={puedeEditar}
              error={!!error}
              onChangeText={(v) => onCambio(fila.clave, 'desde', v)}
            />
            <Campo
              etiqueta="Hasta"
              valor={fila.hasta}
              placeholder="Sin tope (€)"
              editable={puedeEditar}
              error={!!error}
              onChangeText={(v) => onCambio(fila.clave, 'hasta', v)}
            />
            <CampoMultiplicador
              valor={fila.multiplicador}
              editable={puedeEditar}
              error={!!error}
              onChange={(v) => onCambio(fila.clave, 'multiplicador', v)}
            />
          </View>
        );
        return (
          <View key={fila.clave} style={[enTarjetas ? styles.tarjeta : styles.fila, error && styles.filaError]}>
            <Text style={styles.orden}>{i + 1}</Text>
            {campos}
            {puedeEditar ? (
              <Pressable
                style={styles.quitar}
                onPress={() => onQuitarFila(fila.clave)}
                accessibilityRole="button"
                accessibilityLabel={`Quitar tramo ${i + 1}`}
              >
                <MaterialIcons name="close" size={20} color={SECUNDARIO} />
              </Pressable>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        );
      })}
      {puedeEditar ? (
        <Pressable style={styles.anadir} onPress={onAnadir} accessibilityRole="button">
          <MaterialIcons name="add" size={20} color="#be185d" />
          <Text style={styles.anadirTexto}>Añadir tramo</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function idMultiplicador(valor: string) {
  const t = valor.trim().replace(',', '.');
  if (!t) return '';
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return valor.trim();
  return String(n);
}

function tituloMultiplicador(id: string) {
  return `×${id.replace('.', ',')}`;
}

function CampoMultiplicador({
  valor,
  editable,
  error,
  onChange,
}: {
  valor: string;
  editable: boolean;
  error: boolean;
  onChange: (v: string) => void;
}) {
  const id = idMultiplicador(valor);
  const opciones = MULTIPLICADORES.map((n) => ({ id: n, titulo: tituloMultiplicador(n) }));
  if (id && !MULTIPLICADORES.includes(id)) {
    opciones.push({ id, titulo: tituloMultiplicador(id) });
  }
  return (
    <View style={styles.campoMultiplicador}>
      <Text style={styles.etiqueta}>×</Text>
      <SelectorDesplegable
        placeholder="×"
        opciones={opciones}
        valorId={id || null}
        onSeleccionar={onChange}
        disabled={!editable}
        sinIconoTrigger
        triggerStyle={[styles.input, styles.triggerMulti, error && styles.inputError]}
        triggerTextStyle={styles.triggerTexto}
      />
    </View>
  );
}

function Campo({
  etiqueta,
  valor,
  placeholder,
  editable,
  error,
  onChangeText,
}: {
  etiqueta: string;
  valor: string;
  placeholder?: string;
  editable: boolean;
  error: boolean;
  onChangeText: (v: string) => void;
}) {
  return (
    <View style={styles.campo}>
      <Text style={styles.etiqueta}>{etiqueta}</Text>
      <TextInput
        value={valor}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        editable={editable}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        style={[styles.input, error && styles.inputError]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  lista: { gap: SPACING.sm, padding: SPACING.lg },
  fila: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: SPACING.sm,
  },
  tarjeta: {
    gap: SPACING.sm,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: SPACING.md,
  },
  filaError: { borderColor: ROJO, backgroundColor: '#fef2f2' },
  orden: { width: 24, color: SECUNDARIO, fontWeight: '700', textAlign: 'center' },
  campos: { flexDirection: 'row', flexGrow: 1, gap: SPACING.sm },
  camposTarjeta: { gap: SPACING.sm },
  campo: { flexGrow: 1, minWidth: 88 },
  campoMultiplicador: { width: 96, flexGrow: 0, flexShrink: 0, alignSelf: 'flex-start' },
  triggerMulti: {
    width: '100%',
    minHeight: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 0,
  },
  triggerTexto: { fontSize: 15, color: TEXTO },
  etiqueta: { color: SECUNDARIO, fontSize: 12, marginBottom: 4 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    color: TEXTO,
  },
  inputError: { borderColor: ROJO },
  quitar: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  error: { width: '100%', color: ROJO, fontSize: 13 },
  anadir: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 8,
  },
  anadirTexto: { color: '#be185d', fontWeight: '700' },
});
