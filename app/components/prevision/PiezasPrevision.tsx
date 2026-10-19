import { Text, View, StyleSheet } from 'react-native';
import { ESCALA_CALOR, colorDesvio, colores, estiloCifras, formatDesvio, peso, radios } from './tokens';

export function PastillaFestivo({ nombre }: { nombre: string }) {
  return (
    <View style={styles.festivo}>
      <Text style={styles.festivoTexto} numberOfLines={1}>
        {nombre}
      </Text>
    </View>
  );
}

export function PastillaDesvio({ ratio }: { ratio: number }) {
  const texto = formatDesvio(ratio);
  if (!texto) return null;
  return (
    <View style={styles.desvio}>
      <Text style={[styles.desvioTexto, estiloCifras, { color: colorDesvio(ratio) }]} numberOfLines={1}>
        {texto}
      </Text>
    </View>
  );
}

function Cuadrado({ index, tam }: { index: number; tam: number }) {
  const paso = ESCALA_CALOR[index];
  return (
    <View
      style={{
        width: tam,
        height: tam,
        borderRadius: 3,
        backgroundColor: paso.fondo,
        borderWidth: index === 0 ? 1 : 0,
        borderColor: colores.bordeCalorClaro,
      }}
    />
  );
}

/** Leyenda completa (lectura) o mini («Menos» / «Más») del selector de semana. */
export function LeyendaEscala({ variante }: { variante: 'completa' | 'mini' }) {
  const tam = variante === 'mini' ? 12 : 16;
  return (
    <View style={variante === 'completa' ? styles.completa : styles.mini}>
      {variante === 'mini' ? <Text style={styles.miniExt}>Menos</Text> : null}
      <View style={[styles.cuadrados, variante === 'completa' && styles.cuadradosAnchos]}>
        {ESCALA_CALOR.map((_, i) => (
          <Cuadrado key={i} index={i} tam={tam} />
        ))}
      </View>
      {variante === 'mini' ? <Text style={styles.miniExt}>Más</Text> : null}
      {variante === 'completa' ? (
        <View style={styles.extremos}>
          <Text style={styles.extremo}>Menos venta</Text>
          <Text style={styles.extremo}>Más venta</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  festivo: {
    backgroundColor: colores.festivoFondo,
    borderRadius: radios.pastilla,
    paddingHorizontal: 8,
    paddingVertical: 2,
    maxWidth: 148,
    flexShrink: 1,
  },
  festivoTexto: {
    fontSize: 11,
    fontWeight: peso.etiqueta,
    color: colores.festivoTexto,
  },
  desvio: {
    backgroundColor: colores.superficie,
    borderRadius: radios.pastilla,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  desvioTexto: { fontSize: 11, fontWeight: peso.semibold },
  completa: { alignSelf: 'flex-start', width: 168, gap: 6 },
  mini: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cuadrados: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cuadradosAnchos: { width: '100%', justifyContent: 'space-between' },
  extremos: { flexDirection: 'row', justifyContent: 'space-between' },
  extremo: { fontSize: 11, color: colores.textoSecundario },
  miniExt: { fontSize: 11, color: colores.textoTerciario },
});
