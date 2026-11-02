/**
 * Grabadora del dictado en el navegador: getUserMedia + MediaRecorder.
 *
 * Cada trozo es un fichero completo: se para el MediaRecorder y se arranca otro sobre el mismo
 * micrófono (no se usa `timeslice`, que da trozos sin cabecera que el servidor no puede decodificar).
 * Se corta al llegar a MAX_TROZO_MS, tras un silencio de SILENCIO_MS (si en el trozo ya se oyó voz
 * y dura al menos MIN_TROZO_MS), al pausar, al terminar y al desmontar. Al parar se suelta el
 * micrófono (tracks.stop) y se cierra el AudioContext, pase lo que pase. detener() no se resuelve
 * hasta que onTrozo ha guardado el último trozo (también el de un corte en curso), salvo que onstop
 * no llegue en ESPERA_ONSTOP_MS. Ante un error del MediaRecorder se para todo (como detener) y luego
 * se avisa. Si no se puede medir el nivel, la grabación sigue y solo se corta a los 60 s.
 */
import type { Grabadora, OpcionesGrabadora, TrozoAudio } from './grabadora';

export type { Grabadora, OpcionesGrabadora, TrozoAudio };

export const MAX_TROZO_MS = 60000;

export const MENSAJE_NO_DISPONIBLE = 'El dictado solo está disponible en la web';

/** Un trozo más corto que esto (un toque de pausa) no se envía. Tampoco se corta por silencio antes. */
const MIN_TROZO_MS = 600;
/** Silencio seguido, tras haber oído voz en el trozo, que lo cierra. */
const SILENCIO_MS = 1200;
/** Cada cuánto se lee el nivel del micrófono. */
const INTERVALO_NIVEL_MS = 50;
/**
 * Por debajo de esto no hay voz. El ambiente del local no corta el trozo: el silencio se mide
 * respecto al pico de ESTE trozo, no con un suelo que se hunda.
 */
const UMBRAL_MIN = 0.015;
/** La voz tiene que durar esto: un golpe de vaso no cierra un trozo. */
const VOZ_MIN_MS = 250;
/** Silencio de este trozo: el nivel baja de esta parte del pico de voz. */
const RATIO_SILENCIO = 0.4;
/** Tras un error, onstop puede no llegar: no se espera más que esto. */
const ESPERA_ONSTOP_MS = 3000;

const TIPOS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export const grabadoraDisponible =
  typeof window !== 'undefined'
  && typeof MediaRecorder !== 'undefined'
  && typeof navigator !== 'undefined'
  && Boolean(navigator.mediaDevices?.getUserMedia);

function tipoSoportado(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return TIPOS.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

function mensajeMicro(e: unknown): string {
  const nombre = e && typeof e === 'object' && 'name' in e ? String((e as { name?: unknown }).name) : '';
  if (nombre === 'NotAllowedError' || nombre === 'SecurityError' || nombre === 'PermissionDeniedError') {
    return 'No hay permiso para usar el micrófono. Dale permiso en el navegador y vuelve a intentarlo.';
  }
  if (nombre === 'NotFoundError' || nombre === 'OverconstrainedError' || nombre === 'DevicesNotFoundError') {
    return 'No se encuentra ningún micrófono en este dispositivo.';
  }
  if (nombre === 'NotReadableError' || nombre === 'TrackStartError' || nombre === 'AbortError') {
    return 'El micrófono está ocupado por otra aplicación. Ciérrala y vuelve a intentarlo.';
  }
  return 'No se ha podido usar el micrófono.';
}

type TrozoEnCurso = {
  recorder: MediaRecorder;
  empezado: number;
  /** Ha llegado onstop. */
  parado: Promise<void>;
  /** onstop ha llegado y onTrozo ha guardado el trozo. */
  terminado: Promise<void>;
};

/** true si `p` se resuelve antes de `ms`. */
function conLimite(p: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true), new Promise<boolean>((listo) => setTimeout(() => listo(false), ms))]);
}

/** Espera onstop como mucho ESPERA_ONSTOP_MS y, si ha llegado, a que el trozo esté guardado. */
async function esperarTrozo(t: TrozoEnCurso) {
  if (await conLimite(t.parado, ESPERA_ONSTOP_MS)) await t.terminado;
}

/** null si este navegador no tiene Web Audio: la grabación sigue, cortando solo a los 60 s. */
function crearContextoAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

export function crearGrabadora({ onTrozo, onError, maxTrozoMs = MAX_TROZO_MS }: OpcionesGrabadora): Grabadora {
  let stream: MediaStream | null = null;
  let actual: TrozoEnCurso | null = null;
  let corte: ReturnType<typeof setTimeout> | null = null;
  /** Corte en curso (tope de 60 s o silencio): detener() lo espera para no perder ese trozo. */
  let rotando: Promise<void> | null = null;
  let activa = false;
  let fallando = false;
  let tipo = '';

  let audioCtx: AudioContext | null = null;
  let fuente: MediaStreamAudioSourceNode | null = null;
  let analizador: AnalyserNode | null = null;
  let medicion: ReturnType<typeof setInterval> | null = null;
  let datosNivel: Uint8Array<ArrayBuffer> | null = null;
  /** Pico de nivel de ESTE trozo. Se pone a cero al empezar el siguiente. */
  let pico = 0;
  /** Milisegundos de este trozo con nivel de voz (por encima del mínimo y del silencio). */
  let vozMs = 0;
  let ultimoNivel = 0;
  let silencioDesde: number | null = null;

  function soltarMicro() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function pararMedicion() {
    if (medicion) {
      clearInterval(medicion);
      medicion = null;
    }
  }

  /** Suelta el grafo de nivel. No para las pistas: de eso se encarga soltarMicro. */
  function cerrarMedicion() {
    pararMedicion();
    try { fuente?.disconnect(); } catch { /* ya suelta */ }
    fuente = null;
    analizador = null;
    datosNivel = null;
    pico = 0;
    vozMs = 0;
    ultimoNivel = 0;
    silencioDesde = null;
    const ctx = audioCtx;
    audioCtx = null;
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => {});
    }
  }

  /** RMS del micrófono, o null si el contexto no está midiendo (suspended, sin Web Audio…). */
  function leerRms(): number | null {
    const ctx = audioCtx;
    const an = analizador;
    const buf = datosNivel;
    if (!ctx || ctx.state !== 'running' || !an || !buf) return null;
    try {
      an.getByteTimeDomainData(buf);
    } catch {
      return null;
    }
    let suma = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      suma += v * v;
    }
    const rms = Math.sqrt(suma / buf.length);
    return Number.isFinite(rms) ? rms : null;
  }

  /** Cada trozo mide su propio pico: el silencio con el que nace no hereda el anterior. */
  function reiniciarVozTrozo() {
    pico = 0;
    vozMs = 0;
    silencioDesde = null;
  }

  /**
   * Mide el mismo stream que graba el MediaRecorder. Cierra el trozo tras ~1200 ms por debajo
   * del 40 % del pico de voz de ESE trozo, si la voz duró al menos ~250 ms y el trozo ya pasa
   * de MIN_TROZO_MS. El ambiente, que no baja de su propio pico, no corta. Si no se puede medir,
   * no hace nada y el trozo sigue hasta los 60 s.
   */
  function medirNivel() {
    const rms = leerRms();
    if (rms == null) return;
    try {
      if (!activa || !actual || rotando) return;
      const ahora = Date.now();
      const dt = ultimoNivel ? Math.min(ahora - ultimoNivel, 200) : INTERVALO_NIVEL_MS;
      ultimoNivel = ahora;
      const esVoz = rms >= UMBRAL_MIN && (pico === 0 || rms >= pico * RATIO_SILENCIO);
      if (esVoz) {
        pico = Math.max(pico, rms);
        vozMs += dt;
        silencioDesde = null;
        return;
      }
      if (vozMs < VOZ_MIN_MS || pico <= 0) return;
      if (silencioDesde == null) silencioDesde = ahora;
      if (ahora - silencioDesde < SILENCIO_MS) return;
      if (ahora - actual.empezado < MIN_TROZO_MS) return;
      pedirRotacion();
    } catch {
      /* sin medición fiable se sigue cortando solo a los 60 s */
    }
  }

  /** Analyser sobre el stream, sin enviarlo a los altavoces. Un fallo aquí no aborta la grabación. */
  function prepararMedicion(s: MediaStream) {
    const ctx = audioCtx ?? crearContextoAudio();
    if (!ctx) return;
    audioCtx = ctx;
    try {
      const source = ctx.createMediaStreamSource(s);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      fuente = source;
      analizador = analyser;
      datosNivel = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      reiniciarVozTrozo();
      ultimoNivel = 0;
      medicion = setInterval(() => { medirNivel(); }, INTERVALO_NIVEL_MS);
      // Tras getUserMedia: Safari deja el contexto en suspended hasta resume().
      void ctx.resume().catch(() => {});
    } catch {
      cerrarMedicion();
    }
  }

  function limpiarCorte() {
    if (corte) clearTimeout(corte);
    corte = null;
  }

  function pararRecorder(t: TrozoEnCurso) {
    if (t.recorder.state !== 'inactive') {
      try { t.recorder.stop(); } catch { /* ya parado */ }
    }
  }

  async function pararTrozo() {
    limpiarCorte();
    const t = actual;
    actual = null;
    if (!t) return;
    pararRecorder(t);
    await esperarTrozo(t);
  }

  /** Para y suelta el micrófono pase lo que pase. Si justo se estaba cortando, espera ese trozo. */
  async function detener() {
    activa = false;
    limpiarCorte();
    pararMedicion();
    try {
      if (rotando) await rotando.catch(() => {});
      await pararTrozo();
    } finally {
      cerrarMedicion();
      soltarMicro();
    }
  }

  /** Error del MediaRecorder: se para como detener() y luego se avisa. */
  async function fallar(mensaje: string) {
    if (fallando) return;
    fallando = true;
    activa = false;
    pararMedicion();
    try {
      await pararTrozo();
    } finally {
      cerrarMedicion();
      soltarMicro();
      fallando = false;
    }
    onError?.(mensaje);
  }

  /** Arranca un MediaRecorder sobre el micrófono. false si no se ha podido (ya se ha llamado a fallar). */
  function arrancarTrozo(): boolean {
    if (!stream) return false;
    let recorder: MediaRecorder;
    try {
      recorder = tipo ? new MediaRecorder(stream, { mimeType: tipo }) : new MediaRecorder(stream);
    } catch {
      void fallar('Este navegador no puede grabar audio.');
      return false;
    }
    const partes: Blob[] = [];
    const empezado = Date.now();
    let avisarParado: () => void = () => {};
    const parado = new Promise<void>((listo) => { avisarParado = listo; });
    const terminado = new Promise<void>((listo) => {
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) partes.push(ev.data);
      };
      recorder.onstop = () => {
        avisarParado();
        const duracionMs = Date.now() - empezado;
        const tipoTrozo = recorder.mimeType || tipo || partes[0]?.type || 'audio/webm';
        const blob = new Blob(partes, { type: tipoTrozo });
        if (blob.size === 0 || duracionMs < MIN_TROZO_MS) {
          listo();
          return;
        }
        const trozo: TrozoAudio = { blob, tipo: tipoTrozo, duracionMs };
        let guardado: Promise<void> | void;
        try {
          guardado = onTrozo(trozo);
        } catch {
          guardado = undefined;
        }
        Promise.resolve(guardado).catch(() => {}).finally(listo);
      };
    });
    recorder.onerror = () => { void fallar('Se ha cortado la grabación.'); };
    const enCurso: TrozoEnCurso = { recorder, empezado, parado, terminado };
    reiniciarVozTrozo();
    actual = enCurso;
    try {
      recorder.start();
    } catch {
      void fallar('No se ha podido empezar a grabar.');
      return false;
    }
    corte = setTimeout(() => { pedirRotacion(); }, maxTrozoMs);
    return true;
  }

  /** Cierra el trozo (60 s o silencio) y arranca el siguiente. detener() espera a que termine. */
  function pedirRotacion() {
    if (!activa || rotando) return;
    const p = rotar();
    rotando = p;
    void p.finally(() => { if (rotando === p) rotando = null; });
  }

  /** Cierra el trozo y arranca el siguiente sobre el mismo micrófono. */
  async function rotar() {
    limpiarCorte();
    const previo = actual;
    actual = null;
    if (previo) pararRecorder(previo);
    if (activa && stream) arrancarTrozo();
    if (previo) await esperarTrozo(previo);
  }

  async function iniciar() {
    if (activa) return;
    if (!grabadoraDisponible) throw new Error(MENSAJE_NO_DISPONIBLE);
    activa = true;
    // El contexto nace en el gesto; resume() va justo después de getUserMedia (Safari).
    audioCtx = crearContextoAudio();
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      activa = false;
      cerrarMedicion();
      throw new Error(mensajeMicro(e));
    }
    if (!activa) {
      s.getTracks().forEach((t) => t.stop());
      cerrarMedicion();
      return;
    }
    stream = s;
    tipo = tipoSoportado();
    prepararMedicion(s);
    for (const pista of s.getAudioTracks()) {
      pista.addEventListener('ended', () => {
        if (!activa || stream !== s) return;
        void fallar('Se ha perdido el micrófono.');
      });
    }
    if (!arrancarTrozo()) throw new Error('No se ha podido empezar a grabar.');
  }

  return {
    iniciar,
    detener,
    grabando: () => activa && actual != null,
    inicioTrozo: () => actual?.empezado ?? null,
    liberar: () => { void detener(); },
  };
}
