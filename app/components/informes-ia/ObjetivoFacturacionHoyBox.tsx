import { View, Text, StyleSheet } from 'react-native';
import { formatMoneda } from '../../utils/formatMoneda';
import type { ObjetivoFacturacionHoy } from './VistaDiaADia';

type Props = {
  data: ObjetivoFacturacionHoy | null | undefined;
};

/** Hay datos útiles para mostrar el recuadro (total > 0 o locales con objetivo). */
export function tieneObjetivoFacturacionHoyUtil(
  data: ObjetivoFacturacionHoy | null | undefined,
): boolean {
  if (!data) return false;
  const total = Number(data.total?.objetivo) || 0;
  const locales = (data.locales || []).filter((l) => (Number(l.objetivo) || 0) > 0);
  return total > 0 || locales.length > 0;
}

/**
 * Recuadro estructurado «Qué tenemos que facturar hoy» (pantalla + captura PDF).
 * Fondo un poco más oscuro que el resumen IA (`#fef9c3`).
 * Sin `data-pdf-section` propio: va dentro de `resumen-ia` para no duplicarse en el PDF.
 */
export function ObjetivoFacturacionHoyBox({ data }: Props) {
  if (!tieneObjetivoFacturacionHoyUtil(data) || !data) return null;

  const total = Number(data.total?.objetivo) || 0;
  const locales = (data.locales || []).filter((l) => (Number(l.objetivo) || 0) > 0);
  const fechaTxt = data.fechaLabel || data.fecha || '—';

  return (
    <View style={styles.box}>
      <Text style={styles.titulo}>Qué tenemos que facturar hoy</Text>

      <Text style={styles.kpi}>
        {fechaTxt}
        {' · '}
        Objetivo grupo:{' '}
        <Text style={styles.importe}>{formatMoneda(total)}</Text>
      </Text>

      {locales.length > 0 ? (
        <View style={styles.lista}>
          <Text style={styles.listaTitulo}>Objetivos para hoy</Text>
          {locales.map((l) => (
            <Text key={String(l.localId || l.nombre)} style={styles.localTexto}>
              {l.nombre || 'Local'}:{' '}
              <Text style={styles.importe}>{formatMoneda(Number(l.objetivo) || 0)}</Text>
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    marginTop: 10,
    backgroundColor: '#fef08a',
    borderWidth: 1,
    borderColor: '#facc15',
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  titulo: {
    fontSize: 14,
    fontWeight: '800',
    color: '#713f12',
    marginBottom: 2,
  },
  kpi: {
    fontSize: 13,
    color: '#78350f',
    fontWeight: '500',
  },
  lista: {
    marginTop: 4,
    gap: 4,
  },
  listaTitulo: {
    fontSize: 12,
    fontWeight: '800',
    color: '#854d0e',
    marginBottom: 2,
  },
  localTexto: {
    fontSize: 13,
    color: '#78350f',
  },
  importe: {
    fontWeight: '700',
    color: '#713f12',
  },
});
