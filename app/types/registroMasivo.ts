/**
 * Tipos del subdominio "registro masivo de facturas".
 *
 * Este subdominio modela el estado intermedio durante el flujo OCR:
 * un `Borrador` representa una factura mientras está siendo extraída,
 * revisada y reconciliada por el usuario, antes de confirmarse y
 * convertirse en una `Factura` real (ver `app/types/factura.ts`).
 *
 * Convivimos con `app/types/factura.ts` porque el contrato es distinto:
 * el borrador tiene campos que NO existen en la factura final
 * (`extraction_snapshot`, `confianza`, `ia_meta`, `ocr_pipeline_meta`,
 * `entidades_candidatas`, `descartado`, `duplicados`...).
 */

/**
 * Mapa campo → nivel de confianza OCR ('alta' | 'media' | 'baja').
 * Las claves son nombres de campos del borrador (`proveedor_cif`,
 * `numero_factura`, `fecha`, etc.) y se usan para pintar el dot de color
 * junto al label del input.
 */
export type Confianza = Record<string, string>;

/**
 * Entidad detectada por el OCR como posible emisor o receptor.
 * Se usa para reconciliar contra la sociedad seleccionada del grupo
 * en `POST /api/facturacion/ocr/reconciliar`.
 */
export type EntidadCandidata = {
  id: string;
  cif: string;
  nombre_candidato?: string;
  direccion_candidata?: string;
  contexto?: string;
  score_emisor?: number;
  score_receptor?: number;
  rol_provisional?: string;
};

/**
 * Empresa tal como llega del catálogo backend (`GET /api/empresas`),
 * con shape PascalCase. Se usa tanto para el dropdown de proveedor
 * como para filtrar la sociedad receptora del GRUPO PARIPE.
 *
 * Nota: este shape es el mismo que devuelve el endpoint para el
 * dominio acuerdos (ver `EmpresaAcuerdo`), pero aquí incluye `Sede`
 * porque el subdominio sí la usa para filtrar grupo.
 */
export type EmpresaCatalogo = {
  id_empresa?: string;
  Nombre?: string;
  Cif?: string;
  Sede?: string;
};

/**
 * Marca qué campos editó el usuario manualmente. Cuando un campo está
 * marcado, ni el OCR posterior ni la reconciliación pueden sobreescribirlo.
 */
export type CamposManuales = Partial<Record<
  | 'proveedor_cif'
  | 'proveedor_nombre'
  | 'numero_factura_proveedor'
  | 'fecha_emision'
  | 'base_imponible'
  | 'tipo_iva_pct'
  | 'retencion_pct'
  | 'total_iva'
  | 'retencion'
  | 'total_factura'
  | 'observaciones',
  boolean
>>;

/**
 * Una línea del desglose fiscal. Puede ser IVA, retención o recargo
 * de equivalencia. La tupla (base, porcentaje) calcula `cuota` de forma
 * derivada salvo en multitranco, donde puede haber varias líneas IVA
 * con distintos %.
 */
export type LineaDesglose = {
  tipo: 'iva' | 'retencion' | 'recargo_equivalencia';
  base: number;
  porcentaje: number | null;
  cuota: number;
  origen?: string;
  texto_origen?: string;
};

/** Línea inicial usada al añadir una nueva fila al desglose. */
export const LINEA_VACIA: LineaDesglose = {
  tipo: 'iva',
  base: 0,
  porcentaje: 0,
  cuota: 0,
  origen: 'manual',
};

/**
 * Estado intermedio de una factura durante el registro masivo.
 *
 * Un borrador empieza como respuesta de `POST /api/facturacion/ocr/extraer`,
 * se enriquece con `POST /api/facturacion/ocr/enriquecer-ia` (opcional),
 * se reconcilia con la sociedad del grupo seleccionada y, finalmente,
 * se confirma vía `POST /api/facturacion/ocr/confirmar` para crearse
 * como `Factura` con estado de borrador pendiente de revisión.
 */
export type Borrador = {
  idx: number;
  archivo: { fileKey: string; nombre: string; tipo: string; size: number; previewUrl: string };
  /** Sociedad del grupo (GRUPO PARIPE) que recibe el gasto → emisor_* en DynamoDB */
  sociedad_grupo_id: string;
  sociedad_grupo_nombre: string;
  sociedad_grupo_cif: string;
  proveedor_cif: string;
  /** CIF proveedor tras la primera extracción (para reconciliación API) */
  proveedor_provisional_cif: string;
  proveedor_nombre: string;
  /** id en `igp_Empresas` si el CIF existe en maestro */
  empresa_id?: string;
  /** true si el nombre proviene de la tabla empresas (por CIF) */
  proveedor_en_maestros?: boolean;
  /** Sugerencia OCR del nombre si el CIF no está en maestro (para alta rápida) */
  nombre_sugerido_ocr?: string;
  numero_factura_proveedor: string;
  fecha_emision: string;
  base_imponible: number;
  /** Suma bases IVA+R.E. si hay desglose (p. ej. multitranco) */
  base_imponible_total?: number;
  /** % tipo IVA — null si hay varios tramos (no forzar un único %) */
  tipo_iva_pct: number | null;
  /** % retención — null si no aplica un único % */
  retencion_pct: number | null;
  total_iva: number;
  retencion: number;
  /** Cuota total recargo equivalencia (no es retención IRPF) */
  recargo_equivalencia_total?: number;
  /** Líneas fiscales detectadas (IVA, R.E., retención) */
  desglose_impuestos?: LineaDesglose[];
  total_factura: number;
  observaciones: string;
  confianza: Confianza;
  /** Solo true si el usuario editó el campo a mano (no OCR ni reconciliación ni lookup) */
  campos_manuales: CamposManuales;
  entidades_candidatas: EntidadCandidata[];
  texto_extraido: string;
  extraction_snapshot: {
    proveedor_cif: string;
    numero_factura_proveedor: string;
    fecha_emision: string;
    base_imponible: number;
    total_iva: number;
    retencion: number;
    total_factura: number;
    confianza: Confianza;
  };
  reconciliacion_warning: string;
  /** Origen del texto: texto embebido del PDF, OCR de imagen u OCR tras rasterizar PDF escaneado */
  metodo_extraccion?: string;
  ocr_confianza_global?: number;
  /** Metadatos si se aplicó la capa IA en el API (OPENAI_API_KEY). */
  ia_meta?: {
    aplicada?: boolean;
    modelo?: string;
    tipo_documento?: string;
    revision_sugerida?: boolean;
    revision_obligatoria?: boolean;
    motivos?: string[];
    coherencia_importes?: boolean;
    diferencia_importes?: number;
    enriquecido_en?: string;
    campos_corregidos_ia?: string[];
  };
  /** Validación post-OCR (importes, nº factura, retención). */
  ocr_pipeline_meta?: {
    importes_coherentes?: boolean;
    diferencia_importes?: number;
    revision_obligatoria?: boolean;
    revision_sugerida?: boolean;
    motivos_revision?: string[];
    numero_factura_fue_normalizado?: boolean;
    retencion_sospechosa?: boolean;
    formula_usada?: string;
    tiene_desglose_multiple?: boolean;
    total_calculado_desde_desglose?: number;
  };
  descartado: boolean;
  /** Coincidencias con facturas ya registradas (backend). */
  duplicados: {
    id_factura: string;
    numero_factura: string;
    numero_factura_proveedor?: string;
    empresa_nombre: string;
    empresa_cif?: string;
    total_factura: number;
    fecha_emision?: string;
  }[];
  checkingDup: boolean;
  /** Usuario vio el modal de duplicado (descartar o seguir editando). */
  duplicado_modal_visto?: boolean;
  /** Usuario eligió seguir editando pese al duplicado. */
  duplicado_continuar?: boolean;
  /** Usuario confirmó importar pese al aviso en Confirmar lote. */
  duplicado_ack_confirmacion?: boolean;
  /** Registrar pago al confirmar (factura ya cobrada en el momento del gasto). */
  pago_al_confirmar?: boolean;
  /** Datos del pago capturados con RegistrarPagoModal. */
  pago_datos?: {
    fecha: string;
    importe: number;
    metodo_pago: string;
    referencia: string;
    observaciones: string;
  };
};

/**
 * Otro borrador del mismo lote que parece ser la misma factura.
 * Se calcula en cliente: el backend solo compara contra lo ya registrado.
 */
export type DuplicadoLote = {
  idx: number;
  archivo: string;
  numero_factura_proveedor: string;
};

/**
 * Objetivo activo de la herramienta "Selección de zona OCR".
 * `field` es el nombre del campo del borrador que se va a rellenar,
 * `numeric` indica si la zona devuelve un importe (se parsea a número).
 */
export type ZonaTarget = { field: string; numeric?: boolean } | null;

/**
 * Coordenadas del rectángulo dibujado por el usuario sobre el preview
 * (en coordenadas del overlay, 0..pageWidth × 0..pageHeight).
 */
export type ZonaRect = { startX: number; startY: number; endX: number; endY: number };
