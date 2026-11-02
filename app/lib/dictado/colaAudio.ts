/**
 * Cola de envío de los trozos de audio del dictado.
 *
 * Cada trozo recibe su idEnvio y se guarda en IndexedDB ('igp-dictado', almacén 'trozos') ANTES
 * de enviarlo, así que sin cobertura o al recargar la página no se pierde. Lleva el usuario que lo
 * grabó: la cola solo envía y muestra los del usuario fijado con fijarUsuarioCola (tablet
 * compartida); sin usuario no envía nada, y ante un 401 se para hasta que se vuelva a fijar. Un
 * trozo grabado sin usuario conocido se guarda con usuarioId '' y no se envía nunca.
 *
 * Envío en serie, uno a uno (el servidor solo acepta un audio por usuario a la vez) y en orden de
 * grabación dentro de cada inventario (el servidor atribuye «y 3 más» a la línea anterior): un
 * trozo en reintento bloquea a los siguientes de su inventario; uno en error definitivo, no.
 * Reintentos con el MISMO idEnvio y espera creciente hasta 60 s:
 * - red caída / timeout / 408 / 5xx: como mucho MAX_INTENTOS; luego error definitivo.
 * - 409 «se está procesando» y 429: no cuentan para el máximo.
 * - 4xx definitivos (y 409 de inventario importado o sesión cerrada): error, sin reintentar.
 * El audio se borra de IndexedDB en cuanto el servidor confirma el envío (también si era repetido),
 * al descartarlo y, al cargar, si tiene más de 7 días. Sin IndexedDB sigue en memoria.
 *
 * Un solo fichero para todas las plataformas: IndexedDB solo existe en el navegador y en nativo
 * el dictado no graba, así que no hace falta una versión .web.ts.
 */
import { apiFetch } from '../../utils/api';

export type EstadoTrozo = 'pendiente' | 'enviando' | 'error';

type Trozo = {
  idEnvio: string;
  inventarioId: string;
  usuarioId: string;
  blob: Blob;
  tipo: string;
  creadoEn: number;
  estado: EstadoTrozo;
  /** Fallos que cuentan para MAX_INTENTOS (red, timeout, 5xx). */
  intentos: number;
  /** Esperas que no cuentan (409 «procesando», 429). */
  esperasLibres: number;
  error?: string | null;
  /** Descartado mientras se enviaba: al acabar el envío se borra sin reintentar. */
  descartado?: boolean;
};

export type TrozoVisible = {
  idEnvio: string;
  estado: EstadoTrozo;
  creadoEn: number;
  error: string | null;
};

export type ResumenColaAudio = {
  pendientes: number;
  enviando: number;
  errores: number;
  mensajeError: string | null;
  trozos: TrozoVisible[];
  /** false si el audio solo está en memoria (sin IndexedDB). */
  persistente: boolean;
  /** La cola está parada por un 401: hay que volver a entrar. */
  sinSesion: boolean;
  /** Trozos de este inventario grabados sin usuario: no se envían y se borran a los 7 días. */
  sinUsuario: number;
};

export type RespuestaAudio = Record<string, unknown>;
export type MetaRespuesta = { idEnvio: string; creadoEn: number; descartado: boolean };

const BD = 'igp-dictado';
const ALMACEN = 'trozos';
const VERSION_BD = 1;
/** La transcripción puede tardar hasta 60 s más la interpretación. */
const TIMEOUT_ENVIO_MS = 120000;
const ESPERA_BASE_MS = 2000;
const ESPERA_MAX_MS = 60000;
const MAX_INTENTOS = 5;
const MAX_EDAD_MS = 7 * 24 * 60 * 60 * 1000;
const MENSAJE_AGOTADO = 'No se ha podido transcribir este trozo.';

let cola: Trozo[] = [];
let carga: Promise<void> | null = null;
let persistente = true;
let trabajando = false;
let repetir = false;
let reloj: ReturnType<typeof setTimeout> | null = null;
let usuarioActual: string | null = null;
let parada401 = false;
let enCurso: { t: Trozo; fin: Promise<void> } | null = null;
/** Próximo intento por idEnvio (solo en memoria: al reabrir se reintenta enseguida). */
const esperas = new Map<string, number>();
const oyentes = new Set<() => void>();
const receptores = new Set<(inventarioId: string, body: RespuestaAudio, meta: MetaRespuesta) => void>();

function avisar() {
  for (const fn of oyentes) fn();
}

// ─── IndexedDB ───

let bd: Promise<IDBDatabase | null> | null = null;

function abrirBd(): Promise<IDBDatabase | null> {
  if (bd) return bd;
  bd = new Promise((listo) => {
    if (typeof indexedDB === 'undefined') {
      listo(null);
      return;
    }
    let peticion: IDBOpenDBRequest;
    try {
      peticion = indexedDB.open(BD, VERSION_BD);
    } catch {
      listo(null);
      return;
    }
    peticion.onupgradeneeded = () => {
      const db = peticion.result;
      if (!db.objectStoreNames.contains(ALMACEN)) db.createObjectStore(ALMACEN, { keyPath: 'idEnvio' });
    };
    peticion.onsuccess = () => listo(peticion.result);
    peticion.onerror = () => listo(null);
    peticion.onblocked = () => listo(null);
  });
  return bd;
}

async function operar<T>(
  modo: IDBTransactionMode,
  fn: (almacen: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await abrirBd();
  if (!db) throw new Error('IndexedDB no disponible');
  return new Promise<T>((ok, mal) => {
    let peticion: IDBRequest<T>;
    try {
      const tx = db.transaction(ALMACEN, modo);
      peticion = fn(tx.objectStore(ALMACEN));
      tx.oncomplete = () => ok(peticion.result);
      tx.onerror = () => mal(tx.error);
      tx.onabort = () => mal(tx.error);
    } catch (e) {
      mal(e);
    }
  });
}

function registro(t: Trozo) {
  return {
    idEnvio: t.idEnvio,
    inventarioId: t.inventarioId,
    usuarioId: t.usuarioId,
    blob: t.blob,
    tipo: t.tipo,
    creadoEn: t.creadoEn,
    estado: t.estado === 'enviando' ? 'pendiente' : t.estado,
    intentos: t.intentos,
    esperasLibres: t.esperasLibres,
    error: t.error ?? null,
  };
}

async function guardarBd(t: Trozo): Promise<boolean> {
  if (!persistente) return false;
  try {
    await operar('readwrite', (a) => a.put(registro(t)));
    return true;
  } catch {
    persistente = false;
    return false;
  }
}

async function borrarBd(idEnvio: string) {
  try {
    await operar('readwrite', (a) => a.delete(idEnvio));
  } catch { /* si no estaba, nada */ }
}

function cargar(): Promise<void> {
  if (carga) return carga;
  carga = (async () => {
    const db = await abrirBd();
    if (!db) {
      persistente = false;
      return;
    }
    try {
      const guardados = await operar<unknown[]>('readonly', (a) => a.getAll() as IDBRequest<unknown[]>);
      const enMemoria = new Set(cola.map((t) => t.idEnvio));
      const limite = Date.now() - MAX_EDAD_MS;
      for (const raw of guardados) {
        const t = raw as Partial<Trozo>;
        if (!t.idEnvio || enMemoria.has(t.idEnvio)) continue;
        const creadoEn = Number(t.creadoEn) || 0;
        // Viejos o inválidos: fuera. Los sin usuario ('') se quedan (no se envían) hasta los 7 días.
        if (!t.inventarioId || typeof t.usuarioId !== 'string' || !(t.blob instanceof Blob) || creadoEn < limite) {
          await borrarBd(t.idEnvio);
          continue;
        }
        cola.push({
          idEnvio: t.idEnvio,
          inventarioId: t.inventarioId,
          usuarioId: t.usuarioId,
          blob: t.blob,
          tipo: t.tipo || t.blob.type || 'audio/webm',
          creadoEn,
          estado: t.estado === 'error' ? 'error' : 'pendiente',
          intentos: Number(t.intentos) || 0,
          esperasLibres: Number(t.esperasLibres) || 0,
          error: t.error ?? null,
        });
      }
      cola.sort((a, b) => a.creadoEn - b.creadoEn);
    } catch {
      persistente = false;
    }
  })();
  return carga;
}

// ─── API ───

function idSeguro(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function extension(tipo: string): string {
  if (tipo.includes('mp4')) return 'm4a';
  if (tipo.includes('ogg')) return 'ogg';
  return 'webm';
}

function hayRed(): boolean {
  return !(typeof navigator !== 'undefined' && navigator.onLine === false);
}

function delUsuario(t: Trozo): boolean {
  return usuarioActual != null && t.usuarioId === usuarioActual;
}

function propios(inventarioId: string): Trozo[] {
  return cola.filter((t) => t.inventarioId === inventarioId && delUsuario(t));
}

/** Usuario cuyos trozos se envían y se muestran. null: la cola no envía nada. */
export function fijarUsuarioCola(usuarioId: string | null) {
  usuarioActual = usuarioId || null;
  parada401 = false;
  avisar();
  if (usuarioActual) void drenarColaAudio();
}

export function suscribirColaAudio(fn: () => void): () => void {
  oyentes.add(fn);
  void cargar().then(() => {
    avisar();
    void drenarColaAudio();
  });
  return () => { oyentes.delete(fn); };
}

/** Respuestas del servidor a cada trozo enviado (las líneas interpretadas). */
export function alResponderAudio(
  fn: (inventarioId: string, body: RespuestaAudio, meta: MetaRespuesta) => void,
): () => void {
  receptores.add(fn);
  return () => { receptores.delete(fn); };
}

export function resumenColaAudio(inventarioId: string): ResumenColaAudio {
  const mios = propios(inventarioId);
  const conError = mios.filter((t) => t.estado === 'error');
  return {
    pendientes: mios.filter((t) => t.estado === 'pendiente').length,
    enviando: mios.filter((t) => t.estado === 'enviando').length,
    errores: conError.length,
    mensajeError: conError[conError.length - 1]?.error ?? null,
    trozos: mios.map((t) => ({ idEnvio: t.idEnvio, estado: t.estado, creadoEn: t.creadoEn, error: t.error ?? null })),
    persistente,
    sinSesion: parada401,
    sinUsuario: cola.filter((t) => t.inventarioId === inventarioId && !t.usuarioId).length,
  };
}

/**
 * Trozos sin enviar (pendientes, enviándose o en error) de ese usuario e inventario, aunque la
 * cola no tenga usuario fijado (panel cerrado). Para avisar fuera del panel.
 */
export function pendientesDeUsuario(inventarioId: string, usuarioId: string | null): number {
  if (!usuarioId) return 0;
  return cola.filter((t) => t.inventarioId === inventarioId && t.usuarioId === usuarioId).length;
}

/** idEnvio del trozo de ese inventario que se está enviando ahora (como mucho uno). */
export function idsEnVuelo(inventarioId: string): string[] {
  const t = enCurso?.t;
  return t && t.inventarioId === inventarioId && delUsuario(t) ? [t.idEnvio] : [];
}

/**
 * Guarda el trozo (primero en IndexedDB) y lo pone a la cola. Devuelve su idEnvio.
 * Con usuarioId '' se guarda igual pero no se envía nunca (se borra a los 7 días).
 */
export async function encolarTrozo(args: {
  inventarioId: string;
  usuarioId: string;
  blob: Blob;
  tipo: string;
}): Promise<string> {
  const t: Trozo = {
    idEnvio: idSeguro(),
    inventarioId: args.inventarioId,
    usuarioId: args.usuarioId,
    blob: args.blob,
    tipo: args.tipo || args.blob.type || 'audio/webm',
    creadoEn: Date.now(),
    estado: 'pendiente',
    intentos: 0,
    esperasLibres: 0,
    error: null,
  };
  await cargar();
  await guardarBd(t);
  cola.push(t);
  cola.sort((a, b) => a.creadoEn - b.creadoEn);
  avisar();
  void drenarColaAudio();
  return t.idEnvio;
}

type Resultado =
  | { tipo: 'ok'; body: RespuestaAudio }
  | { tipo: 'reintentar'; cuenta: boolean }
  | { tipo: 'sinSesion' }
  | { tipo: 'error'; mensaje: string };

async function enviar(t: Trozo): Promise<Resultado> {
  const fd = new FormData();
  fd.append('idEnvio', t.idEnvio);
  fd.append('audio', t.blob, `dictado-${t.idEnvio}.${extension(t.tipo)}`);
  let res: Response;
  try {
    res = await apiFetch(`/api/inventarios/${encodeURIComponent(t.inventarioId)}/dictado/audio`, {
      method: 'POST',
      body: fd,
      timeoutMs: TIMEOUT_ENVIO_MS,
    });
  } catch {
    // Timeout o fallo de conexión. Si ahora no hay red, no cuenta: se reintenta al volver.
    return { tipo: 'reintentar', cuenta: hayRed() };
  }
  const body = (await res.json().catch(() => ({}))) as RespuestaAudio;
  if (res.ok) return { tipo: 'ok', body };
  const mensaje = typeof body.error === 'string' ? body.error : '';
  if (res.status === 401) return { tipo: 'sinSesion' };
  if (res.status === 409) {
    // «Se está procesando» o «ha cambiado»: se reintenta. Inventario importado o sesión cerrada: no.
    if (/importad|cerrad/i.test(mensaje)) return { tipo: 'error', mensaje };
    return { tipo: 'reintentar', cuenta: false };
  }
  if (res.status === 429) return { tipo: 'reintentar', cuenta: false };
  if (res.status === 408 || res.status >= 500) return { tipo: 'reintentar', cuenta: true };
  return { tipo: 'error', mensaje: mensaje || `No se ha podido enviar el audio (error ${res.status}).` };
}

function programar(ms: number) {
  if (reloj) clearTimeout(reloj);
  reloj = setTimeout(() => {
    reloj = null;
    void drenarColaAudio();
  }, Math.max(0, ms));
}

function espera(n: number): number {
  return Math.min(ESPERA_MAX_MS, ESPERA_BASE_MS * 2 ** Math.min(Math.max(n - 1, 0), 6));
}

/** Siguiente trozo listo: el primero no en error de cada inventario, si no está esperando. */
function siguiente(): { t: Trozo | null; esperaMin: number } {
  const ahora = Date.now();
  const bloqueados = new Set<string>();
  let esperaMin = Infinity;
  for (const x of cola) {
    if (!delUsuario(x) || x.estado !== 'pendiente' || x.descartado) continue;
    if (bloqueados.has(x.inventarioId)) continue;
    const resta = (esperas.get(x.idEnvio) ?? 0) - ahora;
    if (resta > 0) {
      bloqueados.add(x.inventarioId);
      esperaMin = Math.min(esperaMin, resta);
      continue;
    }
    return { t: x, esperaMin };
  }
  return { t: null, esperaMin };
}

async function quitar(t: Trozo) {
  cola = cola.filter((x) => x !== t);
  esperas.delete(t.idEnvio);
  await borrarBd(t.idEnvio);
}

async function procesar(t: Trozo, r: Resultado): Promise<'seguir' | 'parar'> {
  const meta: MetaRespuesta = { idEnvio: t.idEnvio, creadoEn: t.creadoEn, descartado: Boolean(t.descartado) };
  if (r.tipo === 'ok') {
    await quitar(t);
    for (const fn of receptores) fn(t.inventarioId, r.body, meta);
    avisar();
    return 'seguir';
  }
  if (t.descartado) {
    await quitar(t);
    avisar();
    return 'seguir';
  }
  if (r.tipo === 'sinSesion') {
    t.estado = 'pendiente';
    parada401 = true;
    avisar();
    return 'parar';
  }
  if (r.tipo === 'error') {
    t.estado = 'error';
    t.error = r.mensaje;
    await guardarBd(t);
    avisar();
    return 'seguir';
  }
  t.estado = 'pendiente';
  if (r.cuenta) {
    t.intentos += 1;
    if (t.intentos >= MAX_INTENTOS) {
      t.estado = 'error';
      t.error = MENSAJE_AGOTADO;
      await guardarBd(t);
      avisar();
      return 'seguir';
    }
    esperas.set(t.idEnvio, Date.now() + espera(t.intentos));
  } else {
    t.esperasLibres += 1;
    esperas.set(t.idEnvio, Date.now() + espera(t.esperasLibres));
  }
  await guardarBd(t);
  avisar();
  return 'seguir';
}

export async function drenarColaAudio(): Promise<void> {
  if (trabajando) {
    repetir = true;
    return;
  }
  trabajando = true;
  try {
    await cargar();
    for (;;) {
      if (!hayRed() || !usuarioActual || parada401) break;
      const { t, esperaMin } = siguiente();
      if (!t) {
        if (esperaMin < Infinity) programar(esperaMin);
        break;
      }
      t.estado = 'enviando';
      let terminar: () => void = () => {};
      const fin = new Promise<void>((listo) => { terminar = listo; });
      enCurso = { t, fin };
      avisar();
      let paso: 'seguir' | 'parar' = 'seguir';
      try {
        paso = await procesar(t, await enviar(t));
      } finally {
        enCurso = null;
        terminar();
      }
      if (paso === 'parar') break;
    }
  } finally {
    trabajando = false;
  }
  if (repetir) {
    repetir = false;
    void drenarColaAudio();
  }
}

/** Reintenta ya los pendientes, sin esperar a que venza su espera (al reabrir o al volver la red). */
export function reintentarAhora() {
  esperas.clear();
  void drenarColaAudio();
}

/** Los trozos en error de un inventario (del usuario actual) vuelven a la cola. */
export async function reintentarErrores(inventarioId: string) {
  await cargar();
  for (const t of propios(inventarioId)) {
    if (t.estado !== 'error') continue;
    t.estado = 'pendiente';
    t.intentos = 0;
    t.esperasLibres = 0;
    t.error = null;
    esperas.delete(t.idEnvio);
    await guardarBd(t);
  }
  avisar();
  void drenarColaAudio();
}

/**
 * Borra de la cola y de IndexedDB el audio sin enviar de un inventario (del usuario actual).
 * Si uno se está enviando, se marca y se espera a que acabe ese envío: `enVuelo` son sus idEnvio,
 * por si el servidor llegó a crear líneas (las descarta quien llama).
 */
export async function descartarTrozos(
  inventarioId: string,
  { soloErrores = false }: { soloErrores?: boolean } = {},
): Promise<{ descartados: number; enVuelo: string[] }> {
  await cargar();
  const vuelo = enCurso;
  const fuera = propios(inventarioId).filter((t) => t !== vuelo?.t && (!soloErrores || t.estado === 'error'));
  for (const t of fuera) await quitar(t);
  const enVuelo: string[] = [];
  if (!soloErrores && vuelo && vuelo.t.inventarioId === inventarioId && delUsuario(vuelo.t)) {
    vuelo.t.descartado = true;
    enVuelo.push(vuelo.t.idEnvio);
    avisar();
    await vuelo.fin;
  }
  avisar();
  return { descartados: fuera.length + enVuelo.length, enVuelo };
}

/**
 * Se resuelve cuando no quedan trozos de ese inventario pendientes ni enviándose: todos enviados
 * o en error definitivo. También al abortar `signal`.
 */
export function esperarCola(inventarioId: string, signal?: AbortSignal): Promise<void> {
  return new Promise((listo) => {
    const libre = () => {
      const r = resumenColaAudio(inventarioId);
      return r.pendientes + r.enviando === 0;
    };
    if (libre() || signal?.aborted) {
      listo();
      return;
    }
    const fin = () => {
      oyentes.delete(comprobar);
      signal?.removeEventListener('abort', fin);
      listo();
    };
    const comprobar = () => { if (libre()) fin(); };
    oyentes.add(comprobar);
    signal?.addEventListener('abort', fin);
    reintentarAhora();
  });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', reintentarAhora);
}
