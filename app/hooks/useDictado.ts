/**
 * Estado y acciones del dictado por voz de un conteo de inventario.
 *
 * - Graba con la grabadora (solo web) y cada trozo va a la cola de audio (colaAudio), que lo
 *   guarda en el navegador y lo envía. Las líneas que devuelve el servidor se fusionan por `n` con
 *   las del GET (el GET no trae candidatos ni previsto; se conservan los que llegaron al enviar).
 * - Aplicación: las líneas con confirmar=false se aplican en cuanto llegan; las dudosas esperan a
 *   que el usuario las confirme y se aplican al confirmar. Un rechazo deja la línea pendiente con
 *   su motivo. Tras aplicar o deshacer se llama a onAplicado para que la pantalla recargue.
 * - Las líneas de trozos descartados (idEnvio en `descartados`, guardado por usuario e inventario)
 *   nunca se autoaplican: se descartan, o se deshacen si ya estaban aplicadas.
 * - La cola solo envía mientras el panel está abierto y con usuario (tablet compartida).
 * - Nunca se lee ni se muestra stock teórico: el backend ya no lo manda en el dictado.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../utils/api';
import { crearGrabadora, grabadoraDisponible, type Grabadora } from '../lib/dictado/grabadora';
import {
  alResponderAudio,
  descartarTrozos,
  encolarTrozo,
  esperarCola,
  fijarUsuarioCola,
  idsEnVuelo,
  pendientesDeUsuario,
  reintentarAhora,
  reintentarErrores,
  resumenColaAudio,
  suscribirColaAudio,
  type MetaRespuesta,
  type RespuestaAudio,
  type ResumenColaAudio,
} from '../lib/dictado/colaAudio';

export type CantidadDictado = { total: number; stockReal: number; botellasAbiertas: number };
export type ConteoActual = { stockReal: number | null; botellasAbiertas: number; contado: boolean };
export type PrevistoDictado = { total: number | null; stockReal: number | null; botellasAbiertas: number };
export type CandidatoDictado = { productId: string; nombre: string; puntuacion: number };
export type ModoLinea = 'sumar' | 'reemplazar' | 'borrar';
export type EstadoLinea = 'pendiente' | 'confirmada' | 'aplicada' | 'descartada' | 'deshecha';

export type OrdenDictado = {
  tipo: string;
  textoProducto: string | null;
  cantidad: CantidadDictado | null;
  confirmar?: boolean;
  motivos?: string[];
  calculo?: { expresion: string; total: number | null; faltaFormato: boolean };
};

export type LineaDictado = {
  n: number;
  texto: string;
  orden: OrdenDictado | null;
  productId: string | null;
  productoNombre: string | null;
  cantidad: CantidadDictado | null;
  modo: ModoLinea | null;
  motivos: string[];
  confirmar: boolean;
  estado: EstadoLinea;
  creadoEn: string | null;
  actualizadoEn: string | null;
  idEnvio?: string;
  aplicado?: { stockReal: number | null; botellasAbiertas: number; en: string | null };
  anterior?: { existia: boolean; stockReal: number | null; botellasAbiertas: number };
  // Extra que solo llega al interpretar (no en el GET).
  via?: string | null;
  candidatos?: CandidatoDictado[];
  conteoActual?: ConteoActual | null;
  enConteo?: boolean;
  previsto?: PrevistoDictado | null;
  faltaFormato?: { productId: string | null } | null;
};

export type SesionDictado = {
  estado: 'activa' | 'pausada' | 'cerrada';
  siguiente: number;
  creadoEn: string | null;
  actualizadoEn: string | null;
};

export type RechazoDictado = { motivo: string; mensaje?: string };

export type FaseDictado = 'cargando' | 'dictando' | 'pausada' | 'esperando' | 'terminada';

/** Lo que decide el usuario al terminar con trozos sin enviar. */
export type DecisionPendientes = 'esperar' | 'descartar' | 'cancelar';

export type CambiosLinea = {
  productId?: string | null;
  cantidad?: number;
  modo?: ModoLinea;
};

const COLA_VACIA: ResumenColaAudio = {
  pendientes: 0,
  enviando: 0,
  errores: 0,
  mensajeError: null,
  trozos: [],
  persistente: true,
  sinSesion: false,
  sinUsuario: 0,
};

async function leerJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function mensajeDe(body: Record<string, unknown>, respaldo: string): string {
  return typeof body.error === 'string' && body.error.trim() ? body.error : respaldo;
}

function errorTexto(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Error de conexión';
}

function listaLineas(raw: unknown): LineaDictado[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is LineaDictado => Boolean(l) && typeof (l as { n?: unknown }).n === 'number')
    .map((l) => ({ ...l, motivos: Array.isArray(l.motivos) ? l.motivos : [] }));
}

function sesionDe(raw: unknown): SesionDictado | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as SesionDictado;
}

function fusionar(previas: LineaDictado[], nuevas: LineaDictado[]): LineaDictado[] {
  const mapa = new Map(previas.map((l) => [l.n, l]));
  for (const l of nuevas) mapa.set(l.n, { ...mapa.get(l.n), ...l });
  return [...mapa.values()].sort((a, b) => a.n - b.n);
}

function leerLista<T>(clave: string, valido: (v: unknown) => v is T): T[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(clave) || '[]');
    return Array.isArray(raw) ? raw.filter(valido) : [];
  } catch {
    return [];
  }
}

function guardarLista(clave: string, valores: Iterable<unknown>) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(clave, JSON.stringify([...valores])); } catch { /* sigue en memoria */ }
}

const esNumero = (v: unknown): v is number => typeof v === 'number';
const esTexto = (v: unknown): v is string => typeof v === 'string';

export function useDictado(inventarioId: string, { onAplicado }: { onAplicado?: () => void } = {}) {
  const { user } = useAuth();
  const usuarioId = user?.id_usuario ? String(user.id_usuario) : null;
  const clave = `${usuarioId ?? 'sin-usuario'}:${inventarioId}`;
  const ruta = `/api/inventarios/${encodeURIComponent(inventarioId)}/dictado`;

  const [fase, setFase] = useState<FaseDictado>('cargando');
  const [sesion, setSesion] = useState<SesionDictado | null>(null);
  const [lineas, setLineas] = useState<LineaDictado[]>([]);
  const [nuevas, setNuevas] = useState<Set<number>>(new Set());
  const [rechazos, setRechazos] = useState<Record<number, RechazoDictado>>({});
  const [ocupadas, setOcupadas] = useState<Set<number>>(new Set());
  const [cola, setCola] = useState<ResumenColaAudio>(COLA_VACIA);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [descartando, setDescartando] = useState(0);
  const [editadas, setEditadas] = useState<Set<number>>(
    () => new Set(leerLista(`igp-dictado-editadas:${clave}`, esNumero)),
  );

  const grabadora = useRef<Grabadora | null>(null);
  const vivo = useRef(true);
  const faseRef = useRef<FaseDictado>('cargando');
  const lineasRef = useRef<LineaDictado[]>([]);
  const cadenaAplicar = useRef<Promise<void>>(Promise.resolve());
  const ultimoEncolado = useRef<Promise<void>>(Promise.resolve());
  const ultimoReanudar = useRef(0);
  const esperaCtrl = useRef<AbortController | null>(null);
  const terminarAbandonado = useRef(false);
  const usuarioRef = useRef(usuarioId);
  usuarioRef.current = usuarioId;
  /** Último usuario no nulo visto: un trozo que se corta justo al caducar la sesión no se pierde. */
  const ultimoUsuario = useRef(usuarioId);
  if (usuarioId) ultimoUsuario.current = usuarioId;
  const descartados = useRef<Set<string>>(new Set(leerLista(`igp-dictado-descartados:${clave}`, esTexto)));
  const onAplicadoRef = useRef(onAplicado);
  onAplicadoRef.current = onAplicado;

  const cambiarFase = useCallback((f: FaseDictado) => {
    faseRef.current = f;
    if (vivo.current) setFase(f);
  }, []);

  const ponerLineas = useCallback((fn: (prev: LineaDictado[]) => LineaDictado[]) => {
    const siguientes = fn(lineasRef.current);
    lineasRef.current = siguientes;
    if (vivo.current) setLineas(siguientes);
  }, []);

  const marcarOcupada = useCallback((n: number, si: boolean) => {
    if (!vivo.current) return;
    setOcupadas((prev) => {
      const s = new Set(prev);
      if (si) s.add(n);
      else s.delete(n);
      return s;
    });
  }, []);

  const quitarRechazo = useCallback((n: number) => {
    if (!vivo.current) return;
    setRechazos((prev) => {
      if (!(n in prev)) return prev;
      const r = { ...prev };
      delete r[n];
      return r;
    });
  }, []);

  const esDescartada = useCallback(
    (l: LineaDictado) => Boolean(l.idEnvio && descartados.current.has(l.idEnvio)),
    [],
  );

  const autoaplicable = useCallback(
    (l: LineaDictado) => l.estado === 'pendiente' && !l.confirmar && !esDescartada(l),
    [esDescartada],
  );

  // ─── Aplicar ───

  const aplicarAhora = useCallback(async (ns: number[]) => {
    const unicos = [...new Set(ns)];
    let alguna = false;
    for (let i = 0; i < unicos.length; i += 50) {
      const lote = unicos.slice(i, i + 50);
      lote.forEach((n) => marcarOcupada(n, true));
      try {
        const res = await apiFetch(`${ruta}/aplicar`, { method: 'POST', body: JSON.stringify({ lineas: lote }) });
        const body = await leerJson(res);
        if (!res.ok) {
          if (vivo.current) setError(mensajeDe(body, 'No se ha podido aplicar el dictado'));
          continue;
        }
        const aplicadas = Array.isArray(body.aplicadas) ? (body.aplicadas as Array<{ n: number }>) : [];
        const rechazadas = Array.isArray(body.rechazadas)
          ? (body.rechazadas as Array<{ n: number; motivo: string; mensaje?: string }>)
          : [];
        if (aplicadas.length > 0) alguna = true;
        ponerLineas((prev) => fusionar(prev, listaLineas(body.lineasDictado)));
        const s = sesionDe(body.sesion);
        if (s && vivo.current) setSesion(s);
        if (vivo.current) {
          setRechazos((prev) => {
            const r = { ...prev };
            for (const a of aplicadas) delete r[a.n];
            for (const x of rechazadas) r[x.n] = { motivo: x.motivo, mensaje: x.mensaje };
            return r;
          });
        }
      } catch (e) {
        if (vivo.current) setError(errorTexto(e));
      } finally {
        lote.forEach((n) => marcarOcupada(n, false));
      }
    }
    if (alguna) onAplicadoRef.current?.();
  }, [ruta, marcarOcupada, ponerLineas]);

  /** En serie: dos aplicar a la vez no se pisan el estado. */
  const aplicar = useCallback((ns: number[]) => {
    if (ns.length === 0) return cadenaAplicar.current;
    cadenaAplicar.current = cadenaAplicar.current.then(() => aplicarAhora(ns)).catch(() => {});
    return cadenaAplicar.current;
  }, [aplicarAhora]);

  // ─── Sesión y grabación ───

  const postSesion = useCallback(async (accion: 'pausar' | 'reanudar' | 'cerrar') => {
    const res = await apiFetch(`${ruta}/${accion}`, { method: 'POST', body: JSON.stringify({}) });
    const body = await leerJson(res);
    // 404: aún no hay sesión (se crea con la primera línea dictada).
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(mensajeDe(body, 'No se ha podido cambiar el estado del dictado'));
    const s = sesionDe(body.sesion);
    if (s && vivo.current) setSesion(s);
    return s;
  }, [ruta]);

  /** Corta el trozo en curso y espera a que esté guardado en la cola. */
  const cortarYGuardar = useCallback(async () => {
    await grabadora.current?.detener();
    await ultimoEncolado.current;
  }, []);

  /** Todo paso a pausa: corta, guarda el trozo, pasa a 'pausada' y avisa al servidor. */
  const pasarAPausa = useCallback(async () => {
    await cortarYGuardar();
    if (faseRef.current !== 'terminada') cambiarFase('pausada');
    try {
      await postSesion('pausar');
    } catch (e) {
      if (vivo.current) setError(errorTexto(e));
    }
  }, [cambiarFase, cortarYGuardar, postSesion]);

  const pausar = pasarAPausa;

  const empezar = useCallback(async () => {
    setError(null);
    if (!grabadoraDisponible || !grabadora.current) {
      cambiarFase('pausada');
      setError('El dictado solo está disponible en la web');
      return;
    }
    if (!usuarioRef.current) {
      cambiarFase('pausada');
      setError('Vuelve a entrar para dictar.');
      return;
    }
    try {
      await postSesion('reanudar');
    } catch (e) {
      if (vivo.current) setError(errorTexto(e));
    }
    ultimoReanudar.current = Date.now();
    try {
      await grabadora.current.iniciar();
      if (vivo.current) cambiarFase('dictando');
    } catch (e) {
      if (vivo.current) setError(errorTexto(e));
      await pasarAPausa();
    }
  }, [cambiarFase, pasarAPausa, postSesion]);

  const reanudar = empezar;

  // ─── Líneas de trozos descartados ───

  const recordarDescartados = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    for (const id of ids) descartados.current.add(id);
    guardarLista(`igp-dictado-descartados:${clave}`, descartados.current);
  }, [clave]);

  /** Descarta (o deshace, si ya se aplicaron) las líneas creadas por trozos descartados. */
  const limpiarDescartadas = useCallback(async (lista: LineaDictado[]) => {
    let tocado = false;
    for (const l of lista) {
      if (!esDescartada(l)) continue;
      try {
        if (l.estado === 'pendiente' || l.estado === 'confirmada') {
          const res = await apiFetch(`${ruta}/lineas/${l.n}`, {
            method: 'PATCH',
            body: JSON.stringify({ estado: 'descartada' }),
          });
          const body = await leerJson(res);
          const [linea] = listaLineas([body.linea]);
          if (res.ok && linea) ponerLineas((prev) => fusionar(prev, [linea]));
        } else if (l.estado === 'aplicada') {
          const res = await apiFetch(`${ruta}/lineas/${l.n}/deshacer`, { method: 'POST', body: JSON.stringify({}) });
          const body = await leerJson(res);
          const [linea] = listaLineas([body.linea]);
          if (res.ok && linea) {
            ponerLineas((prev) => fusionar(prev, [linea]));
            if (linea.estado === 'deshecha' && !body.yaDeshecha) tocado = true;
          } else if (!res.ok && vivo.current) {
            setError(mensajeDe(body, 'No se ha podido deshacer una línea descartada; corrígela a mano.'));
          }
        }
      } catch (e) {
        if (vivo.current) setError(errorTexto(e));
      }
      quitarRechazo(l.n);
    }
    if (tocado) onAplicadoRef.current?.();
  }, [esDescartada, ponerLineas, quitarRechazo, ruta]);

  /** Descarta el audio sin enviar; si un trozo se estaba enviando, espera y limpia sus líneas. */
  const descartarPendientes = useCallback(async ({ soloErrores = false } = {}) => {
    const vuelo = soloErrores ? [] : idsEnVuelo(inventarioId);
    recordarDescartados(vuelo);
    if (vivo.current) setDescartando(vuelo.length);
    const r = await descartarTrozos(inventarioId, { soloErrores });
    recordarDescartados(r.enVuelo);
    if (vivo.current) setDescartando(0);
    if (r.enVuelo.length === 0) return;
    await cadenaAplicar.current;
    try {
      const res = await apiFetch(ruta);
      const body = await leerJson(res);
      if (!res.ok) return;
      const cargadas = listaLineas(body.lineas);
      ponerLineas((prev) => fusionar(prev, cargadas));
      await limpiarDescartadas(cargadas);
    } catch (e) {
      if (vivo.current) setError(errorTexto(e));
    }
  }, [inventarioId, limpiarDescartadas, ponerLineas, recordarDescartados, ruta]);

  // ─── Respuestas del audio ───

  const recibir = useCallback((body: RespuestaAudio, meta: MetaRespuesta) => {
    if (meta.descartado) recordarDescartados([meta.idEnvio]);
    const llegadas = listaLineas(body.lineas);
    ponerLineas((prev) => fusionar(prev, llegadas));
    if (vivo.current && !meta.descartado) {
      if (llegadas.length > 0) setNuevas(new Set(llegadas.map((l) => l.n)));
      setAviso(typeof body.aviso === 'string' ? body.aviso : null);
    }
    const s = sesionDe(body.sesion);
    if (s) {
      if (vivo.current) setSesion(s);
      // «pausa» dicha en voz alta: para el micrófono, salvo que el trozo sea de antes del último
      // reanudar (el usuario ya ha vuelto a dictar).
      if (s.estado === 'pausada' && faseRef.current === 'dictando' && meta.creadoEn >= ultimoReanudar.current) {
        void pasarAPausa();
      }
    }
    void aplicar(llegadas.filter(autoaplicable).map((l) => l.n));
  }, [aplicar, autoaplicable, pasarAPausa, ponerLineas, recordarDescartados]);

  const recibirRef = useRef(recibir);
  recibirRef.current = recibir;

  // ─── Montaje ───

  useEffect(() => {
    fijarUsuarioCola(usuarioId);
    return () => { fijarUsuarioCola(null); };
  }, [usuarioId]);

  useEffect(() => {
    vivo.current = true;
    grabadora.current = crearGrabadora({
      onTrozo: (trozo) => {
        // Sin usuario conocido se guarda con '' (no se envía; el panel avisa con cola.sinUsuario).
        const uid = usuarioRef.current ?? ultimoUsuario.current ?? '';
        const p = encolarTrozo({ inventarioId, usuarioId: uid, blob: trozo.blob, tipo: trozo.tipo })
          .then(() => {})
          .catch(() => {
            if (vivo.current) setError('No se ha podido guardar el audio en el navegador');
          });
        ultimoEncolado.current = ultimoEncolado.current.then(() => p);
        return p;
      },
      onError: (mensaje) => {
        if (vivo.current) setError(mensaje);
        void pasarAPausa();
      },
    });
    const dejarCola = suscribirColaAudio(() => {
      if (vivo.current) setCola(resumenColaAudio(inventarioId));
    });
    const dejarRespuestas = alResponderAudio((id, body, meta) => {
      if (id === inventarioId) recibirRef.current(body, meta);
    });
    setCola(resumenColaAudio(inventarioId));
    reintentarAhora();

    void (async () => {
      try {
        const res = await apiFetch(ruta);
        const body = await leerJson(res);
        if (!vivo.current) return;
        if (!res.ok) {
          setError(mensajeDe(body, 'No se ha podido leer el dictado'));
          cambiarFase('pausada');
          return;
        }
        setSesion(sesionDe(body.sesion));
        const cargadas = listaLineas(body.lineas);
        ponerLineas((prev) => fusionar(cargadas, prev));
        void limpiarDescartadas(cargadas);
        void aplicar(cargadas.filter(autoaplicable).map((l) => l.n));
      } catch (e) {
        if (!vivo.current) return;
        setError(errorTexto(e));
      }
      if (vivo.current && faseRef.current === 'cargando') await empezar();
    })();

    return () => {
      vivo.current = false;
      grabadora.current?.liberar();
      grabadora.current = null;
      esperaCtrl.current?.abort();
      dejarCola();
      dejarRespuestas();
    };
    // Solo al abrir el panel de un inventario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventarioId]);

  useEffect(() => {
    setCola(resumenColaAudio(inventarioId));
  }, [inventarioId, usuarioId]);

  // ─── Líneas ───

  const marcarEditada = useCallback((n: number) => {
    setEditadas((prev) => {
      const s = new Set(prev);
      s.add(n);
      guardarLista(`igp-dictado-editadas:${clave}`, s);
      return s;
    });
  }, [clave]);

  const patch = useCallback(async (n: number, cuerpo: Record<string, unknown>) => {
    marcarOcupada(n, true);
    setError(null);
    try {
      const res = await apiFetch(`${ruta}/lineas/${n}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
      const body = await leerJson(res);
      if (!res.ok) {
        if (vivo.current) setError(mensajeDe(body, 'No se ha podido cambiar la línea'));
        return null;
      }
      const [linea] = listaLineas([body.linea]);
      if (linea) {
        const previsto = (body.previsto ?? null) as PrevistoDictado | null;
        ponerLineas((prev) => fusionar(prev, [{ ...linea, previsto }]));
      }
      return linea ?? null;
    } catch (e) {
      if (vivo.current) setError(errorTexto(e));
      return null;
    } finally {
      marcarOcupada(n, false);
    }
  }, [ruta, marcarOcupada, ponerLineas]);

  const confirmarLinea = useCallback(async (n: number) => {
    const actual = lineasRef.current.find((l) => l.n === n);
    if (!actual) return;
    if (actual.estado !== 'confirmada') {
      const linea = await patch(n, { estado: 'confirmada' });
      if (!linea) return;
    }
    await aplicar([n]);
  }, [aplicar, patch]);

  const descartarLinea = useCallback(async (n: number) => {
    const linea = await patch(n, { estado: 'descartada' });
    if (linea) quitarRechazo(n);
  }, [patch, quitarRechazo]);

  const editarLinea = useCallback(async (n: number, cambios: CambiosLinea) => {
    const actual = lineasRef.current.find((l) => l.n === n);
    if (!actual) return null;
    const cuerpo: Record<string, unknown> = { ...cambios };
    // Una línea ya confirmada vuelve a pendiente al corregirla: se confirma otra vez.
    if (actual.estado === 'confirmada') cuerpo.estado = 'pendiente';
    const linea = await patch(n, cuerpo);
    if (!linea) return null;
    marcarEditada(n);
    if (Object.prototype.hasOwnProperty.call(cambios, 'productId') && cambios.productId !== actual.productId) {
      // El contado que llegó al dictar era del producto anterior.
      ponerLineas((prev) => prev.map((l) => (l.n === n ? { ...l, conteoActual: undefined, enConteo: undefined } : l)));
    }
    return linea;
  }, [marcarEditada, patch, ponerLineas]);

  const deshacerUltimo = useCallback(async () => {
    const ultima = [...lineasRef.current].reverse().find((l) => l.estado !== 'descartada' && l.estado !== 'deshecha');
    if (!ultima) return null;
    const n = ultima.n;
    marcarOcupada(n, true);
    setError(null);
    try {
      const res = await apiFetch(`${ruta}/lineas/${n}/deshacer`, { method: 'POST', body: JSON.stringify({}) });
      const body = await leerJson(res);
      if (!res.ok) {
        if (vivo.current) setError(mensajeDe(body, 'No se ha podido deshacer'));
        return null;
      }
      const [linea] = listaLineas([body.linea]);
      if (linea) ponerLineas((prev) => fusionar(prev, [linea]));
      quitarRechazo(n);
      // 'deshecha' = se restauró el conteo (una pendiente pasa a 'descartada' sin tocarlo).
      if (linea?.estado === 'deshecha') onAplicadoRef.current?.();
      return linea ?? null;
    } catch (e) {
      if (vivo.current) setError(errorTexto(e));
      return null;
    } finally {
      marcarOcupada(n, false);
    }
  }, [ruta, marcarOcupada, ponerLineas, quitarRechazo]);

  /**
   * Guarda (si se pide) el formato de caja del producto y fija la cantidad total de la línea.
   * `total` lo calcula el panel con el formato; si no se pudo, es el total que escribió el usuario.
   */
  const guardarFormato = useCallback(async (
    n: number,
    args: { productId: string; unidadesCaja: number; unidadesPack?: number | null; guardar: boolean; total: number },
  ) => {
    setError(null);
    if (args.guardar) {
      try {
        const res = await apiFetch('/api/inventarios/dictado/formatos', {
          method: 'POST',
          body: JSON.stringify({
            productId: args.productId,
            unidadesCaja: args.unidadesCaja,
            ...(args.unidadesPack ? { unidadesPack: args.unidadesPack } : {}),
          }),
        });
        // 409: ya había formato para ese producto; la línea se corrige igual.
        if (!res.ok && res.status !== 409) {
          const body = await leerJson(res);
          if (vivo.current) setError(mensajeDe(body, 'No se ha podido guardar el formato'));
          return null;
        }
      } catch (e) {
        if (vivo.current) setError(errorTexto(e));
        return null;
      }
    }
    const linea = await editarLinea(n, { cantidad: args.total });
    if (linea) ponerLineas((prev) => prev.map((l) => (l.n === n ? { ...l, faltaFormato: null } : l)));
    return linea;
  }, [editarLinea, ponerLineas]);

  // ─── Terminar ───

  const cancelarEspera = useCallback(() => {
    esperaCtrl.current?.abort();
  }, []);

  /** La X durante «esperando»: deja de esperar y sale de terminar sin cerrar ni descartar. */
  const abandonarTerminar = useCallback(() => {
    terminarAbandonado.current = true;
    esperaCtrl.current?.abort();
  }, []);

  /**
   * Corta la grabación y espera a que el último trozo esté en la cola. Si queda audio sin enviar,
   * pregunta con `decidir`: esperar (hasta que todo esté enviado o en error definitivo) o
   * descartar. Solo entonces cierra la sesión: nunca con audio sin enviar salvo descarte
   * explícito. Devuelve false si el usuario cancela o se abandona.
   */
  const terminar = useCallback(async (decidir: (sinEnviar: number) => Promise<DecisionPendientes>) => {
    terminarAbandonado.current = false;
    await pasarAPausa();
    for (;;) {
      if (terminarAbandonado.current || !vivo.current) return false;
      const r = resumenColaAudio(inventarioId);
      const sinEnviar = r.pendientes + r.enviando + r.errores;
      if (sinEnviar === 0) break;
      const decision = await decidir(sinEnviar);
      if (terminarAbandonado.current || !vivo.current) return false;
      if (decision === 'cancelar') return false;
      if (decision === 'descartar') {
        await descartarPendientes();
        continue;
      }
      if (r.errores > 0) await reintentarErrores(inventarioId);
      const ctrl = new AbortController();
      esperaCtrl.current = ctrl;
      cambiarFase('esperando');
      await esperarCola(inventarioId, ctrl.signal);
      esperaCtrl.current = null;
      if (vivo.current && faseRef.current === 'esperando') cambiarFase('pausada');
    }
    await cadenaAplicar.current;
    try {
      await postSesion('cerrar');
    } catch (e) {
      if (vivo.current) setError(errorTexto(e));
      return false;
    }
    cambiarFase('terminada');
    return true;
  }, [cambiarFase, descartarPendientes, inventarioId, pasarAPausa, postSesion]);

  const reintentarCola = useCallback(() => {
    void reintentarErrores(inventarioId);
  }, [inventarioId]);

  const descartarErrores = useCallback(() => descartarPendientes({ soloErrores: true }), [descartarPendientes]);

  const leerInicioTrozo = useCallback(() => grabadora.current?.inicioTrozo() ?? null, []);

  /** Pendientes + enviándose ahora mismo (sin esperar al siguiente render). */
  const sinEnviarAhora = useCallback(() => {
    const r = resumenColaAudio(inventarioId);
    return r.pendientes + r.enviando;
  }, [inventarioId]);

  const ultimaDeshacible = useMemo(
    () => [...lineas].reverse().find((l) => l.estado !== 'descartada' && l.estado !== 'deshecha') ?? null,
    [lineas],
  );

  return {
    disponible: grabadoraDisponible,
    fase,
    sesion,
    lineas,
    nuevas,
    rechazos,
    ocupadas,
    editadas,
    cola,
    error,
    aviso,
    descartando,
    ultimaDeshacible,
    empezar,
    pausar,
    reanudar,
    terminar,
    cancelarEspera,
    abandonarTerminar,
    deshacerUltimo,
    confirmarLinea,
    descartarLinea,
    editarLinea,
    aplicar,
    guardarFormato,
    reintentarCola,
    descartarErrores,
    leerInicioTrozo,
    sinEnviarAhora,
  };
}

export type Dictado = ReturnType<typeof useDictado>;

/** Trozos de audio del usuario actual sin enviar para ese inventario (con el panel cerrado). */
export function usePendientesDictado(inventarioId: string | null | undefined): number {
  const { user } = useAuth();
  const usuarioId = user?.id_usuario ? String(user.id_usuario) : null;
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!inventarioId || !usuarioId) {
      setN(0);
      return undefined;
    }
    const leer = () => setN(pendientesDeUsuario(inventarioId, usuarioId));
    leer();
    return suscribirColaAudio(leer);
  }, [inventarioId, usuarioId]);
  return n;
}
