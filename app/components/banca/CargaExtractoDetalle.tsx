/**
 * Detalle de una carga de extracto bancario: contadores, cuentas del fichero,
 * descuadres contables e incidencias del lector.
 *
 * Lo usan el modal de importación (para el resumen de lo que acaba de subirse) y
 * la vista «Cargas» (para el histórico), así que no asume de dónde vienen los
 * datos ni los pide él: los recibe ya cargados.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Platform,
  ActivityIndicator,
  Linking,
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
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch, errorMessage } from '../../utils/api';
import { formatCreadoEn, formatFecha } from '../../utils/formatFecha';
import { formatMoneda } from '../../utils/facturacion';
import {
  bancoDesdeIban,
  etiquetaDescuadre,
  etiquetaEstadoCarga,
  ibanLegible,
  nombreFormato,
  tamanoLegible,
  urlAsignarCuentaCarga,
  valorDescuadre,
} from '../../lib/banca';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import type { CargaExtracto, CuentaCarga, FormatoExtracto, IncidenciaCarga } from '../../types/banca';

export type ResumenAsignacionCuenta = {
  movimientosAsignados: number;
  empresaNombre: string;
};

type Props = {
  carga: CargaExtracto | null;
  formatos: FormatoExtracto[];
  /** URL firmada de S3 del fichero tal como lo mandó el banco (puede venir vacía). */
  urlOriginal?: string;
  cargando?: boolean;
  error?: string | null;
  onReintentar?: () => void;
  /** El modal ya pinta el nombre del fichero en su cabecera. */
  mostrarCabecera?: boolean;
  vacioTexto?: string;
  /**
   * Tras dar de alta la cuenta pendiente desde el aviso ámbar. El padre
   * sustituye la carga por `fichero` de la respuesta.
   */
  onCargaActualizada?: (carga: CargaExtracto, resumen: ResumenAsignacionCuenta) => void;
};

type RespuestaAsignar = {
  ok?: boolean;
  movimientosAsignados?: number;
  fichero?: CargaExtracto;
  error?: string;
};

/** Igual que la importación: el alta de cuenta también toca todos los movimientos. */
const TIMEOUT_ASIGNAR_MS = 300_000;

/** El abort del timeout llega como DOMException sin mensaje útil para el usuario. */
function esAborto(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError');
}

function abrirUrl(url: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  void Linking.openURL(url).catch(() => {});
}

function Contador({ etiqueta, valor, color }: { etiqueta: string; valor: number; color?: string }) {
  return (
    <View style={styles.contador}>
      <Text style={[styles.contadorValor, color ? { color } : null]}>{valor}</Text>
      <Text style={styles.contadorEtiqueta}>{etiqueta}</Text>
    </View>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <View style={styles.dato}>
      <Text style={styles.datoEtiqueta}>{etiqueta}</Text>
      <Text style={styles.datoValor}>{valor}</Text>
    </View>
  );
}

function textoIncidencia(incidencia: IncidenciaCarga): string {
  const linea = Number(incidencia.linea) || 0;
  const tipo = String(incidencia.tipo || '').trim();
  const motivo = String(incidencia.motivo || '').trim() || 'Sin detalle';
  const prefijo = [linea ? `Línea ${linea}` : '', tipo ? `registro ${tipo}` : '']
    .filter(Boolean)
    .join(' · ');
  return prefijo ? `${prefijo} — ${motivo}` : motivo;
}

function nombreEmpresaItem(item: Record<string, unknown>): string {
  const candidatos = [item.Nombre, item.nombre, item.Alias, item.alias];
  for (const c of candidatos) {
    const texto = String(c ?? '').trim();
    if (texto) return texto;
  }
  return '';
}

function BloqueIncidencias({
  titulo,
  icono,
  color,
  fondo,
  borde,
  incidencias,
  truncadas,
  total,
}: {
  titulo: string;
  icono: 'error-outline' | 'warning-amber';
  color: string;
  fondo: string;
  borde: string;
  incidencias: IncidenciaCarga[];
  truncadas: boolean;
  total: number;
}) {
  if (incidencias.length === 0) return null;
  return (
    <View style={[styles.bloqueIncidencias, { backgroundColor: fondo, borderColor: borde }]}>
      <View style={styles.bloqueIncidenciasCabecera}>
        <MaterialIcons name={icono} size={16} color={color} />
        <Text style={[styles.bloqueIncidenciasTitulo, { color }]}>
          {titulo} ({total})
        </Text>
      </View>
      {incidencias.map((incidencia, idx) => (
        <Text key={`${incidencia.linea ?? 'x'}-${idx}`} style={styles.incidenciaTexto}>
          {textoIncidencia(incidencia)}
        </Text>
      ))}
      {truncadas ? (
        <Text style={styles.incidenciaTruncada}>
          Solo se guardan las 100 primeras. Descarga el fichero original para revisar el resto.
        </Text>
      ) : null}
    </View>
  );
}

function CuentaCargada({
  cuenta,
  compacta,
  hashFichero,
  puedeAsignar,
  onCargaActualizada,
}: {
  cuenta: CuentaCarga;
  compacta: boolean;
  hashFichero: string;
  puedeAsignar: boolean;
  onCargaActualizada?: (carga: CargaExtracto, resumen: ResumenAsignacionCuenta) => void;
}) {
  const descuadres = cuenta.descuadres || [];
  const rango =
    cuenta.fechaDesde || cuenta.fechaHasta
      ? `${formatFecha(cuenta.fechaDesde)} – ${formatFecha(cuenta.fechaHasta)}`
      : '—';
  const iban = String(cuenta.iban || cuenta.cuentaRef || '').trim();

  const [formAbierto, setFormAbierto] = useState(false);
  const [empresaId, setEmpresaId] = useState('');
  const [bancoNombre, setBancoNombre] = useState('');
  const [notas, setNotas] = useState('');
  const [predeterminada, setPredeterminada] = useState(false);
  const [opcionesEmpresa, setOpcionesEmpresa] = useState<OpcionDesplegable[]>([]);
  const [empresasCargando, setEmpresasCargando] = useState(false);
  const [empresasError, setEmpresasError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [errorForm, setErrorForm] = useState<string | null>(null);

  const enviandoRef = useRef(false);
  const secuenciaRef = useRef(0);
  const empresasCargadasRef = useRef(false);

  const cargarEmpresas = useCallback(async () => {
    if (empresasCargadasRef.current && opcionesEmpresa.length > 0) return;
    const secuencia = ++secuenciaRef.current;
    setEmpresasCargando(true);
    setEmpresasError(null);
    try {
      const res = await apiFetch('/api/empresas');
      const data = await res.json().catch(() => ({}));
      if (secuencia !== secuenciaRef.current) return;
      if (!res.ok) {
        setEmpresasError(data?.error || 'No se han podido cargar las empresas');
        return;
      }
      const lista = Array.isArray(data.empresas) ? (data.empresas as Record<string, unknown>[]) : [];
      const opciones = lista
        .map((item) => {
          const id = String(item.id_empresa ?? '').trim();
          const titulo = nombreEmpresaItem(item);
          return id && titulo ? { id, titulo } : null;
        })
        .filter((o): o is OpcionDesplegable => Boolean(o))
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'));
      setOpcionesEmpresa(opciones);
      empresasCargadasRef.current = true;
    } catch (e) {
      if (secuencia !== secuenciaRef.current) return;
      setEmpresasError(errorMessage(e, 'No se han podido cargar las empresas'));
    } finally {
      if (secuencia === secuenciaRef.current) setEmpresasCargando(false);
    }
  }, [opcionesEmpresa.length]);

  const abrirFormulario = useCallback(() => {
    setErrorForm(null);
    setEmpresaId('');
    setBancoNombre(bancoDesdeIban(iban).nombre);
    setNotas('');
    setPredeterminada(false);
    setFormAbierto(true);
    void cargarEmpresas();
  }, [cargarEmpresas, iban]);

  const cancelarFormulario = useCallback(() => {
    if (enviandoRef.current) return;
    setFormAbierto(false);
    setErrorForm(null);
  }, []);

  const confirmarAsignacion = useCallback(async () => {
    if (enviandoRef.current) return;
    const hash = hashFichero.trim();
    if (!hash) {
      setErrorForm('Falta el identificador de la carga.');
      return;
    }
    if (!empresaId.trim()) {
      setErrorForm('Selecciona la empresa a la que pertenece la cuenta.');
      return;
    }
    if (!iban) {
      setErrorForm('El extracto no trae un IBAN utilizable.');
      return;
    }

    enviandoRef.current = true;
    const secuencia = ++secuenciaRef.current;
    setEnviando(true);
    setErrorForm(null);
    try {
      // El alta recorre y actualiza todos los movimientos huérfanos de la cuenta:
      // con extractos grandes pasa del timeout por defecto de `apiFetch`.
      const res = await apiFetch(urlAsignarCuentaCarga(hash), {
        method: 'POST',
        timeoutMs: TIMEOUT_ASIGNAR_MS,
        body: JSON.stringify({
          empresaId: empresaId.trim(),
          iban,
          bancoNombre: bancoNombre.trim(),
          notas: notas.trim(),
          predeterminada,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as RespuestaAsignar;
      if (secuencia !== secuenciaRef.current) return;
      if (!res.ok || !data.fichero) {
        setErrorForm(data.error || 'No se ha podido asignar la cuenta');
        return;
      }
      const empresaNombre =
        opcionesEmpresa.find((o) => o.id === empresaId.trim())?.titulo || empresaId.trim();
      onCargaActualizada?.(data.fichero, {
        movimientosAsignados: Number(data.movimientosAsignados) || 0,
        empresaNombre,
      });
      setFormAbierto(false);
    } catch (e) {
      if (secuencia !== secuenciaRef.current) return;
      setErrorForm(
        esAborto(e)
          ? 'La asignación está tardando más de lo esperado. Puede que haya terminado en el servidor: recarga las cargas antes de reintentar.'
          : errorMessage(e, 'No se ha podido asignar la cuenta'),
      );
    } finally {
      enviandoRef.current = false;
      if (secuencia === secuenciaRef.current) setEnviando(false);
    }
  }, [
    bancoNombre,
    empresaId,
    hashFichero,
    iban,
    notas,
    onCargaActualizada,
    opcionesEmpresa,
    predeterminada,
  ]);

  return (
    <View style={[styles.cuenta, cuenta.pendienteAsignar && styles.cuentaPendiente]}>
      <View style={styles.cuentaCabecera}>
        <MaterialIcons name="account-balance" size={15} color="#0ea5e9" />
        <Text style={styles.cuentaIban} selectable>
          {ibanLegible(cuenta.iban || cuenta.cuentaRef)}
        </Text>
        {cuenta.ibanValido === false ? (
          <View style={styles.chipAviso}>
            <Text style={styles.chipAvisoTexto}>IBAN no válido</Text>
          </View>
        ) : null}
      </View>

      {cuenta.titular ? <Text style={styles.cuentaTitular}>{cuenta.titular}</Text> : null}

      {cuenta.pendienteAsignar ? (
        <View style={[styles.avisoAmbar, formAbierto && styles.avisoAmbarFormulario]}>
          <View style={styles.avisoAmbarCabecera}>
            <MaterialIcons name="link-off" size={15} color="#b45309" />
            <Text style={styles.avisoAmbarTexto}>
              Esta cuenta no está dada de alta en ninguna empresa. Los movimientos se han guardado, pero
              quedan sin empresa asociada: da de alta la cuenta en la ficha de la empresa para que
              aparezcan al filtrar por empresa.
            </Text>
          </View>

          {puedeAsignar && !formAbierto ? (
            <TouchableOpacity
              style={[styles.btnAsignar, compacta && styles.pulsableComodo]}
              onPress={abrirFormulario}
              accessibilityLabel="Asignar cuenta a una empresa"
            >
              <MaterialIcons name="link" size={16} color="#fff" />
              <Text style={styles.btnAsignarTexto}>Asignar</Text>
            </TouchableOpacity>
          ) : null}

          {puedeAsignar && formAbierto ? (
            <View style={styles.formAsignar}>
              <View style={styles.campoForm}>
                <Text style={styles.etiquetaForm}>IBAN</Text>
                <Text style={styles.ibanSoloLectura} selectable>
                  {ibanLegible(iban)}
                </Text>
              </View>

              <View style={[styles.campoForm, styles.campoDesplegable]}>
                <SelectorDesplegable
                  label="Empresa"
                  icono="business"
                  tituloLista="Empresa"
                  iconoLista="business"
                  placeholder="Selecciona una empresa"
                  opciones={opcionesEmpresa}
                  valorId={empresaId}
                  onSeleccionar={setEmpresaId}
                  loading={empresasCargando}
                  disabled={enviando}
                  buscador
                  buscadorPlaceholder="Buscar empresa…"
                  vacioTexto={empresasError || 'No hay empresas en el maestro.'}
                />
              </View>

              <View style={styles.campoForm}>
                <Text style={styles.etiquetaForm}>Banco</Text>
                <TextInput
                  style={[styles.inputForm, compacta && styles.inputFormComodo]}
                  value={bancoNombre}
                  onChangeText={setBancoNombre}
                  placeholder="Nombre del banco"
                  placeholderTextColor="#94a3b8"
                  editable={!enviando}
                />
              </View>

              <View style={styles.campoForm}>
                <Text style={styles.etiquetaForm}>Notas</Text>
                <TextInput
                  style={[styles.inputForm, styles.inputMultilinea, compacta && styles.inputFormComodo]}
                  value={notas}
                  onChangeText={setNotas}
                  placeholder="Opcional"
                  placeholderTextColor="#94a3b8"
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  editable={!enviando}
                />
              </View>

              <TouchableOpacity
                style={[styles.checkFila, compacta && styles.pulsableComodo]}
                onPress={() => setPredeterminada((v) => !v)}
                disabled={enviando}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: predeterminada, disabled: enviando }}
                accessibilityLabel="Cuenta predeterminada"
              >
                <MaterialIcons
                  name={predeterminada ? 'check-box' : 'check-box-outline-blank'}
                  size={22}
                  color={predeterminada ? '#0ea5e9' : '#94a3b8'}
                />
                <Text style={styles.checkTexto}>Cuenta predeterminada</Text>
              </TouchableOpacity>

              {errorForm || empresasError ? (
                <View style={styles.errorFormFila}>
                  <MaterialIcons name="error-outline" size={14} color="#b91c1c" />
                  <Text style={styles.errorFormTexto}>{errorForm || empresasError}</Text>
                </View>
              ) : null}

              <View style={[styles.formAcciones, compacta && styles.formAccionesApiladas]}>
                <TouchableOpacity
                  style={[styles.btnSecundario, styles.btnFormAccion, compacta && styles.pulsableComodo]}
                  onPress={cancelarFormulario}
                  disabled={enviando}
                  accessibilityLabel="Cancelar asignación"
                >
                  <Text style={styles.btnSecundarioTexto}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.btnConfirmar,
                    styles.btnFormAccion,
                    enviando && styles.btnConfirmarDisabled,
                    compacta && styles.pulsableComodo,
                  ]}
                  onPress={() => void confirmarAsignacion()}
                  disabled={enviando}
                  accessibilityLabel="Confirmar asignación de cuenta"
                >
                  {enviando ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.btnConfirmarTexto}>Confirmar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </View>
      ) : (
        <Text style={styles.cuentaEmpresa}>
          Empresa: {String(cuenta.empresaNombre || '').trim() || cuenta.empresaId || '—'}
        </Text>
      )}

      <View style={[styles.datosGrid, compacta && styles.datosGridCompacto]}>
        <Dato etiqueta="Periodo" valor={rango} />
        <Dato etiqueta="Saldo inicial" valor={formatMoneda(Number(cuenta.saldoInicial) || 0)} />
        <Dato
          etiqueta="Saldo final"
          valor={cuenta.saldoFinal == null ? '—' : formatMoneda(Number(cuenta.saldoFinal) || 0)}
        />
      </View>

      <View style={styles.contadoresFila}>
        <Contador etiqueta="Movimientos" valor={Number(cuenta.movimientos) || 0} />
        <Contador etiqueta="Nuevos" valor={Number(cuenta.nuevos) || 0} color="#16a34a" />
        <Contador etiqueta="Ya existían" valor={Number(cuenta.duplicados) || 0} color="#64748b" />
      </View>

      {descuadres.length > 0 ? (
        <View style={styles.descuadres}>
          <View style={styles.bloqueIncidenciasCabecera}>
            <MaterialIcons name="rule" size={16} color="#b91c1c" />
            <Text style={[styles.bloqueIncidenciasTitulo, { color: '#b91c1c' }]}>
              Descuadre contable ({descuadres.length})
            </Text>
          </View>
          <Text style={styles.descuadreAyuda}>
            Lo que suman los movimientos no coincide con lo que declara el banco. Revisa el extracto
            antes de dar los datos por buenos.
          </Text>
          {descuadres.map((descuadre) => (
            <View key={descuadre.campo} style={styles.descuadreFila}>
              <Text style={styles.descuadreCampo}>{etiquetaDescuadre(descuadre.campo)}</Text>
              <Text style={styles.descuadreValor}>
                Banco: {valorDescuadre(descuadre, 'declarado')}
              </Text>
              <Text style={styles.descuadreValor}>
                Calculado: {valorDescuadre(descuadre, 'calculado')}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function CargaExtractoDetalle({
  carga,
  formatos,
  urlOriginal,
  cargando = false,
  error = null,
  onReintentar,
  mostrarCabecera = true,
  vacioTexto = 'Selecciona una carga para ver su detalle.',
  onCargaActualizada,
}: Props) {
  const { hasPermiso } = useAuth();
  const { isCompact, shouldStackPanels } = useBreakpoint();
  const compacta = isCompact || shouldStackPanels;
  const puedeAsignar = hasPermiso('empresas.editar') && Boolean(String(carga?.hashFichero || '').trim());

  if (cargando && !carga) {
    return (
      <View style={styles.estado}>
        <ActivityIndicator size="small" color="#0ea5e9" />
        <Text style={styles.estadoTexto}>Cargando detalle…</Text>
      </View>
    );
  }

  if (error && !carga) {
    return (
      <View style={styles.estadoError}>
        <MaterialIcons name="error-outline" size={16} color="#dc2626" />
        <Text style={styles.estadoErrorTexto}>{error}</Text>
        {onReintentar ? (
          <TouchableOpacity
            style={[styles.btnSecundario, compacta && styles.pulsableComodo]}
            onPress={onReintentar}
          >
            <Text style={styles.btnSecundarioTexto}>Reintentar</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  if (!carga) {
    return (
      <View style={styles.vacio}>
        <MaterialIcons name="description" size={32} color="#cbd5e1" />
        <Text style={styles.vacioTexto}>{vacioTexto}</Text>
      </View>
    );
  }

  const errores = carga.errores || [];
  const avisos = carga.avisos || [];
  const cuentas = carga.cuentas || [];
  const estado = String(carga.estado || '');
  const hashFichero = String(carga.hashFichero || '').trim();

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContenido}
      keyboardShouldPersistTaps="handled"
    >
      {mostrarCabecera ? (
        <View style={styles.cabecera}>
          <MaterialIcons name="insert-drive-file" size={16} color="#0ea5e9" />
          <Text style={styles.cabeceraNombre} numberOfLines={2}>
            {String(carga.nombreFichero || '').trim() || 'Extracto sin nombre'}
          </Text>
        </View>
      ) : null}

      <View style={styles.chipsFila}>
        <View style={[styles.chip, estado === 'pendiente_cuenta' ? styles.chipAmbar : styles.chipVerde]}>
          <Text
            style={[
              styles.chipTexto,
              estado === 'pendiente_cuenta' ? styles.chipTextoAmbar : styles.chipTextoVerde,
            ]}
          >
            {etiquetaEstadoCarga(estado)}
          </Text>
        </View>
        <View style={styles.chip}>
          <Text style={styles.chipTexto}>{nombreFormato(carga.formato, formatos)}</Text>
        </View>
        {carga.importadoConSolapamiento ? (
          <View style={[styles.chip, styles.chipAmbar]}>
            <Text style={[styles.chipTexto, styles.chipTextoAmbar]}>Importado con solapamiento</Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.datosGrid, compacta && styles.datosGridCompacto]}>
        <Dato etiqueta="Importado" valor={formatCreadoEn(carga.importadoEn)} />
        <Dato etiqueta="Por" valor={String(carga.importadoPor || '').trim() || '—'} />
        <Dato etiqueta="Tamaño" valor={tamanoLegible(carga.tamanoBytes)} />
        <Dato etiqueta="Codificación" valor={String(carga.codificacion || '').trim() || '—'} />
      </View>

      <View style={styles.contadoresFila}>
        <Contador etiqueta="Leídos" valor={Number(carga.movimientosLeidos) || 0} />
        <Contador etiqueta="Nuevos" valor={Number(carga.movimientosNuevos) || 0} color="#16a34a" />
        <Contador etiqueta="Ya existían" valor={Number(carga.movimientosDuplicados) || 0} color="#64748b" />
        <Contador
          etiqueta="Líneas con error"
          valor={Number(carga.lineasConError) || 0}
          color={(Number(carga.lineasConError) || 0) > 0 ? '#dc2626' : undefined}
        />
        <Contador
          etiqueta="Avisos"
          valor={Number(carga.avisosTotal) || 0}
          color={(Number(carga.avisosTotal) || 0) > 0 ? '#d97706' : undefined}
        />
      </View>

      {urlOriginal ? (
        <TouchableOpacity
          style={[styles.btnDescargar, compacta && styles.pulsableComodo]}
          onPress={() => abrirUrl(urlOriginal)}
          accessibilityLabel="Descargar el fichero original del banco"
        >
          <MaterialIcons name="download" size={16} color="#0369a1" />
          <Text style={styles.btnDescargarTexto}>Descargar el fichero original</Text>
        </TouchableOpacity>
      ) : carga.s3Key ? (
        <Text style={styles.pista}>
          No se ha podido generar el enlace de descarga del fichero original. Inténtalo de nuevo en
          unos minutos.
        </Text>
      ) : null}

      {cuentas.length === 0 ? (
        <Text style={styles.pista}>El extracto no traía ninguna cuenta.</Text>
      ) : (
        <View style={styles.cuentas}>
          <Text style={styles.seccionTitulo}>
            {cuentas.length === 1 ? 'Cuenta del extracto' : `Cuentas del extracto (${cuentas.length})`}
          </Text>
          {cuentas.map((cuenta, idx) => (
            <CuentaCargada
              key={`${cuenta.cuentaRef || cuenta.iban || 'cuenta'}-${idx}`}
              cuenta={cuenta}
              compacta={compacta}
              hashFichero={hashFichero}
              puedeAsignar={puedeAsignar}
              onCargaActualizada={onCargaActualizada}
            />
          ))}
        </View>
      )}

      <BloqueIncidencias
        titulo="Líneas con error"
        icono="error-outline"
        color="#b91c1c"
        fondo="#fef2f2"
        borde="#fecaca"
        incidencias={errores}
        truncadas={Boolean(carga.erroresTruncados)}
        total={Number(carga.lineasConError) || errores.length}
      />
      <BloqueIncidencias
        titulo="Avisos del lector"
        icono="warning-amber"
        color="#b45309"
        fondo="#fffbeb"
        borde="#fde68a"
        incidencias={avisos}
        truncadas={Boolean(carga.avisosTruncados)}
        total={Number(carga.avisosTotal) || avisos.length}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0, position: 'relative', zIndex: 0 },
  scrollContenido: { padding: 12, gap: 10 },
  estado: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14 },
  estadoTexto: { fontSize: 12, color: '#64748b' },
  estadoError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    flexWrap: 'wrap',
  },
  estadoErrorTexto: { flex: 1, fontSize: 12, color: '#b91c1c', lineHeight: 17 },
  vacio: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  vacioTexto: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cabeceraNombre: { flex: 1, fontSize: 13, fontWeight: '700', color: '#334155' },
  chipsFila: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipVerde: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  chipAmbar: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  chipTexto: { fontSize: 11, fontWeight: '600', color: '#475569' },
  chipTextoVerde: { color: '#15803d' },
  chipTextoAmbar: { color: '#b45309' },
  chipAviso: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  chipAvisoTexto: { fontSize: 10, fontWeight: '700', color: '#b91c1c' },
  datosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  datosGridCompacto: { gap: 8 },
  dato: { minWidth: 120, gap: 1 },
  datoEtiqueta: { fontSize: 10, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase' },
  datoValor: { fontSize: 12, color: '#334155', fontWeight: '500' },
  contadoresFila: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  contador: { minWidth: 78, gap: 1 },
  contadorValor: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  contadorEtiqueta: { fontSize: 10, color: '#94a3b8' },
  btnDescargar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  btnDescargarTexto: { fontSize: 12, fontWeight: '600', color: '#0369a1' },
  pulsableComodo: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  pista: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
  seccionTitulo: { fontSize: 12, fontWeight: '700', color: '#334155' },
  cuentas: { gap: 8, position: 'relative', zIndex: 1 },
  cuenta: {
    gap: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#ffffff',
    position: 'relative',
    zIndex: 1,
  },
  cuentaPendiente: { borderColor: '#fde68a', backgroundColor: '#fffdf5' },
  cuentaCabecera: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  cuentaIban: { fontSize: 13, fontWeight: '700', color: '#0f172a', letterSpacing: 0.3 },
  cuentaTitular: { fontSize: 12, color: '#475569' },
  cuentaEmpresa: { fontSize: 12, color: '#475569', fontWeight: '500' },
  avisoAmbar: {
    gap: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  avisoAmbarFormulario: {
    position: 'relative',
    zIndex: 20,
    ...(Platform.OS === 'web' ? {} : { elevation: 8 }),
  },
  avisoAmbarCabecera: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  avisoAmbarTexto: { flex: 1, fontSize: 11, color: '#92400e', lineHeight: 16 },
  btnAsignar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#d97706',
  },
  btnAsignarTexto: { fontSize: 12, fontWeight: '700', color: '#fff' },
  formAsignar: { gap: 8, position: 'relative', zIndex: 21 },
  campoForm: { gap: 4 },
  campoDesplegable: {
    position: 'relative',
    zIndex: 30,
    ...(Platform.OS === 'web' ? {} : { elevation: 10 }),
  },
  etiquetaForm: { fontSize: 10, fontWeight: '600', color: '#92400e', textTransform: 'uppercase' },
  ibanSoloLectura: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0f172a',
    letterSpacing: 0.3,
    paddingVertical: 6,
  },
  inputForm: {
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#0f172a',
    backgroundColor: '#ffffff',
  },
  inputFormComodo: { minHeight: MIN_TOUCH, paddingVertical: 10 },
  inputMultilinea: { minHeight: 64, paddingTop: 8 },
  checkFila: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  checkTexto: { fontSize: 12, color: '#78350f', fontWeight: '500' },
  errorFormFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  errorFormTexto: { flex: 1, fontSize: 11, color: '#b91c1c', lineHeight: 16 },
  formAcciones: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  formAccionesApiladas: { flexDirection: 'column' },
  btnFormAccion: { flexGrow: 1, minWidth: 110 },
  btnConfirmar: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnConfirmarDisabled: { opacity: 0.7 },
  btnConfirmarTexto: { fontSize: 12, fontWeight: '700', color: '#fff' },
  descuadres: {
    gap: 4,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  descuadreAyuda: { fontSize: 11, color: '#b91c1c', lineHeight: 16 },
  descuadreFila: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  descuadreCampo: { fontSize: 11, fontWeight: '700', color: '#7f1d1d', minWidth: 150 },
  descuadreValor: { fontSize: 11, color: '#b91c1c' },
  bloqueIncidencias: { gap: 4, padding: 10, borderRadius: 8, borderWidth: 1 },
  bloqueIncidenciasCabecera: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bloqueIncidenciasTitulo: { fontSize: 12, fontWeight: '700' },
  incidenciaTexto: { fontSize: 11, color: '#475569', lineHeight: 16 },
  incidenciaTruncada: { fontSize: 11, color: '#64748b', fontStyle: 'italic', marginTop: 2 },
  btnSecundario: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
  },
  btnSecundarioTexto: { fontSize: 12, fontWeight: '600', color: '#475569' },
});
