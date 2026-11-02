/**
 * Grabadora del dictado en el navegador: getUserMedia + MediaRecorder.
 *
 * Cada trozo es un fichero completo: se para el MediaRecorder y se arranca otro sobre el mismo
 * micrófono cada MAX_TROZO_MS (no se usa `timeslice`, que da trozos sin cabecera que el servidor
 * no puede decodificar). También se corta al pausar, al terminar y al desmontar, y en esos casos
 * se suelta el micrófono (tracks.stop) pase lo que pase. detener() no se resuelve hasta que onTrozo
 * ha guardado el último trozo (también el de un corte de MAX_TROZO_MS en curso), salvo que onstop no
 * llegue en ESPERA_ONSTOP_MS. Ante un error del MediaRecorder se para todo (como detener) y luego
 * se avisa.
 */
import type { Grabadora, OpcionesGrabadora, TrozoAudio } from './grabadora';

export type { Grabadora, OpcionesGrabadora, TrozoAudio };

export const MAX_TROZO_MS = 60000;

export const MENSAJE_NO_DISPONIBLE = 'El dictado solo está disponible en la web';

/** Un trozo más corto que esto (un toque de pausa) no se envía. */
const MIN_TROZO_MS = 600;
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

export function crearGrabadora({ onTrozo, onError, maxTrozoMs = MAX_TROZO_MS }: OpcionesGrabadora): Grabadora {
  let stream: MediaStream | null = null;
  let actual: TrozoEnCurso | null = null;
  let corte: ReturnType<typeof setTimeout> | null = null;
  /** Corte de MAX_TROZO_MS en curso: detener() lo espera para no perder ese trozo. */
  let rotando: Promise<void> | null = null;
  let activa = false;
  let fallando = false;
  let tipo = '';

  function soltarMicro() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
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
    try {
      if (rotando) await rotando.catch(() => {});
      await pararTrozo();
    } finally {
      soltarMicro();
    }
  }

  /** Error del MediaRecorder: se para como detener() y luego se avisa. */
  async function fallar(mensaje: string) {
    if (fallando) return;
    fallando = true;
    activa = false;
    try {
      await pararTrozo();
    } finally {
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
    actual = enCurso;
    try {
      recorder.start();
    } catch {
      void fallar('No se ha podido empezar a grabar.');
      return false;
    }
    corte = setTimeout(() => {
      const p = rotar();
      rotando = p;
      void p.finally(() => { if (rotando === p) rotando = null; });
    }, maxTrozoMs);
    return true;
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
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      activa = false;
      throw new Error(mensajeMicro(e));
    }
    if (!activa) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    tipo = tipoSoportado();
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
