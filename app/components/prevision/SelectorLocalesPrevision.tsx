import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MenuAnclado, useAnclaMenu } from './menuAnclado';
import { colores, estiloEtiqueta, peso, radios } from './tokens';

export type OpcionLocalPrevision = {
  id: string;
  titulo: string;
  subtitulo?: string;
};

type Props = {
  opciones: OpcionLocalPrevision[];
  valorIds: string[];
  onChange: (ids: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  /** flotante: disparador «Locales · N». embebido: lista dentro de la hoja móvil. */
  variante: 'flotante' | 'embebido';
  alto: number;
  vacioTexto?: string;
};

export function SelectorLocalesPrevision({
  opciones,
  valorIds,
  onChange,
  loading,
  disabled,
  variante,
  alto,
  vacioTexto = 'No tienes locales con código de Ágora.',
}: Props) {
  const { ref, abierto, ancla, toggle, cerrar } = useAnclaMenu();
  const [filtro, setFiltro] = useState('');
  const seleccion = useMemo(() => new Set(valorIds), [valorIds]);
  const tactil = alto >= 44;
  const altoFila = tactil ? 44 : 40;

  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return opciones;
    return opciones.filter((o) => `${o.titulo} ${o.subtitulo ?? ''}`.toLowerCase().includes(q));
  }, [filtro, opciones]);

  const marcarTodos = () => onChange(opciones.map((o) => o.id));
  const limpiar = () => onChange([]);

  const toggleId = (id: string) => {
    if (seleccion.has(id)) onChange(valorIds.filter((x) => x !== id));
    else onChange([...valorIds, id]);
  };

  const lista = (
    <View style={variante === 'embebido' ? styles.bloque : styles.listaFlotante}>
      <View style={[styles.buscador, { minHeight: altoFila }]}>
        <MaterialIcons name="search" size={16} color={colores.textoTerciario} />
        <TextInput
          value={filtro}
          onChangeText={setFiltro}
          placeholder="Buscar local"
          placeholderTextColor={colores.textoTerciario}
          style={styles.buscadorInput}
          autoCorrect={false}
          accessibilityLabel="Buscar local"
        />
      </View>
      {loading ? (
        <ActivityIndicator color={colores.acento} style={styles.carga} />
      ) : visibles.length === 0 ? (
        <Text style={styles.vacio}>{opciones.length === 0 ? vacioTexto : 'Sin resultados.'}</Text>
      ) : (
        <ScrollView style={styles.scroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {visibles.map((o) => {
            const marcado = seleccion.has(o.id);
            return (
              <TouchableOpacity
                key={o.id}
                style={[styles.fila, { minHeight: altoFila }, marcado && styles.filaMarcada]}
                onPress={() => toggleId(o.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: marcado }}
                accessibilityLabel={o.titulo}
              >
                <View style={[styles.casilla, marcado && styles.casillaOn]}>
                  {marcado ? <MaterialIcons name="check" size={12} color={colores.textoSobreAcento} /> : null}
                </View>
                <View style={styles.textos}>
                  <Text style={styles.nombre} numberOfLines={1}>{o.titulo}</Text>
                  {o.subtitulo ? (
                    <Text style={styles.sub} numberOfLines={1}>{o.subtitulo}</Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
      <View style={styles.pie}>
        <TouchableOpacity
          style={[styles.pieBtn, { minHeight: altoFila }]}
          onPress={marcarTodos}
          disabled={loading || opciones.length === 0}
          accessibilityRole="button"
        >
          <Text style={styles.todo}>Seleccionar todo</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.pieBtn, { minHeight: altoFila }]}
          onPress={limpiar}
          disabled={loading}
          accessibilityRole="button"
        >
          <Text style={styles.limpiar}>Limpiar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  if (variante === 'embebido') {
    const n = valorIds.length;
    return (
      <View style={styles.embebido}>
        <View style={styles.embebidoCab}>
          <Text style={estiloEtiqueta}>Locales</Text>
          <Text style={styles.contador}>{n === 1 ? '1 seleccionado' : `${n} seleccionados`}</Text>
        </View>
        {lista}
      </View>
    );
  }

  return (
    <View>
      <View ref={ref} collapsable={false}>
        <TouchableOpacity
          style={[
            styles.trigger,
            { minHeight: alto, height: alto },
            abierto && styles.triggerAbierto,
            disabled && styles.triggerOff,
          ]}
          onPress={toggle}
          disabled={disabled}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={`Locales, ${valorIds.length} seleccionados`}
          accessibilityState={{ expanded: abierto }}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colores.acento} />
          ) : (
            <Text style={styles.triggerTexto} numberOfLines={1}>
              {`Locales · ${valorIds.length}`}
            </Text>
          )}
          <MaterialIcons
            name={abierto ? 'expand-less' : 'expand-more'}
            size={18}
            color={colores.textoSecundario}
          />
        </TouchableOpacity>
      </View>
      <MenuAnclado visible={abierto} ancla={ancla} onClose={cerrar} ancho={300}>
        {lista}
      </MenuAnclado>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.control,
    backgroundColor: colores.superficie,
  },
  triggerAbierto: { borderColor: colores.acento },
  triggerOff: { opacity: 0.5 },
  triggerTexto: {
    flex: 1,
    fontSize: 13,
    fontWeight: peso.medio,
    color: colores.texto,
  },
  embebido: { gap: 6 },
  embebidoCab: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  contador: { fontSize: 12, color: colores.textoSecundario },
  bloque: {
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    overflow: 'hidden',
    backgroundColor: colores.superficie,
  },
  listaFlotante: { maxHeight: 420 },
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colores.separador,
  },
  buscadorInput: {
    flex: 1,
    fontSize: 13,
    color: colores.texto,
    paddingVertical: 8,
  },
  scroll: { maxHeight: 260 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
  },
  filaMarcada: { backgroundColor: colores.filaMarcada },
  casilla: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colores.borde,
    backgroundColor: colores.superficie,
    alignItems: 'center',
    justifyContent: 'center',
  },
  casillaOn: { backgroundColor: colores.acento, borderColor: colores.acento },
  textos: { flex: 1, minWidth: 0 },
  nombre: { fontSize: 13, fontWeight: peso.medio, color: colores.texto },
  sub: { fontSize: 11, color: colores.textoSecundario, marginTop: 1 },
  pie: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: colores.separador,
  },
  pieBtn: { justifyContent: 'center', paddingHorizontal: 8 },
  todo: { fontSize: 13, fontWeight: peso.semibold, color: colores.enlace },
  limpiar: { fontSize: 13, fontWeight: peso.medio, color: colores.textoSecundario },
  vacio: { fontSize: 13, color: colores.textoSecundario, padding: 14 },
  carga: { marginVertical: 16 },
});
