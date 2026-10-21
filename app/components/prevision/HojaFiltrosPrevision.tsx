import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View, StyleSheet, Platform } from 'react-native';
import { BotonPrevision } from './BotonPrevision';
import { CampoCoste, CampoPlantilla } from './FiltrosPrevision';
import { SelectorDiasRango } from './SelectorDiasRango';
import { SelectorLocalesPrevision, type OpcionLocalPrevision } from './SelectorLocalesPrevision';
import { colores, familia, peso, radios, sombraMenu } from './tokens';

type AccionVacio = { texto: string; onPress: () => void };

type Props = {
  visible: boolean;
  onClose: () => void;
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

const ALTO_CAMPO = 48;

export function HojaFiltrosPrevision(props: Props) {
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <Pressable style={styles.fondo} onPress={props.onClose} accessibilityLabel="Cerrar filtros" />
        <View style={styles.hoja}>
          <View style={styles.tiradorWrap}>
            <View style={styles.tirador} />
          </View>
          <View style={styles.cabecera}>
            <Text style={styles.titulo}>Filtros</Text>
            <TouchableOpacity onPress={props.onClose} accessibilityRole="button" style={styles.cerrar}>
              <Text style={styles.cerrarTexto}>Cerrar</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.cuerpo}
            contentContainerStyle={styles.cuerpoInner}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            <SelectorDiasRango
              desdeIso={props.fechaDesde}
              hastaIso={props.fechaHasta}
              onChangeDesde={props.onChangeDesde}
              onChangeHasta={props.onChangeHasta}
              excluidos={props.excluidos}
              onChangeExcluidos={props.onChangeExcluidos}
              disabled={props.calculando}
              variante="embebido"
              alto={ALTO_CAMPO}
            />
            <SelectorLocalesPrevision
              opciones={props.locales}
              valorIds={props.workplaceIds}
              onChange={props.onChangeLocales}
              loading={props.cargandoLocales}
              disabled={props.calculando}
              variante="embebido"
              alto={ALTO_CAMPO}
            />
            <View style={styles.dos}>
              <View style={styles.col}>
                <CampoPlantilla
                  alto={ALTO_CAMPO}
                  plantillas={props.plantillas}
                  plantillaId={props.plantillaId}
                  onChangePlantilla={props.onChangePlantilla}
                  cargandoPlantillas={props.cargandoPlantillas}
                  vacioPlantillas={
                    props.vacioPlantillas
                      ? { texto: props.vacioPlantillas.texto, onPress: () => { props.onClose(); props.vacioPlantillas?.onPress(); } }
                      : undefined
                  }
                  disabled={props.calculando}
                />
              </View>
              <View style={styles.col}>
                <CampoCoste
                  alto={ALTO_CAMPO}
                  objetivoTxt={props.objetivoTxt}
                  onChangeObjetivo={props.onChangeObjetivo}
                  disabled={props.calculando}
                />
              </View>
            </View>
            {props.errorMaestros ? <Text style={styles.error}>{props.errorMaestros}</Text> : null}
          </ScrollView>
          <View style={styles.pie}>
            <BotonPrevision
              titulo={props.calculando ? 'Calculando…' : 'Calcular'}
              variante="primario"
              alto={50}
              radio={radios.calcularHoja}
              onPress={props.onCalcular}
              cargando={props.calculando}
              style={styles.calcular}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colores.overlay,
    ...(Platform.OS === 'web' ? ({ zIndex: 10000 } as object) : null),
  },
  fondo: { flex: 1 },
  hoja: {
    backgroundColor: colores.superficie,
    borderTopLeftRadius: radios.hoja,
    borderTopRightRadius: radios.hoja,
    maxHeight: '92%',
    ...sombraMenu,
  },
  tiradorWrap: { alignItems: 'center', paddingTop: 8 },
  tirador: { width: 36, height: 4, borderRadius: radios.pastilla, backgroundColor: colores.tirador },
  cabecera: {
    minHeight: 48,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  titulo: { flex: 1, fontSize: 17, fontFamily: familia.semibold, fontWeight: peso.semibold, color: colores.texto },
  cerrar: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  cerrarTexto: { fontSize: 14, fontFamily: familia.medio, fontWeight: peso.medio, color: colores.textoSecundario },
  cuerpo: { flexGrow: 0 },
  cuerpoInner: { paddingHorizontal: 16, paddingBottom: 16, gap: 14 },
  dos: { flexDirection: 'row', gap: 10, alignItems: 'flex-end' },
  col: { flex: 1, minWidth: 0 },
  pie: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: colores.separador,
  },
  calcular: { width: '100%' },
  error: { fontFamily: familia.regular, fontSize: 13, color: colores.negativa },
});
