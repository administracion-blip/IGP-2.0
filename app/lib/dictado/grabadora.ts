/**
 * Grabadora del dictado del conteo. En nativo no se graba: el dictado solo está disponible en la
 * web. La versión que graba vive en grabadora.web.ts (Metro la elige por plataforma); este fichero
 * define el contrato común y es el que ve TypeScript.
 */

/** Trozo completo y decodificable (un fichero por trozo, con su cabecera). */
export type TrozoAudio = {
  blob: Blob;
  tipo: string;
  duracionMs: number;
};

export type OpcionesGrabadora = {
  /**
   * Se llama con cada trozo cerrado: al llegar al máximo, tras un silencio, al pausar, al terminar
   * y al desmontar. Si devuelve una promesa (guardar el trozo), detener() no se resuelve hasta que termine.
   */
  onTrozo: (trozo: TrozoAudio) => Promise<void> | void;
  /** Fallo durante la grabación (micrófono perdido, error del navegador). La grabadora ya se ha parado. */
  onError?: (mensaje: string) => void;
  /** Duración máxima de un trozo. Por defecto MAX_TROZO_MS. */
  maxTrozoMs?: number;
};

export type Grabadora = {
  /** Pide el micrófono y empieza a grabar. Lanza Error con el mensaje en español. */
  iniciar: () => Promise<void>;
  /** Cierra el trozo en curso, espera a que onTrozo lo guarde y suelta el micrófono. */
  detener: () => Promise<void>;
  grabando: () => boolean;
  /** Instante (ms) en que empezó el trozo en curso, o null si no se graba. */
  inicioTrozo: () => number | null;
  /**
   * Cierra el micrófono mientras suena la respuesta, para no transcribirla.
   * Al terminar la promesa vuelve a oír, si la grabación sigue.
   */
  enmudecer: (mientras: Promise<void>) => Promise<void>;
  /** Como detener, sin esperar: para desmontar. */
  liberar: () => void;
};

export const MAX_TROZO_MS = 60000;

export const MENSAJE_NO_DISPONIBLE = 'El dictado solo está disponible en la web';

export const grabadoraDisponible = false;

export function crearGrabadora(_opciones: OpcionesGrabadora): Grabadora {
  return {
    iniciar: async () => {
      throw new Error(MENSAJE_NO_DISPONIBLE);
    },
    detener: async () => {},
    grabando: () => false,
    inicioTrozo: () => null,
    enmudecer: async (mientras) => { await mientras; },
    liberar: () => {},
  };
}
