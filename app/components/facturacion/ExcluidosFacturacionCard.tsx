/**
 * Lo que se queda fuera de una facturación mensual, agrupado por motivo.
 *
 * Lo comparten la facturación de mantenimiento y la de ventas internas de
 * compras, que reciben del backend la misma forma (`excluidos` con su motivo en
 * lenguaje claro) y tienen el mismo problema de presentación: el mismo motivo
 * repetido veinte veces no se lee.
 *
 * `tono` separa lo que hay que arreglar de lo que solo se informa. Enseñar las
 * dos cosas con el mismo peso es lo que hace que el usuario no vea lo que
 * importa: una sociedad sin CIF hay que corregirla, y una devolución no.
 */
import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { totalExcluidos, type GrupoExcluidos } from '../../lib/facturacionPeriodica';

type Props = {
  grupos: GrupoExcluidos[];
  titulo: string;
  /** Frase que explica qué hacer con esto. */
  intro: string;
  /** `aviso` (ámbar, requiere corrección) o `info` (gris, solo informativo). */
  tono?: 'aviso' | 'info';
  /** Arranca plegado: para el bloque informativo, que no pide ninguna acción. */
  plegadoInicial?: boolean;
  /**
   * Elementos que se enumeran por motivo. Con un motivo que afecta a cien
   * pedidos, la lista completa no aporta nada que el recuento no diga ya.
   */
  maxItems?: number;
};

export function ExcluidosFacturacionCard({
  grupos,
  titulo,
  intro,
  tono = 'aviso',
  plegadoInicial = false,
  maxItems = 25,
}: Props) {
  const [plegado, setPlegado] = useState(plegadoInicial);
  if (grupos.length === 0) return null;

  const esInfo = tono === 'info';
  const total = totalExcluidos(grupos);

  return (
    <View style={[styles.card, esInfo && styles.cardInfo]}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setPlegado((p) => !p)}
        activeOpacity={0.75}
        accessibilityLabel={plegado ? `Mostrar ${titulo}` : `Ocultar ${titulo}`}
      >
        <MaterialIcons
          name={esInfo ? 'info-outline' : 'report-problem'}
          size={18}
          color={esInfo ? '#64748b' : '#b45309'}
        />
        <Text style={[styles.titulo, esInfo && styles.textoInfo]}>
          {`${titulo} (${total})`}
        </Text>
        <MaterialIcons
          name={plegado ? 'expand-more' : 'expand-less'}
          size={20}
          color={esInfo ? '#94a3b8' : '#b45309'}
        />
      </TouchableOpacity>

      {plegado ? null : (
        <>
          <Text style={[styles.intro, esInfo && styles.introInfo]}>{intro}</Text>
          {grupos.map((grupo) => (
            <View key={grupo.motivo} style={[styles.grupo, esInfo && styles.grupoInfo]}>
              <Text style={[styles.motivo, esInfo && styles.textoInfo]}>
                {grupo.items.length > 1 ? `${grupo.texto} (${grupo.items.length})` : grupo.texto}
              </Text>
              {grupo.items.slice(0, maxItems).map((item, i) => (
                <View key={`${grupo.motivo}-${i}`} style={styles.item}>
                  <MaterialIcons
                    name="chevron-right"
                    size={14}
                    color={esInfo ? '#94a3b8' : '#a16207'}
                  />
                  <View style={styles.itemBody}>
                    <Text style={[styles.itemTexto, esInfo && styles.itemTextoInfo]}>
                      {item.etiqueta}
                      {item.recuento ? (
                        <Text style={[styles.itemRecuento, esInfo && styles.itemDetalleInfo]}>
                          {`  ·  ${item.recuento}`}
                        </Text>
                      ) : null}
                    </Text>
                    {item.detalle ? (
                      <Text style={[styles.itemDetalle, esInfo && styles.itemDetalleInfo]}>
                        {item.detalle}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
              {grupo.items.length > maxItems ? (
                <Text style={[styles.itemDetalle, esInfo && styles.itemDetalleInfo]}>
                  {`… y ${grupo.items.length - maxItems} más con el mismo motivo`}
                </Text>
              ) : null}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 12,
    backgroundColor: '#fffbeb',
    padding: 12,
    gap: 8,
  },
  cardInfo: { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: MIN_TOUCH },
  titulo: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700', color: '#92400e' },
  textoInfo: { color: '#475569' },
  intro: { fontSize: 11, color: '#a16207', lineHeight: 16 },
  introInfo: { color: '#94a3b8' },
  grupo: { gap: 3, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#fde68a' },
  grupoInfo: { borderTopColor: '#e2e8f0' },
  motivo: { fontSize: 12, fontWeight: '700', color: '#92400e', lineHeight: 16 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 2, paddingLeft: 4 },
  itemBody: { flex: 1, minWidth: 0, gap: 1 },
  itemTexto: { fontSize: 11, color: '#78350f', lineHeight: 16 },
  itemTextoInfo: { color: '#475569' },
  itemRecuento: { color: '#a16207', fontWeight: '600' },
  itemDetalle: { fontSize: 10, color: '#a16207', lineHeight: 14 },
  itemDetalleInfo: { color: '#94a3b8' },
});
