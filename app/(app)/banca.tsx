/**
 * Banca — importación de extractos bancarios y consulta de movimientos.
 *
 * Dos vistas sobre la misma pantalla:
 * - «Movimientos»: consulta filtrada por empresa/cuenta, rango de fechas y
 *   estado de conciliación. La API exige al menos uno de esos tres filtros, así
 *   que sin filtro no se lanza la petición: se invita a elegir uno.
 * - «Cargas»: histórico de ficheros importados y, al seleccionar uno, su detalle
 *   con incidencias, descuadres y el enlace al fichero original del banco.
 *
 * La conciliación con facturas no entra aquí: esta pantalla solo importa y
 * consulta.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { MIN_TOUCH } from '../constants/layout';
import { TablaBasica } from '../components/TablaBasica';
import { SelectorDesplegable, type OpcionDesplegable } from '../components/SelectorDesplegable';
import { RangoFechas } from '../components/RangoFechas';
import { useLocalToast } from '../components/Toast';
import { useConfirmar } from '../hooks/useConfirmar';
import { CargaExtractoDetalle } from '../components/banca/CargaExtractoDetalle';
import { ImportarExtractoModal } from '../components/banca/ImportarExtractoModal';
import { apiFetch, errorMessage } from '../utils/api';
import { formatMoneda, esEmpresaSedeGrupoParipe } from '../utils/facturacion';
import { formatCreadoEn, formatFecha } from '../utils/formatFecha';
import { limpiarIban, validarIban } from '../lib/iban';
import {
  ESTADO_CONCILIACION_PENDIENTE,
  beneficiarioMovimiento,
  conceptoCortoMovimiento,
  esCargo,
  estiloBadgeBanco,
  etiquetaBancoMovimiento,
  etiquetaEstadoCarga,
  hayFiltroMovimientos,
  ibanLegible,
  importeMovimiento,
  nombreFormato,
  periodoCarga,
  queryCargas,
  queryMovimientos,
  textoBusquedaMovimiento,
  totalesMovimientos,
} from '../lib/banca';
import type {
  CargaExtracto,
  FiltrosCargas,
  FiltrosMovimientos,
  FormatoExtracto,
  MovimientoBanca,
} from '../types/banca';

type Vista = 'movimientos' | 'cargas';

type EmpresaOpcion = { id: string; nombre: string };

type CuentaOpcion = { iban: string; empresaId: string; empresaNombre: string; titular: string };

const COLUMNAS_MOVIMIENTOS = [
  'Fecha',
  'Banco',
  'Concepto',
  'Beneficiario',
  'Importe',
  'Empresa',
  'Cuenta',
];

const COLUMNAS_CARGAS = [
  'Importado',
  'Periodo',
  'Fichero',
  'Formato',
  'Estado',
  'Cuentas',
  'Leídos',
  'Nuevos',
  'Duplicados',
  'Errores',
  'Avisos',
];

const FILTROS_MOVIMIENTOS_VACIOS: FiltrosMovimientos = {
  iban: '',
  empresaId: '',
  estado: '',
  desde: '',
  hasta: '',
};

const FILTROS_CARGAS_VACIOS: FiltrosCargas = { estado: '', iban: '', desde: '', hasta: '' };

const OPCIONES_ESTADO_CARGA: OpcionDesplegable[] = [
  { id: '', titulo: 'Todas las cargas', icono: 'inbox' },
  { id: 'cargado', titulo: 'Cargadas', subtitulo: 'Cuenta identificada', icono: 'check-circle' },
  {
    id: 'pendiente_cuenta',
    titulo: 'Cuenta sin asignar',
    subtitulo: 'El IBAN no está de alta en ninguna empresa',
    icono: 'link-off',
  },
];

/** Nombre visible de una empresa venga como venga del maestro. */
function nombreEmpresa(item: Record<string, unknown>): string {
  const candidatos = [item.Nombre, item.nombre, item.Alias, item.alias];
  for (const c of candidatos) {
    const texto = String(c ?? '').trim();
    if (texto) return texto;
  }
  return '';
}

export default function BancaScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();
  const { isCompact, shouldStackPanels, shouldStackToolbar } = useBreakpoint();
  const { show: mostrarToast, ToastView } = useLocalToast();
  const { confirmar, ConfirmarView } = useConfirmar();

  const puedeVer = hasPermiso('banca.ver');
  const puedeImportar = hasPermiso('banca.importar');
  const puedeVerEmpresas = hasPermiso('empresas.ver');

  const [vista, setVista] = useState<Vista>('movimientos');
  const [formatos, setFormatos] = useState<FormatoExtracto[]>([]);
  const [formatosCargando, setFormatosCargando] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  const [filtros, setFiltros] = useState<FiltrosMovimientos>(FILTROS_MOVIMIENTOS_VACIOS);
  const [movimientos, setMovimientos] = useState<MovimientoBanca[]>([]);
  const [cursor, setCursor] = useState('');
  const [movimientosCargando, setMovimientosCargando] = useState(false);
  const [masCargando, setMasCargando] = useState(false);
  const [movimientosError, setMovimientosError] = useState<string | null>(null);
  const [filaMovimiento, setFilaMovimiento] = useState<number | null>(null);
  const [busquedaMovimientos, setBusquedaMovimientos] = useState('');
  const [ibanManual, setIbanManual] = useState('');

  const [filtrosCargas, setFiltrosCargas] = useState<FiltrosCargas>(FILTROS_CARGAS_VACIOS);
  const [cargas, setCargas] = useState<CargaExtracto[]>([]);
  const [cargasCargando, setCargasCargando] = useState(false);
  const [cargasError, setCargasError] = useState<string | null>(null);
  const [filaCarga, setFilaCarga] = useState<number | null>(null);
  const [busquedaCargas, setBusquedaCargas] = useState('');
  const [detalle, setDetalle] = useState<CargaExtracto | null>(null);
  const [detalleUrl, setDetalleUrl] = useState('');
  const [detalleCargando, setDetalleCargando] = useState(false);
  const [detalleError, setDetalleError] = useState<string | null>(null);
  const [borrandoCarga, setBorrandoCarga] = useState(false);

  const [empresas, setEmpresas] = useState<EmpresaOpcion[]>([]);
  const [empresasCargando, setEmpresasCargando] = useState(false);
  const [cuentasEmpresa, setCuentasEmpresa] = useState<string[]>([]);

  /** Descarta respuestas de peticiones que ya no corresponden al filtro actual. */
  const peticionMovimientos = useRef(0);
  const peticionCargas = useRef(0);
  const peticionDetalle = useRef(0);

  // ---------------------------------------------------------------- catálogos

  useEffect(() => {
    if (!puedeVer) return;
    let vivo = true;
    setFormatosCargando(true);
    apiFetch('/api/banca/formatos')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'No se han podido cargar los formatos');
        return Array.isArray(data.formatos) ? (data.formatos as FormatoExtracto[]) : [];
      })
      .then((lista) => {
        if (vivo) setFormatos(lista);
      })
      .catch(() => {
        // Sin catálogo se sigue pudiendo importar: `lib/banca` trae extensiones
        // de reserva y el backend detecta el formato por la extensión.
        if (vivo) setFormatos([]);
      })
      .finally(() => {
        if (vivo) setFormatosCargando(false);
      });
    return () => {
      vivo = false;
    };
  }, [puedeVer]);

  useEffect(() => {
    if (!puedeVer || !puedeVerEmpresas) return;
    let vivo = true;
    setEmpresasCargando(true);
    apiFetch('/api/empresas')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'No se han podido cargar las empresas');
        const lista = Array.isArray(data.empresas) ? (data.empresas as Record<string, unknown>[]) : [];
        return lista
          .filter((item) => esEmpresaSedeGrupoParipe(item as { Sede?: string; sede?: string }))
          .map((item) => ({ id: String(item.id_empresa ?? '').trim(), nombre: nombreEmpresa(item) }))
          .filter((e) => e.id && e.nombre)
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      })
      .then((lista) => {
        if (!vivo) return;
        setEmpresas(lista);
        // Si había una empresa ajena al grupo seleccionada (p. ej. de una
        // sesión anterior), la quitamos para no consultar fuera del universo.
        setFiltros((prev) => {
          const id = prev.empresaId.trim();
          if (!id || lista.some((e) => e.id === id)) return prev;
          return { ...prev, empresaId: '', iban: '' };
        });
      })
      .catch(() => {
        // El maestro de empresas es un lujo aquí: si falla, las empresas y las
        // cuentas se derivan del histórico de cargas (solo pide `banca.ver`).
        if (vivo) setEmpresas([]);
      })
      .finally(() => {
        if (vivo) setEmpresasCargando(false);
      });
    return () => {
      vivo = false;
    };
  }, [puedeVer, puedeVerEmpresas]);

  // Cuentas de alta de la empresa elegida: añade las que aún no tienen ningún
  // movimiento importado. Si no hay permiso o falla, no se rompe nada.
  useEffect(() => {
    const empresaId = filtros.empresaId.trim();
    if (!puedeVer || !puedeVerEmpresas || !empresaId) {
      setCuentasEmpresa([]);
      return;
    }
    let vivo = true;
    apiFetch(`/api/empresas/${encodeURIComponent(empresaId)}/cuentas`)
      .then(async (res) => {
        if (!res.ok) throw new Error('sin cuentas');
        const data = await res.json().catch(() => ({}));
        const lista = Array.isArray(data.cuentas) ? (data.cuentas as Record<string, unknown>[]) : [];
        return lista
          .filter((c) => c.activa !== false)
          .map((c) => limpiarIban(c.iban))
          .filter(Boolean);
      })
      .then((lista) => {
        if (vivo) setCuentasEmpresa(lista);
      })
      .catch(() => {
        if (vivo) setCuentasEmpresa([]);
      });
    return () => {
      vivo = false;
    };
  }, [filtros.empresaId, puedeVer, puedeVerEmpresas]);

  // ------------------------------------------------------------------ cargas

  const cargarCargas = useCallback(async () => {
    if (!puedeVer) return;
    const marca = ++peticionCargas.current;
    setCargasCargando(true);
    setCargasError(null);
    try {
      const res = await apiFetch(queryCargas(filtrosCargas));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'No se ha podido cargar el historial de importaciones');
      if (marca !== peticionCargas.current) return;
      setCargas(Array.isArray(data.ficheros) ? (data.ficheros as CargaExtracto[]) : []);
    } catch (e) {
      if (marca !== peticionCargas.current) return;
      setCargas([]);
      setCargasError(errorMessage(e, 'No se ha podido cargar el historial de importaciones'));
    } finally {
      if (marca === peticionCargas.current) setCargasCargando(false);
    }
  }, [filtrosCargas, puedeVer]);

  useEffect(() => {
    void cargarCargas();
  }, [cargarCargas]);

  const cargasFiltradas = useMemo(() => {
    const q = busquedaCargas.trim().toLowerCase();
    if (!q) return cargas;
    return cargas.filter((c) => {
      const texto = [
        c.nombreFichero,
        c.formato,
        c.importadoPor,
        ...(c.cuentas || []).flatMap((cu) => [cu.iban, cu.titular, cu.empresaNombre]),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return texto.includes(q);
    });
  }, [busquedaCargas, cargas]);

  const cargaSeleccionada = filaCarga != null ? cargasFiltradas[filaCarga] ?? null : null;
  const hashSeleccionado = cargaSeleccionada?.hashFichero ?? '';

  const cargarDetalle = useCallback(async (hash: string) => {
    const marca = ++peticionDetalle.current;
    setDetalleCargando(true);
    setDetalleError(null);
    try {
      const res = await apiFetch(`/api/banca/ficheros/${encodeURIComponent(hash)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'No se ha podido cargar el detalle de la importación');
      if (marca !== peticionDetalle.current) return;
      setDetalle((data.fichero ?? null) as CargaExtracto | null);
      setDetalleUrl(String(data.urlOriginal || ''));
    } catch (e) {
      if (marca !== peticionDetalle.current) return;
      setDetalle(null);
      setDetalleUrl('');
      setDetalleError(errorMessage(e, 'No se ha podido cargar el detalle de la importación'));
    } finally {
      if (marca === peticionDetalle.current) setDetalleCargando(false);
    }
  }, []);

  useEffect(() => {
    if (!hashSeleccionado) {
      peticionDetalle.current += 1;
      setDetalle(null);
      setDetalleUrl('');
      setDetalleError(null);
      setDetalleCargando(false);
      return;
    }
    void cargarDetalle(hashSeleccionado);
  }, [cargarDetalle, hashSeleccionado]);

  // ------------------------------------------------------------- movimientos

  const hayFiltro = hayFiltroMovimientos(filtros);

  const cargarMovimientos = useCallback(
    async (cursorPagina = '') => {
      if (!puedeVer) return;
      const marca = ++peticionMovimientos.current;
      if (!hayFiltroMovimientos(filtros)) {
        setMovimientos([]);
        setCursor('');
        setMovimientosError(null);
        setMovimientosCargando(false);
        return;
      }
      const esMas = Boolean(cursorPagina);
      if (esMas) setMasCargando(true);
      else setMovimientosCargando(true);
      setMovimientosError(null);
      try {
        const res = await apiFetch(queryMovimientos(filtros, cursorPagina));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'No se han podido cargar los movimientos');
        if (marca !== peticionMovimientos.current) return;
        const lista = Array.isArray(data.movimientos) ? (data.movimientos as MovimientoBanca[]) : [];
        setMovimientos((prev) => (esMas ? [...prev, ...lista] : lista));
        setCursor(String(data.cursor || ''));
      } catch (e) {
        if (marca !== peticionMovimientos.current) return;
        if (!esMas) {
          setMovimientos([]);
          setCursor('');
        }
        setMovimientosError(errorMessage(e, 'No se han podido cargar los movimientos'));
      } finally {
        if (marca !== peticionMovimientos.current) return;
        setMasCargando(false);
        setMovimientosCargando(false);
      }
    },
    [filtros, puedeVer],
  );

  useEffect(() => {
    setFilaMovimiento(null);
    void cargarMovimientos();
  }, [cargarMovimientos]);

  const movimientosFiltrados = useMemo(() => {
    const q = busquedaMovimientos.trim().toLowerCase();
    if (!q) return movimientos;
    return movimientos.filter((m) => textoBusquedaMovimiento(m).includes(q));
  }, [busquedaMovimientos, movimientos]);

  const totales = useMemo(() => totalesMovimientos(movimientosFiltrados), [movimientosFiltrados]);

  // ------------------------------------------------------------------ filtros

  /** Cuentas conocidas: las que ya han aparecido en alguna carga importada. */
  const cuentasConocidas = useMemo(() => {
    const mapa = new Map<string, CuentaOpcion>();
    for (const carga of cargas) {
      for (const cuenta of carga.cuentas || []) {
        const iban = limpiarIban(cuenta.iban || cuenta.cuentaRef);
        if (!iban || mapa.has(iban)) continue;
        mapa.set(iban, {
          iban,
          empresaId: String(cuenta.empresaId || '').trim(),
          empresaNombre: String(cuenta.empresaNombre || '').trim(),
          titular: String(cuenta.titular || '').trim(),
        });
      }
    }
    for (const iban of cuentasEmpresa) {
      if (mapa.has(iban)) continue;
      const empresa = empresas.find((e) => e.id === filtros.empresaId.trim());
      mapa.set(iban, {
        iban,
        empresaId: filtros.empresaId.trim(),
        empresaNombre: empresa?.nombre ?? '',
        titular: '',
      });
    }
    return [...mapa.values()].sort((a, b) => a.iban.localeCompare(b.iban));
  }, [cargas, cuentasEmpresa, empresas, filtros.empresaId]);

  /** Empresas del selector: solo sede Grupo Paripe (maestro). Sin permiso, las del histórico. */
  const empresasOpciones = useMemo<OpcionDesplegable[]>(() => {
    const base = empresas.length > 0
      ? empresas
      : [
          ...new Map(
            cuentasConocidas
              .filter((c) => c.empresaId && c.empresaNombre)
              .map((c) => [c.empresaId, { id: c.empresaId, nombre: c.empresaNombre }]),
          ).values(),
        ].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return [
      { id: '', titulo: 'Todas las empresas del grupo', icono: 'business' },
      ...base.map((e) => ({ id: e.id, titulo: e.nombre, icono: 'business' as const })),
    ];
  }, [cuentasConocidas, empresas]);

  const cuentasOpciones = useMemo<OpcionDesplegable[]>(() => {
    const empresaId = filtros.empresaId.trim();
    const visibles = empresaId
      ? cuentasConocidas.filter((c) => !c.empresaId || c.empresaId === empresaId)
      : cuentasConocidas;
    return [
      { id: '', titulo: 'Todas las cuentas', icono: 'account-balance' },
      ...visibles.map((c) => ({
        id: c.iban,
        titulo: ibanLegible(c.iban),
        subtitulo: c.empresaNombre || c.titular || 'Cuenta sin empresa asignada',
        icono: 'account-balance' as const,
      })),
    ];
  }, [cuentasConocidas, filtros.empresaId]);

  const elegirEmpresa = useCallback((id: string) => {
    // Con una cuenta elegida el backend ignora `empresaId`: al cambiar de
    // empresa se suelta la cuenta para que el filtro no engañe.
    setFiltros((prev) => ({ ...prev, empresaId: id, iban: '' }));
    setIbanManual('');
  }, []);

  const elegirCuenta = useCallback((iban: string) => {
    setFiltros((prev) => ({ ...prev, iban }));
    setIbanManual('');
  }, []);

  const aplicarIbanManual = useCallback(() => {
    const iban = limpiarIban(ibanManual);
    if (!iban) {
      setFiltros((prev) => ({ ...prev, iban: '' }));
      return;
    }
    const validacion = validarIban(iban);
    if (!validacion.valido) {
      mostrarToast('IBAN inválido', validacion.motivo ?? 'Revisa el IBAN escrito.', 'error');
      return;
    }
    setFiltros((prev) => ({ ...prev, iban }));
  }, [ibanManual, mostrarToast]);

  const alternarPendientes = useCallback(() => {
    setFiltros((prev) => ({
      ...prev,
      estado: prev.estado ? '' : ESTADO_CONCILIACION_PENDIENTE,
    }));
  }, []);

  const limpiarFiltros = useCallback(() => {
    setFiltros(FILTROS_MOVIMIENTOS_VACIOS);
    setIbanManual('');
    setBusquedaMovimientos('');
  }, []);

  const trasImportar = useCallback(
    (carga: CargaExtracto | null, yaCargado: boolean) => {
      void cargarCargas();
      void cargarMovimientos();
      if (yaCargado) return;
      const nuevos = Number(carga?.movimientosNuevos) || 0;
      mostrarToast(
        'Extracto importado',
        nuevos > 0
          ? `Se han guardado ${nuevos} movimiento(s) nuevo(s).`
          : 'El extracto no traía movimientos nuevos.',
        'success',
      );
    },
    [cargarCargas, cargarMovimientos, mostrarToast],
  );

  const trasAsignarCuenta = useCallback(
    (carga: CargaExtracto, resumen: { movimientosAsignados: number; empresaNombre: string }) => {
      setDetalle(carga);
      void cargarCargas();
      void cargarMovimientos();
      const n = Number(resumen.movimientosAsignados) || 0;
      mostrarToast(
        'Cuenta asignada',
        n > 0
          ? `${n} movimiento${n === 1 ? '' : 's'} vinculado${n === 1 ? '' : 's'}`
          : `Vinculada a ${resumen.empresaNombre || 'la empresa'}`,
        'success',
      );
    },
    [cargarCargas, cargarMovimientos, mostrarToast],
  );

  const borrarCargaSeleccionada = useCallback(async () => {
    if (!puedeImportar || borrandoCarga) return;
    const carga = filaCarga != null ? cargasFiltradas[filaCarga] : null;
    const hash = String(carga?.hashFichero || '').trim();
    if (!carga || !hash) {
      mostrarToast('Selecciona una carga', 'Elige una fila del historial para borrarla.', 'error');
      return;
    }
    const leidos = Number(carga.movimientosLeidos) || 0;
    const nombre = String(carga.nombreFichero || hash).trim();
    const ok = await confirmar(
      'Borrar carga',
      `Se eliminará «${nombre}», sus ${leidos} movimiento(s) importados y el fichero original. Podrás volver a importarlo después.`,
      { variant: 'danger', confirmarLabel: 'Borrar' },
    );
    if (!ok) return;

    setBorrandoCarga(true);
    try {
      const res = await apiFetch(`/api/banca/ficheros/${encodeURIComponent(hash)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'No se ha podido borrar la carga');
      const movs = Number(data.movimientosBorrados) || 0;
      setFilaCarga(null);
      setDetalle(null);
      setDetalleUrl('');
      void cargarCargas();
      void cargarMovimientos();
      mostrarToast(
        'Carga borrada',
        movs > 0
          ? `Se han eliminado ${movs} movimiento(s) y el registro de la carga.`
          : 'Se ha eliminado el registro de la carga.',
        'success',
      );
    } catch (e) {
      mostrarToast('No se ha podido borrar', errorMessage(e, 'Error al borrar la carga'), 'error');
    } finally {
      setBorrandoCarga(false);
    }
  }, [
    borrandoCarga,
    cargasFiltradas,
    cargarCargas,
    cargarMovimientos,
    confirmar,
    filaCarga,
    mostrarToast,
    puedeImportar,
  ]);

  // -------------------------------------------------------------------- celdas

  const valorCeldaMovimiento = useCallback((m: MovimientoBanca, col: string): string => {
    switch (col) {
      case 'Fecha':
        return formatFecha(m.fechaOperacion || '');
      case 'Banco':
        return etiquetaBancoMovimiento(m);
      case 'Concepto':
        return conceptoCortoMovimiento(m);
      case 'Beneficiario':
        return beneficiarioMovimiento(m) || '—';
      case 'Importe':
        return formatMoneda(importeMovimiento(m));
      case 'Empresa':
        return String(m.empresaNombre || '').trim() || 'Sin asignar';
      case 'Cuenta':
        return ibanLegible(m.iban || m.cuentaRef);
      default:
        return '';
    }
  }, []);

  const valorCeldaCarga = useCallback(
    (c: CargaExtracto, col: string): string => {
      switch (col) {
        case 'Importado':
          return formatCreadoEn(c.importadoEn || '');
        case 'Periodo':
          return periodoCarga(c, formatFecha);
        case 'Fichero':
          return String(c.nombreFichero || '').trim() || '—';
        case 'Formato':
          return nombreFormato(c.formato, formatos);
        case 'Estado':
          return etiquetaEstadoCarga(c.estado);
        case 'Cuentas':
          return (c.cuentas || []).map((cu) => ibanLegible(cu.iban)).join(', ') || '—';
        case 'Leídos':
          return String(Number(c.movimientosLeidos) || 0);
        case 'Nuevos':
          return String(Number(c.movimientosNuevos) || 0);
        case 'Duplicados':
          return String(Number(c.movimientosDuplicados) || 0);
        case 'Errores':
          return String(Number(c.lineasConError) || 0);
        case 'Avisos':
          return String(Number(c.avisosTotal) || 0);
        default:
          return '';
      }
    },
    [formatos],
  );

  // --------------------------------------------------------------------- gates

  if (!puedeVer) {
    return (
      <View style={styles.center}>
        <MaterialIcons name="lock" size={48} color="#94a3b8" />
        <Text style={styles.sinPermisoTexto}>No tienes permiso para acceder a Banca</Text>
        <TouchableOpacity style={styles.volverLink} onPress={() => router.push('/')}>
          <MaterialIcons name="arrow-back" size={18} color="#0ea5e9" />
          <Text style={styles.volverLinkTexto}>Volver al inicio</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Los filtros viven fuera de `TablaBasica`: sus estados de carga y de error
  // sustituyen la tabla entera (toolbar incluido) y dejarían al usuario sin
  // forma de cambiar el filtro que ha fallado.
  const filtrosMovimientos = (
    <View style={[styles.filtros, shouldStackToolbar && styles.filtrosApilados]}>
      <SelectorDesplegable
        icono="business"
        tituloLista="Empresa"
        iconoLista="business"
        placeholder="Todas las empresas"
        opciones={empresasOpciones}
        valorId={filtros.empresaId}
        onSeleccionar={elegirEmpresa}
        loading={empresasCargando}
        buscador={empresasOpciones.length > 12}
        buscadorPlaceholder="Buscar empresa…"
        compact
        style={styles.filtroSelector}
      />
      <SelectorDesplegable
        icono="account-balance"
        tituloLista="Cuenta bancaria"
        iconoLista="account-balance"
        placeholder="Todas las cuentas"
        opciones={cuentasOpciones}
        valorId={filtros.iban}
        onSeleccionar={elegirCuenta}
        loading={cargasCargando && cuentasOpciones.length <= 1}
        buscador={cuentasOpciones.length > 12}
        buscadorPlaceholder="Buscar IBAN…"
        vacioTexto="Todavía no hay cuentas con movimientos importados."
        compact
        style={styles.filtroSelectorAncho}
      />
      {cuentasOpciones.length <= 1 ? (
        <View style={styles.ibanManual}>
          <TextInput
            style={[styles.ibanInput, isCompact && styles.ibanInputComodo]}
            value={ibanManual}
            onChangeText={setIbanManual}
            onSubmitEditing={aplicarIbanManual}
            placeholder="IBAN de la cuenta"
            placeholderTextColor="#94a3b8"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
          />
          <TouchableOpacity
            style={styles.ibanBtn}
            onPress={aplicarIbanManual}
            accessibilityLabel="Buscar por IBAN"
          >
            <MaterialIcons name="search" size={16} color="#0ea5e9" />
          </TouchableOpacity>
        </View>
      ) : null}
      <RangoFechas
        desdeIso={filtros.desde}
        hastaIso={filtros.hasta}
        onChangeDesde={(iso) => setFiltros((prev) => ({ ...prev, desde: iso }))}
        onChangeHasta={(iso) => setFiltros((prev) => ({ ...prev, hasta: iso }))}
        placeholderDesde="Desde"
        placeholderHasta="Hasta"
        cellWidth={124}
        modoToolbar
      />
      <TouchableOpacity
        style={[styles.chip, filtros.estado ? styles.chipActivo : null, isCompact && styles.chipComodo]}
        onPress={alternarPendientes}
        accessibilityRole="button"
        accessibilityState={{ selected: Boolean(filtros.estado) }}
      >
        <MaterialIcons
          name={filtros.estado ? 'check-box' : 'check-box-outline-blank'}
          size={15}
          color={filtros.estado ? '#0369a1' : '#94a3b8'}
        />
        <Text style={[styles.chipTexto, filtros.estado ? styles.chipTextoActivo : null]}>
          Sin conciliar
        </Text>
      </TouchableOpacity>
      {hayFiltro ? (
        <TouchableOpacity
          style={[styles.chip, isCompact && styles.chipComodo]}
          onPress={limpiarFiltros}
          accessibilityLabel="Quitar filtros"
        >
          <MaterialIcons name="filter-alt-off" size={15} color="#94a3b8" />
          <Text style={styles.chipTexto}>Quitar filtros</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  const filtrosCargasUi = (
    <View style={[styles.filtros, shouldStackToolbar && styles.filtrosApilados]}>
      <SelectorDesplegable
        icono="inbox"
        tituloLista="Estado de la carga"
        iconoLista="inbox"
        placeholder="Todas las cargas"
        opciones={OPCIONES_ESTADO_CARGA}
        valorId={filtrosCargas.estado}
        onSeleccionar={(estado) => setFiltrosCargas((prev) => ({ ...prev, estado }))}
        compact
        style={styles.filtroSelector}
      />
      <RangoFechas
        desdeIso={filtrosCargas.desde}
        hastaIso={filtrosCargas.hasta}
        onChangeDesde={(iso) => setFiltrosCargas((prev) => ({ ...prev, desde: iso }))}
        onChangeHasta={(iso) => setFiltrosCargas((prev) => ({ ...prev, hasta: iso }))}
        placeholderDesde="Importado desde"
        placeholderHasta="Importado hasta"
        cellWidth={136}
        modoToolbar
      />
      {filtrosCargas.estado || filtrosCargas.desde || filtrosCargas.hasta ? (
        <TouchableOpacity
          style={[styles.chip, isCompact && styles.chipComodo]}
          onPress={() => setFiltrosCargas(FILTROS_CARGAS_VACIOS)}
          accessibilityLabel="Quitar filtros"
        >
          <MaterialIcons name="filter-alt-off" size={15} color="#94a3b8" />
          <Text style={styles.chipTexto}>Quitar filtros</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  const botonRefrescar = (
    <TouchableOpacity
      style={[styles.btnIcono, isCompact && styles.btnIconoComodo]}
      onPress={() => (vista === 'movimientos' ? void cargarMovimientos() : void cargarCargas())}
      disabled={vista === 'movimientos' ? movimientosCargando : cargasCargando}
      accessibilityLabel="Refrescar"
    >
      {(vista === 'movimientos' ? movimientosCargando : cargasCargando) ? (
        <ActivityIndicator size="small" color="#0ea5e9" />
      ) : (
        <MaterialIcons name="refresh" size={18} color="#0ea5e9" />
      )}
    </TouchableOpacity>
  );

  const botonBorrarCarga = puedeImportar ? (
    <TouchableOpacity
      style={[
        styles.btnIcono,
        isCompact && styles.btnIconoComodo,
        (!cargaSeleccionada || borrandoCarga) && styles.btnIconoDisabled,
      ]}
      onPress={() => void borrarCargaSeleccionada()}
      disabled={!cargaSeleccionada || borrandoCarga}
      accessibilityLabel="Borrar carga seleccionada"
    >
      {borrandoCarga ? (
        <ActivityIndicator size="small" color="#dc2626" />
      ) : (
        <MaterialIcons
          name="delete-outline"
          size={18}
          color={!cargaSeleccionada ? '#cbd5e1' : '#dc2626'}
        />
      )}
    </TouchableOpacity>
  ) : null;

  return (
    <View style={styles.container}>
      <View style={[styles.cabecera, shouldStackToolbar && styles.cabeceraApilada]}>
        <View style={styles.cabeceraTitulo}>
          <TouchableOpacity
            style={styles.btnAtras}
            onPress={() => router.push('/')}
            accessibilityLabel="Volver"
          >
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <View style={styles.cabeceraTextos}>
            <Text style={styles.titulo}>Banca</Text>
            <Text style={styles.subtitulo}>
              Extractos bancarios importados y movimientos de las cuentas del grupo
            </Text>
          </View>
        </View>

        <View style={styles.cabeceraAcciones}>
          <View style={styles.pestanas}>
            {(
              [
                { id: 'movimientos' as Vista, label: 'Movimientos', icono: 'swap-vert' as const },
                { id: 'cargas' as Vista, label: 'Cargas', icono: 'history' as const },
              ]
            ).map((op) => {
              const activa = vista === op.id;
              return (
                <TouchableOpacity
                  key={op.id}
                  style={[styles.pestana, activa && styles.pestanaActiva, isCompact && styles.pestanaComoda]}
                  onPress={() => setVista(op.id)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activa }}
                >
                  <MaterialIcons name={op.icono} size={16} color={activa ? '#0369a1' : '#64748b'} />
                  <Text style={[styles.pestanaTexto, activa && styles.pestanaTextoActivo]}>
                    {op.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {puedeImportar ? (
            <TouchableOpacity
              style={[styles.btnImportar, isCompact && styles.btnImportarComodo]}
              onPress={() => setModalVisible(true)}
            >
              <MaterialIcons name="cloud-upload" size={16} color="#ffffff" />
              <Text style={styles.btnImportarTexto}>Importar extracto</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <View style={styles.barraFiltros}>
        {vista === 'movimientos' ? filtrosMovimientos : filtrosCargasUi}
        {vista === 'cargas' ? botonBorrarCarga : null}
        {botonRefrescar}
      </View>

      {vista === 'movimientos' ? (
        <>
          <TablaBasica<MovimientoBanca>
            title="Movimientos"
            onBack={() => router.push('/')}
            hideHeader
            hideToolbarActions
            dense
            columnas={COLUMNAS_MOVIMIENTOS}
            datos={movimientosFiltrados}
            getValorCelda={valorCeldaMovimiento}
            loading={movimientosCargando}
            error={movimientosError}
            onRetry={() => void cargarMovimientos()}
            filtroBusqueda={busquedaMovimientos}
            onFiltroChange={setBusquedaMovimientos}
            selectedRowIndex={filaMovimiento}
            onSelectRow={setFilaMovimiento}
            onCrear={() => {}}
            onEditar={() => {}}
            onBorrar={() => {}}
            columnasMoneda={['Importe']}
            defaultColWidth={88}
            getRowKey={(m, idx) => `${m.movementHash || 'mov'}-${idx}`}
            getColumnCellStyle={(col) => {
              if (col === 'Fecha') return { cell: { minWidth: 88 } };
              if (col === 'Banco') return { cell: { minWidth: 96 } };
              if (col === 'Concepto') return { cell: { minWidth: isCompact ? 160 : 220 } };
              if (col === 'Beneficiario') return { cell: { minWidth: isCompact ? 160 : 220 } };
              if (col === 'Importe') return { cell: { minWidth: 100 } };
              if (col === 'Cuenta') return { cell: { minWidth: 180 } };
              if (col === 'Empresa') return { cell: { minWidth: 140 } };
              return undefined;
            }}
            renderCell={(m, col, defaultText) => {
              if (col === 'Banco') {
                const colores = estiloBadgeBanco(defaultText);
                return (
                  <View
                    style={[
                      styles.badgeBanco,
                      { backgroundColor: colores.fondo, borderColor: colores.borde },
                    ]}
                  >
                    <Text style={[styles.badgeBancoTexto, { color: colores.texto }]} numberOfLines={1}>
                      {defaultText}
                    </Text>
                  </View>
                );
              }
              if (col === 'Importe') {
                return (
                  <Text
                    style={[styles.importe, esCargo(m) ? styles.importeCargo : styles.importeAbono]}
                  >
                    {defaultText}
                  </Text>
                );
              }
              if (col === 'Empresa' && !String(m.empresaNombre || '').trim()) {
                return (
                  <View style={styles.chipSinEmpresa}>
                    <Text style={styles.chipSinEmpresaTexto}>Sin asignar</Text>
                  </View>
                );
              }
              return null;
            }}
            emptyMessage={
              hayFiltro
                ? 'No hay movimientos con estos filtros'
                : 'Elige una empresa, una cuenta o marca «Sin conciliar» para consultar movimientos'
            }
            emptyFilterMessage="Ningún movimiento coincide con la búsqueda"
          />

          <View style={[styles.pie, shouldStackToolbar && styles.pieApilado]}>
            <View style={styles.pieTotales}>
              <Text style={styles.pieTexto}>
                {movimientosFiltrados.length} movimiento(s) en pantalla
              </Text>
              <Text style={styles.pieSeparador}>·</Text>
              <Text style={styles.pieEtiqueta}>Cargos</Text>
              <Text style={[styles.pieImporte, styles.importeCargo]}>
                {formatMoneda(-totales.cargos)}
              </Text>
              <Text style={styles.pieSeparador}>·</Text>
              <Text style={styles.pieEtiqueta}>Abonos</Text>
              <Text style={[styles.pieImporte, styles.importeAbono]}>
                {formatMoneda(totales.abonos)}
              </Text>
              <Text style={styles.pieSeparador}>·</Text>
              <Text style={styles.pieEtiqueta}>Neto</Text>
              <Text
                style={[
                  styles.pieImporte,
                  totales.neto < 0 ? styles.importeCargo : styles.importeAbono,
                ]}
              >
                {formatMoneda(totales.neto)}
              </Text>
            </View>
            {cursor ? (
              <TouchableOpacity
                style={[styles.btnMas, isCompact && styles.btnMasComodo]}
                onPress={() => void cargarMovimientos(cursor)}
                disabled={masCargando}
              >
                {masCargando ? (
                  <ActivityIndicator size="small" color="#0ea5e9" />
                ) : (
                  <MaterialIcons name="expand-more" size={16} color="#0ea5e9" />
                )}
                <Text style={styles.btnMasTexto}>
                  {masCargando ? 'Cargando…' : 'Cargar más movimientos'}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.pieNota}>
                {hayFiltro && movimientosFiltrados.length > 0
                  ? 'No hay más movimientos con estos filtros.'
                  : ''}
              </Text>
            )}
          </View>
        </>
      ) : (
        <TablaBasica<CargaExtracto>
          title="Cargas"
          onBack={() => router.push('/')}
          hideHeader
          hideToolbarActions
          columnas={COLUMNAS_CARGAS}
          datos={cargasFiltradas}
          getValorCelda={valorCeldaCarga}
          loading={cargasCargando}
          error={cargasError}
          onRetry={() => void cargarCargas()}
          filtroBusqueda={busquedaCargas}
          onFiltroChange={setBusquedaCargas}
          selectedRowIndex={filaCarga}
          onSelectRow={setFilaCarga}
          onCrear={() => {}}
          onEditar={() => {}}
          onBorrar={() => void borrarCargaSeleccionada()}
          defaultColWidth={96}
          getRowKey={(c, idx) => `${c.hashFichero || 'carga'}-${idx}`}
          getColumnCellStyle={(col) => {
            if (col === 'Fichero') return { cell: { minWidth: 200 } };
            if (col === 'Periodo') return { cell: { minWidth: 160 } };
            if (col === 'Importado') return { cell: { minWidth: 140 } };
            if (col === 'Cuentas') return { cell: { minWidth: 180 } };
            if (col === 'Estado') return { cell: { minWidth: 130 } };
            return undefined;
          }}
          extraToolbarRight={
            puedeImportar ? (
              <TouchableOpacity
                style={[
                  styles.btnBorrarCarga,
                  isCompact && styles.btnBorrarCargaComodo,
                  (!cargaSeleccionada || borrandoCarga) && styles.btnBorrarCargaDisabled,
                ]}
                onPress={() => void borrarCargaSeleccionada()}
                disabled={!cargaSeleccionada || borrandoCarga}
                accessibilityLabel="Borrar carga"
              >
                {borrandoCarga ? (
                  <ActivityIndicator size="small" color="#dc2626" />
                ) : (
                  <MaterialIcons name="delete-outline" size={16} color={cargaSeleccionada ? '#dc2626' : '#cbd5e1'} />
                )}
                <Text
                  style={[
                    styles.btnBorrarCargaTexto,
                    !cargaSeleccionada && styles.btnBorrarCargaTextoDisabled,
                  ]}
                >
                  Borrar carga
                </Text>
              </TouchableOpacity>
            ) : null
          }
          renderCell={(c, col) => {
            if (col === 'Estado') {
              const pendiente = c.estado === 'pendiente_cuenta';
              return (
                <View style={[styles.chipEstado, pendiente ? styles.chipEstadoAviso : styles.chipEstadoOk]}>
                  <Text
                    style={[
                      styles.chipEstadoTexto,
                      pendiente ? styles.chipEstadoTextoAviso : styles.chipEstadoTextoOk,
                    ]}
                  >
                    {etiquetaEstadoCarga(c.estado)}
                  </Text>
                </View>
              );
            }
            if (col === 'Errores' || col === 'Avisos') {
              const total = col === 'Errores'
                ? Number(c.lineasConError) || 0
                : Number(c.avisosTotal) || 0;
              if (total === 0) return null;
              return (
                <Text style={col === 'Errores' ? styles.contadorError : styles.contadorAviso}>
                  {total}
                </Text>
              );
            }
            return null;
          }}
          emptyMessage="Todavía no se ha importado ningún extracto"
          emptyFilterMessage="Ninguna carga coincide con la búsqueda"
          rightPanel={
            // Apilado (móvil/tablet vertical) el detalle empuja la tabla hacia
            // arriba: ahí solo se muestra cuando hay una carga elegida.
            !shouldStackPanels || filaCarga != null ? (
              <CargaExtractoDetalle
                carga={detalle}
                formatos={formatos}
                urlOriginal={detalleUrl}
                cargando={detalleCargando}
                error={detalleError}
                onReintentar={hashSeleccionado ? () => void cargarDetalle(hashSeleccionado) : undefined}
                onCargaActualizada={trasAsignarCuenta}
                vacioTexto="Selecciona una carga para ver sus cuentas, descuadres e incidencias."
              />
            ) : undefined
          }
        />
      )}

      {puedeImportar ? (
        <ImportarExtractoModal
          visible={modalVisible}
          formatos={formatos}
          formatosCargando={formatosCargando}
          onClose={() => setModalVisible(false)}
          onImportado={trasImportar}
        />
      ) : null}

      {ToastView}
      {ConfirmarView}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#e2e8f0' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    backgroundColor: '#e2e8f0',
  },
  sinPermisoTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  volverLink: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 },
  volverLinkTexto: { fontSize: 12, color: '#0ea5e9', fontWeight: '600' },

  cabecera: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 4,
  },
  cabeceraApilada: { flexDirection: 'column', alignItems: 'stretch' },
  cabeceraTitulo: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  cabeceraTextos: { flex: 1, minWidth: 0 },
  btnAtras: { padding: 4 },
  titulo: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitulo: { fontSize: 12, color: '#64748b' },
  cabeceraAcciones: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },

  pestanas: {
    flexDirection: 'row',
    gap: 4,
    padding: 3,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  pestana: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  pestanaComoda: { minHeight: MIN_TOUCH, paddingHorizontal: 14 },
  pestanaActiva: { backgroundColor: '#e0f2fe' },
  pestanaTexto: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  pestanaTextoActivo: { color: '#0369a1' },
  btnImportar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnImportarComodo: { minHeight: MIN_TOUCH },
  btnImportarTexto: { fontSize: 12, fontWeight: '700', color: '#ffffff' },

  barraFiltros: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 8,
    zIndex: 3,
  },
  filtros: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 },
  filtrosApilados: { flexDirection: 'column', alignItems: 'stretch' },
  filtroSelector: { minWidth: 170, maxWidth: 240 },
  filtroSelectorAncho: { minWidth: 200, maxWidth: 300 },
  ibanManual: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ibanInput: {
    minWidth: 190,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12,
    color: '#334155',
  },
  ibanInputComodo: { minHeight: MIN_TOUCH, fontSize: 14 },
  ibanBtn: {
    padding: 7,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  chipComodo: { minHeight: MIN_TOUCH },
  chipActivo: { backgroundColor: '#e0f2fe', borderColor: '#bae6fd' },
  chipTexto: { fontSize: 11, fontWeight: '600', color: '#64748b' },
  chipTextoActivo: { color: '#0369a1' },
  btnIcono: {
    padding: 7,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnIconoComodo: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH },
  btnIconoDisabled: { opacity: 0.55 },
  btnBorrarCarga: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#fff1f2',
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  btnBorrarCargaComodo: { minHeight: MIN_TOUCH },
  btnBorrarCargaDisabled: { opacity: 0.5 },
  btnBorrarCargaTexto: { fontSize: 12, fontWeight: '700', color: '#dc2626' },
  btnBorrarCargaTextoDisabled: { color: '#94a3b8' },

  badgeBanco: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: '100%',
  },
  badgeBancoTexto: { fontSize: 10, fontWeight: '700' },

  importe: { fontSize: 10, fontWeight: '700', textAlign: 'right', width: '100%' },
  importeCargo: { color: '#dc2626' },
  importeAbono: { color: '#16a34a' },
  chipSinEmpresa: {
    alignSelf: 'flex-start',
    paddingVertical: 1,
    paddingHorizontal: 6,
    borderRadius: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  chipSinEmpresaTexto: { fontSize: 9, fontWeight: '700', color: '#b45309' },
  chipEstado: {
    alignSelf: 'flex-start',
    paddingVertical: 1,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  chipEstadoOk: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  chipEstadoAviso: { backgroundColor: '#fffbeb', borderColor: '#fde68a' },
  chipEstadoTexto: { fontSize: 9, fontWeight: '700' },
  chipEstadoTextoOk: { color: '#15803d' },
  chipEstadoTextoAviso: { color: '#b45309' },
  contadorError: { fontSize: 10, fontWeight: '700', color: '#dc2626' },
  contadorAviso: { fontSize: 10, fontWeight: '700', color: '#d97706' },

  pie: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginHorizontal: 10,
    marginBottom: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    flexWrap: 'wrap',
  },
  pieApilado: { flexDirection: 'column', alignItems: 'stretch' },
  pieTotales: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  pieTexto: { fontSize: 11, color: '#64748b', fontWeight: '600' },
  pieEtiqueta: {
    fontSize: 10,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight: '600',
  },
  pieImporte: { fontSize: 12, fontWeight: '700' },
  pieSeparador: { fontSize: 11, color: '#cbd5e1' },
  pieNota: { fontSize: 10, color: '#94a3b8' },
  btnMas: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : null),
  },
  btnMasComodo: { minHeight: MIN_TOUCH },
  btnMasTexto: { fontSize: 11, fontWeight: '700', color: '#0369a1' },
});
