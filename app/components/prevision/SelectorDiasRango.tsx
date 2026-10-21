import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { InputFecha } from '../InputFecha';
import { MenuAnclado, useAnclaMenu } from './menuAnclado';
import { colores, estiloCifras, estiloEtiqueta, familia, peso, radios } from './tokens';
import {
  MAX_DIAS_PREVISION,
  diaSemanaIso,
  diasEntreIso,
  etiquetaDiaCorta,
  fechaEs,
} from '../../lib/previsionFranjasApi';

type Props = {
  desdeIso: string;
  hastaIso: string;
  onChangeDesde: (iso: string) => void;
  onChangeHasta: (iso: string) => void;
  excluidos: string[];
  onChangeExcluidos: (dias: string[]) => void;
  disabled?: boolean;
  /** campo: disparador + panel. embebido: fechas visibles en la hoja móvil. */
  variante: 'campo' | 'embebido';
  alto: number;
};

type Atajo = { id: string; label: string; incluye: (dow: number) => boolean };

const ATAJOS: Atajo[] = [
  { id: 'todos', label: 'Todos', incluye: () => true },
  { id: 'lj', label: 'L–J', incluye: (d) => d >= 1 && d <= 4 },
  { id: 'vs', label: 'V–S', incluye: (d) => d === 5 || d === 6 },
  { id: 'finde', label: 'V–D', incluye: (d) => d === 5 || d === 6 || d === 0 },
  { id: 'ninguno', label: 'Ninguno', incluye: () => false },
];

function estiloFecha(alto: number) {
  return {
    width: '100%' as const,
    height: alto,
    minHeight: alto,
    fontFamily: familia.regular, fontSize: 14,
    borderRadius: radios.control,
    borderWidth: 1,
    borderColor: colores.borde,
    backgroundColor: colores.superficie,
  };
}

export function SelectorDiasRango({
  desdeIso,
  hastaIso,
  onChangeDesde,
  onChangeHasta,
  excluidos,
  onChangeExcluidos,
  disabled,
  variante,
  alto,
}: Props) {
  const { ref, abierto, ancla, toggle, cerrar } = useAnclaMenu();
  const [diasAbiertos, setDiasAbiertos] = useState(false);
  const dias = useMemo(() => diasEntreIso(desdeIso, hastaIso), [desdeIso, hastaIso]);
  const excluidosSet = useMemo(() => new Set(excluidos), [excluidos]);
  const excedeMax = dias.length > MAX_DIAS_PREVISION;
  const nIncluidos = dias.filter((d) => !excluidosSet.has(d)).length;
  const tactil = alto >= 44;

  const toggleDia = (dia: string) => {
    if (excluidosSet.has(dia)) onChangeExcluidos(excluidos.filter((d) => d !== dia));
    else onChangeExcluidos([...excluidos, dia]);
  };

  const aplicarAtajo = (atajo: Atajo) => {
    onChangeExcluidos(dias.filter((d) => !atajo.incluye(diaSemanaIso(d))));
  };

  const atajoActivo = ATAJOS.find(
    (a) => dias.length > 0 && dias.every((d) => a.incluye(diaSemanaIso(d)) === !excluidosSet.has(d)),
  )?.id;

  const resumenRango =
    dias.length === 0 ? 'Elige un periodo' : `${fechaEs(desdeIso)} – ${fechaEs(hastaIso)}`;
  const resumenDias =
    dias.length === 0 ? 'Rango no válido' : `${nIncluidos} de ${dias.length} días`;

  const editorDias = dias.length > 0 && !excedeMax ? (
    <View style={styles.dias}>
      <View style={styles.atajos}>
        {ATAJOS.map((a) => {
          const activo = atajoActivo === a.id;
          return (
            <TouchableOpacity
              key={a.id}
              style={[styles.atajo, tactil && styles.tactil, activo && styles.atajoOn]}
              onPress={() => aplicarAtajo(a)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: activo }}
            >
              <Text style={[styles.atajoTexto, activo && styles.atajoTextoOn]}>{a.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={styles.chips}>
        {dias.map((d) => {
          const incluido = !excluidosSet.has(d);
          return (
            <TouchableOpacity
              key={d}
              style={[
                styles.chip,
                tactil && styles.tactil,
                incluido ? styles.chipOn : styles.chipOff,
              ]}
              onPress={() => toggleDia(d)}
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: incluido }}
              accessibilityLabel={`${etiquetaDiaCorta(d)} ${incluido ? 'incluido' : 'excluido'}`}
            >
              <Text style={[styles.chipTexto, incluido ? styles.chipTextoOn : styles.chipTextoOff]}>
                {etiquetaDiaCorta(d)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  ) : null;

  const fechas = (
    <View style={styles.fechas}>
      <View style={styles.fechaCelda}>
        <InputFecha
          compact
          editable={!disabled}
          valueIso={desdeIso}
          onChangeIso={onChangeDesde}
          placeholder="Desde"
          style={estiloFecha(variante === 'embebido' ? alto : 40)}
          accessibilityLabel="Fecha desde"
        />
      </View>
      <View style={styles.fechaCelda}>
        <InputFecha
          compact
          editable={!disabled}
          valueIso={hastaIso}
          onChangeIso={onChangeHasta}
          placeholder="Hasta"
          style={estiloFecha(variante === 'embebido' ? alto : 40)}
          accessibilityLabel="Fecha hasta"
        />
      </View>
    </View>
  );

  const cuerpo = (
    <ScrollView
      style={variante === 'campo' ? styles.panelScroll : undefined}
      contentContainerStyle={styles.panel}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
    >
      {variante === 'campo' ? fechas : null}
      {excedeMax ? (
        <Text style={styles.error}>El rango no puede superar {MAX_DIAS_PREVISION} días.</Text>
      ) : (
        <Text style={styles.resumenDias}>{resumenDias}</Text>
      )}
      {editorDias}
    </ScrollView>
  );

  if (variante === 'embebido') {
    return (
      <View style={styles.embebido}>
        <Text style={estiloEtiqueta}>Periodo</Text>
        {fechas}
        {excedeMax ? <Text style={styles.error}>El rango no puede superar {MAX_DIAS_PREVISION} días.</Text> : null}
        {dias.length > 0 && !excedeMax ? (
          <View>
            <TouchableOpacity
              style={styles.disclosure}
              onPress={() => setDiasAbiertos((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: diasAbiertos }}
            >
              <Text style={styles.disclosureTexto}>{resumenDias}</Text>
              <MaterialIcons
                name={diasAbiertos ? 'expand-less' : 'expand-more'}
                size={18}
                color={colores.textoSecundario}
              />
            </TouchableOpacity>
            {diasAbiertos ? editorDias : null}
          </View>
        ) : null}
      </View>
    );
  }

  const extra = nIncluidos < dias.length && dias.length > 0 ? ` · ${nIncluidos} días` : '';

  return (
    <View>
      <Text style={[estiloEtiqueta, styles.etiquetaCampo]}>Periodo</Text>
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
          accessibilityLabel={`Periodo ${resumenRango}. ${resumenDias}`}
          accessibilityState={{ expanded: abierto }}
        >
          <MaterialIcons name="calendar-today" size={16} color={colores.textoSecundario} />
          <Text style={[styles.triggerTexto, estiloCifras]} numberOfLines={1}>
            {resumenRango}
            {extra}
          </Text>
        </TouchableOpacity>
      </View>
      <MenuAnclado visible={abierto} ancla={ancla} onClose={cerrar} ancho={360}>
        {cuerpo}
      </MenuAnclado>
    </View>
  );
}

const styles = StyleSheet.create({
  etiquetaCampo: { marginBottom: 6 },
  trigger: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.control,
    backgroundColor: colores.superficie,
  },
  triggerAbierto: { borderColor: colores.acento },
  triggerOff: { opacity: 0.5 },
  triggerTexto: { flex: 1, fontSize: 13, fontFamily: familia.medio, fontWeight: peso.medio, color: colores.texto },
  embebido: { gap: 6 },
  fechas: { flexDirection: 'row', gap: 8 },
  fechaCelda: { flex: 1, minWidth: 0 },
  panelScroll: { maxHeight: 420 },
  panel: { padding: 12, gap: 10 },
  resumenDias: { fontSize: 12, color: colores.textoSecundario, fontFamily: familia.medio, fontWeight: peso.medio },
  error: { fontSize: 12, color: colores.negativa, fontFamily: familia.medio, fontWeight: peso.medio },
  dias: { gap: 8 },
  atajos: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  atajo: {
    paddingHorizontal: 10,
    borderRadius: radios.control,
    borderWidth: 1,
    borderColor: colores.borde,
    justifyContent: 'center',
    minHeight: 32,
  },
  atajoOn: { backgroundColor: colores.acento, borderColor: colores.acento },
  atajoTexto: { fontSize: 12, fontFamily: familia.medio, fontWeight: peso.medio, color: colores.textoSecundario },
  atajoTextoOn: { color: colores.textoSobreAcento, fontFamily: familia.semibold, fontWeight: peso.semibold },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 10,
    borderRadius: radios.control,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 32,
  },
  chipOn: { backgroundColor: colores.filaMarcada, borderColor: colores.bordeCalorClaro },
  chipOff: { backgroundColor: colores.superficie, borderColor: colores.borde },
  chipTexto: { fontSize: 12, fontFamily: familia.semibold, fontWeight: peso.semibold },
  chipTextoOn: { color: colores.enlace },
  chipTextoOff: { color: colores.textoTerciario, textDecorationLine: 'line-through', fontFamily: familia.medio, fontWeight: peso.medio },
  tactil: { minHeight: 44, paddingHorizontal: 12 },
  disclosure: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  disclosureTexto: { fontSize: 13, fontFamily: familia.medio, fontWeight: peso.medio, color: colores.texto },
});
