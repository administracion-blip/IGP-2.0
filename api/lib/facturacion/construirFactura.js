/**
 * Construcción del ítem de factura y de sus líneas.
 *
 * Vive aquí y no dentro de `POST /facturacion/facturas` porque hay más de un
 * productor de facturas (la pantalla de alta y la facturación mensual de
 * mantenimiento). Si cada uno armara el ítem por su cuenta, divergirían en
 * silencio en campos que ninguna validación comprueba —los de VERI*FACTU, el
 * resumen de impuestos o el saldo pendiente— y las facturas generadas se verían
 * mal en el detalle y en el cuadro de mando sin que salte ningún error.
 */

function now() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Texto corto para listados: tipos de IVA y % de retención presentes en las líneas. */
export function buildImpuestosResumenFromLineas(lineas) {
  if (!Array.isArray(lineas) || lineas.length === 0) return '';
  const tiposIva = new Set();
  const retPcts = new Set();
  for (const l of lineas) {
    const t = Number(l.tipo_iva);
    if (!Number.isNaN(t)) tiposIva.add(t);
    const r = Number(l.retencion_pct);
    if (!Number.isNaN(r) && r > 0) retPcts.add(r);
  }
  const ivaPart = [...tiposIva].sort((a, b) => a - b).map((x) => `${x}%`).join(' · ');
  const retPart = [...retPcts].sort((a, b) => a - b).map((x) => `${x}%`).join(' · ');
  if (retPart) return `IVA ${ivaPart || '—'} · Ret ${retPart}`;
  return `IVA ${ivaPart || '—'}`;
}

/**
 * Normaliza las líneas que llegan del cliente y calcula sus importes y los
 * totales de la factura. El identificador de línea es posicional (`L001`…), que
 * es lo que espera el reemplazo de líneas al editar.
 * @returns {{ lineas: object[], base_imponible: number, total_iva: number, total_retencion: number, total_factura: number }}
 */
export function construirLineasFactura(idFactura, lineas) {
  let base_imponible = 0;
  let total_iva = 0;
  let total_retencion = 0;
  const lineasToSave = [];

  if (Array.isArray(lineas)) {
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i] || {};
      const cantidad = Number(l.cantidad) || 0;
      const precio = Number(l.precio_unitario) || 0;
      const descuento = Number(l.descuento_pct) || 0;
      const tipoIva = Number(l.tipo_iva) || 0;
      const retencionPct = Number(l.retencion_pct) || 0;

      const base = round2(cantidad * precio * (1 - descuento / 100));
      const iva = round2((base * tipoIva) / 100);
      const retencion = round2((base * retencionPct) / 100);
      const total = round2(base + iva - retencion);

      base_imponible += base;
      total_iva += iva;
      total_retencion += retencion;

      lineasToSave.push({
        id_factura: idFactura,
        id_linea: `L${String(i + 1).padStart(3, '0')}`,
        producto_id: l.producto_id || '',
        producto_ref: l.producto_ref || '',
        descripcion: l.descripcion || '',
        cantidad,
        precio_unitario: precio,
        descuento_pct: descuento,
        tipo_iva: tipoIva,
        iva_nombre: l.iva_nombre || `${tipoIva}%`,
        retencion_pct: retencionPct,
        base_linea: base,
        iva_linea: iva,
        retencion_linea: retencion,
        total_linea: total,
      });
    }
  }

  base_imponible = round2(base_imponible);
  total_iva = round2(total_iva);
  total_retencion = round2(total_retencion);
  return {
    lineas: lineasToSave,
    base_imponible,
    total_iva,
    total_retencion,
    total_factura: round2(base_imponible + total_iva - total_retencion),
  };
}

/**
 * Construye el ítem de factura completo y sus líneas, listos para persistir.
 *
 * `numero` y `numero_factura` los decide el llamante: las ventas (OUT) nacen sin
 * número porque el correlativo se reserva al emitir.
 * @param {{ id_factura: string, numero?: number, numero_factura?: string, datos?: object }} params
 * @returns {{ factura: object, lineas: object[] }}
 */
export function construirFacturaConLineas({ id_factura, numero = 0, numero_factura = '', datos = {} }) {
  const {
    tipo, serie,
    emisor_id, emisor_nombre, emisor_cif, emisor_direccion,
    emisor_cp, emisor_municipio, emisor_provincia, emisor_email,
    emisor_iban, emisor_iban_alternativo,
    empresa_id, empresa_nombre, empresa_cif, empresa_direccion,
    empresa_cp, empresa_municipio, empresa_provincia, empresa_email,
    empresa_iban, empresa_iban_alternativo,
    fecha_emision, fecha_operacion, fecha_vencimiento,
    condiciones_pago, forma_pago, observaciones, local_id,
    es_rectificativa, factura_rectificada_id, motivo_rectificacion, rectificativa_tipo,
    es_abono,
    numero_factura_proveedor, fecha_contabilizacion,
    lineas, usuario_id, usuario_nombre,
  } = datos;

  const calculo = construirLineasFactura(id_factura, lineas);

  const factura = {
    id_entrada: id_factura,
    id_factura,
    numero_factura,
    tipo,
    serie,
    numero,
    estado: 'borrador',
    emisor_id: emisor_id || '',
    emisor_nombre: emisor_nombre || '',
    emisor_cif: emisor_cif || '',
    emisor_direccion: emisor_direccion || '',
    emisor_cp: emisor_cp || '',
    emisor_municipio: emisor_municipio || '',
    emisor_provincia: emisor_provincia || '',
    emisor_email: emisor_email || '',
    emisor_iban: emisor_iban || '',
    emisor_iban_alternativo: emisor_iban_alternativo || '',
    empresa_id: empresa_id || '',
    empresa_nombre: empresa_nombre || '',
    empresa_cif: empresa_cif || '',
    empresa_direccion: empresa_direccion || '',
    empresa_cp: empresa_cp || '',
    empresa_municipio: empresa_municipio || '',
    empresa_provincia: empresa_provincia || '',
    empresa_email: empresa_email || '',
    empresa_iban: empresa_iban || '',
    empresa_iban_alternativo: empresa_iban_alternativo || '',
    fecha_emision: fecha_emision || now().slice(0, 10),
    fecha_operacion: fecha_operacion || '',
    fecha_vencimiento: fecha_vencimiento || '',
    condiciones_pago: condiciones_pago || '',
    forma_pago: forma_pago || '',
    base_imponible: calculo.base_imponible,
    total_iva: calculo.total_iva,
    total_retencion: calculo.total_retencion,
    total_factura: calculo.total_factura,
    total_cobrado: 0,
    saldo_pendiente: calculo.total_factura,
    observaciones: observaciones || '',
    adjuntos: [],
    local_id: local_id || '',
    /**
     * Abono: documento con importes negativos a propósito. Sin esta marca no hay
     * forma de distinguir un abono legítimo de una factura de venta con el signo
     * mal puesto, que es un error grave y silencioso. La validación de emisión
     * exige el signo que corresponda a cada uno.
     */
    es_abono: es_abono || false,
    es_rectificativa: es_rectificativa || false,
    factura_rectificada_id: factura_rectificada_id || '',
    motivo_rectificacion: motivo_rectificacion || '',
    /**
     * Cómo rectifica, cuando rectifica. VERI*FACTU no tiene un tipo "abono": un
     * abono es una rectificativa, y las hay por sustitución (rehacer una factura
     * concreta, que es lo que hace `POST /facturacion/facturas/:id/rectificar`) y
     * por diferencias (rectificar importes sin rehacer el documento). Los abonos
     * de rappel son 'diferencias' y no señalan ninguna factura concreta.
     */
    rectificativa_tipo: rectificativa_tipo || '',
    numero_factura_proveedor: numero_factura_proveedor || '',
    /** Facturas IN: fecha/hora de alta contable y usuario (automático al crear) */
    fecha_contabilizacion: tipo === 'IN' ? now() : (fecha_contabilizacion || ''),
    contabilizado_por: tipo === 'IN' ? (usuario_nombre || '') : '',
    contabilizado_por_id: tipo === 'IN' ? (usuario_id || '') : '',
    creado_por: usuario_id || '',
    creado_en: now(),
    modificado_por: usuario_id || '',
    modificado_en: now(),
    version: 1,
    verifactu_hash: '',
    verifactu_hash_anterior: '',
    verifactu_qr_data: '',
    verifactu_registro_alta: '',
    verifactu_registro_anulacion: '',
    verifactu_estado: 'no_enviado',
    verifactu_huella_completa: '',
    verifactu_cadena_encadenamiento: '',
    impuestos_resumen: buildImpuestosResumenFromLineas(calculo.lineas),
  };

  return { factura, lineas: calculo.lineas };
}
