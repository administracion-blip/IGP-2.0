/**
 * Envíos internos entre locales: quién sirve la mercancía y qué consecuencia de
 * facturación tiene.
 *
 * La facturación mensual de ventas internas agrupa los pedidos por sociedad que
 * sirve y sociedad que recibe, así que un pedido cuyo origen no es el Almacén
 * General acaba en una factura entre dos sociedades del grupo. Aquí vive el
 * cruce que permite anticiparlo en pantalla: almacén → local (por el campo
 * `almacen origen` del local) → sociedad (`id_empresa` / `Empresa`).
 *
 * Todo el módulo tolera datos incompletos, porque el maestro los admite:
 * locales sin almacenes, almacenes que no pertenecen a ningún local, almacenes
 * compartidos por varios locales y locales sin sociedad. En esos casos se avisa
 * de que no se puede anticipar la factura, nunca se inventa una sociedad.
 */
import { parseAlmacenesOrigen } from '../utils/parseAlmacenesOrigen';
import { valorEnLocal } from '../utils/valorEnLocal';
import { normalizarIdEmpresa } from './empresaId';

/** Registro tal como llega de la API (claves con capitalización variable). */
export type RegistroApi = Record<string, unknown>;

/** Texto comparable: sin acentos, en minúsculas y sin dobles espacios (igual que el backend). */
function normalizar(txt: string | number | undefined | null): string {
  return String(txt ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Nombre normalizado del Almacén General en el maestro `igp_Almacenes`.
 *
 * El maestro se sincroniza desde Ágora y no tiene ningún campo que marque el
 * almacén central, así que el nombre es lo único que lo distingue.
 */
const NOMBRE_ALMACEN_GENERAL = 'almacen general';

/** Id del almacén tal como lo guardan los pedidos en `AlmacenOrigenId`. */
export function idAlmacen(almacen: RegistroApi): string {
  return String(valorEnLocal(almacen, 'Id') ?? '').trim();
}

export function nombreAlmacen(almacen: RegistroApi): string {
  return String(valorEnLocal(almacen, 'Nombre') ?? '').trim();
}

/** Id del local en el maestro (`id_Locales`, con los alias que usan las pantallas). */
export function idLocal(local: RegistroApi): string {
  return String(
    valorEnLocal(local, 'id_Locales') ?? valorEnLocal(local, 'Id_Locales') ?? valorEnLocal(local, 'Id') ?? '',
  ).trim();
}

export function nombreLocal(local: RegistroApi): string {
  return String(valorEnLocal(local, 'nombre') ?? valorEnLocal(local, 'Nombre') ?? '').trim();
}

/**
 * ¿Es el Almacén General, el origen habitual de los pedidos?
 *
 * Por igualdad exacta, igual que el backend (`api/routes/pedidos.js`), que exige
 * el permiso `pedidos.crear_entre_locales` a todo pedido cuyo origen no sea este
 * almacén. Por inclusión también casarían almacenes de local como
 * `ALMACEN GENERAL NEPTUNO`, que sí generan factura entre sociedades: darlos por
 * central haría que el backend rechazara con un 403 los pedidos normales.
 */
export function esAlmacenGeneral(almacen: RegistroApi): boolean {
  return normalizar(nombreAlmacen(almacen)) === NOMBRE_ALMACEN_GENERAL;
}

/**
 * Id del Almacén General en el maestro, o cadena vacía si ningún almacén se
 * llama así. La cadena vacía no debe tratarse como «cualquier almacén sirve»:
 * significa que no se puede saber cuál es el central, y la pantalla tiene que
 * avisar en vez de preseleccionar un origen que el backend rechazaría.
 */
export function idAlmacenGeneral(almacenes: RegistroApi[]): string {
  const alm = almacenes.find((a) => esAlmacenGeneral(a));
  return alm ? idAlmacen(alm) : '';
}

/** Nombres de almacén configurados en el local (campo `almacen origen`, separado por comas). */
export function nombresAlmacenDeLocal(local: RegistroApi): string[] {
  const val = valorEnLocal(local, 'almacen origen') ?? valorEnLocal(local, 'Almacen origen');
  return parseAlmacenesOrigen(val as string | number | undefined);
}

/**
 * Almacenes del maestro que corresponden al local. El local guarda **nombres**,
 * así que se casa por nombre exacto o por inclusión, igual que las pantallas de
 * compras.
 */
export function almacenesDeLocal(local: RegistroApi | null, almacenes: RegistroApi[]): RegistroApi[] {
  if (!local) return [];
  const permitidos = nombresAlmacenDeLocal(local);
  if (permitidos.length === 0) return [];
  return almacenes.filter((alm) => {
    const nombre = nombreAlmacen(alm);
    if (!nombre) return false;
    return permitidos.some((n) => n === nombre || normalizar(nombre).includes(normalizar(n)));
  });
}

/** Local del maestro por su id, o `null` si no está entre los cargados. */
export function buscarLocalPorId(localId: string, locales: RegistroApi[]): RegistroApi | null {
  const id = String(localId ?? '').trim();
  if (!id) return null;
  return locales.find((loc) => idLocal(loc) === id) ?? null;
}

/**
 * Local al que pertenece un almacén, o `null` si ninguno lo tiene configurado o
 * si lo comparten varios (no se puede saber quién sirve, mejor avisar que
 * elegir uno al azar).
 */
export function localDeAlmacen(
  almacenId: string,
  locales: RegistroApi[],
  almacenes: RegistroApi[],
): RegistroApi | null {
  const id = String(almacenId ?? '').trim();
  if (!id) return null;
  const almacen = almacenes.find((alm) => idAlmacen(alm) === id);
  if (!almacen) return null;
  const candidatos = locales.filter((loc) =>
    almacenesDeLocal(loc, almacenes).some((alm) => idAlmacen(alm) === id),
  );
  return candidatos.length === 1 ? candidatos[0] : null;
}

/** Sociedad del local: el vínculo estable (`id_empresa`) y el nombre para mostrar. */
export function sociedadDeLocal(local: RegistroApi | null): { id: string; nombre: string } {
  if (!local) return { id: '', nombre: '' };
  const id = normalizarIdEmpresa(valorEnLocal(local, 'id_empresa') as string | number | undefined);
  const nombre = String(valorEnLocal(local, 'Empresa') ?? '').trim();
  return { id, nombre };
}

/** Etiqueta de la sociedad: su nombre y, si no lo tiene, el id del maestro. */
function etiquetaSociedad(sociedad: { id: string; nombre: string }): string {
  if (sociedad.nombre) return sociedad.nombre;
  return sociedad.id ? `la sociedad ${sociedad.id}` : '';
}

function etiquetaLocal(local: RegistroApi | null, porDefecto: string): string {
  const nombre = local ? nombreLocal(local) : '';
  return nombre || porDefecto;
}

export type AvisoSalida = {
  /** `info` cuando no hay factura que anunciar; `aviso` cuando conviene fijarse. */
  tono: 'info' | 'aviso';
  texto: string;
};

/**
 * Qué implica en facturación que la mercancía salga de `localOrigen` hacia
 * `localDestino`. Devuelve `null` cuando todavía no hay nada que contar (no se
 * ha elegido uno de los dos lados).
 *
 * `localOrigenDesconocido` distingue «aún no lo has elegido» de «el almacén de
 * origen no se puede atribuir a ningún local»: en el segundo caso hay que
 * avisar de que no se puede anticipar la factura.
 */
export function avisoFacturacionSalida(opts: {
  localOrigen: RegistroApi | null;
  localDestino: RegistroApi | null;
  localOrigenDesconocido?: boolean;
}): AvisoSalida | null {
  const { localOrigen, localDestino, localOrigenDesconocido } = opts;
  if (localOrigenDesconocido) {
    return {
      tono: 'aviso',
      texto:
        'No se puede identificar el local del almacén de origen, así que tampoco qué sociedad sirve la mercancía ni si esta salida generará factura.',
    };
  }
  if (!localOrigen || !localDestino) return null;

  const origen = etiquetaLocal(localOrigen, 'el local que sirve');
  const destino = etiquetaLocal(localDestino, 'el local que recibe');

  if (idLocal(localOrigen) && idLocal(localOrigen) === idLocal(localDestino)) {
    return {
      tono: 'info',
      texto: `Origen y destino son el mismo local (${origen}): es un movimiento interno y no generará factura.`,
    };
  }

  const socOrigen = sociedadDeLocal(localOrigen);
  const socDestino = sociedadDeLocal(localDestino);

  if (!socOrigen.id || !socDestino.id) {
    const sinSociedad = [!socOrigen.id ? origen : '', !socDestino.id ? destino : ''].filter(Boolean).join(' y ');
    return {
      tono: 'aviso',
      texto: `Sin sociedad asignada en ${sinSociedad}: no se puede anticipar si esta salida generará factura. Asígnala en Locales.`,
    };
  }

  if (socOrigen.id === socDestino.id) {
    const misma = etiquetaSociedad(socOrigen);
    return {
      tono: 'info',
      texto: misma
        ? `${origen} y ${destino} son de la misma sociedad (${misma}), así que esta salida no generará factura.`
        : `${origen} y ${destino} son de la misma sociedad, así que esta salida no generará factura.`,
    };
  }

  return {
    tono: 'aviso',
    texto: `La mercancía sale de ${origen} (${etiquetaSociedad(socOrigen)}) hacia ${destino} (${etiquetaSociedad(socDestino)}). Al cerrar el mes se facturará: ${etiquetaSociedad(socOrigen)} emitirá factura a ${etiquetaSociedad(socDestino)}.`,
  };
}
