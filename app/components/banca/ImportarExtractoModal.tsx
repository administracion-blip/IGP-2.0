/**
 * Modal de importación de un extracto bancario.
 *
 * La subida sigue el patrón de `facturacion/registro-masivo`: `FormData` con
 * `apiFetch` y sin tocar `Content-Type` (lo calcula fetch con su boundary).
 *
 * Los tres desenlaces que el backend distingue se tratan como tres estados
 * distintos, porque para quien usa esto no son lo mismo:
 * - importado: se muestra el resumen de lo que ha entrado;
 * - `yaCargado`: el fichero ya estaba subido y NO se ha reprocesado (no es un error);
 * - `409 SOLAPAMIENTO`: el extracto pisa un periodo ya cargado y hace falta una
 *   decisión informada antes de reenviarlo con `confirmar=true`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { MIN_TOUCH } from '../../constants/layout';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatFecha } from '../../utils/formatFecha';
import { limpiarIban, validarIban } from '../../lib/iban';
import {
  aceptaExtracto,
  extensionesAceptadas,
  ibanLegible,
  tamanoLegible,
  textoErrorImportacion,
} from '../../lib/banca';
import { SelectorDesplegable } from '../SelectorDesplegable';
import { CargaExtractoDetalle } from './CargaExtractoDetalle';
import type { CargaExtracto, FormatoExtracto, Solapamiento } from '../../types/banca';

type Fase = 'seleccion' | 'enviando' | 'solapamiento' | 'resultado';

type MensajeError = { titulo: string; mensaje: string };

type Props = {
  visible: boolean;
  formatos: FormatoExtracto[];
  formatosCargando?: boolean;
  onClose: () => void;
  /** Se llama al terminar; `yaCargado` indica que no se ha escrito nada nuevo. */
  onImportado: (carga: CargaExtracto | null, yaCargado: boolean) => void;
};

/** La View de RN Web no reenvía onDrop al DOM: la zona de soltar es un div. */
function zonaDropWebStyle(activa: boolean, deshabilitada: boolean): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 22,
    border: `2px dashed ${deshabilitada ? '#e2e8f0' : activa ? '#0ea5e9' : '#cbd5e1'}`,
    borderRadius: 10,
    backgroundColor: deshabilitada ? '#f8fafc' : activa ? '#f0f9ff' : '#ffffff',
    boxSizing: 'border-box',
    cursor: deshabilitada ? 'not-allowed' : 'pointer',
  };
}

export function ImportarExtractoModal({
  visible,
  formatos,
  formatosCargando = false,
  onClose,
  onImportado,
}: Props) {
  const { isCompact } = useBreakpoint();
  const esWeb = Platform.OS === 'web';

  const [fase, setFase] = useState<Fase>('seleccion');
  const [fichero, setFichero] = useState<File | null>(null);
  const [formatoClave, setFormatoClave] = useState('');
  const [ibanTexto, setIbanTexto] = useState('');
  const [arrastrando, setArrastrando] = useState(false);
  const [errorImport, setErrorImport] = useState<MensajeError | null>(null);
  const [solapamientos, setSolapamientos] = useState<Solapamiento[]>([]);
  const [resumen, setResumen] = useState<CargaExtracto | null>(null);
  const [yaCargado, setYaCargado] = useState(false);
  const [mensajeResultado, setMensajeResultado] = useState('');
  /**
   * Espejo síncrono del envío: el estado no se ha repintado cuando llega un
   * segundo toque en el mismo tick, y sin esto se colarían dos importaciones.
   */
  const enviandoRef = useRef(false);

  const extensiones = useMemo(() => extensionesAceptadas(formatos), [formatos]);
  const formatoElegido = useMemo(
    () => formatos.find((f) => f.clave === formatoClave) ?? null,
    [formatos, formatoClave],
  );
  const ibanObligatorio = formatoElegido != null && !formatoElegido.traeIban;
  const enviando = fase === 'enviando';

  const reiniciar = useCallback(() => {
    setFase('seleccion');
    setFichero(null);
    setFormatoClave('');
    setIbanTexto('');
    setArrastrando(false);
    setErrorImport(null);
    setSolapamientos([]);
    setResumen(null);
    setYaCargado(false);
    setMensajeResultado('');
  }, []);

  useEffect(() => {
    if (visible) reiniciar();
  }, [visible, reiniciar]);

  const cerrar = useCallback(() => {
    if (enviandoRef.current) return;
    onClose();
  }, [onClose]);

  const aceptarFichero = useCallback(
    (candidato: File | null | undefined) => {
      if (!candidato) return;
      if (!aceptaExtracto(candidato.name, extensiones)) {
        setErrorImport({
          titulo: 'Fichero no admitido',
          mensaje: `Solo se aceptan extractos ${extensiones.join(', ')}. Descárgalo de la banca electrónica en uno de esos formatos.`,
        });
        return;
      }
      setErrorImport(null);
      setSolapamientos([]);
      setFichero(candidato);
      setFase('seleccion');
    },
    [extensiones],
  );

  const seleccionarFichero = useCallback(() => {
    if (!esWeb || enviando) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensiones.join(',');
    input.onchange = () => aceptarFichero(input.files?.[0]);
    input.click();
  }, [aceptarFichero, enviando, esWeb, extensiones]);

  const dropHandlers = useMemo(() => {
    if (!esWeb) return {};
    return {
      onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = enviando ? 'none' : 'copy';
        if (!enviando) setArrastrando(true);
      },
      onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const relacionado = e.relatedTarget as Node | null;
        if (!relacionado || !e.currentTarget.contains(relacionado)) setArrastrando(false);
      },
      onDrop: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setArrastrando(false);
        if (enviando) return;
        aceptarFichero(e.dataTransfer?.files?.[0]);
      },
      onClick: () => seleccionarFichero(),
    };
  }, [aceptarFichero, enviando, esWeb, seleccionarFichero]);

  const enviar = useCallback(
    async (confirmar: boolean) => {
      if (enviandoRef.current) return;
      if (!fichero) {
        setErrorImport({ titulo: 'Falta el extracto', mensaje: 'Selecciona el fichero que has descargado del banco.' });
        return;
      }

      const ibanLimpio = limpiarIban(ibanTexto);
      if (ibanObligatorio && !ibanLimpio) {
        setErrorImport({
          titulo: 'Falta el IBAN de la cuenta',
          mensaje: `Los extractos ${formatoElegido?.nombre ?? 'de este formato'} no identifican la cuenta: escribe el IBAN al que corresponden los movimientos.`,
        });
        return;
      }
      if (ibanLimpio) {
        const validacion = validarIban(ibanLimpio);
        if (!validacion.valido) {
          setErrorImport({
            titulo: 'IBAN inválido',
            mensaje: `${validacion.motivo ?? 'Revisa el IBAN'}. Puedes pegarlo con espacios o guiones.`,
          });
          return;
        }
      }

      const faseAnterior: Fase = confirmar ? 'solapamiento' : 'seleccion';
      enviandoRef.current = true;
      setErrorImport(null);
      setFase('enviando');

      try {
        const cuerpo = new FormData();
        cuerpo.append('file', fichero);
        if (ibanLimpio) cuerpo.append('iban', ibanLimpio);
        if (formatoClave) cuerpo.append('formato', formatoClave);
        if (confirmar) cuerpo.append('confirmar', 'true');

        // Un extracto de varios miles de apuntes se escribe movimiento a
        // movimiento: el timeout por defecto (30 s) se queda corto.
        const res = await apiFetch('/api/banca/importar', {
          method: 'POST',
          body: cuerpo,
          timeoutMs: 300_000,
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        if (res.status === 409 && data?.code === 'SOLAPAMIENTO') {
          setSolapamientos(Array.isArray(data.solapamientos) ? (data.solapamientos as Solapamiento[]) : []);
          setFase('solapamiento');
          return;
        }

        if (!res.ok) {
          setErrorImport(
            textoErrorImportacion(
              typeof data.code === 'string' ? data.code : undefined,
              typeof data.error === 'string' ? data.error : undefined,
              Array.isArray(data.ibanesFichero) ? (data.ibanesFichero as string[]) : undefined,
            ),
          );
          setFase(faseAnterior);
          return;
        }

        const carga = (data.resumen ?? null) as CargaExtracto | null;
        const repetido = Boolean(data.yaCargado);
        setResumen(carga);
        setYaCargado(repetido);
        setMensajeResultado(typeof data.mensaje === 'string' ? data.mensaje : '');
        setSolapamientos([]);
        setFase('resultado');
        onImportado(carga, repetido);
      } catch (e) {
        setErrorImport({
          titulo: 'No se ha podido subir el extracto',
          mensaje: errorMessage(e, 'Revisa la conexión con el servidor e inténtalo de nuevo.'),
        });
        setFase(faseAnterior);
      } finally {
        enviandoRef.current = false;
      }
    },
    [fichero, formatoClave, formatoElegido, ibanObligatorio, ibanTexto, onImportado],
  );

  const opcionesFormato = useMemo(
    () => [
      { id: '', titulo: 'Detectar por la extensión', subtitulo: 'Recomendado', icono: 'auto-fix-high' as const },
      ...formatos.map((f) => ({
        id: f.clave,
        titulo: f.nombre,
        subtitulo: f.extensiones.join(', '),
        icono: 'description' as const,
      })),
    ],
    [formatos],
  );

  const totalSolapado = solapamientos.reduce(
    (acc, s) => acc + (Number(s.movimientosExistentes) || 0),
    0,
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cerrar}>
      <View style={styles.overlay}>
        <View style={styles.tarjeta}>
          <View style={styles.cabecera}>
            <MaterialIcons name="cloud-upload" size={18} color="#0ea5e9" />
            <View style={styles.cabeceraTexto}>
              <Text style={styles.titulo}>Importar extracto bancario</Text>
              <Text style={styles.subtitulo}>
                Sube el fichero tal como lo descargas de la banca electrónica. Subir dos veces el
                mismo extracto no duplica movimientos.
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.btnCerrar, isCompact && styles.pulsableComodo]}
              onPress={cerrar}
              disabled={enviando}
              accessibilityLabel="Cerrar"
            >
              <MaterialIcons name="close" size={20} color={enviando ? '#cbd5e1' : '#64748b'} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.cuerpo} contentContainerStyle={styles.cuerpoContenido}>
            {fase === 'resultado' ? (
              <>
                <View style={yaCargado ? styles.avisoInfo : styles.avisoOk}>
                  <MaterialIcons
                    name={yaCargado ? 'info-outline' : 'check-circle'}
                    size={18}
                    color={yaCargado ? '#0369a1' : '#16a34a'}
                  />
                  <View style={styles.avisoTexto}>
                    <Text style={[styles.avisoTitulo, yaCargado ? styles.avisoTituloInfo : styles.avisoTituloOk]}>
                      {yaCargado ? 'Este extracto ya estaba cargado' : 'Extracto importado'}
                    </Text>
                    <Text style={styles.avisoCuerpo}>
                      {yaCargado
                        ? mensajeResultado
                          || 'El fichero ya se había subido antes, así que no se ha vuelto a procesar. Abajo tienes el resumen de aquella carga.'
                        : `Se han guardado ${Number(resumen?.movimientosNuevos) || 0} movimiento(s) nuevo(s) de ${Number(resumen?.movimientosLeidos) || 0} leído(s).`}
                    </Text>
                  </View>
                </View>
                <CargaExtractoDetalle
                  carga={resumen}
                  formatos={formatos}
                  onCargaActualizada={(carga) => {
                    setResumen(carga);
                    // Refresca listados del padre sin toast de importación.
                    onImportado(carga, true);
                  }}
                />
              </>
            ) : (
              <>
                {esWeb ? (
                  <div {...dropHandlers} style={zonaDropWebStyle(arrastrando, enviando)}>
                    <MaterialIcons
                      name={fichero ? 'insert-drive-file' : 'file-upload'}
                      size={30}
                      color={arrastrando ? '#0ea5e9' : '#94a3b8'}
                    />
                    <Text style={styles.zonaTitulo}>
                      {fichero
                        ? fichero.name
                        : arrastrando
                          ? 'Suelta aquí el extracto'
                          : 'Arrastra el extracto o pulsa para elegirlo'}
                    </Text>
                    <Text style={styles.zonaPista}>
                      {fichero
                        ? `${tamanoLegible(fichero.size)} · pulsa para cambiarlo`
                        : `${extensiones.join(', ')} · máximo 10 MB`}
                    </Text>
                  </div>
                ) : (
                  <View style={styles.zonaNoWeb}>
                    <MaterialIcons name="desktop-windows" size={26} color="#94a3b8" />
                    <Text style={styles.zonaPista}>
                      La subida de extractos solo está disponible en la versión web. Los movimientos
                      ya importados sí se pueden consultar aquí.
                    </Text>
                  </View>
                )}

                <SelectorDesplegable
                  label="Formato del extracto"
                  icono="description"
                  tituloLista="Formato"
                  iconoLista="description"
                  placeholder="Detectar por la extensión"
                  opciones={opcionesFormato}
                  valorId={formatoClave}
                  onSeleccionar={setFormatoClave}
                  loading={formatosCargando}
                  disabled={enviando}
                  vacioTexto="El servidor no ha devuelto ningún formato de extracto."
                />

                <View style={styles.campo}>
                  <Text style={styles.campoEtiqueta}>
                    IBAN de la cuenta {ibanObligatorio ? '*' : '(opcional)'}
                  </Text>
                  <TextInput
                    style={[styles.input, isCompact && styles.inputComodo]}
                    value={ibanTexto}
                    onChangeText={setIbanTexto}
                    placeholder="ES00 0000 0000 0000 0000 0000"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    editable={!enviando}
                  />
                  <Text style={styles.campoPista}>
                    {ibanObligatorio
                      ? 'Este formato no identifica la cuenta: indica a qué IBAN pertenecen los movimientos.'
                      : 'En los ficheros Norma 43 la cuenta viene dentro. Si lo rellenas se usa como comprobación: si no coincide, no se importa.'}
                  </Text>
                </View>

                {fase === 'solapamiento' ? (
                  <View style={styles.solapamiento}>
                    <View style={styles.solapamientoCabecera}>
                      <MaterialIcons name="warning-amber" size={18} color="#b45309" />
                      <Text style={styles.solapamientoTitulo}>
                        Este extracto pisa un periodo ya cargado
                      </Text>
                    </View>
                    <Text style={styles.solapamientoTexto}>
                      La cuenta ya tiene {totalSolapado} movimiento(s) guardado(s) en las fechas que
                      cubre el fichero. No se ha importado nada todavía.
                    </Text>
                    {solapamientos.map((s, idx) => (
                      <View key={`${s.cuentaRef || s.iban || 'cuenta'}-${idx}`} style={styles.solapamientoBloque}>
                        <Text style={styles.solapamientoCuenta}>{ibanLegible(s.iban || s.cuentaRef)}</Text>
                        <Text style={styles.solapamientoDetalle}>
                          Periodo del extracto: {formatFecha(s.desde)} – {formatFecha(s.hasta)} ·{' '}
                          {Number(s.movimientosExistentes) || 0} movimiento(s) ya guardado(s)
                        </Text>
                        {(s.cargas || []).map((carga, i) => (
                          <Text key={`${carga.hashFichero || 'carga'}-${i}`} style={styles.solapamientoCarga}>
                            · {String(carga.nombreFichero || '').trim() || 'Carga anterior sin nombre'} —{' '}
                            {Number(carga.movimientos) || 0} movimiento(s)
                          </Text>
                        ))}
                      </View>
                    ))}
                    <Text style={styles.solapamientoAdvertencia}>
                      Si confirmas, el extracto se importará igualmente. Los apuntes idénticos ya
                      guardados no se repiten, pero los apuntes repetidos del mismo día (mismo importe
                      y misma fecha) pueden quedar duplicados, porque cada fichero los numera a su
                      manera. Confirma solo si sabes que el periodo anterior estaba incompleto.
                    </Text>
                  </View>
                ) : null}

                {errorImport ? (
                  <View style={styles.avisoError}>
                    <MaterialIcons name="error-outline" size={18} color="#dc2626" />
                    <View style={styles.avisoTexto}>
                      <Text style={[styles.avisoTitulo, styles.avisoTituloError]}>{errorImport.titulo}</Text>
                      <Text style={styles.avisoCuerpo}>{errorImport.mensaje}</Text>
                    </View>
                  </View>
                ) : null}

                {enviando ? (
                  <View style={styles.progreso}>
                    <ActivityIndicator size="small" color="#0ea5e9" />
                    <Text style={styles.progresoTexto}>
                      Procesando el extracto… con varios miles de movimientos puede tardar un par de
                      minutos. No cierres la ventana ni vuelvas a enviarlo.
                    </Text>
                  </View>
                ) : null}
              </>
            )}
          </ScrollView>

          <View style={styles.acciones}>
            {fase === 'resultado' ? (
              <>
                <TouchableOpacity
                  style={[styles.btnSecundario, isCompact && styles.pulsableComodo]}
                  onPress={reiniciar}
                  accessibilityLabel="Nueva importación"
                >
                  <MaterialIcons name="upload-file" size={16} color="#475569" />
                  <Text style={styles.btnSecundarioTexto}>Nueva importación</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnPrimario, isCompact && styles.pulsableComodo]}
                  onPress={cerrar}
                >
                  <Text style={styles.btnPrimarioTexto}>Cerrar</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={[styles.btnSecundario, isCompact && styles.pulsableComodo]}
                  onPress={cerrar}
                  disabled={enviando}
                >
                  <Text style={styles.btnSecundarioTexto}>Cancelar</Text>
                </TouchableOpacity>
                {fase === 'solapamiento' ? (
                  <TouchableOpacity
                    style={[styles.btnPeligro, isCompact && styles.pulsableComodo]}
                    onPress={() => void enviar(true)}
                    disabled={enviando}
                  >
                    <MaterialIcons name="playlist-add-check" size={16} color="#ffffff" />
                    <Text style={styles.btnPeligroTexto}>Importar igualmente</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[
                      styles.btnPrimario,
                      (!fichero || enviando || !esWeb) && styles.btnDeshabilitado,
                      isCompact && styles.pulsableComodo,
                    ]}
                    onPress={() => void enviar(false)}
                    disabled={!fichero || enviando || !esWeb}
                  >
                    {enviando ? (
                      <ActivityIndicator size="small" color="#ffffff" />
                    ) : (
                      <MaterialIcons name="cloud-upload" size={16} color="#ffffff" />
                    )}
                    <Text style={styles.btnPrimarioTexto}>
                      {enviando ? 'Importando…' : 'Importar extracto'}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  tarjeta: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '92%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? ({ boxShadow: '0 16px 40px rgba(0,0,0,0.18)' } as object) : { elevation: 12 }),
  },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  cabeceraTexto: { flex: 1, gap: 2 },
  titulo: { fontSize: 15, fontWeight: '700', color: '#334155' },
  subtitulo: { fontSize: 11, color: '#64748b', lineHeight: 16 },
  btnCerrar: { padding: 4, borderRadius: 8 },
  pulsableComodo: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  cuerpo: { maxHeight: 520 },
  cuerpoContenido: { padding: 14, gap: 12 },
  zonaTitulo: { fontSize: 13, fontWeight: '600', color: '#334155', textAlign: 'center' },
  zonaPista: { fontSize: 11, color: '#94a3b8', textAlign: 'center', lineHeight: 16 },
  zonaNoWeb: {
    alignItems: 'center',
    gap: 6,
    padding: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  campo: { gap: 3 },
  campoEtiqueta: {
    fontSize: 10,
    fontWeight: '600',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  campoPista: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
  },
  inputComodo: { minHeight: MIN_TOUCH, fontSize: 14 },
  avisoOk: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  avisoInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  avisoError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  avisoTexto: { flex: 1, gap: 2 },
  avisoTitulo: { fontSize: 12, fontWeight: '700' },
  avisoTituloOk: { color: '#15803d' },
  avisoTituloInfo: { color: '#0369a1' },
  avisoTituloError: { color: '#b91c1c' },
  avisoCuerpo: { fontSize: 11, color: '#475569', lineHeight: 16 },
  solapamiento: {
    gap: 6,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  solapamientoCabecera: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  solapamientoTitulo: { flex: 1, fontSize: 12, fontWeight: '700', color: '#92400e' },
  solapamientoTexto: { fontSize: 11, color: '#92400e', lineHeight: 16 },
  solapamientoBloque: {
    gap: 2,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  solapamientoCuenta: { fontSize: 12, fontWeight: '700', color: '#0f172a', letterSpacing: 0.3 },
  solapamientoDetalle: { fontSize: 11, color: '#475569', lineHeight: 16 },
  solapamientoCarga: { fontSize: 11, color: '#64748b', lineHeight: 16 },
  solapamientoAdvertencia: { fontSize: 11, color: '#b45309', lineHeight: 16, fontWeight: '500' },
  progreso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  progresoTexto: { flex: 1, fontSize: 11, color: '#0369a1', lineHeight: 16 },
  acciones: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    flexWrap: 'wrap',
  },
  btnPrimario: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnPrimarioTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },
  btnPeligro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#d97706',
  },
  btnPeligroTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },
  btnSecundario: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
  },
  btnSecundarioTexto: { fontSize: 12, fontWeight: '600', color: '#475569' },
  btnDeshabilitado: { opacity: 0.5 },
});
