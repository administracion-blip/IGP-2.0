/**
 * Filas de tramos de importe. El error de una fila se pinta en esa fila.
 */

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH, SPACING } from '../../constants/layout';

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
            <Campo etiqueta="Desde" valor={fila.desde} editable={puedeEditar} error={!!error} onChangeText={(v) => onCambio(fila.clave, 'desde', v)} />
            <Campo
              etiqueta="Hasta"
              valor={fila.hasta}
              placeholder="Sin tope"
              editable={puedeEditar}
              error={!!error}
              onChangeText={(v) => onCambio(fila.clave, 'hasta', v)}
            />
            <Campo etiqueta="×" valor={fila.multiplicador} editable={puedeEditar} error={!!error} onChangeText={(v) => onCambio(fila.clave, 'multiplicador', v)} />
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
