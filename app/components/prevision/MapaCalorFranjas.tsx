import { useMemo, useState } from 'react';
import { ScrollView, Text, View, StyleSheet } from 'react-native';
import {
  TEXTO_MOTIVO,
  etiquetaDiaCorta,
  formatEur,
  maxCeldaLocal,
  type DiaPrevision,
  type FranjaPrevision,
  type LocalPrevision,
} from '../../lib/previsionFranjasApi';
import { PastillaDesvio, PastillaFestivo } from './PiezasPrevision';
import {
  colores,
  estiloCalor,
  estiloCifras,
  eurosA11y,
  fechaCompCorta,
  fechaLargaA11y,
  formatDesvio,
  nombreFranjaVisible,
  rangoFranja,
  peso,
  radios,
  type ModoPrevision,
} from './tokens';

type Props = {
  local: LocalPrevision;
  franjas: FranjaPrevision[];
  hoyJornada?: string;
  modo: Extract<ModoPrevision, 'escritorio' | 'tablet'>;
};

function etiquetaCelda(
  fecha: string,
  franja: string,
  euros: number,
  personas: number | null,
  hoy: boolean,
  desvio: string | null,
): string {
  const pers =
    personas == null ? '' : `, ${personas} ${personas === 1 ? 'persona' : 'personas'}`;
  const extra = desvio ? `, desviación ${desvio}` : '';
  return `${fechaLargaA11y(fecha)}${hoy ? ', hoy' : ''}, ${franja}, ${eurosA11y(euros)}${pers}${extra}`;
}

export function MapaCalorFranjas({ local, franjas, hoyJornada, modo }: Props) {
  const max = useMemo(() => maxCeldaLocal(local), [local]);
  const [ancho, setAncho] = useState(0);
  const tablet = modo === 'tablet';
  const anchoDia = tablet ? 112 : 172;
  const minCelda = tablet ? 88 : 104;
  const minGrid = anchoDia + franjas.length * minCelda + Math.round(minCelda * 1.15) + 6 * (franjas.length + 1);
  const anchoGrid = Math.max(ancho, minGrid);
  const minAltura = tablet ? 64 : 62;
  const tamImporte = tablet ? 15 : 16;

  if (local.dias.length === 0) {
    return <Text style={styles.vacio}>No hay días seleccionados en el periodo.</Text>;
  }

  return (
    <View style={styles.superficie}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        onLayout={(e) => setAncho(e.nativeEvent.layout.width)}
        contentContainerStyle={styles.scroll}
      >
        <View style={{ width: anchoGrid || '100%', gap: 6 }}>
          <View style={styles.fila}>
            <View style={[styles.cabDia, { width: anchoDia }]}>
              <Text style={styles.cab}>Día</Text>
            </View>
            {franjas.map((f, i) => {
              const rango = rangoFranja(f);
              return (
                <View key={`${f.desde}-${i}`} style={styles.cabFranja}>
                  <Text style={styles.cab} numberOfLines={1}>
                    {nombreFranjaVisible(f)}
                  </Text>
                  {rango ? (
                    <Text style={styles.cabRango} numberOfLines={1}>{rango}</Text>
                  ) : null}
                </View>
              );
            })}
            <View style={styles.cabTotal}>
              <Text style={styles.cabTotalTexto} numberOfLines={1}>Total</Text>
            </View>
          </View>

          {local.dias.map((d) => (
            <View key={d.fecha} style={styles.fila}>
              <CeldaDia dia={d} ancho={anchoDia} tablet={tablet} />
              {d.valida ? (
                <>
                  {franjas.map((f, i) => {
                    const c = d.celdas[i];
                    if (!c) return <View key={i} style={[styles.vacia, { minHeight: minAltura }]} />;
                    return (
                      <CeldaDato
                        key={i}
                        previsto={c.previsto}
                        personal={c.personal}
                        desvioPct={d.pasado ? c.desvioPct : null}
                        max={max}
                        tablet={tablet}
                        minAltura={minAltura}
                        tamImporte={tamImporte}
                        accessibilityLabel={etiquetaCelda(
                          d.fecha,
                          nombreFranjaVisible(f),
                          c.previsto,
                          c.personal,
                          d.fecha === hoyJornada,
                          d.pasado ? formatDesvio(c.desvioPct) : null,
                        )}
                      />
                    );
                  })}
                  <CeldaDato
                    previsto={d.totalPrevisto}
                    personal={null}
                    desvioPct={d.pasado ? d.desvioPct : null}
                    max={max}
                    tablet={tablet}
                    minAltura={minAltura}
                    tamImporte={tamImporte}
                    total
                    accessibilityLabel={etiquetaCelda(
                      d.fecha,
                      'Total',
                      d.totalPrevisto,
                      null,
                      d.fecha === hoyJornada,
                      d.pasado ? formatDesvio(d.desvioPct) : null,
                    )}
                  />
                </>
              ) : (
                <View
                  style={[styles.noValida, { minHeight: minAltura }]}
                  accessible
                  accessibilityLabel={`${fechaLargaA11y(d.fecha)}, ${d.motivo ? TEXTO_MOTIVO[d.motivo] : 'Sin previsión'}`}
                >
                  <Text style={styles.noValidaTexto}>
                    {d.motivo ? TEXTO_MOTIVO[d.motivo] : 'Sin previsión'}
                  </Text>
                </View>
              )}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function CeldaDia({ dia, ancho, tablet }: { dia: DiaPrevision; ancho: number; tablet: boolean }) {
  const festivo = dia.festivo?.nombre?.trim();
  return (
    <View style={[styles.dia, { width: ancho }]} accessible accessibilityLabel={fechaLargaA11y(dia.fecha)}>
      <View style={[styles.diaCab, tablet && styles.diaCabTablet]}>
        <Text style={styles.diaFecha}>{etiquetaDiaCorta(dia.fecha)}</Text>
        {festivo && !tablet ? <PastillaFestivo nombre={festivo} /> : null}
      </View>
      {festivo && tablet ? <PastillaFestivo nombre={festivo} /> : null}
      <Text style={styles.comp} numberOfLines={1}>
        {`comp. ${fechaCompCorta(dia.fechaComparativa)}`}
      </Text>
    </View>
  );
}

function CeldaDato({
  previsto,
  personal,
  desvioPct,
  max,
  tablet,
  minAltura,
  tamImporte,
  total,
  accessibilityLabel,
}: {
  previsto: number;
  personal: number | null;
  desvioPct: number | null;
  max: number;
  tablet: boolean;
  minAltura: number;
  tamImporte: number;
  total?: boolean;
  accessibilityLabel: string;
}) {
  const tono = estiloCalor(previsto, max);
  const pill = desvioPct != null ? <PastillaDesvio ratio={desvioPct} /> : null;
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.dato,
        total ? styles.datoTotal : styles.datoFranja,
        {
          minHeight: minAltura,
          backgroundColor: tono.fondo,
          borderWidth: tono.borde ? 1 : 0,
          borderColor: tono.borde ?? 'transparent',
        },
      ]}
    >
      {!tablet && pill ? <View style={styles.pillEsquina}>{pill}</View> : null}
      <Text
        style={[
          styles.importe,
          estiloCifras,
          { color: tono.texto, fontSize: tamImporte, paddingRight: !tablet && pill ? 54 : 0 },
        ]}
        numberOfLines={1}
      >
        {formatEur(previsto)}
      </Text>
      {tablet ? (
        <View style={styles.persLinea}>
          {personal != null ? (
            <Text style={[styles.pers, { color: tono.texto }]} numberOfLines={1}>
              {`${personal} pers.`}
            </Text>
          ) : <View />}
          {pill}
        </View>
      ) : personal != null ? (
        <Text style={[styles.pers, { color: tono.texto }]} numberOfLines={1}>
          {`${personal} pers.`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  superficie: {
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    padding: 20,
  },
  scroll: { flexGrow: 1 },
  fila: { flexDirection: 'row', gap: 6, alignItems: 'stretch' },
  cabDia: { justifyContent: 'flex-end', paddingBottom: 4 },
  cabFranja: { flex: 1, minWidth: 0, justifyContent: 'flex-end', paddingBottom: 4, paddingHorizontal: 2 },
  cabTotal: { flex: 1.15, minWidth: 0, justifyContent: 'flex-end', paddingBottom: 4, paddingHorizontal: 2 },
  cab: { fontSize: 12, fontWeight: peso.medio, color: colores.textoSecundario },
  cabRango: { fontSize: 11, color: colores.textoTerciario, marginTop: 1 },
  cabTotalTexto: { fontSize: 12, fontWeight: peso.negrita, color: colores.texto },
  dia: { justifyContent: 'center', gap: 2, paddingRight: 4 },
  diaCab: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  diaCabTablet: { flexDirection: 'column', alignItems: 'flex-start' },
  diaFecha: { fontSize: 14, fontWeight: peso.semibold, color: colores.texto },
  comp: { fontSize: 11, color: colores.textoTerciario },
  dato: {
    borderRadius: radios.control,
    paddingVertical: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
    gap: 2,
    overflow: 'hidden',
  },
  datoFranja: { flex: 1, minWidth: 0 },
  datoTotal: { flex: 1.15, minWidth: 0 },
  importe: { fontWeight: peso.negrita },
  pers: { fontSize: 11, opacity: 0.8 },
  persLinea: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  pillEsquina: { position: 'absolute', top: 6, right: 6, zIndex: 1 },
  noValida: {
    flex: 1,
    borderRadius: radios.control,
    backgroundColor: colores.lienzo,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  noValidaTexto: { fontSize: 11, color: colores.textoSecundario },
  vacia: { flex: 1, borderRadius: radios.control, backgroundColor: colores.lienzo },
  vacio: { fontSize: 13, color: colores.textoSecundario, padding: 8 },
});
