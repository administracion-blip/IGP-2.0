/**
 * Albaranes citados en una factura de gasto (IN) que no aparecen en Ágora.
 * Se anotan a mano desde la conciliación compras ↔ facturas y se guardan en
 * la propia factura (`albaranes_faltantes`).
 */

export type EstadoAlbaranFaltante = 'pendiente' | 'resuelta';

/** Albarán con el mismo Nº doc. prov. encontrado en Ágora en otra sociedad. */
export type UbicacionOtraEmpresa = {
  empresa_cif: string;
  empresa_nombre: string;
  almacen: string;
  fecha: string;
};

export type AlbaranFaltante = {
  id: string;
  numero_doc_proveedor: string;
  numero_norm: string;
  /** `YYYY-MM-DD` o '' */
  fecha_albaran: string;
  importe: number | null;
  nota: string;
  estado: EstadoAlbaranFaltante;
  resuelta_por: 'auto' | 'manual' | null;
  resuelta_en: string | null;
  en_otra_empresa: UbicacionOtraEmpresa | null;
  creado_en: string;
  creado_por: string;
  creado_por_id: string;
};

/** Item para el PUT: los nuevos pueden omitir id / numero_norm / creado_* (los pone el servidor). */
export type AlbaranFaltanteInput = Omit<
  AlbaranFaltante,
  'id' | 'numero_norm' | 'creado_en' | 'creado_por' | 'creado_por_id'
> &
  Partial<Pick<AlbaranFaltante, 'id' | 'numero_norm' | 'creado_en' | 'creado_por' | 'creado_por_id'>>;

export type ConsultaComprobarAlbaranes = {
  proveedor_cif: string;
  proveedor_nombre: string;
  anio: number;
  numeros: string[];
};

/** Albarán de Ágora con ese Nº doc. prov. La empresa se resuelve en el front por almacén. */
export type CoincidenciaAgora = {
  warehouse_id: string;
  almacen: string;
  /** `YYYY-MM-DD` */
  fecha: string;
  albaran: string;
  numero_doc_proveedor: string;
};

export type ResultadoComprobarAlbaran = {
  proveedor_cif: string;
  proveedor_nombre: string;
  anio: number | string;
  numero_norm: string;
  coincidencias: CoincidenciaAgora[];
  /** Consulta rechazada por el servidor: no comprobada (no equivale a «no encontrado»). */
  error?: 'consulta_invalida';
};

/** Empresa del grupo a la que pertenece el almacén de una coincidencia (cif '' si no resuelve). */
export type EmpresaCoincidencia = { cif: string; nombre: string };
