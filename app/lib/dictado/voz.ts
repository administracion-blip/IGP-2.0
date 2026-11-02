/**
 * Respuesta por voz del dictado, solo en el navegador: speechSynthesis en es-ES y un pitido.
 * Sin red y sin guardar audio. La preferencia queda en este navegador.
 */

export type ModoVoz = 'silencio' | 'pitido' | 'hablada';

export type AvisoVoz =
  | { tipo: 'confirmacion'; texto: string }
  | { tipo: 'pregunta'; texto: string }
  | { tipo: 'no_entendido' };

type LineaAviso = {
  estado: string;
  productId: string | null;
  productoNombre: string | null;
  cantidad: { total: number } | null;
  confirmar: boolean;
  candidatos?: Array<{ productId: string; nombre: string }>;
};

const CLAVE = 'igp-dictado-voz';

const MODOS: ModoVoz[] = ['silencio', 'pitido', 'hablada'];

export function leerModoVoz(): ModoVoz {
  try {
    const v = localStorage.getItem(CLAVE);
    if (v === 'silencio' || v === 'pitido' || v === 'hablada') return v;
  } catch { /* sin almacenamiento: pitido */ }
  return 'pitido';
}

export function guardarModoVoz(modo: ModoVoz) {
  if (!MODOS.includes(modo)) return;
  try { localStorage.setItem(CLAVE, modo); } catch { /* sigue en memoria */ }
}

function textoCantidad(total: number): string {
  return Number.isInteger(total) ? String(total) : String(total).replace('.', ',');
}

/** «¿Ballantines 10 o 12?» a partir de los nombres que comparten la primera palabra. */
function textoPregunta(nombres: string[]): string {
  const lista = nombres.map((n) => n.trim()).filter(Boolean).slice(0, 3);
  if (lista.length === 0) return '¿Cuál de ellos?';
  const cabezas = lista.map((n) => n.split(/\s+/)[0] || n);
  const misma = cabezas.every((p) => p.toLocaleLowerCase('es') === cabezas[0].toLocaleLowerCase('es'));
  if (misma) {
    const restos = lista.map((n) => n.split(/\s+/).slice(1).join(' ') || n);
    return `¿${cabezas[0]} ${restos.join(' o ')}?`;
  }
  return `¿${lista.join(' o ')}?`;
}

/**
 * Solo tres avisos: confirmación corta, pregunta si hay varios parecidos, o que no se entendió.
 * Un ya contado o un cálculo no se narran.
 */
export function avisoDeLinea(l: LineaAviso): AvisoVoz | null {
  if (l.estado === 'descartada' || l.estado === 'deshecha') return null;
  const otros = (l.candidatos ?? []).filter((c) => c.productId !== l.productId && c.nombre.trim());
  if (!l.productId && otros.length >= 2) {
    return { tipo: 'pregunta', texto: textoPregunta(otros.map((c) => c.nombre)) };
  }
  if (!l.productId) return { tipo: 'no_entendido' };
  if (l.confirmar) return null;
  const nombre = (l.productoNombre || '').trim();
  if (!nombre) return null;
  const cant = l.cantidad ? textoCantidad(l.cantidad.total) : '';
  return { tipo: 'confirmacion', texto: cant ? `${nombre}, ${cant}` : nombre };
}

function vozEspanola(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === 'undefined') return null;
  const lista = speechSynthesis.getVoices();
  return lista.find((v) => v.lang.toLowerCase().startsWith('es')) ?? null;
}

if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener?.('voiceschanged', () => { vozEspanola(); });
}

function pitido(): Promise<void> {
  return new Promise((resolve) => {
    const terminar = () => resolve();
    try {
      const w = window as Window & { webkitAudioContext?: typeof AudioContext };
      const Ctor = window.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) { terminar(); return; }
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const ganancia = ctx.createGain();
      osc.frequency.value = 880;
      ganancia.gain.value = 0.06;
      osc.connect(ganancia);
      ganancia.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      osc.onended = () => { void ctx.close().catch(() => {}); terminar(); };
      setTimeout(terminar, 400);
    } catch {
      terminar();
    }
  });
}

function decir(texto: string): Promise<void> {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
    return pitido();
  }
  return new Promise((resolve) => {
    let cerrado = false;
    const terminar = () => {
      if (cerrado) return;
      cerrado = true;
      resolve();
    };
    try {
      const frase = new SpeechSynthesisUtterance(texto);
      frase.lang = 'es-ES';
      frase.rate = 1.05;
      const voz = vozEspanola();
      if (voz) frase.voice = voz;
      frase.onend = terminar;
      frase.onerror = terminar;
      speechSynthesis.speak(frase);
      setTimeout(terminar, 8000);
    } catch {
      terminar();
    }
  });
}

let cadena: Promise<void> = Promise.resolve();

function enSerie(trabajo: () => Promise<void>): Promise<void> {
  const siguiente = cadena.then(trabajo, trabajo);
  cadena = siguiente.then(() => {}, () => {});
  return siguiente;
}

/** Para la frase en curso (al cerrar el panel). */
export function callar() {
  cadena = Promise.resolve();
  try { speechSynthesis?.cancel(); } catch { /* sin voz */ }
}

/**
 * Habla las líneas nuevas, en orden. En pitido, los aciertos son un solo pitido.
 * Devuelve null si no hay nada que decir (silencio, o líneas que no se narran).
 */
export function hablarLineas(lineas: LineaAviso[], modo: ModoVoz = leerModoVoz()): Promise<void> | null {
  if (modo === 'silencio') return null;
  const avisos = lineas.map(avisoDeLinea).filter((a): a is AvisoVoz => a != null);
  if (avisos.length === 0) return null;
  const trabajos: Array<() => Promise<void>> = [];
  const confirmaciones = avisos.filter((a) => a.tipo === 'confirmacion');
  if (confirmaciones.length > 0 && modo === 'pitido') trabajos.push(pitido);
  if (modo === 'hablada') {
    for (const a of confirmaciones) trabajos.push(() => decir(a.texto));
  }
  for (const a of avisos) {
    if (a.tipo === 'pregunta') trabajos.push(() => decir(a.texto));
    if (a.tipo === 'no_entendido') trabajos.push(() => decir('No te he entendido'));
  }
  if (trabajos.length === 0) return null;
  return enSerie(async () => {
    for (const trabajo of trabajos) await trabajo();
  });
}
