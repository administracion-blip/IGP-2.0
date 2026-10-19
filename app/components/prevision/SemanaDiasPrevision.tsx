import { useEffect, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import {
  TEXTO_MOTIVO,
  etiquetaDiaCorta,
  formatEur,
  maxCeldaLocal,
  type DiaPrevision,
  type FranjaPrevision,
  type LocalPrevision,
} from '../../lib/previsionFranjasApi';
import { LeyendaEscala, PastillaDesvio, PastillaFestivo } from './PiezasPrevision';
import {
  colores,
  estiloCalor,
  estiloCifras,
  etiquetaBloqueSemana,
  eurosA11y,
  fechaCompCorta,
  fechaLargaA11y,
  nombreFranjaVisible,
  rangoFranja,
  peso,
  radios,
} from './tokens';

type Props = {
  local: LocalPrevision;
  franjas: FranjaPrevision[];
  hoyJornada?: string;
};

function filasDe<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2));
  return out;
}

function bloquesDe(dias: DiaPrevision[]): DiaPrevision[][] {
  const out: DiaPrevision[][] = [];
  for (let i = 0; i < dias.length; i += 7) out.push(dias.slice(i, i + 7));
  return out;
}

export function SemanaDiasPrevision({ local, franjas, hoyJornada }: Props) {
  const bloques = useMemo(() => bloquesDe(local.dias), [local.dias]);
  const [indice, setIndice] = useState(0);
  const max = useMemo(() => maxCeldaLocal(local), [local]);

  useEffect(() => {
    setIndice(0);
  }, [local.workplaceId, local.dias.length, local.dias[0]?.fecha, local.dias[local.dias.length - 1]?.fecha]);

  if (bloques.length === 0) {
    return <Text style={styles.vacio}>No hay días seleccionados en el periodo.</Text>;
  }

  const i = Math.min(indice, bloques.length - 1);
  const semana = bloques[i];
  const suma = semana.reduce((acc, d) => acc + (Number(d.totalPrevisto) || 0), 0);
  const primero = semana[0].fecha;
  const ultimo = semana[semana.length - 1].fecha;

  return (
    <View style={styles.wrap}>
      <View style={styles.selector}>
        <TouchableOpacity
          style={[styles.flecha, i === 0 && styles.flechaOff]}
          onPress={() => setIndice((n) => Math.max(0, n - 1))}
          disabled={i === 0}
          accessibilityRole="button"
          accessibilityLabel="Semana anterior"
          accessibilityState={{ disabled: i === 0 }}
        >
          <MaterialIcons name="chevron-left" size={22} color={colores.texto} />
        </TouchableOpacity>
        <View style={styles.centro}>
          <Text style={styles.rango}>{etiquetaBloqueSemana(primero, ultimo)}</Text>
          <Text style={[styles.meta, estiloCifras]}>
            {`Semana ${i + 1} de ${bloques.length} · ${formatEur(suma)}`}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.flecha, i >= bloques.length - 1 && styles.flechaOff]}
          onPress={() => setIndice((n) => Math.min(bloques.length - 1, n + 1))}
          disabled={i >= bloques.length - 1}
          accessibilityRole="button"
          accessibilityLabel="Semana siguiente"
          accessibilityState={{ disabled: i >= bloques.length - 1 }}
        >
          <MaterialIcons name="chevron-right" size={22} color={colores.texto} />
        </TouchableOpacity>
      </View>
      <View style={styles.leyenda}>
        <LeyendaEscala variante="mini" />
      </View>

      {semana.map((d) => (
        <TarjetaDia key={d.fecha} dia={d} franjas={franjas} max={max} hoy={d.fecha === hoyJornada} />
      ))}
    </View>
  );
}

function TarjetaDia({
  dia,
  franjas,
  max,
  hoy,
}: {
  dia: DiaPrevision;
  franjas: FranjaPrevision[];
  max: number;
  hoy: boolean;
}) {
  const festivo = dia.festivo?.nombre?.trim();
  const tonoTotal = estiloCalor(dia.totalPrevisto, max);
  return (
    <View style={styles.tarjeta}>
      <View style={styles.tarjetaCab}>
        <View style={styles.tarjetaIzq}>
          <View style={styles.fechaFila}>
            <Text style={styles.fecha}>{etiquetaDiaCorta(dia.fecha)}</Text>
            {festivo ? <PastillaFestivo nombre={festivo} /> : null}
          </View>
          <Text style={styles.comp} numberOfLines={1}>
            {`comp. ${fechaCompCorta(dia.fechaComparativa)}`}
          </Text>
        </View>
        {dia.valida ? (
          <View
            accessible
            accessibilityLabel={`${fechaLargaA11y(dia.fecha)}${hoy ? ', hoy' : ''}, Total, ${eurosA11y(dia.totalPrevisto)}`}
            style={[
              styles.total,
              {
                backgroundColor: tonoTotal.fondo,
                borderWidth: tonoTotal.borde ? 1 : 0,
                borderColor: tonoTotal.borde ?? 'transparent',
              },
            ]}
          >
            <View style={styles.totalCab}>
              <Text style={[styles.totalEtiqueta, { color: tonoTotal.texto }]}>Total</Text>
              {dia.pasado && dia.desvioPct != null ? <PastillaDesvio ratio={dia.desvioPct} /> : null}
            </View>
            <Text style={[styles.totalImporte, estiloCifras, { color: tonoTotal.texto }]} numberOfLines={1}>
              {formatEur(dia.totalPrevisto)}
            </Text>
          </View>
        ) : null}
      </View>

      {dia.valida ? (
        <View style={styles.grid}>
          {filasDe(franjas).map((fila, fi) => (
            <View key={fi} style={styles.gridFila}>
              {fila.map((f, col) => {
                const idx = fi * 2 + col;
                const c = dia.celdas[idx];
                const nombre = nombreFranjaVisible(f);
                const rango = rangoFranja(f);
                if (!c) return <View key={idx} style={styles.celdaHueca} />;
                const tono = estiloCalor(c.previsto, max);
                return (
                  <View
                    key={`${f.desde}-${idx}`}
                    accessible
                    accessibilityLabel={`${fechaLargaA11y(dia.fecha)}${hoy ? ', hoy' : ''}, ${nombre}, ${eurosA11y(c.previsto)}, ${c.personal} ${c.personal === 1 ? 'persona' : 'personas'}`}
                    style={[
                      styles.celda,
                      {
                        backgroundColor: tono.fondo,
                        borderWidth: tono.borde ? 1 : 0,
                        borderColor: tono.borde ?? 'transparent',
                      },
                    ]}
                  >
                    {dia.pasado && c.desvioPct != null ? (
                      <View style={styles.pillCelda}>
                        <PastillaDesvio ratio={c.desvioPct} />
                      </View>
                    ) : null}
                    <Text style={[styles.franjaNombre, { color: tono.texto }]} numberOfLines={1}>
                      {nombre}
                    </Text>
                    {rango ? (
                      <Text style={[styles.franjaRango, { color: tono.texto }]} numberOfLines={1}>
                        {rango}
                      </Text>
                    ) : null}
                    <Text style={[styles.celdaImporte, estiloCifras, { color: tono.texto }]} numberOfLines={1}>
                      {formatEur(c.previsto)}
                    </Text>
                    <Text style={[styles.pers, { color: tono.texto }]}>{`${c.personal} pers.`}</Text>
                  </View>
                );
              })}
              {fila.length === 1 ? <View style={styles.celdaHueca} /> : null}
            </View>
          ))}
        </View>
      ) : (
        <View
          style={styles.noValida}
          accessible
          accessibilityLabel={`${fechaLargaA11y(dia.fecha)}, ${dia.motivo ? TEXTO_MOTIVO[dia.motivo] : 'Sin previsión'}`}
        >
          <Text style={styles.noValidaTexto}>
            {dia.motivo ? TEXTO_MOTIVO[dia.motivo] : 'Sin previsión'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  selector: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  flecha: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radios.control,
  },
  flechaOff: { opacity: 0.4 },
  centro: { flex: 1, alignItems: 'center', gap: 2 },
  rango: { fontSize: 15, fontWeight: peso.semibold, color: colores.texto },
  meta: { fontSize: 12, color: colores.textoSecundario },
  leyenda: { alignItems: 'flex-end' },
  tarjeta: {
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    padding: 12,
    gap: 10,
  },
  tarjetaCab: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tarjetaIzq: { flex: 1, minWidth: 0, gap: 2 },
  fechaFila: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  fecha: { fontSize: 15, fontWeight: peso.semibold, color: colores.texto },
  comp: { fontSize: 11, color: colores.textoTerciario },
  total: {
    minWidth: 118,
    borderRadius: radios.control,
    paddingVertical: 8,
    paddingHorizontal: 10,
    position: 'relative',
  },
  totalCab: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  totalEtiqueta: { fontSize: 11, opacity: 0.85 },
  totalImporte: { fontSize: 16, fontWeight: peso.negrita, marginTop: 2 },
  grid: { gap: 6 },
  gridFila: { flexDirection: 'row', gap: 6 },
  celda: {
    flex: 1,
    borderRadius: radios.control,
    paddingVertical: 10,
    paddingHorizontal: 10,
    minHeight: 72,
    position: 'relative',
    gap: 2,
  },
  celdaHueca: {
    flex: 1,
    borderRadius: radios.control,
    backgroundColor: colores.lienzo,
    minHeight: 72,
  },
  pillCelda: { position: 'absolute', top: 6, right: 6 },
  franjaNombre: { fontSize: 11, opacity: 0.75, paddingRight: 48 },
  franjaRango: { fontSize: 11, opacity: 0.6 },
  celdaImporte: { fontSize: 16, fontWeight: peso.negrita },
  pers: { fontSize: 11, opacity: 0.8 },
  noValida: {
    borderRadius: radios.control,
    backgroundColor: colores.lienzo,
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  noValidaTexto: { fontSize: 11, color: colores.textoSecundario },
  vacio: { fontSize: 13, color: colores.textoSecundario },
});
