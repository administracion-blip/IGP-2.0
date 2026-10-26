/**
 * Cola de subida de las fotos del conteo.
 * Si no hay red, el fichero se queda en el móvil y se reintenta.
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { apiFetch } from '../../utils/api';

export type PosicionFoto = 'frente' | 'superior';

type Pendiente = {
  inventarioId: string;
  numero: number;
  posicion: PosicionFoto;
  uri: string;
  nombre: string;
  contentType: string;
  tamano: number;
  estado: 'pendiente' | 'subiendo' | 'error';
};

const MAX = 6;
const NOMBRE_COLA = 'inventario-fotos-cola.json';

let cola: Pendiente[] = [];
let lista = false;
let trabajando = false;
let alConfirmar: (() => void) | null = null;
const oyentes = new Set<() => void>();

function avisar() {
  for (const fn of oyentes) fn();
}

function rutaCola(): string | null {
  const base = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  return base ? `${base}${NOMBRE_COLA}` : null;
}

async function persistir() {
  const ruta = rutaCola();
  const texto = JSON.stringify(cola);
  if (ruta) {
    await FileSystem.writeAsStringAsync(ruta, texto).catch(() => {});
    return;
  }
  if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
    try { localStorage.setItem(NOMBRE_COLA, texto); } catch { /* la sesión sigue en memoria */ }
  }
}

async function cargar() {
  if (lista) return;
  lista = true;
  const ruta = rutaCola();
  try {
    if (ruta) {
      const info = await FileSystem.getInfoAsync(ruta);
      if (info.exists) {
        cola = JSON.parse(await FileSystem.readAsStringAsync(ruta)) as Pendiente[];
      }
    } else if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const guardado = localStorage.getItem(NOMBRE_COLA);
      if (guardado) cola = JSON.parse(guardado) as Pendiente[];
    }
  } catch {
    cola = [];
  }
  for (const item of cola) {
    if (item.estado === 'subiendo') item.estado = 'pendiente';
  }
  avisar();
  void drenarCola();
}

export function suscribirCola(fn: () => void): () => void {
  oyentes.add(fn);
  void cargar();
  return () => { oyentes.delete(fn); };
}

export function alSubirFoto(fn: (() => void) | null) {
  alConfirmar = fn;
}

export function resumenCola(inventarioId: string, fotosServidor: Array<{ numero: number }>) {
  const propias = cola.filter((f) => f.inventarioId === inventarioId);
  const numeros = new Set(fotosServidor.map((f) => f.numero));
  for (const f of propias) numeros.add(f.numero);
  return {
    subidas: fotosServidor.length,
    enProceso: propias.filter((f) => f.estado !== 'error').length,
    ocupados: numeros.size,
  };
}

export function numerosEnCola(inventarioId: string): number[] {
  return [...new Set(cola.filter((f) => f.inventarioId === inventarioId).map((f) => f.numero))];
}

export function siguienteNumero(inventarioId: string, fotosServidor: Array<{ numero: number }>): number | null {
  const usados = new Set(fotosServidor.map((f) => f.numero));
  for (const f of cola) {
    if (f.inventarioId === inventarioId) usados.add(f.numero);
  }
  for (let n = 1; n <= MAX; n += 1) {
    if (!usados.has(n)) return n;
  }
  return null;
}

async function copiarAlMovil(item: Pendiente): Promise<string> {
  const base = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!base) return item.uri;
  const dir = `${base}inventario-fotos/${item.inventarioId}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const destino = `${dir}${item.numero}-${item.posicion}.jpg`;
  await FileSystem.copyAsync({ from: item.uri, to: destino });
  return destino;
}

export async function encolarFoto(item: Omit<Pendiente, 'estado' | 'uri'> & { uri: string }) {
  await cargar();
  const uri = await copiarAlMovil({ ...item, estado: 'pendiente' });
  let tamano = item.tamano;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && 'size' in info && info.size) tamano = info.size;
  } catch { /* se usa el tamaño que traía la foto */ }
  cola.push({ ...item, uri, tamano: tamano || 1, estado: 'pendiente' });
  await persistir();
  avisar();
  void drenarCola();
}

function hayRed(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return true;
}

async function subir(item: Pendiente): Promise<'ok' | 'luego' | 'error'> {
  const id = encodeURIComponent(item.inventarioId);
  let preparada: Response;
  try {
    preparada = await apiFetch(`/api/inventarios/${id}/fotos/preparar`, {
      method: 'POST',
      body: JSON.stringify({
        numero: item.numero,
        posicion: item.posicion,
        nombre: item.nombre,
        contentType: item.contentType,
        tamano: item.tamano,
      }),
    });
  } catch {
    return 'luego';
  }
  if (!preparada.ok) return preparada.status >= 500 ? 'luego' : 'error';
  const prep = await preparada.json() as { uploadUrl?: string; s3Key?: string };
  if (!prep.uploadUrl || !prep.s3Key) return 'error';
  try {
    const archivo = await fetch(item.uri);
    const cuerpo = await archivo.blob();
    const puesta = await fetch(prep.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': item.contentType },
      body: cuerpo,
    });
    if (!puesta.ok) return 'luego';
  } catch {
    return 'luego';
  }
  try {
    const confirmada = await apiFetch(`/api/inventarios/${id}/fotos/confirmar`, {
      method: 'POST',
      body: JSON.stringify({ numero: item.numero, posicion: item.posicion, s3Key: prep.s3Key }),
    });
    if (!confirmada.ok) return confirmada.status >= 500 ? 'luego' : 'error';
  } catch {
    return 'luego';
  }
  return 'ok';
}

export async function drenarCola() {
  if (trabajando) return;
  if (!hayRed()) return;
  trabajando = true;
  try {
    await cargar();
    for (const item of [...cola]) {
      if (!hayRed()) break;
      if (item.estado === 'error') continue;
      item.estado = 'subiendo';
      avisar();
      const resultado = await subir(item);
      if (resultado === 'ok') {
        cola = cola.filter((f) => f !== item);
        if (item.uri.startsWith(FileSystem.documentDirectory || '___') || item.uri.startsWith(FileSystem.cacheDirectory || '___')) {
          await FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
        }
        alConfirmar?.();
      } else if (resultado === 'error') {
        item.estado = 'error';
      } else {
        item.estado = 'pendiente';
      }
      await persistir();
      avisar();
    }
  } finally {
    trabajando = false;
  }
}

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('online', () => { void drenarCola(); });
}
