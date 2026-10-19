import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useConfirmar } from '../../hooks/useConfirmar';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../constants/layout';
import { errorMessage } from '../../utils/api';
import {
  actualizarEscenario,
  borrarEscenario,
  crearEscenario,
  fechaEs,
  listarEscenarios,
  type AmbitoEscenario,
  type EscenarioPrevision,
  type PeticionPrevision,
} from '../../lib/previsionFranjasApi';
import { BotonPrevision } from './BotonPrevision';
import { altoControl, colores, estiloCifras, modoPrevision, peso, radios, sombraMenu } from './tokens';

type Props = {
  visible: boolean;
  onClose: () => void;
  filtros: PeticionPrevision;
  onCargar: (escenario: EscenarioPrevision) => void;
  puedeGlobal: boolean;
};

const MAX_NOMBRE = 80;

/** Listar, cargar, guardar, sobrescribir y borrar escenarios de previsión. */
export function ModalEscenarios({ visible, onClose, filtros, onCargar, puedeGlobal }: Props) {
  const { width } = useBreakpoint();
  const modo = modoPrevision(width);
  const tactil = modo !== 'escritorio';
  const alto = altoControl(modo);
  const { confirmar, ConfirmarView } = useConfirmar();
  const [escenarios, setEscenarios] = useState<EscenarioPrevision[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [ambito, setAmbito] = useState<AmbitoEscenario>('propio');
  const [guardando, setGuardando] = useState(false);
  const [ocupadoId, setOcupadoId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setEscenarios(await listarEscenarios());
    } catch (e) {
      setError(errorMessage(e, 'No se pudieron cargar los escenarios'));
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void cargar();
  }, [visible, cargar]);

  const validarFiltros = (): string | null => {
    if (!filtros.plantillaId) return 'Elige una plantilla de franjas antes de guardar.';
    if (!filtros.fechaDesde || !filtros.fechaHasta) return 'Indica un rango de fechas válido.';
    return null;
  };

  const guardarNuevo = async () => {
    const n = nombre.trim();
    if (!n) {
      setError('Indica un nombre para el escenario.');
      return;
    }
    const invalido = validarFiltros();
    if (invalido) {
      setError(invalido);
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      await crearEscenario({ ...filtros, nombre: n, ambito: puedeGlobal ? ambito : 'propio' });
      setNombre('');
      await cargar();
    } catch (e) {
      setError(errorMessage(e, 'No se pudo guardar el escenario'));
    } finally {
      setGuardando(false);
    }
  };

  const sobrescribir = async (esc: EscenarioPrevision) => {
    const invalido = validarFiltros();
    if (invalido) {
      setError(invalido);
      return;
    }
    const ok = await confirmar(
      'Sobrescribir escenario',
      `Se sustituirán los filtros guardados en «${esc.nombre}» por los filtros actuales de la pantalla.`,
      { confirmarLabel: 'Sobrescribir' },
    );
    if (!ok) return;
    setOcupadoId(esc.id);
    setError(null);
    try {
      await actualizarEscenario(esc.id, { ...filtros, nombre: esc.nombre, ambito: esc.ambito });
      await cargar();
    } catch (e) {
      setError(errorMessage(e, 'No se pudo actualizar el escenario'));
    } finally {
      setOcupadoId(null);
    }
  };

  const borrar = async (esc: EscenarioPrevision) => {
    const ok = await confirmar(
      'Borrar escenario',
      `¿Seguro que quieres borrar «${esc.nombre}»${esc.ambito === 'global' ? ' (compartido con todos)' : ''}?`,
      { confirmarLabel: 'Borrar', variant: 'danger' },
    );
    if (!ok) return;
    setOcupadoId(esc.id);
    setError(null);
    try {
      await borrarEscenario(esc.id, esc.ambito);
      setEscenarios((prev) => prev.filter((e) => !(e.id === esc.id && e.ambito === esc.ambito)));
    } catch (e) {
      setError(errorMessage(e, 'No se pudo borrar el escenario'));
    } finally {
      setOcupadoId(null);
    }
  };

  const puedeEditar = (esc: EscenarioPrevision) => esc.ambito === 'propio' || puedeGlobal;
  const ladoIcono = tactil ? MIN_TOUCH : 36;

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[styles.overlay, modo === 'movil' && styles.overlayMovil]} onPress={onClose}>
        <Pressable
          style={[styles.card, modo === 'movil' && styles.cardMovil]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.header}>
            <Text style={styles.headerText}>Escenarios</Text>
            <TouchableOpacity onPress={onClose} style={styles.cerrar} accessibilityLabel="Cerrar" accessibilityRole="button">
              <Text style={styles.cerrarTexto}>Cerrar</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.guardar}>
            <Text style={styles.seccion}>Guardar los filtros actuales</Text>
            <View style={styles.guardarFila}>
              <TextInput
                style={[styles.input, { minHeight: alto }]}
                value={nombre}
                onChangeText={setNombre}
                placeholder="Nombre del escenario"
                placeholderTextColor={colores.textoTerciario}
                maxLength={MAX_NOMBRE}
                accessibilityLabel="Nombre del escenario"
              />
              <BotonPrevision
                titulo="Guardar"
                variante="primario"
                alto={alto}
                onPress={guardarNuevo}
                cargando={guardando}
              />
            </View>
            {puedeGlobal ? (
              <View style={styles.ambitos}>
                {(['propio', 'global'] as const).map((a) => {
                  const activo = ambito === a;
                  return (
                    <TouchableOpacity
                      key={a}
                      style={[styles.ambito, { minHeight: alto }, activo && styles.ambitoOn]}
                      onPress={() => setAmbito(a)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: activo }}
                    >
                      <Text style={[styles.ambitoTexto, activo && styles.ambitoTextoOn]}>
                        {a === 'propio' ? 'Solo para mí' : 'Compartido con todos'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Text style={styles.seccionLista}>Escenarios guardados</Text>
          {cargando ? (
            <ActivityIndicator color={colores.acento} style={styles.carga} />
          ) : escenarios.length === 0 ? (
            <Text style={styles.vacioText}>Aún no hay escenarios guardados.</Text>
          ) : (
            <ScrollView style={styles.lista} contentContainerStyle={styles.listaInner} keyboardShouldPersistTaps="handled">
              {escenarios.map((esc) => {
                const ocupado = ocupadoId === esc.id;
                return (
                  <View key={`${esc.ambito}-${esc.id}`} style={styles.fila}>
                    <View style={styles.filaTextos}>
                      <View style={styles.filaTitulo}>
                        <Text style={styles.nombre} numberOfLines={1}>{esc.nombre}</Text>
                        <View style={[styles.badge, esc.ambito === 'global' ? styles.badgeGlobal : styles.badgePropio]}>
                          <Text style={[styles.badgeText, esc.ambito === 'global' && styles.badgeTextGlobal]}>
                            {esc.ambito === 'global' ? 'Compartido' : 'Propio'}
                          </Text>
                        </View>
                      </View>
                      <Text style={[styles.sub, estiloCifras]} numberOfLines={1}>
                        {fechaEs(esc.fechaDesde)} – {fechaEs(esc.fechaHasta)} · {esc.workplaceIds.length}{' '}
                        {esc.workplaceIds.length === 1 ? 'local' : 'locales'} · {esc.objetivoEurEmpHora} €/h
                      </Text>
                    </View>
                    {ocupado ? (
                      <ActivityIndicator size="small" color={colores.acento} />
                    ) : (
                      <View style={styles.acciones}>
                        <BotonPrevision
                          titulo="Cargar"
                          variante="secundario"
                          alto={tactil ? MIN_TOUCH : 32}
                          onPress={() => onCargar(esc)}
                        />
                        {puedeEditar(esc) ? (
                          <>
                            <TouchableOpacity
                              style={[styles.iconBtn, { width: ladoIcono, height: ladoIcono }]}
                              onPress={() => sobrescribir(esc)}
                              accessibilityLabel="Sobrescribir con los filtros actuales"
                            >
                              <MaterialIcons name="sync" size={18} color={colores.textoSecundario} />
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.iconBtn, { width: ladoIcono, height: ladoIcono }]}
                              onPress={() => borrar(esc)}
                              accessibilityLabel="Borrar escenario"
                            >
                              <MaterialIcons name="delete-outline" size={18} color={colores.negativa} />
                            </TouchableOpacity>
                          </>
                        ) : null}
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
      {ConfirmarView}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colores.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    ...(Platform.OS === 'web' ? ({ zIndex: 10000 } as object) : null),
  },
  overlayMovil: { padding: 0, justifyContent: 'flex-end' },
  card: {
    backgroundColor: colores.superficie,
    borderRadius: radios.superficie,
    width: '100%',
    maxWidth: 520,
    maxHeight: '85%',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colores.borde,
    ...sombraMenu,
  },
  cardMovil: {
    maxWidth: '100%',
    maxHeight: '92%',
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopLeftRadius: radios.hoja,
    borderTopRightRadius: radios.hoja,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 52,
    borderBottomWidth: 1,
    borderBottomColor: colores.separador,
  },
  headerText: { flex: 1, fontSize: 17, fontWeight: peso.semibold, color: colores.texto },
  cerrar: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  cerrarTexto: { fontSize: 14, fontWeight: peso.medio, color: colores.textoSecundario },
  guardar: { padding: 16, gap: 8, borderBottomWidth: 1, borderBottomColor: colores.separador },
  seccion: { fontSize: 11, fontWeight: peso.etiqueta, color: colores.textoSecundario },
  seccionLista: {
    fontSize: 11,
    fontWeight: peso.etiqueta,
    color: colores.textoSecundario,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  guardarFila: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colores.borde,
    backgroundColor: colores.superficie,
    borderRadius: radios.control,
    paddingHorizontal: 10,
    fontSize: 13,
    color: colores.texto,
  },
  ambitos: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  ambito: {
    paddingHorizontal: 12,
    borderRadius: radios.control,
    justifyContent: 'center',
  },
  ambitoOn: { backgroundColor: colores.acento },
  ambitoTexto: { fontSize: 13, fontWeight: peso.medio, color: colores.textoPestana },
  ambitoTextoOn: { color: colores.textoSobreAcento, fontWeight: peso.semibold },
  errorText: { fontSize: 13, color: colores.negativa, paddingHorizontal: 16, paddingTop: 10 },
  carga: { marginVertical: 24 },
  lista: { paddingHorizontal: 16 },
  listaInner: { paddingBottom: 12 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colores.separador,
  },
  filaTextos: { flex: 1, minWidth: 0, gap: 2 },
  filaTitulo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nombre: { fontSize: 14, fontWeight: peso.semibold, color: colores.texto, flexShrink: 1 },
  sub: { fontSize: 12, color: colores.textoSecundario },
  badge: { borderRadius: radios.pastilla, paddingHorizontal: 8, paddingVertical: 2 },
  badgePropio: { backgroundColor: colores.separador },
  badgeGlobal: { backgroundColor: colores.filaMarcada },
  badgeText: { fontSize: 11, fontWeight: peso.etiqueta, color: colores.textoSecundario },
  badgeTextGlobal: { color: colores.enlace },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconBtn: { alignItems: 'center', justifyContent: 'center', borderRadius: radios.control },
  vacioText: { fontSize: 13, color: colores.textoSecundario, paddingHorizontal: 16, paddingVertical: 28 },
});
