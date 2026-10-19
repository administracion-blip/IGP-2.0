import { useMemo, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { formatEur, type FranjaPrevision, type LocalPrevision } from '../../lib/previsionFranjasApi';
import { LeyendaEscala } from './PiezasPrevision';
import { colores, estiloCifras, nombreFranjaVisible, peso, radios, rangoFranja, type ModoPrevision } from './tokens';

type Props = {
  local: LocalPrevision;
  franjas: FranjaPrevision[];
  modo: ModoPrevision;
};

export function PanelLecturaPrevision({ local, franjas, modo }: Props) {
  const [abierto, setAbierto] = useState(false);
  const barras = useMemo(() => {
    const items = franjas.map((f, i) => {
      let suma = 0;
      for (const d of local.dias) {
        if (!d.valida) continue;
        suma += d.celdas[i]?.previsto ?? 0;
      }
      return { key: `${f.desde}-${f.hasta}-${i}`, label: nombreFranjaVisible(f), rango: rangoFranja(f), suma };
    });
    const max = items.reduce((m, b) => (b.suma > m ? b.suma : m), 0);
    return { items, max };
  }, [local, franjas]);

  const cuerpo = (
    <View style={modo === 'tablet' ? styles.dosCols : styles.col}>
      <View style={[styles.textoCol, modo === 'tablet' && styles.flex]}>
        {modo !== 'movil' ? <Text style={styles.titulo}>Lectura</Text> : null}
        <Text style={styles.frase}>Cada día usa la venta real de su fecha comparativa.</Text>
        <LeyendaEscala variante="completa" />
      </View>
      {barras.items.length > 0 ? (
        <View style={[styles.barrasCol, modo === 'tablet' && styles.flex]}>
          {modo === 'tablet' ? null : <View style={styles.separador} />}
          <Text style={styles.barrasTitulo}>Total por franja</Text>
          {barras.items.map((b) => {
            const ratio = barras.max > 0 ? b.suma / barras.max : 0;
            return (
              <View key={b.key} style={styles.barra}>
                <View style={styles.barraCab}>
                  <View style={styles.barraNombreCol}>
                    <Text style={styles.barraNombre} numberOfLines={1}>{b.label}</Text>
                    {b.rango ? <Text style={styles.barraRango} numberOfLines={1}>{b.rango}</Text> : null}
                  </View>
                  <Text style={[styles.barraImporte, estiloCifras]}>{formatEur(b.suma)}</Text>
                </View>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, ratio * 100))}%` }]} />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );

  if (modo === 'movil') {
    return (
      <View style={styles.superficie}>
        <TouchableOpacity
          style={styles.cabecera}
          onPress={() => setAbierto((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: abierto }}
          accessibilityLabel="Cómo leerlo"
        >
          <Text style={styles.cabeceraTexto}>Cómo leerlo</Text>
          <MaterialIcons name={abierto ? 'expand-less' : 'expand-more'} size={20} color={colores.textoSecundario} />
        </TouchableOpacity>
        {abierto ? <View style={styles.cuerpoMovil}>{cuerpo}</View> : null}
      </View>
    );
  }

  return (
    <View style={[styles.superficie, styles.cuerpo, modo === 'escritorio' ? styles.lado : styles.ancho]}>
      {cuerpo}
    </View>
  );
}

const styles = StyleSheet.create({
  superficie: {
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
  },
  lado: { width: 260, flexShrink: 0 },
  ancho: { width: '100%' },
  cuerpo: { padding: 16 },
  cuerpoMovil: { paddingHorizontal: 16, paddingBottom: 16 },
  col: { gap: 14 },
  dosCols: { flexDirection: 'row', gap: 20, alignItems: 'flex-start' },
  textoCol: { gap: 10, minWidth: 0 },
  barrasCol: { gap: 10, minWidth: 0 },
  flex: { flex: 1 },
  titulo: { fontSize: 13, fontWeight: peso.semibold, color: colores.texto },
  frase: { fontSize: 13, lineHeight: 18, color: colores.textoSecundario },
  separador: { height: 1, backgroundColor: colores.separador },
  barrasTitulo: { fontSize: 13, fontWeight: peso.semibold, color: colores.texto },
  barra: { gap: 4 },
  barraCab: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  barraNombreCol: { flex: 1, minWidth: 0 },
  barraNombre: { fontSize: 13, fontWeight: peso.medio, color: colores.texto },
  barraRango: { fontSize: 11, color: colores.textoTerciario, marginTop: 1 },
  barraImporte: { fontSize: 13, fontWeight: peso.semibold, color: colores.texto },
  track: {
    height: 4,
    borderRadius: radios.pastilla,
    backgroundColor: colores.separador,
    overflow: 'hidden',
  },
  fill: { height: 4, borderRadius: radios.pastilla, backgroundColor: colores.acento },
  cabecera: {
    minHeight: 48,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cabeceraTexto: { fontSize: 14, fontWeight: peso.semibold, color: colores.texto },
});
