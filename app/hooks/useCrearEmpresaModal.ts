import { useCallback, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
import { crearEmpresaConIdLibre, type EmpresaMaestro } from '../lib/empresaId';
import { limpiarIban } from '../lib/iban';
import { formatearIbanLegible } from '../components/CuentasBancariasEmpresa';
import type { Borrador } from '../types/registroMasivo';
import type { DocumentoPreviewArchivo } from '../components/PreviewDocumentoArchivo';

/**
 * Hook que encapsula el modal "Crear empresa desde OCR" del registro masivo.
 *
 * Responsabilidades:
 * - Estado UI (visibilidad, formulario editable, flag guardando, error inline).
 * - Formulario con los atributos editables de `igp_Empresas`, de modo que el
 *   alta desde OCR deje la ficha completa sin tener que ir después al maestro.
 * - Prefill al abrir: nombre e id sugeridos, CIF del borrador (solo lectura),
 *   dirección de la entidad candidata que casa con ese CIF (se sanea y se
 *   intenta partir en Direccion / Cp / Municipio) e IBAN del emisor leído por
 *   el OCR.
 * - Alta vía `crearEmpresaConIdLibre` (`app/lib/empresaId.ts`), que reintenta
 *   con un id nuevo si el calculado estaba ocupado, y propagación del resultado
 *   al padre vía callbacks `onCreated`, `onSuccess`, `onError`.
 * - Alta de la cuenta bancaria con el IBAN del formulario en un segundo paso
 *   (`POST /api/empresas/:id/cuentas`), porque en el modelo de N cuentas por
 *   empresa el campo `Iban` del maestro lo escribe el backend a partir de la
 *   cuenta predeterminada.
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
 * Atributos de `igp_Empresas` que se editan en este modal (mismo orden que
 * `ATRIBUTOS_TABLA_EMPRESAS` en `app/(app)/empresas.tsx`). `IbanAlternativo`
 * no está: en el modelo de N cuentas por empresa no hay cuenta alternativa.
 */
export const ATRIBUTOS_TABLA_EMPRESAS = [
  'id_empresa',
  'Nombre',
  'Cif',
  'Iban',
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
 * Campos de IBAN del maestro. Los escribe el backend a partir de la cuenta
 * predeterminada (`POST /api/empresas/:id/cuentas`), así que nunca se envían en
 * el body del alta: mandarlos dejaría el campo viejo y la tabla de cuentas
 * divergiendo y las remesas pagarían a la cuenta equivocada.
 */
const CAMPOS_CUENTA_BANCARIA = new Set<string>(['Iban', 'IbanAlternativo']);

/**
 * Formulario del modal. Campos de texto salvo `etiquetas`, gestionadas aparte.
 */
export type FormEmpresa = Omit<Record<CampoEmpresa, string>, 'Etiqueta'>;

const FORM_VACIO: FormEmpresa = ATRIBUTOS_TABLA_EMPRESAS.filter((k) => k !== 'Etiqueta').reduce(
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

/**
 * Alta de la cuenta bancaria de la empresa recién creada. No lanza: la empresa
 * ya existe cuando se llama, y un fallo aquí no puede invalidar ese alta.
 */
async function crearCuentaBancaria(
  idEmpresa: string,
  iban: string,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const fallback = 'No se pudo dar de alta la cuenta bancaria.';
  try {
    const res = await apiFetch(`/api/empresas/${encodeURIComponent(idEmpresa)}/cuentas`, {
      method: 'POST',
      body: JSON.stringify({ iban }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, motivo: data.error || fallback };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, motivo: errorMessage(e, fallback) };
  }
}

export type UseCrearEmpresaModalReturn = {
  visible: boolean;
  /** CIF del borrador para el que se está creando la empresa (solo lectura). */
  cif: string;
  form: FormEmpresa;
  etiquetas: string[];
  setEtiquetas: (tags: string[]) => void;
  setCampo: (key: Exclude<CampoEmpresa, 'Etiqueta'>, value: string) => void;
  guardando: boolean;
  /** Error del último intento de guardado, para pintarlo dentro del modal. */
  error: string | null;
  /** True si la dirección se prellenó desde la entidad candidata del OCR. */
  direccionDesdeOcr: boolean;
  /** True si el IBAN se prellenó con el que el OCR leyó en el documento. */
  ibanDesdeOcr: boolean;
  /** Documento OCR del borrador para previsualizar mientras se da de alta la empresa. */
  documentoPreview: DocumentoPreviewArchivo | null;
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
  /**
   * La empresa se creó pero su cuenta bancaria no. El alta NO es un fallo: hay
   * que avisar aparte para que el usuario no crea que debe repetirla.
   */
  onCuentaError?: (msg: string) => void;
}): UseCrearEmpresaModalReturn {
  const [idx, setIdx] = useState<number | null>(null);
  const [form, setForm] = useState<FormEmpresa>(FORM_VACIO);
  const [etiquetas, setEtiquetas] = useState<string[]>([]);
  const [guardando, setGuardando] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [direccionDesdeOcr, setDireccionDesdeOcr] = useState<boolean>(false);
  const [ibanDesdeOcr, setIbanDesdeOcr] = useState<boolean>(false);
  const [documentoPreview, setDocumentoPreview] = useState<DocumentoPreviewArchivo | null>(null);

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
    // El IBAN de la raíz del borrador puede venir de la capa IA, que no llega a
    // `entidades_candidatas`: manda sobre el de la candidata del mismo CIF.
    const ibanOcr =
      limpiarIban(b.proveedor_iban || '') || limpiarIban(candidata?.iban_candidato || '');
    setIdx(b.idx);
    setError(null);
    setEtiquetas([]);
    setDireccionDesdeOcr(Boolean(direccion.Direccion));
    setIbanDesdeOcr(Boolean(ibanOcr));
    setDocumentoPreview(
      b.archivo?.previewUrl
        ? {
            nombre: b.archivo.nombre,
            tipo: b.archivo.tipo,
            previewUrl: b.archivo.previewUrl,
          }
        : null,
    );
    setForm({
      ...FORM_VACIO,
      id_empresa: proximoId,
      Nombre: (b.nombre_sugerido_ocr || '').trim(),
      Cif: cifBorrador,
      Iban: ibanOcr ? formatearIbanLegible(ibanOcr) : '',
      ...direccion,
    });
  }, []);

  const cerrar = useCallback(() => {
    setIdx(null);
    setForm(FORM_VACIO);
    setEtiquetas([]);
    setGuardando(false);
    setError(null);
    setDireccionDesdeOcr(false);
    setIbanDesdeOcr(false);
    setDocumentoPreview(null);
  }, []);

  const setCampo = useCallback((key: Exclude<CampoEmpresa, 'Etiqueta'>, value: string) => {
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
        if (CAMPOS_CUENTA_BANCARIA.has(key)) continue;
        if (key === 'Etiqueta') {
          body[key] = etiquetas.map((s) => s.trim()).filter(Boolean);
        } else if (key === 'Nombre') {
          body[key] = nombreLimpio;
        } else {
          body[key] = (form[key] || '').trim();
        }
      }
      const { empresa, idUsado } = await crearEmpresaConIdLibre(body);
      // `idUsado` puede diferir del calculado al abrir el modal si hubo colisión.
      const emp: EmpresaCreada = { ...empresa, id_empresa: empresa.id_empresa || idUsado };

      // La empresa ya existe: a partir de aquí ningún fallo puede propagarse
      // como error del alta o el usuario la crearía otra vez.
      const iban = limpiarIban(form.Iban);
      const idEmpresaCreada = String(emp.id_empresa || '').trim();
      let avisoCuenta = '';
      if (iban) {
        const resultado = idEmpresaCreada
          ? await crearCuentaBancaria(idEmpresaCreada, iban)
          : ({ ok: false, motivo: 'El alta no devolvió el id de la empresa.' } as const);
        if (!resultado.ok) {
          const motivo = resultado.motivo.trim();
          avisoCuenta =
            `${nombreLimpio} se ha creado, pero su cuenta bancaria no: ` +
            `${/[.!?]$/.test(motivo) ? motivo : `${motivo}.`} ` +
            'Puedes añadirla desde la ficha de la empresa, en Empresas.';
        }
      }

      opts.onCreated(idx, emp, nombreLimpio);
      if (avisoCuenta) {
        (opts.onCuentaError ?? opts.onError)?.(avisoCuenta);
      } else {
        opts.onSuccess?.(`${nombreLimpio} vinculada al CIF ${form.Cif}`);
      }
      setIdx(null);
      setForm(FORM_VACIO);
      setEtiquetas([]);
      setDireccionDesdeOcr(false);
      setIbanDesdeOcr(false);
      setDocumentoPreview(null);
    } catch (e: unknown) {
      fallar(errorMessage(e, 'Error al crear empresa'));
    } finally {
      setGuardando(false);
    }
  }, [idx, form, etiquetas, opts, fallar]);

  return {
    visible: idx !== null,
    cif: form.Cif,
    form,
    etiquetas,
    setEtiquetas,
    setCampo,
    guardando,
    error,
    direccionDesdeOcr,
    ibanDesdeOcr,
    documentoPreview,
    abrir,
    cerrar,
    guardar,
  };
}
