import { useCallback, useState } from 'react';
import { errorMessage } from '../utils/api';
import { crearEmpresaConIdLibre, type EmpresaMaestro } from '../lib/empresaId';
import type { Borrador } from '../types/registroMasivo';

/**
 * Hook que encapsula el modal "Crear empresa desde OCR" del registro masivo.
 *
 * Responsabilidades:
 * - Estado UI (visibilidad, formulario editable, flag guardando, error inline).
 * - Formulario con TODOS los atributos de `igp_Empresas`, de modo que el alta
 *   desde OCR deje la ficha completa sin tener que ir después al maestro.
 * - Prefill al abrir: nombre e id sugeridos, CIF del borrador (solo lectura) y
 *   dirección de la entidad candidata que casa con ese CIF (se sanea y se
 *   intenta partir en Direccion / Cp / Municipio).
 * - Alta vía `crearEmpresaConIdLibre` (`app/lib/empresaId.ts`), que reintenta
 *   con un id nuevo si el calculado estaba ocupado, y propagación del resultado
 *   al padre vía callbacks `onCreated`, `onSuccess`, `onError`.
 *
 * El padre es responsable de mutar el array de `borradores` en respuesta
 * al éxito (vía `onCreated(idx, emp, nombre)`); el hook nunca muta estado
 * del padre directamente, lo que lo mantiene desacoplado. También es el padre
 * quien calcula el próximo `id_empresa` libre y lo pasa en `abrir()`, porque
 * es quien tiene cargado el catálogo de empresas.
 *
 * Los errores se exponen además como `error` para pintarlos DENTRO del modal:
 * en nativo el `Modal` de RN es una ventana aparte y un toast del padre queda
 * detrás, así que el usuario no vería nada al pulsar Guardar.
 */

/**
 * Atributos exactos de la tabla `igp_Empresas` en AWS (mismo orden que
 * `ATRIBUTOS_TABLA_EMPRESAS` en `app/(app)/empresas.tsx`).
 */
export const ATRIBUTOS_TABLA_EMPRESAS = [
  'id_empresa',
  'Nombre',
  'Cif',
  'Iban',
  'IbanAlternativo',
  'Direccion',
  'Cp',
  'Municipio',
  'Provincia',
  'Email',
  'Telefono',
  'Tipo de recibo',
  'Vencimiento',
  'Etiqueta',
  'Cuenta contable',
  'Administrador',
  'Sede',
  'CCC',
] as const;

export type CampoEmpresa = (typeof ATRIBUTOS_TABLA_EMPRESAS)[number];

/**
 * Formulario del modal. Todos los campos son texto; `Etiqueta` se edita como
 * lista separada por comas y se convierte a array al enviar (igual que hace
 * la edición rápida de `app/(app)/empresas.tsx`).
 */
export type FormEmpresa = Record<CampoEmpresa, string>;

const FORM_VACIO: FormEmpresa = ATRIBUTOS_TABLA_EMPRESAS.reduce(
  (acc, key) => ({ ...acc, [key]: '' }),
  {} as FormEmpresa,
);

/** `"C/ Mayor 5, 28001 MADRID"` → calle / CP / municipio. */
const DIRECCION_RE = /^\s*(.+?)\s*,\s*(\d{5})\s+(.+?)\s*$/;

/**
 * Primer indicio de vía dentro del texto. El OCR entrega la dirección con el
 * nombre y el CIF del emisor pegados delante (recorta N caracteres antes del
 * CIF), así que cortamos por aquí para no rellenar `Direccion` con basura.
 */
const INDICIO_VIA_RE =
  /(^|[\s,;:])(c\/|c\.\/|calle|avda|avenida|av\.|plaza|pza|paseo|p\.º|ctra|carretera|camino|polígono|poligono|pol\.|ronda|travesía|travesia|urbanización|urbanizacion|urb\.|glorieta|rambla)/i;

/** Token con forma de CIF/NIF al principio del texto (A46103834, 12345678Z…). */
const CIF_INICIAL_RE = /^[A-Z]?\d{7,8}[A-Z]?\s*[,.\-]?\s*/i;

/**
 * Limpia la dirección sugerida por el OCR y la parte en calle / CP / municipio.
 * Si no se reconoce ningún indicio de vía se deja el texto tal cual (mejor un
 * texto largo en `Direccion` que perder datos).
 */
function partirDireccion(texto: string): { Direccion: string; Cp: string; Municipio: string } {
  let limpio = (texto || '').trim();
  const via = INDICIO_VIA_RE.exec(limpio);
  if (via) {
    limpio = limpio.slice(via.index + via[1].length).replace(CIF_INICIAL_RE, '').trim();
  }
  const m = DIRECCION_RE.exec(limpio);
  if (!m) return { Direccion: limpio, Cp: '', Municipio: '' };
  return { Direccion: m[1], Cp: m[2], Municipio: m[3] };
}

/** Empresa devuelta por el backend tras el alta (`{ ok, empresa }`). */
export type EmpresaCreada = EmpresaMaestro;

export type UseCrearEmpresaModalReturn = {
  visible: boolean;
  /** CIF del borrador para el que se está creando la empresa (solo lectura). */
  cif: string;
  form: FormEmpresa;
  setCampo: (key: CampoEmpresa, value: string) => void;
  guardando: boolean;
  /** Error del último intento de guardado, para pintarlo dentro del modal. */
  error: string | null;
  /** True si la dirección se prellenó desde la entidad candidata del OCR. */
  direccionDesdeOcr: boolean;
  abrir: (b: Borrador, proximoId: string) => void;
  cerrar: () => void;
  guardar: () => Promise<void>;
};

export function useCrearEmpresaModal(opts: {
  /** Llamado cuando la empresa se crea correctamente. El padre hace el merge en `borradores`. */
  onCreated: (idx: number, emp: EmpresaCreada, nombre: string) => void;
  /** Mensaje de error (UX). Si se omite, el error solo se descarta. */
  onError?: (msg: string) => void;
  /** Mensaje de éxito (UX, p. ej. toast). */
  onSuccess?: (msg: string) => void;
}): UseCrearEmpresaModalReturn {
  const [idx, setIdx] = useState<number | null>(null);
  const [form, setForm] = useState<FormEmpresa>(FORM_VACIO);
  const [guardando, setGuardando] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [direccionDesdeOcr, setDireccionDesdeOcr] = useState<boolean>(false);

  const fallar = useCallback(
    (msg: string) => {
      setError(msg);
      opts.onError?.(msg);
    },
    [opts],
  );

  const abrir = useCallback((b: Borrador, proximoId: string) => {
    const cifBorrador = b.proveedor_cif || '';
    const cifNorm = cifBorrador.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const candidata = (b.entidades_candidatas || []).find(
      (e) => (e.cif || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() === cifNorm,
    );
    const direccion = partirDireccion(candidata?.direccion_candidata || '');
    setIdx(b.idx);
    setError(null);
    setDireccionDesdeOcr(Boolean(direccion.Direccion));
    setForm({
      ...FORM_VACIO,
      id_empresa: proximoId,
      Nombre: (b.nombre_sugerido_ocr || '').trim(),
      Cif: cifBorrador,
      ...direccion,
    });
  }, []);

  const cerrar = useCallback(() => {
    setIdx(null);
    setForm(FORM_VACIO);
    setGuardando(false);
    setError(null);
    setDireccionDesdeOcr(false);
  }, []);

  const setCampo = useCallback((key: CampoEmpresa, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const guardar = useCallback(async () => {
    if (idx == null) return;
    const nombreLimpio = form.Nombre.trim();
    if (!nombreLimpio) {
      fallar('Indica el nombre de la empresa para darla de alta.');
      return;
    }
    if (!form.id_empresa) {
      fallar('No se ha podido asignar un id de empresa. Recarga la pantalla e inténtalo de nuevo.');
      return;
    }
    setGuardando(true);
    setError(null);
    try {
      const body: Record<string, string | string[]> = {};
      for (const key of ATRIBUTOS_TABLA_EMPRESAS) {
        if (key === 'Etiqueta') {
          body[key] = form.Etiqueta.split(',').map((s) => s.trim()).filter(Boolean);
        } else if (key === 'Nombre') {
          body[key] = nombreLimpio;
        } else {
          body[key] = (form[key] || '').trim();
        }
      }
      const { empresa, idUsado } = await crearEmpresaConIdLibre(body);
      // `idUsado` puede diferir del calculado al abrir el modal si hubo colisión.
      const emp: EmpresaCreada = { ...empresa, id_empresa: empresa.id_empresa || idUsado };
      opts.onCreated(idx, emp, nombreLimpio);
      opts.onSuccess?.(`${nombreLimpio} vinculada al CIF ${form.Cif}`);
      setIdx(null);
      setForm(FORM_VACIO);
      setDireccionDesdeOcr(false);
    } catch (e: unknown) {
      fallar(errorMessage(e, 'Error al crear empresa'));
    } finally {
      setGuardando(false);
    }
  }, [idx, form, opts, fallar]);

  return {
    visible: idx !== null,
    cif: form.Cif,
    form,
    setCampo,
    guardando,
    error,
    direccionDesdeOcr,
    abrir,
    cerrar,
    guardar,
  };
}
