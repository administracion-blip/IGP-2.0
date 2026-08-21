import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { MIN_TOUCH } from '../constants/layout';
import { apiFetch, errorMessage } from '../utils/api';

/**
 * Bloque de gestión de las cuentas bancarias de una empresa (tabla
 * `Igp_BankAccounts`, N cuentas por empresa).
 *
 * Reglas del modelo que esta pantalla materializa:
 * - Exactamente una cuenta es la predeterminada y es la que usa el resto del
 *   sistema (facturas, remesas, pagos). Se elige con un selector único.
 * - Las cuentas no se borran nunca: se desactivan.
 * - El IBAN no se puede editar (es la clave): para corregirlo se da de alta la
 *   cuenta buena y se desactiva la vieja.
 *
 * El IBAN lo limpia y valida el backend, así que aquí no se replica esa lógica:
 * se muestra el motivo que devuelve.
 */

export type CuentaBancariaEmpresa = {
  iban: string;
  empresaId?: string;
  empresaCif?: string;
  empresaNombre?: string;
  bancoCodigo?: string;
  bancoNombre?: string;
  notas?: string;
  activa?: boolean;
  creadoEn?: string;
  creadoPor?: string;
  actualizadoEn?: string;
  actualizadoPor?: string;
};

type RespuestaListado = {
  cuentas?: CuentaBancariaEmpresa[];
  ibanPredeterminado?: string;
  punteroSinCuenta?: boolean;
  error?: string;
};

type RespuestaAccion = {
  ok?: boolean;
  cuenta?: CuentaBancariaEmpresa;
  reactivada?: boolean;
  ibanPredeterminado?: string;
  /** Movimientos importados sin empresa a los que el alta les ha puesto esta. */
  movimientosAsignados?: number;
  error?: string;
};

type Props = {
  /** id_empresa del maestro igp_Empresas. */
  idEmpresa: string;
  /**
   * Cambio de cuenta predeterminada. El backend reescribe el campo `Iban` de la
   * empresa, así que el padre debería refrescar su listado.
   */
  onPredeterminadaChange?: (iban: string) => void;
};

/** Clave de `errorAccion` para los fallos del formulario de alta. */
const CLAVE_ALTA = 'alta';

/** Error de una acción, atado a la fila (IBAN) o al alta que lo ha provocado. */
type ErrorAccion = { clave: string; mensaje: string };

const COLOR_PRIMARIO = '#0ea5e9';
const COLOR_EXITO = '#16a34a';
const COLOR_AVISO = '#d97706';
const COLOR_ERROR = '#ef4444';

function normalizarIban(val: unknown): string {
  return String(val ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** `ES1234…` → `ES12 3456 7890 …`: un IBAN se lee agrupado de 4 en 4. */
export function formatearIbanLegible(iban: string): string {
  const limpio = normalizarIban(iban);
  return limpio.replace(/(.{4})/g, '$1 ').trim();
}

export function CuentasBancariasEmpresa({ idEmpresa, onPredeterminadaChange }: Props) {
  const { hasPermiso } = useAuth();
  const { isCompact, shouldStackPanels } = useBreakpoint();
  const puedeEditar = hasPermiso('empresas.editar');
  const apilado = shouldStackPanels;

  const [cuentas, setCuentas] = useState<CuentaBancariaEmpresa[]>([]);
  const [ibanPredeterminado, setIbanPredeterminado] = useState('');
  const [punteroSinCuenta, setPunteroSinCuenta] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<ErrorAccion | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** IBAN con una acción en curso, o 'alta' mientras se crea una cuenta. */
  const [enCurso, setEnCurso] = useState<string | null>(null);
  /**
   * Espejo síncrono de `enCurso`: el estado no se ha repintado todavía cuando
   * llega un segundo toque en el mismo tick, así que sin el ref se colarían dos
   * peticiones simultáneas.
   */
  const accionEnCursoRef = useRef(false);
  /**
   * Contador de peticiones. Solo la última lanzada puede escribir en el estado:
   * dos cambios de predeterminada seguidos pueden responder en orden distinto
   * al que los procesó el backend y dejarían pintada la cuenta equivocada.
   */
  const secuenciaRef = useRef(0);

  /** Cualquier acción en vuelo bloquea todo el bloque, no solo su fila. */
  const hayAccionEnCurso = enCurso !== null;

  const [altaVisible, setAltaVisible] = useState(false);
  const [altaIban, setAltaIban] = useState('');
  const [altaNotas, setAltaNotas] = useState('');

  const [editandoIban, setEditandoIban] = useState<string | null>(null);
  const [editBanco, setEditBanco] = useState('');
  const [editNotas, setEditNotas] = useState('');

  const [confirmandoIban, setConfirmandoIban] = useState<string | null>(null);

  const rutaCuentas = `/api/empresas/${encodeURIComponent(idEmpresa)}/cuentas`;

  const cargar = useCallback(
    async (silencioso = false) => {
      if (!idEmpresa) return;
      const secuencia = ++secuenciaRef.current;
      if (!silencioso) setCargando(true);
      setErrorCarga(null);
      try {
        const res = await apiFetch(`/api/empresas/${encodeURIComponent(idEmpresa)}/cuentas`);
        const data = (await res.json().catch(() => ({}))) as RespuestaListado;
        if (secuencia !== secuenciaRef.current) return;
        if (!res.ok) {
          setErrorCarga(data.error || 'No se pudieron cargar las cuentas');
          return;
        }
        setCuentas(Array.isArray(data.cuentas) ? data.cuentas : []);
        setIbanPredeterminado(normalizarIban(data.ibanPredeterminado));
        setPunteroSinCuenta(Boolean(data.punteroSinCuenta));
      } catch (e) {
        if (secuencia !== secuenciaRef.current) return;
        setErrorCarga(errorMessage(e, 'No se pudieron cargar las cuentas'));
      } finally {
        if (secuencia === secuenciaRef.current) setCargando(false);
      }
    },
    [idEmpresa],
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

  /**
   * Lanza la petición y deja en `errorAccion` el motivo que devuelve el backend,
   * etiquetado con `clave` para poder pintarlo en la fila que lo ha provocado.
   * Descarta la respuesta si mientras tanto se ha lanzado otra petición.
   */
  const ejecutar = useCallback(
    async (clave: string, peticion: () => Promise<Response>, fallback: string): Promise<RespuestaAccion | null> => {
      if (accionEnCursoRef.current) return null;
      accionEnCursoRef.current = true;
      const secuencia = ++secuenciaRef.current;
      setEnCurso(clave);
      setErrorAccion(null);
      setAviso(null);
      try {
        const res = await peticion();
        const data = (await res.json().catch(() => ({}))) as RespuestaAccion;
        if (secuencia !== secuenciaRef.current) return null;
        if (!res.ok) {
          setErrorAccion({ clave, mensaje: data.error || fallback });
          return null;
        }
        return data;
      } catch (e) {
        if (secuencia !== secuenciaRef.current) return null;
        setErrorAccion({ clave, mensaje: errorMessage(e, fallback) });
        return null;
      } finally {
        accionEnCursoRef.current = false;
        if (secuencia === secuenciaRef.current) setEnCurso(null);
      }
    },
    [],
  );

  const marcarPredeterminada = useCallback(
    async (iban: string) => {
      if (normalizarIban(iban) === ibanPredeterminado) return;
      const data = await ejecutar(
        iban,
        () => apiFetch(`${rutaCuentas}/${encodeURIComponent(iban)}/predeterminada`, { method: 'PUT' }),
        'No se pudo marcar la cuenta como predeterminada',
      );
      if (!data) return;
      const nuevo = normalizarIban(data.ibanPredeterminado ?? iban);
      setIbanPredeterminado(nuevo);
      onPredeterminadaChange?.(nuevo);
      await cargar(true);
    },
    [cargar, ejecutar, ibanPredeterminado, onPredeterminadaChange, rutaCuentas],
  );

  const crearCuenta = useCallback(async () => {
    const iban = altaIban.trim();
    if (!iban) {
      setErrorAccion({ clave: CLAVE_ALTA, mensaje: 'Indica el IBAN de la cuenta' });
      return;
    }
    const data = await ejecutar(
      CLAVE_ALTA,
      () =>
        apiFetch(rutaCuentas, {
          method: 'POST',
          body: JSON.stringify({ iban, notas: altaNotas.trim() }),
        }),
      'No se pudo añadir la cuenta',
    );
    if (!data) return;
    setAltaIban('');
    setAltaNotas('');
    setAltaVisible(false);
    const nuevo = normalizarIban(data.ibanPredeterminado);
    if (nuevo && nuevo !== ibanPredeterminado) {
      setIbanPredeterminado(nuevo);
      onPredeterminadaChange?.(nuevo);
    }
    const base = data.reactivada
      ? 'Esa cuenta ya existía desactivada en esta empresa y se ha reactivado.'
      : 'Cuenta añadida.';
    // Los extractos importados antes de dar de alta el IBAN se guardaron sin
    // empresa; el alta los engancha y conviene decir cuántos.
    const vinculados = Number(data.movimientosAsignados) || 0;
    setAviso(
      vinculados > 0
        ? `${base} Se ${vinculados === 1 ? 'ha vinculado 1 movimiento bancario' : `han vinculado ${vinculados} movimientos bancarios`} que estaban sin empresa.`
        : base,
    );
    await cargar(true);
  }, [altaIban, altaNotas, cargar, ejecutar, ibanPredeterminado, onPredeterminadaChange, rutaCuentas]);

  const abrirEdicion = useCallback((cuenta: CuentaBancariaEmpresa) => {
    setEditandoIban(cuenta.iban);
    setEditBanco(String(cuenta.bancoNombre ?? ''));
    setEditNotas(String(cuenta.notas ?? ''));
    setErrorAccion(null);
    setAviso(null);
  }, []);

  const guardarEdicion = useCallback(
    async (iban: string) => {
      const data = await ejecutar(
        iban,
        () =>
          apiFetch(`${rutaCuentas}/${encodeURIComponent(iban)}`, {
            method: 'PUT',
            body: JSON.stringify({ bancoNombre: editBanco.trim(), notas: editNotas.trim() }),
          }),
        'No se pudo guardar la cuenta',
      );
      if (!data) return;
      setEditandoIban(null);
      await cargar(true);
    },
    [cargar, editBanco, editNotas, ejecutar, rutaCuentas],
  );

  const desactivar = useCallback(
    async (iban: string) => {
      const data = await ejecutar(
        iban,
        () => apiFetch(`${rutaCuentas}/${encodeURIComponent(iban)}`, { method: 'DELETE' }),
        'No se pudo desactivar la cuenta',
      );
      // La confirmación sigue abierta si falla: es donde se pinta el motivo.
      if (!data) return;
      setConfirmandoIban(null);
      setAviso('Cuenta desactivada.');
      await cargar(true);
    },
    [cargar, ejecutar, rutaCuentas],
  );

  const reactivar = useCallback(
    async (iban: string) => {
      const data = await ejecutar(
        iban,
        () =>
          apiFetch(`${rutaCuentas}/${encodeURIComponent(iban)}`, {
            method: 'PUT',
            body: JSON.stringify({ activa: true }),
          }),
        'No se pudo reactivar la cuenta',
      );
      if (!data) return;
      setAviso('Cuenta reactivada.');
      await cargar(true);
    },
    [cargar, ejecutar, rutaCuentas],
  );

  /** Activas primero (el backend ya las ordena con la predeterminada delante). */
  const cuentasOrdenadas = useMemo(() => {
    const activas = cuentas.filter((c) => c.activa !== false);
    const inactivas = cuentas.filter((c) => c.activa === false);
    return [...activas, ...inactivas];
  }, [cuentas]);

  const totalActivas = cuentasOrdenadas.filter((c) => c.activa !== false).length;

  /**
   * Los errores se pintan en la fila (o en el alta) que los provoca, para que se
   * vean sin tener que subir el scroll del modal. Solo si la clave ya no tiene
   * hueco donde pintarse se recurre al aviso de cabecera, y así no se pierde.
   */
  const errorAccionSinFila = useMemo(() => {
    if (!errorAccion) return null;
    if (errorAccion.clave === CLAVE_ALTA) return altaVisible ? null : errorAccion.mensaje;
    const hayFila = cuentasOrdenadas.some((c) => String(c.iban ?? '') === errorAccion.clave);
    return hayFila ? null : errorAccion.mensaje;
  }, [altaVisible, cuentasOrdenadas, errorAccion]);

  const alternarAlta = () => {
    setAltaVisible((v) => !v);
    setErrorAccion(null);
    setAviso(null);
  };

  const renderCuenta = (cuenta: CuentaBancariaEmpresa) => {
    const iban = String(cuenta.iban ?? '');
    const esPredeterminada = normalizarIban(iban) === ibanPredeterminado && Boolean(ibanPredeterminado);
    const inactiva = cuenta.activa === false;
    const enEdicion = editandoIban === iban;
    /** Solo para el indicador de progreso: el bloqueo es de todo el bloque. */
    const ocupada = enCurso === iban;
    const confirmando = confirmandoIban === iban;
    const errorFila = errorAccion?.clave === iban ? errorAccion.mensaje : null;
    const banco = String(cuenta.bancoNombre ?? '').trim();
    const codigo = String(cuenta.bancoCodigo ?? '').trim();
    const notas = String(cuenta.notas ?? '').trim();

    return (
      <View
        key={iban}
        style={[
          styles.fila,
          apilado && styles.filaApilada,
          esPredeterminada && styles.filaPredeterminada,
          inactiva && styles.filaInactiva,
        ]}
      >
        <View style={[styles.filaDatos, apilado && styles.filaDatosApilada]}>
          <TouchableOpacity
            style={[styles.radio, isCompact && styles.pulsableComodo]}
            onPress={() => marcarPredeterminada(iban)}
            disabled={!puedeEditar || inactiva || esPredeterminada || hayAccionEnCurso}
            accessibilityRole="radio"
            accessibilityState={{ selected: esPredeterminada, disabled: !puedeEditar || inactiva }}
            accessibilityLabel={
              esPredeterminada ? 'Cuenta predeterminada' : `Marcar ${formatearIbanLegible(iban)} como predeterminada`
            }
          >
            {ocupada ? (
              <ActivityIndicator size="small" color={COLOR_PRIMARIO} />
            ) : (
              <MaterialIcons
                name={esPredeterminada ? 'radio-button-checked' : 'radio-button-unchecked'}
                size={22}
                color={esPredeterminada ? COLOR_EXITO : inactiva || !puedeEditar ? '#cbd5e1' : '#94a3b8'}
              />
            )}
          </TouchableOpacity>

          <View style={styles.cuerpo}>
            <View style={styles.lineaIban}>
              <Text style={[styles.iban, isCompact && styles.ibanComodo]} selectable>
                {formatearIbanLegible(iban)}
              </Text>
              {esPredeterminada ? (
                <View style={styles.chipPredeterminada}>
                  <MaterialIcons name="star" size={12} color={COLOR_EXITO} />
                  <Text style={styles.chipPredeterminadaTexto}>Predeterminada</Text>
                </View>
              ) : null}
              {inactiva ? (
                <View style={styles.chipInactiva}>
                  <Text style={styles.chipInactivaTexto}>Desactivada</Text>
                </View>
              ) : null}
            </View>

            {enEdicion ? (
              <View style={[styles.lineaCampos, apilado && styles.lineaCamposApilada]}>
                <View style={[styles.campoBanco, apilado && styles.sinFlexEnApilado]}>
                  <Text style={styles.etiqueta}>Banco</Text>
                  <TextInput
                    style={[styles.input, isCompact && styles.inputComodo]}
                    value={editBanco}
                    onChangeText={setEditBanco}
                    placeholder="Nombre del banco"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
                <View style={[styles.campoNotas, apilado && styles.sinFlexEnApilado]}>
                  <Text style={styles.etiqueta}>Notas</Text>
                  <TextInput
                    style={[styles.input, isCompact && styles.inputComodo]}
                    value={editNotas}
                    onChangeText={setEditNotas}
                    placeholder="Notas de la cuenta"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
              </View>
            ) : (
              <View style={[styles.lineaCampos, apilado && styles.lineaCamposApilada]}>
                <Text
                  style={[styles.textoBanco, isCompact && styles.textoComodo, apilado && styles.sinFlexEnApilado]}
                  numberOfLines={1}
                >
                  {banco || (codigo ? `Entidad ${codigo}` : 'Banco sin identificar')}
                </Text>
                <Text
                  style={[styles.textoNotas, isCompact && styles.textoComodo, apilado && styles.sinFlexEnApilado]}
                  numberOfLines={2}
                >
                  {notas || '—'}
                </Text>
              </View>
            )}

            {esPredeterminada && puedeEditar ? (
              <Text style={styles.pistaFila}>
                {totalActivas > 1
                  ? 'No se puede desactivar: es la cuenta que usa el sistema. Marca antes otra como predeterminada.'
                  : 'No se puede desactivar: es la única cuenta activa y la que usa el sistema.'}
              </Text>
            ) : null}
            {inactiva && puedeEditar ? (
              <Text style={styles.pistaFila}>Reactívala para poder marcarla como predeterminada.</Text>
            ) : null}
            {confirmando ? (
              <View style={styles.confirmacion}>
                <Text style={styles.confirmacionTexto}>
                  ¿Desactivar esta cuenta? Dejará de estar disponible, pero no se borra.
                </Text>
                <View style={styles.confirmacionBotones}>
                  <TouchableOpacity
                    style={[styles.btnSecundario, isCompact && styles.pulsableComodo]}
                    onPress={() => setConfirmandoIban(null)}
                    disabled={hayAccionEnCurso}
                  >
                    <Text style={styles.btnSecundarioTexto}>Cancelar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnPeligro, isCompact && styles.pulsableComodo]}
                    onPress={() => desactivar(iban)}
                    disabled={hayAccionEnCurso}
                  >
                    {ocupada ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.btnPeligroTexto}>Sí, desactivar</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
            {errorFila ? (
              <View style={styles.avisoError}>
                <MaterialIcons name="error-outline" size={16} color={COLOR_ERROR} />
                <Text style={styles.avisoErrorTexto}>{errorFila}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {puedeEditar ? (
          <View style={[styles.acciones, apilado && styles.accionesApiladas]}>
            {enEdicion ? (
              <>
                <TouchableOpacity
                  style={[styles.btnIcono, isCompact && styles.pulsableComodo]}
                  onPress={() => setEditandoIban(null)}
                  disabled={hayAccionEnCurso}
                  accessibilityLabel="Cancelar edición"
                >
                  <MaterialIcons name="close" size={18} color="#64748b" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnIcono, styles.btnIconoPrimario, isCompact && styles.pulsableComodo]}
                  onPress={() => guardarEdicion(iban)}
                  disabled={hayAccionEnCurso}
                  accessibilityLabel="Guardar cambios de la cuenta"
                >
                  {ocupada ? <ActivityIndicator size="small" color="#fff" /> : <MaterialIcons name="check" size={18} color="#fff" />}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={[styles.btnIcono, isCompact && styles.pulsableComodo]}
                  onPress={() => abrirEdicion(cuenta)}
                  disabled={hayAccionEnCurso}
                  accessibilityLabel="Editar banco y notas"
                >
                  <MaterialIcons name="edit" size={18} color={COLOR_PRIMARIO} />
                </TouchableOpacity>
                {inactiva ? (
                  <TouchableOpacity
                    style={[styles.btnIcono, isCompact && styles.pulsableComodo]}
                    onPress={() => reactivar(iban)}
                    disabled={hayAccionEnCurso}
                    accessibilityLabel="Reactivar cuenta"
                  >
                    <MaterialIcons name="restore" size={18} color={COLOR_EXITO} />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[
                      styles.btnIcono,
                      esPredeterminada && styles.btnIconoDeshabilitado,
                      isCompact && styles.pulsableComodo,
                    ]}
                    onPress={() => {
                      setErrorAccion(null);
                      setConfirmandoIban(iban);
                    }}
                    disabled={esPredeterminada || hayAccionEnCurso || confirmando}
                    accessibilityLabel={
                      esPredeterminada
                        ? 'No se puede desactivar la cuenta predeterminada'
                        : 'Desactivar cuenta'
                    }
                  >
                    <MaterialIcons name="block" size={18} color={esPredeterminada ? '#cbd5e1' : COLOR_ERROR} />
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.bloque}>
      <View style={styles.cabecera}>
        <View style={styles.cabeceraIzq}>
          <MaterialIcons name="account-balance" size={16} color={COLOR_PRIMARIO} />
          <Text style={styles.titulo}>Cuentas bancarias</Text>
          {!cargando && !errorCarga && cuentasOrdenadas.length > 0 ? (
            <Text style={styles.contador}>
              {totalActivas} activa{totalActivas !== 1 ? 's' : ''}
              {cuentasOrdenadas.length !== totalActivas
                ? ` · ${cuentasOrdenadas.length - totalActivas} desactivada${cuentasOrdenadas.length - totalActivas !== 1 ? 's' : ''}`
                : ''}
            </Text>
          ) : null}
        </View>
        {puedeEditar && !cargando && !errorCarga ? (
          <TouchableOpacity
            style={[styles.btnAnadir, isCompact && styles.pulsableComodo]}
            onPress={alternarAlta}
            disabled={hayAccionEnCurso}
            accessibilityLabel={altaVisible ? 'Cancelar alta de cuenta' : 'Añadir cuenta bancaria'}
          >
            <MaterialIcons name={altaVisible ? 'close' : 'add-circle-outline'} size={16} color={COLOR_PRIMARIO} />
            <Text style={styles.btnAnadirTexto}>{altaVisible ? 'Cancelar' : 'Añadir cuenta'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={styles.ayuda}>
        {puedeEditar
          ? 'La cuenta predeterminada es la que usan facturas, remesas y pagos. El IBAN no se puede modificar: da de alta la cuenta correcta y desactiva la antigua.'
          : 'Consulta de solo lectura: no tienes permiso para gestionar las cuentas bancarias.'}
      </Text>

      {punteroSinCuenta ? (
        <View style={styles.avisoAmbar}>
          <MaterialIcons name="warning" size={16} color={COLOR_AVISO} />
          <Text style={styles.avisoAmbarTexto}>
            El IBAN antiguo de esta empresa no se pudo migrar (era inválido o ya estaba dado de alta en otra empresa).
            Da de alta la cuenta correcta y márcala como predeterminada.
          </Text>
        </View>
      ) : null}

      {cargando ? (
        <View style={styles.estado}>
          <ActivityIndicator size="small" color={COLOR_PRIMARIO} />
          <Text style={styles.estadoTexto}>Cargando cuentas…</Text>
        </View>
      ) : errorCarga ? (
        <View style={styles.estadoError}>
          <MaterialIcons name="error-outline" size={16} color={COLOR_ERROR} />
          <Text style={styles.estadoErrorTexto}>{errorCarga}</Text>
          <TouchableOpacity
            style={[styles.btnSecundario, isCompact && styles.pulsableComodo]}
            onPress={() => cargar()}
            accessibilityLabel="Reintentar carga de cuentas"
          >
            <Text style={styles.btnSecundarioTexto}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {altaVisible && puedeEditar ? (
            <View style={styles.alta}>
              <Text style={styles.altaTitulo}>Nueva cuenta</Text>
              <View style={[styles.lineaCampos, apilado && styles.lineaCamposApilada]}>
                <View style={[styles.campoAltaIban, apilado && styles.sinFlexEnApilado]}>
                  <Text style={styles.etiqueta}>IBAN *</Text>
                  <TextInput
                    style={[styles.input, isCompact && styles.inputComodo]}
                    value={altaIban}
                    onChangeText={setAltaIban}
                    placeholder="ES00 0000 0000 0000 0000 0000"
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="characters"
                    autoCorrect={false}
                  />
                </View>
                <View style={[styles.campoAltaNotas, apilado && styles.sinFlexEnApilado]}>
                  <Text style={styles.etiqueta}>Notas</Text>
                  <TextInput
                    style={[styles.input, isCompact && styles.inputComodo]}
                    value={altaNotas}
                    onChangeText={setAltaNotas}
                    placeholder="Opcional"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
              </View>
              <Text style={styles.pista}>
                Puedes pegarlo con espacios o guiones. El banco se deduce del IBAN y luego se puede editar.
              </Text>
              {errorAccion?.clave === CLAVE_ALTA ? (
                <View style={styles.avisoError}>
                  <MaterialIcons name="error-outline" size={16} color={COLOR_ERROR} />
                  <Text style={styles.avisoErrorTexto}>{errorAccion.mensaje}</Text>
                </View>
              ) : null}
              <View style={styles.altaAcciones}>
                <TouchableOpacity
                  style={[styles.btnSecundario, isCompact && styles.pulsableComodo]}
                  onPress={alternarAlta}
                  disabled={hayAccionEnCurso}
                >
                  <Text style={styles.btnSecundarioTexto}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.btnPrimario,
                    (!altaIban.trim() || hayAccionEnCurso) && styles.btnPrimarioDeshabilitado,
                    isCompact && styles.pulsableComodo,
                  ]}
                  onPress={crearCuenta}
                  disabled={!altaIban.trim() || hayAccionEnCurso}
                >
                  {enCurso === CLAVE_ALTA ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <MaterialIcons name="add" size={16} color="#fff" />
                  )}
                  <Text style={styles.btnPrimarioTexto}>Añadir cuenta</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {errorAccionSinFila ? (
            <View style={styles.avisoError}>
              <MaterialIcons name="error-outline" size={16} color={COLOR_ERROR} />
              <Text style={styles.avisoErrorTexto}>{errorAccionSinFila}</Text>
            </View>
          ) : null}
          {aviso ? (
            <View style={styles.avisoOk}>
              <MaterialIcons name="check-circle-outline" size={16} color={COLOR_EXITO} />
              <Text style={styles.avisoOkTexto}>{aviso}</Text>
            </View>
          ) : null}

          {cuentasOrdenadas.length === 0 ? (
            <View style={styles.vacio}>
              <Text style={styles.vacioTexto}>Esta empresa no tiene ninguna cuenta bancaria.</Text>
              {puedeEditar ? (
                <Text style={styles.pista}>La primera cuenta que añadas quedará como predeterminada.</Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.lista}>{cuentasOrdenadas.map(renderCuenta)}</View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bloque: {
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 12,
    marginTop: 8,
    gap: 8,
  },
  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  cabeceraIzq: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  titulo: { fontSize: 13, fontWeight: '700', color: '#334155' },
  contador: { fontSize: 12, color: '#64748b' },
  ayuda: { fontSize: 12, color: '#64748b', lineHeight: 17 },
  pista: { fontSize: 12, color: '#94a3b8', lineHeight: 16 },
  pistaFila: { fontSize: 12, color: '#94a3b8', lineHeight: 16, marginTop: 2 },
  btnAnadir: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
  },
  btnAnadirTexto: { fontSize: 12, fontWeight: '600', color: COLOR_PRIMARIO },
  pulsableComodo: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, justifyContent: 'center' },
  estado: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  estadoTexto: { fontSize: 12, color: '#64748b' },
  estadoError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    flexWrap: 'wrap',
  },
  estadoErrorTexto: { flex: 1, fontSize: 12, color: '#b91c1c', lineHeight: 17 },
  avisoAmbar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  avisoAmbarTexto: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 17 },
  avisoError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  avisoErrorTexto: { flex: 1, fontSize: 12, color: '#b91c1c', lineHeight: 17 },
  avisoOk: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  avisoOkTexto: { flex: 1, fontSize: 12, color: '#15803d', lineHeight: 17 },
  vacio: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    gap: 4,
  },
  vacioTexto: { fontSize: 12, color: '#475569' },
  lista: { gap: 8 },
  fila: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    backgroundColor: '#ffffff',
  },
  filaApilada: { flexDirection: 'column', alignItems: 'stretch' },
  filaPredeterminada: { borderColor: '#bbf7d0', backgroundColor: '#f8fffb' },
  filaInactiva: { opacity: 0.6, backgroundColor: '#f8fafc' },
  filaDatos: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  // En apilado el contenedor es una columna: flexBasis 0 colapsaría el alto.
  filaDatosApilada: { flexGrow: 0, flexBasis: 'auto' },
  radio: { paddingVertical: 2, paddingHorizontal: 2, alignItems: 'center' },
  cuerpo: { flex: 1, gap: 4 },
  lineaIban: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  iban: { fontSize: 13, fontWeight: '700', color: '#0f172a', letterSpacing: 0.4 },
  ibanComodo: { fontSize: 15 },
  chipPredeterminada: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: '#dcfce7',
  },
  chipPredeterminadaTexto: { fontSize: 11, fontWeight: '700', color: '#15803d' },
  chipInactiva: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: '#e2e8f0',
  },
  chipInactivaTexto: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  lineaCampos: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  lineaCamposApilada: { flexDirection: 'column', gap: 6 },
  campoBanco: { flex: 1, gap: 2 },
  campoNotas: { flex: 1.4, gap: 2 },
  campoAltaIban: { flex: 1.6, gap: 2 },
  campoAltaNotas: { flex: 1, gap: 2 },
  /** En columna, flexBasis 0 colapsaría el contenido: se deja al tamaño del contenido. */
  sinFlexEnApilado: { flexGrow: 0, flexBasis: 'auto' },
  etiqueta: { fontSize: 11, fontWeight: '600', color: '#94a3b8' },
  textoBanco: { flex: 1, fontSize: 12, color: '#334155', fontWeight: '500' },
  textoNotas: { flex: 1.4, fontSize: 12, color: '#64748b', lineHeight: 17 },
  textoComodo: { fontSize: 13 },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: '#334155',
  },
  inputComodo: { minHeight: MIN_TOUCH, fontSize: 14 },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  accionesApiladas: { justifyContent: 'flex-end', marginTop: 4 },
  btnIcono: {
    padding: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnIconoPrimario: { backgroundColor: COLOR_PRIMARIO, borderColor: COLOR_PRIMARIO },
  btnIconoDeshabilitado: { opacity: 0.5 },
  confirmacion: {
    marginTop: 6,
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    gap: 8,
  },
  confirmacionTexto: { fontSize: 12, color: '#b91c1c', lineHeight: 17 },
  confirmacionBotones: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
  alta: {
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    backgroundColor: '#f0f9ff',
    gap: 8,
  },
  altaTitulo: { fontSize: 12, fontWeight: '700', color: '#0369a1' },
  altaAcciones: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
  btnPrimario: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: COLOR_PRIMARIO,
  },
  btnPrimarioDeshabilitado: { opacity: 0.5 },
  btnPrimarioTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },
  btnSecundario: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSecundarioTexto: { fontSize: 12, fontWeight: '600', color: '#475569' },
  btnPeligro: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: COLOR_ERROR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPeligroTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },
});
