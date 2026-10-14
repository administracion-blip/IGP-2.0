import { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { BadgeEstado } from '../../BadgeEstado';
import { BadgeEnRemesa } from '../../BadgeEnRemesa';
import { formatMoneda } from '../../../utils/facturacion';
import { fechaEmisionFacturaAIso, formatFecha } from '../../../utils/formatFecha';
import { esFacturaPagableGasto } from '../../MultipagoFacturasModal';
import {
  COLOR_ESTADO_DEUDA,
  COLOR_INTRAGRUPO,
  ETIQUETA_ESTADO_DEUDA,
  esFacturaRemesableDeuda,
  etiquetaFacturaDeuda,
  puedeTenerDocumento,
  saldoPendienteFactura,
  textoNetoIntragrupo,
} from '../../../lib/deudaProveedores';
import { MIN_TOUCH } from '../../../constants/layout';
import type { DetalleProveedorResp, FacturaDeuda, ProveedorDeuda } from '../../../types/deudaProveedores';
import { BarraAntiguedadDeuda } from './BarraAntiguedadDeuda';

type Props = {
  /** Resumen de la lista: permite pintar la cabecera mientras carga el detalle. */
  proveedorResumen: ProveedorDeuda | null;
  detalle: DetalleProveedorResp | null;
  loading: boolean;
  error: string | null;
  onReintentar: () => void;
  /** Tarjetas en lugar de tabla (teléfono / panel apilado). */
  modoTarjetas: boolean;
  seleccion: Map<string, FacturaDeuda>;
  puedeSeleccionar: boolean;
  onToggleSeleccion: (f: FacturaDeuda) => void;
  puedePagar: boolean;
  onPagar: (f: FacturaDeuda) => void;
  onVer: (f: FacturaDeuda) => void;
  onDocumento: (f: FacturaDeuda) => void;
};

const AVISO_REVISION = 'Pendiente de revisión: no se puede remesar';

function fechaCelda(raw: string | undefined | null): string {
  if (!raw) return '—';
  const iso = fechaEmisionFacturaAIso(String(raw));
  return iso ? formatFecha(iso) : '—';
}

function sumar(facturas: FacturaDeuda[]) {
  let total = 0;
  let pagado = 0;
  let pendiente = 0;
  for (const f of facturas) {
    total += Number(f.total_factura) || 0;
    pagado += Number(f.total_cobrado) || 0;
    pendiente += Number(f.saldo_pendiente) || 0;
  }
  return { total, pagado, pendiente };
}

function esPagable(f: FacturaDeuda): boolean {
  return esFacturaPagableGasto({ ...f, remesaActiva: null });
}

export function DetalleFacturasProveedor({
  proveedorResumen,
  detalle,
  loading,
  error,
  onReintentar,
  modoTarjetas,
  seleccion,
  puedeSeleccionar,
  onToggleSeleccion,
  puedePagar,
  onPagar,
  onVer,
  onDocumento,
}: Props) {
  const proveedor = detalle?.proveedor ?? proveedorResumen;
  const facturas = useMemo(() => detalle?.facturas ?? [], [detalle]);
  // La cabecera solo cuenta el periodo: el pie separa la deuda anterior para que cuadre.
  const totales = useMemo(() => {
    const periodo = facturas.filter((f) => !f.anteriorAlPeriodo);
    const anteriores = facturas.filter((f) => f.anteriorAlPeriodo);
    return {
      periodo: { ...sumar(periodo), num: periodo.length },
      anterior: { ...sumar(anteriores), num: anteriores.length },
    };
  }, [facturas]);
  const hayRevision = facturas.some((f) => f.estado === 'pendiente_revision');

  if (!proveedor) {
    return (
      <View style={styles.centro}>
        <MaterialIcons name="touch-app" size={36} color="#cbd5e1" />
        <Text style={styles.centroTexto}>Selecciona un proveedor para ver sus facturas</Text>
      </View>
    );
  }

  const estilo = COLOR_ESTADO_DEUDA[proveedor.estado] ?? COLOR_ESTADO_DEUDA.pendiente;

  const renderCasilla = (f: FacturaDeuda) => {
    if (!puedeSeleccionar) return null;
    if (f.estado === 'pendiente_revision') {
      return (
        <View style={[styles.casillaWrap, modoTarjetas && styles.casillaWrapTouch]} accessibilityLabel={AVISO_REVISION}>
          <MaterialIcons name="lock-outline" size={16} color="#cbd5e1" />
        </View>
      );
    }
    if (!esFacturaRemesableDeuda(f)) {
      return <View style={[styles.casillaWrap, modoTarjetas && styles.casillaWrapTouch]} />;
    }
    const marcada = seleccion.has(f.id_factura);
    return (
      <TouchableOpacity
        style={[styles.casillaWrap, modoTarjetas && styles.casillaWrapTouch]}
        onPress={() => onToggleSeleccion(f)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: marcada }}
        accessibilityLabel={`Seleccionar factura ${etiquetaFacturaDeuda(f)}`}
      >
        <MaterialIcons
          name={marcada ? 'check-box' : 'check-box-outline-blank'}
          size={modoTarjetas ? 22 : 18}
          color={marcada ? '#0ea5e9' : '#94a3b8'}
        />
      </TouchableOpacity>
    );
  };

  const renderEstado = (f: FacturaDeuda) => (
    <View style={styles.estadoCol}>
      <BadgeEstado estado={String(f.estado ?? '')} compact={!modoTarjetas} />
      {f.remesaActiva ? <BadgeEnRemesa compact={!modoTarjetas} /> : null}
      {f.vencida && f.diasVencida != null && f.diasVencida > 0 ? (
        <Text style={styles.diasVencida}>Vencida hace {f.diasVencida} d</Text>
      ) : null}
      {f.anteriorAlPeriodo ? <Text style={styles.anterior}>Anterior al periodo</Text> : null}
    </View>
  );

  const renderAcciones = (f: FacturaDeuda) => (
    <View style={styles.acciones}>
      <TouchableOpacity
        style={[styles.accionBtn, modoTarjetas && styles.accionBtnTouch]}
        onPress={() => onVer(f)}
        accessibilityLabel="Ver factura"
      >
        <MaterialIcons name="visibility" size={18} color="#0ea5e9" />
        {modoTarjetas ? <Text style={styles.accionTexto}>Ver</Text> : null}
      </TouchableOpacity>
      {puedeTenerDocumento(f) ? (
        <TouchableOpacity
          style={[styles.accionBtn, modoTarjetas && styles.accionBtnTouch]}
          onPress={() => onDocumento(f)}
          accessibilityLabel="Descargar documento"
        >
          <MaterialIcons name="picture-as-pdf" size={18} color="#dc2626" />
          {modoTarjetas ? <Text style={styles.accionTexto}>PDF</Text> : null}
        </TouchableOpacity>
      ) : null}
      {puedePagar && esPagable(f) ? (
        <TouchableOpacity
          style={[styles.accionBtn, styles.accionPagar, modoTarjetas && styles.accionBtnTouch]}
          onPress={() => onPagar(f)}
          accessibilityLabel="Pagar factura"
        >
          <MaterialIcons name="payments" size={16} color="#fff" />
          <Text style={styles.accionPagarTexto}>Pagar</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  const renderTabla = () => (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.tablaScroll}>
      <View style={styles.tabla}>
        <View style={[styles.fila, styles.filaCabecera]}>
          {puedeSeleccionar ? <View style={styles.colCasilla} /> : null}
          <Text style={[styles.th, styles.colNumero]}>Nº factura</Text>
          <Text style={[styles.th, styles.colSociedad]}>Sociedad</Text>
          <Text style={[styles.th, styles.colFecha]}>Emisión</Text>
          <Text style={[styles.th, styles.colFecha]}>Vencimiento</Text>
          <Text style={[styles.th, styles.colImporte, styles.derecha]}>Total</Text>
          <Text style={[styles.th, styles.colImporte, styles.derecha]}>Pagado</Text>
          <Text style={[styles.th, styles.colImporte, styles.derecha]}>Pendiente</Text>
          <Text style={[styles.th, styles.colEstado]}>Estado</Text>
          <Text style={[styles.th, styles.colAcciones]}>Acciones</Text>
        </View>
        {facturas.map((f) => {
          const marcada = seleccion.has(f.id_factura);
          const pendiente = saldoPendienteFactura(f);
          return (
            <View key={f.id_factura} style={[styles.fila, marcada && styles.filaMarcada]}>
              {puedeSeleccionar ? <View style={styles.colCasilla}>{renderCasilla(f)}</View> : null}
              <Text style={[styles.td, styles.colNumero, styles.tdFuerte]} numberOfLines={1}>{etiquetaFacturaDeuda(f)}</Text>
              <Text style={[styles.td, styles.colSociedad]} numberOfLines={1}>{f.emisor_nombre || '—'}</Text>
              <Text style={[styles.td, styles.colFecha]}>{fechaCelda(f.fecha_emision)}</Text>
              <Text style={[styles.td, styles.colFecha, f.vencida && styles.tdVencida]}>{fechaCelda(f.fecha_vencimiento)}</Text>
              <Text style={[styles.td, styles.colImporte, styles.derecha]}>{formatMoneda(Number(f.total_factura) || 0)}</Text>
              <Text style={[styles.td, styles.colImporte, styles.derecha]}>{formatMoneda(Number(f.total_cobrado) || 0)}</Text>
              <Text style={[styles.td, styles.colImporte, styles.derecha, pendiente > 0 && styles.tdPendiente]}>
                {formatMoneda(Number(f.saldo_pendiente) || 0)}
              </Text>
              <View style={styles.colEstado}>{renderEstado(f)}</View>
              <View style={styles.colAcciones}>{renderAcciones(f)}</View>
            </View>
          );
        })}
        {renderFilaPie('Total periodo', totales.periodo)}
        {totales.anterior.num > 0 ? renderFilaPie('Anterior al periodo', totales.anterior) : null}
      </View>
    </ScrollView>
  );

  function renderFilaPie(etiqueta: string, t: ReturnType<typeof sumar> & { num: number }) {
    return (
      <View style={[styles.fila, styles.filaPie]}>
        {puedeSeleccionar ? <View style={styles.colCasilla} /> : null}
        <Text style={[styles.td, styles.tdFuerte, styles.colNumero]}>{etiqueta}</Text>
        <Text style={[styles.td, styles.colSociedad]}>{t.num} factura{t.num === 1 ? '' : 's'}</Text>
        <View style={styles.colFecha} />
        <View style={styles.colFecha} />
        <Text style={[styles.td, styles.tdFuerte, styles.colImporte, styles.derecha]}>{formatMoneda(t.total)}</Text>
        <Text style={[styles.td, styles.tdFuerte, styles.colImporte, styles.derecha]}>{formatMoneda(t.pagado)}</Text>
        <Text style={[styles.td, styles.tdFuerte, styles.colImporte, styles.derecha, styles.tdPendiente]}>
          {formatMoneda(t.pendiente)}
        </Text>
        <View style={styles.colEstado} />
        <View style={styles.colAcciones} />
      </View>
    );
  }

  const renderTarjetas = () => (
    <View style={styles.tarjetas}>
      {facturas.map((f) => {
        const marcada = seleccion.has(f.id_factura);
        return (
          <View key={f.id_factura} style={[styles.tarjeta, marcada && styles.tarjetaMarcada]}>
            <View style={styles.tarjetaCabecera}>
              {renderCasilla(f)}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.tarjetaNumero} numberOfLines={1}>{etiquetaFacturaDeuda(f)}</Text>
                <Text style={styles.tarjetaSub} numberOfLines={1}>{f.emisor_nombre || '—'}</Text>
              </View>
              <Text style={[styles.tarjetaPendiente, saldoPendienteFactura(f) > 0 && styles.tdPendiente]}>
                {formatMoneda(Number(f.saldo_pendiente) || 0)}
              </Text>
            </View>
            <View style={styles.tarjetaFila}>
              <Text style={styles.tarjetaDato}>Emisión <Text style={styles.tarjetaDatoValor}>{fechaCelda(f.fecha_emision)}</Text></Text>
              <Text style={[styles.tarjetaDato, f.vencida && styles.tdVencida]}>
                Vence <Text style={styles.tarjetaDatoValor}>{fechaCelda(f.fecha_vencimiento)}</Text>
              </Text>
            </View>
            <View style={styles.tarjetaFila}>
              <Text style={styles.tarjetaDato}>Total <Text style={styles.tarjetaDatoValor}>{formatMoneda(Number(f.total_factura) || 0)}</Text></Text>
              <Text style={styles.tarjetaDato}>Pagado <Text style={styles.tarjetaDatoValor}>{formatMoneda(Number(f.total_cobrado) || 0)}</Text></Text>
            </View>
            {renderEstado(f)}
            {renderAcciones(f)}
          </View>
        );
      })}
      {renderPieTarjetas('Periodo', totales.periodo)}
      {totales.anterior.num > 0 ? renderPieTarjetas('Anterior al periodo', totales.anterior) : null}
    </View>
  );

  function renderPieTarjetas(etiqueta: string, t: ReturnType<typeof sumar> & { num: number }) {
    return (
      <View style={styles.pieTarjetas}>
        <Text style={styles.pieTarjetasTexto}>
          {etiqueta}: {t.num} factura{t.num === 1 ? '' : 's'} · Total {formatMoneda(t.total)} · Pagado {formatMoneda(t.pagado)}
        </Text>
        <Text style={[styles.pieTarjetasTexto, styles.tdPendiente]}>Pendiente {formatMoneda(t.pendiente)}</Text>
      </View>
    );
  }

  const renderIntragrupo = () => {
    const ig = detalle?.intragrupo;
    if (!ig) return null;
    const totalLe = sumar(ig.leDebemos).pendiente;
    const totalNos = sumar(ig.nosDebe).pendiente;
    const neto = textoNetoIntragrupo(totalLe, totalNos);
    const lista = (titulo: string, items: FacturaDeuda[], total: number) => (
      <View style={styles.igColumna}>
        <View style={styles.igColumnaCabecera}>
          <Text style={styles.igColumnaTitulo}>{titulo}</Text>
          <Text style={styles.igColumnaTotal}>{formatMoneda(total)}</Text>
        </View>
        {items.length === 0 ? (
          <Text style={styles.igVacio}>Sin facturas pendientes</Text>
        ) : (
          items.map((f) => (
            <TouchableOpacity
              key={f.id_factura}
              style={[styles.igFila, modoTarjetas && { minHeight: MIN_TOUCH }]}
              onPress={() => onVer(f)}
              accessibilityLabel={`Ver factura ${etiquetaFacturaDeuda(f)}`}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.igFilaNumero} numberOfLines={1}>{etiquetaFacturaDeuda(f)}</Text>
                <Text style={styles.igFilaSub} numberOfLines={1}>
                  {f.emisor_nombre || '—'} · {fechaCelda(f.fecha_emision)}
                </Text>
              </View>
              <Text style={styles.igFilaImporte}>{formatMoneda(Number(f.saldo_pendiente) || 0)}</Text>
            </TouchableOpacity>
          ))
        )}
      </View>
    );
    return (
      <View style={styles.igBloque}>
        <View style={styles.igCabecera}>
          <MaterialIcons name="sync-alt" size={16} color={COLOR_INTRAGRUPO} />
          <Text style={styles.igTitulo}>Saldo intragrupo</Text>
          <Text style={styles.igNeto}>
            Neto: {neto.importe === 0 ? 'cuadrado' : `${neto.texto} ${formatMoneda(neto.importe)}`}
          </Text>
        </View>
        <View style={[styles.igColumnas, modoTarjetas && styles.igColumnasApiladas]}>
          {lista('Le debemos', ig.leDebemos, totalLe)}
          {lista('Nos debe', ig.nosDebe, totalNos)}
        </View>
        <Text style={styles.igNota}>La compensación entre sociedades se registra en cada sociedad.</Text>
      </View>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.cabecera}>
        <View style={styles.cabeceraFila}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.cabeceraNombre} numberOfLines={2}>{proveedor.nombre || '—'}</Text>
            <Text style={styles.cabeceraCif}>{proveedor.cif || 'Sin CIF'}</Text>
          </View>
          <View style={[styles.badgeEstado, { backgroundColor: estilo.bg, borderColor: estilo.border }]}>
            <Text style={[styles.badgeEstadoTexto, { color: estilo.color }]}>
              {ETIQUETA_ESTADO_DEUDA[proveedor.estado] ?? proveedor.estado}
            </Text>
          </View>
        </View>
        <View style={styles.cabeceraCifras}>
          <Text style={styles.cabeceraCifra}>Facturado <Text style={styles.cabeceraCifraValor}>{formatMoneda(proveedor.facturado)}</Text></Text>
          <Text style={styles.cabeceraCifra}>Pagado <Text style={[styles.cabeceraCifraValor, { color: '#16a34a' }]}>{formatMoneda(proveedor.pagado)}</Text></Text>
          <Text style={styles.cabeceraCifra}>Pendiente <Text style={[styles.cabeceraCifraValor, { color: estilo.color }]}>{formatMoneda(proveedor.pendiente)}</Text></Text>
        </View>
        {proveedor.antiguedad ? <BarraAntiguedadDeuda antiguedad={proveedor.antiguedad} mini /> : null}
      </View>

      {loading ? (
        <View style={styles.centro}>
          <ActivityIndicator size="small" color="#0ea5e9" />
          <Text style={styles.centroTexto}>Cargando facturas…</Text>
        </View>
      ) : error ? (
        <View style={styles.centro}>
          <MaterialIcons name="error-outline" size={28} color="#dc2626" />
          <Text style={[styles.centroTexto, { color: '#dc2626' }]}>{error}</Text>
          <TouchableOpacity style={styles.btnReintentar} onPress={onReintentar}>
            <MaterialIcons name="refresh" size={16} color="#0ea5e9" />
            <Text style={styles.btnReintentarTexto}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : facturas.length === 0 ? (
        <View style={styles.centro}>
          <MaterialIcons name="inbox" size={32} color="#cbd5e1" />
          <Text style={styles.centroTexto}>No hay facturas en este periodo</Text>
        </View>
      ) : (
        <>
          {modoTarjetas ? renderTarjetas() : renderTabla()}
          {puedeSeleccionar && hayRevision ? (
            <View style={styles.notaRevision}>
              <MaterialIcons name="lock-outline" size={14} color="#b45309" />
              <Text style={styles.notaRevisionTexto}>{AVISO_REVISION}.</Text>
            </View>
          ) : null}
        </>
      )}

      {!loading && !error ? renderIntragrupo() : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  centro: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 16 },
  centroTexto: { fontSize: 13, color: '#64748b', textAlign: 'center' },
  btnReintentar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 12 },
  btnReintentarTexto: { fontSize: 13, color: '#0ea5e9', fontWeight: '600' },

  cabecera: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    gap: 10,
  },
  cabeceraFila: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cabeceraNombre: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  cabeceraCif: { fontSize: 12, color: '#94a3b8', marginTop: 2 },
  badgeEstado: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  badgeEstadoTexto: { fontSize: 12, fontWeight: '700' },
  cabeceraCifras: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4 },
  cabeceraCifra: { fontSize: 12, color: '#64748b' },
  cabeceraCifraValor: { fontWeight: '700', color: '#0f172a' },

  tablaScroll: { flexGrow: 1 },
  tabla: {
    flexGrow: 1,
    minWidth: 860,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    overflow: 'hidden',
  },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    gap: 6,
  },
  filaCabecera: { backgroundColor: '#f8fafc', paddingVertical: 8 },
  filaMarcada: { backgroundColor: '#f0f9ff' },
  filaPie: { backgroundColor: '#f8fafc', borderBottomWidth: 0 },
  th: { fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 },
  td: { fontSize: 12, color: '#0f172a' },
  tdFuerte: { fontWeight: '700' },
  tdVencida: { color: '#dc2626', fontWeight: '600' },
  tdPendiente: { color: '#d97706', fontWeight: '700' },
  derecha: { textAlign: 'right' },
  colCasilla: { width: 28, alignItems: 'center' },
  colNumero: { flex: 1.3, minWidth: 110 },
  colSociedad: { flex: 1.3, minWidth: 110 },
  colFecha: { width: 82 },
  colImporte: { width: 92 },
  colEstado: { width: 120 },
  colAcciones: { width: 130 },
  casillaWrap: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  casillaWrapTouch: { width: MIN_TOUCH, height: MIN_TOUCH },
  estadoCol: { gap: 3, alignItems: 'flex-start' },
  diasVencida: { fontSize: 11, color: '#dc2626', fontWeight: '600' },
  anterior: { fontSize: 11, color: '#b45309', fontWeight: '600' },
  acciones: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  accionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  accionBtnTouch: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, paddingHorizontal: 12, justifyContent: 'center' },
  accionTexto: { fontSize: 13, color: '#334155', fontWeight: '600' },
  accionPagar: { backgroundColor: '#16a34a', borderColor: '#16a34a' },
  accionPagarTexto: { fontSize: 12, color: '#fff', fontWeight: '700' },

  tarjetas: { gap: 10 },
  tarjeta: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    gap: 8,
  },
  tarjetaMarcada: { borderColor: '#0ea5e9', backgroundColor: '#f0f9ff' },
  tarjetaCabecera: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tarjetaNumero: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  tarjetaSub: { fontSize: 12, color: '#64748b' },
  tarjetaPendiente: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  tarjetaFila: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  tarjetaDato: { fontSize: 12, color: '#64748b' },
  tarjetaDatoValor: { color: '#0f172a', fontWeight: '600' },
  pieTarjetas: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
    gap: 4,
  },
  pieTarjetasTexto: { fontSize: 13, color: '#334155', fontWeight: '600' },

  notaRevision: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  notaRevisionTexto: { fontSize: 12, color: '#b45309' },

  igBloque: {
    backgroundColor: '#faf5ff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ddd6fe',
    padding: 12,
    gap: 10,
  },
  igCabecera: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  igTitulo: { fontSize: 14, fontWeight: '700', color: '#5b21b6', flex: 1 },
  igNeto: { fontSize: 13, fontWeight: '800', color: COLOR_INTRAGRUPO },
  igColumnas: { flexDirection: 'row', gap: 10 },
  igColumnasApiladas: { flexDirection: 'column' },
  igColumna: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ede9fe',
    padding: 10,
    gap: 6,
  },
  igColumnaCabecera: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  igColumnaTitulo: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  igColumnaTotal: { fontSize: 13, fontWeight: '700', color: COLOR_INTRAGRUPO },
  igVacio: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  igFila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#f5f3ff',
    ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : {}),
  },
  igFilaNumero: { fontSize: 12, fontWeight: '600', color: '#0f172a' },
  igFilaSub: { fontSize: 11, color: '#64748b' },
  igFilaImporte: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  igNota: { fontSize: 12, color: '#6d28d9', fontStyle: 'italic' },
});
