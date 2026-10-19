import { Text, View, StyleSheet } from 'react-native';
import {
  etiquetaDiaCorta,
  formatEur,
  type KpisPrevision as Kpis,
} from '../../lib/previsionFranjasApi';
import {
  colorDesvio,
  colores,
  diaMesCorto,
  estiloCifras,
  formatDesvio,
  nombreFranjaKpi,
  peso,
  radios,
  tamanoCifra,
  trackingCifra,
  type ModoPrevision,
} from './tokens';

type Props = {
  kpis: Kpis;
  modo: ModoPrevision;
};

type Metrica = {
  id: string;
  etiqueta: string;
  cifra: string;
  detalle?: string;
};

export function KpisPrevision({ kpis, modo }: Props) {
  const tam = tamanoCifra(modo);
  const franja = kpis.franjaMasFuerte;
  const dia = kpis.diaMasFuerte;
  const pico = kpis.picoPersonal;

  const metricas: Metrica[] = [
    {
      id: 'venta',
      etiqueta: 'Venta prevista',
      cifra: formatEur(kpis.ventaPrevista),
    },
    {
      id: 'franja',
      etiqueta: 'Franja más fuerte',
      cifra: franja ? nombreFranjaKpi(franja.label) : '—',
      detalle: franja ? formatEur(franja.importe) : undefined,
    },
    {
      id: 'dia',
      etiqueta: modo === 'movil' && dia ? `Día más fuerte · ${diaMesCorto(dia.fecha)}` : 'Día más fuerte',
      cifra: modo === 'movil'
        ? (dia ? formatEur(dia.importe) : '—')
        : (dia ? etiquetaDiaCorta(dia.fecha) : '—'),
      detalle: modo === 'movil' ? undefined : (dia ? formatEur(dia.importe) : undefined),
    },
    {
      id: 'personal',
      etiqueta: 'Pico de personal',
      cifra: pico ? String(pico.personas) : '—',
      detalle: pico ? `${etiquetaDiaCorta(pico.fecha)} · ${nombreFranjaKpi(pico.label)}` : undefined,
    },
  ];

  const filas: Metrica[][] = modo === 'escritorio'
    ? [metricas]
    : [metricas.slice(0, 2), metricas.slice(2, 4)];
  const desvio = formatDesvio(kpis.desvioPct);
  const importeReal = kpis.ventaRealPasados == null ? '—' : formatEur(kpis.ventaRealPasados);
  const colorReal = kpis.desvioPct != null ? colorDesvio(kpis.desvioPct) : colores.textoSecundario;

  return (
    <View style={styles.superficie}>
      {filas.map((fila, fi) => (
        <View key={fi} style={[styles.fila, fi < filas.length - 1 && styles.bordeAbajo]}>
          {fila.map((m, i) => (
            <View key={m.id} style={[styles.metrica, i < fila.length - 1 && styles.bordeDer]}>
              <Text style={styles.etiqueta} numberOfLines={2}>{m.etiqueta}</Text>
              <Text
                style={[
                  styles.cifra,
                  estiloCifras,
                  { fontSize: tam, letterSpacing: trackingCifra(tam), lineHeight: Math.round(tam * 1.15) },
                ]}
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.55}
              >
                {m.cifra}
              </Text>
              {m.detalle ? (
                <Text style={[styles.detalle, estiloCifras]} numberOfLines={2}>{m.detalle}</Text>
              ) : null}
            </View>
          ))}
        </View>
      ))}
      <View style={styles.real}>
        {modo === 'movil' ? (
          <>
            <View style={styles.realIzq}>
              <Text style={styles.realTexto}>
                Real días pasados <Text style={[styles.realImporte, estiloCifras]}>{importeReal}</Text>
              </Text>
              <Text style={styles.aclaracion}>solo días ya cerrados</Text>
            </View>
            {desvio ? (
              <Text style={[styles.realDesvio, estiloCifras, { color: colorReal }]}>{desvio}</Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.realTexto}>
            Real días pasados <Text style={[styles.realImporte, estiloCifras]}>{importeReal}</Text>
            {desvio ? <Text style={[estiloCifras, { color: colorReal, fontWeight: peso.semibold }]}>{`  ${desvio}`}</Text> : null}
            <Text style={styles.aclaracion}>{'  solo días ya cerrados'}</Text>
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  superficie: {
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    overflow: 'hidden',
  },
  fila: { flexDirection: 'row' },
  metrica: { flex: 1, paddingHorizontal: 16, paddingVertical: 14, gap: 4, minWidth: 0 },
  bordeDer: { borderRightWidth: 1, borderRightColor: colores.borde },
  bordeAbajo: { borderBottomWidth: 1, borderBottomColor: colores.borde },
  etiqueta: { fontSize: 12, color: colores.textoSecundario, fontWeight: peso.medio },
  cifra: { fontWeight: peso.semibold, color: colores.texto },
  detalle: { fontSize: 13, color: colores.textoSecundario },
  real: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colores.separador,
  },
  realIzq: { flex: 1, minWidth: 0, gap: 2 },
  realTexto: { fontSize: 13, color: colores.texto },
  realImporte: { fontWeight: peso.semibold, color: colores.texto },
  realDesvio: { fontSize: 13, fontWeight: peso.semibold },
  aclaracion: { fontSize: 13, color: colores.textoTerciario },
});
