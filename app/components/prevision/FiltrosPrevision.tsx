import { Text, TextInput, View, StyleSheet, Platform } from 'react-native';
import { SelectorDesplegable } from '../SelectorDesplegable';
import { BotonPrevision } from './BotonPrevision';
import { SelectorDiasRango } from './SelectorDiasRango';
import { SelectorLocalesPrevision, type OpcionLocalPrevision } from './SelectorLocalesPrevision';
import { colores, estiloCifras, estiloEtiqueta, peso, radios, type ModoPrevision } from './tokens';

type AccionVacio = { texto: string; onPress: () => void };

type Props = {
  modo: Extract<ModoPrevision, 'escritorio' | 'tablet'>;
  alto: number;
  fechaDesde: string;
  fechaHasta: string;
  onChangeDesde: (iso: string) => void;
  onChangeHasta: (iso: string) => void;
  excluidos: string[];
  onChangeExcluidos: (dias: string[]) => void;
  locales: OpcionLocalPrevision[];
  workplaceIds: string[];
  onChangeLocales: (ids: string[]) => void;
  cargandoLocales: boolean;
  plantillas: OpcionLocalPrevision[];
  plantillaId: string;
  onChangePlantilla: (id: string) => void;
  cargandoPlantillas: boolean;
  vacioPlantillas?: AccionVacio;
  objetivoTxt: string;
  onChangeObjetivo: (v: string) => void;
  onCalcular: () => void;
  calculando: boolean;
  errorMaestros: string | null;
};

export function BarraFiltrosPrevision(props: Props) {
  const escritorio = props.modo === 'escritorio';
  return (
    <View style={[styles.barra, escritorio ? styles.barraFila : styles.barraRejilla]}>
      {escritorio ? <FilaEscritorio {...props} /> : <RejillaTablet {...props} />}
      {props.errorMaestros ? <Text style={styles.error}>{props.errorMaestros}</Text> : null}
    </View>
  );
}

function FilaEscritorio(props: Props) {
  return (
    <View style={styles.fila}>
      <View style={styles.wPeriodo}>
        <Periodo {...props} />
      </View>
      <View style={styles.wLocales}>
        <Text style={styles.etiqueta}>Locales</Text>
        <Locales {...props} />
      </View>
      <View style={styles.wPlantilla}>
        <Plantilla {...props} />
      </View>
      <View style={styles.wCoste}>
        <Coste {...props} />
      </View>
      <BotonPrevision
        titulo={props.calculando ? 'Calculando…' : 'Calcular'}
        variante="primario"
        alto={props.alto}
        onPress={props.onCalcular}
        cargando={props.calculando}
      />
    </View>
  );
}

function RejillaTablet(props: Props) {
  return (
    <View style={styles.rejilla}>
      <View style={styles.linea}>
        <View style={styles.flex3}>
          <Periodo {...props} />
        </View>
        <View style={styles.flex3}>
          <Text style={styles.etiqueta}>Locales</Text>
          <Locales {...props} />
        </View>
      </View>
      <View style={styles.linea}>
        <View style={styles.flex2}>
          <Plantilla {...props} />
        </View>
        <View style={styles.flex2}>
          <Coste {...props} />
        </View>
        <View style={styles.flex2}>
          <BotonPrevision
            titulo={props.calculando ? 'Calculando…' : 'Calcular'}
            variante="primario"
            alto={props.alto}
            onPress={props.onCalcular}
            cargando={props.calculando}
            style={styles.botonAncho}
          />
        </View>
      </View>
    </View>
  );
}

function Periodo(props: Props) {
  return (
    <SelectorDiasRango
      desdeIso={props.fechaDesde}
      hastaIso={props.fechaHasta}
      onChangeDesde={props.onChangeDesde}
      onChangeHasta={props.onChangeHasta}
      excluidos={props.excluidos}
      onChangeExcluidos={props.onChangeExcluidos}
      disabled={props.calculando}
      variante="campo"
      alto={props.alto}
    />
  );
}

function Locales(props: Props) {
  return (
    <SelectorLocalesPrevision
      opciones={props.locales}
      valorIds={props.workplaceIds}
      onChange={props.onChangeLocales}
      loading={props.cargandoLocales}
      disabled={props.calculando}
      variante="flotante"
      alto={props.alto}
    />
  );
}

export function CampoPlantilla({
  alto,
  plantillas,
  plantillaId,
  onChangePlantilla,
  cargandoPlantillas,
  vacioPlantillas,
  disabled,
}: {
  alto: number;
  plantillas: OpcionLocalPrevision[];
  plantillaId: string;
  onChangePlantilla: (id: string) => void;
  cargandoPlantillas: boolean;
  vacioPlantillas?: AccionVacio;
  disabled?: boolean;
}) {
  return (
    <View style={styles.campo}>
      <Text style={styles.etiqueta}>Plantilla</Text>
      <SelectorDesplegable
        placeholder="Elige plantilla…"
        compact
        sinIconoTrigger
        opciones={plantillas}
        valorId={plantillaId}
        onSeleccionar={onChangePlantilla}
        tituloLista="Plantillas de franjas"
        loading={cargandoPlantillas}
        disabled={disabled}
        vacioTexto="No hay plantillas de franjas."
        vacioAccion={vacioPlantillas}
        triggerStyle={[styles.trigger, { minHeight: alto, height: alto, width: '100%' }]}
        triggerTextStyle={styles.triggerTexto}
      />
    </View>
  );
}

function Plantilla(props: Props) {
  return (
    <CampoPlantilla
      alto={props.alto}
      plantillas={props.plantillas}
      plantillaId={props.plantillaId}
      onChangePlantilla={props.onChangePlantilla}
      cargandoPlantillas={props.cargandoPlantillas}
      vacioPlantillas={props.vacioPlantillas}
      disabled={props.calculando}
    />
  );
}

export function CampoCoste({
  alto,
  objetivoTxt,
  onChangeObjetivo,
  disabled,
}: {
  alto: number;
  objetivoTxt: string;
  onChangeObjetivo: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.campo}>
      <Text style={styles.etiqueta}>Coste hora</Text>
      <TextInput
        style={[styles.input, estiloCifras, { height: alto, minHeight: alto }]}
        value={objetivoTxt}
        onChangeText={onChangeObjetivo}
        keyboardType="decimal-pad"
        placeholder="120"
        placeholderTextColor={colores.textoTerciario}
        editable={!disabled}
        accessibilityLabel="Coste hora"
      />
    </View>
  );
}

function Coste(props: Props) {
  return (
    <CampoCoste
      alto={props.alto}
      objetivoTxt={props.objetivoTxt}
      onChangeObjetivo={props.onChangeObjetivo}
      disabled={props.calculando}
    />
  );
}

const styles = StyleSheet.create({
  barra: {
    position: 'relative',
    zIndex: 20,
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.superficie,
    padding: 12,
    gap: 8,
  },
  barraFila: {},
  barraRejilla: {},
  fila: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  rejilla: { gap: 10 },
  linea: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  wPeriodo: { width: 236, flexShrink: 1, minWidth: 160 },
  wLocales: { width: 168, flexShrink: 1, minWidth: 120 },
  wPlantilla: { width: 140, flexShrink: 1, minWidth: 110 },
  wCoste: { width: 92, flexShrink: 0 },
  flex3: { flex: 3, minWidth: 0 },
  flex2: { flex: 2, minWidth: 0 },
  campo: { minWidth: 0 },
  etiqueta: { ...estiloEtiqueta, marginBottom: 6 },
  trigger: {
    backgroundColor: colores.superficie,
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.control,
    paddingHorizontal: 10,
  },
  triggerTexto: {
    fontSize: 13,
    fontWeight: peso.medio,
    color: colores.texto,
  },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: colores.borde,
    borderRadius: radios.control,
    backgroundColor: colores.superficie,
    paddingHorizontal: 10,
    fontSize: 13,
    fontWeight: peso.medio,
    color: colores.texto,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  botonAncho: { width: '100%' },
  error: { fontSize: 13, color: colores.negativa },
});
