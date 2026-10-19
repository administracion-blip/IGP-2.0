/**
 * Panel «Albaranes que faltan» de una factura de gasto: lista de albaranes
 * citados en la factura que no están en Ágora y formulario para anotarlos.
 * Antes de anotar comprueba el Nº doc. prov. en Ágora (todo el año, todas las
 * sociedades) para no anotar algo que solo hay que marcar.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useConfirmar } from '../../hooks/useConfirmar';
import { MIN_TOUCH } from '../../constants/layout';
import { InputFecha } from '../InputFecha';
import { estiloCampoFechaCompacto } from '../RangoFechas';
import { formatMoneda } from '../../utils/formatMoneda';
import { errorMessage } from '../../utils/api';
import { normDocProveedor } from '../../utils/docProveedor';
import { formatFecha } from '../../utils/formatFecha';
import type { FacturaListado } from '../../types/factura';
import {
  type AlbaranFaltante,
  type AlbaranFaltanteInput,
  type ClasificacionAgora,
  type ResolverEmpresaCoincidencia,
  aniosConsulta,
  clasificarCoincidencias,
  coincidenciasDe,
  comprobarAlbaranesFaltantes,
  facturaConProveedor,
  fechaFacturaIso,
  guardarAlbaranesFaltantes,
  numeroFacturaVisible,
} from '../../lib/albaranesFaltantes';
import { PastillaAlbaranFaltante } from './PastillaAlbaranFaltante';

type Comprobacion =
  | { clave: string; estado: 'cargando' }
  | { clave: string; estado: 'ok'; cls: ClasificacionAgora }
  | { clave: string; estado: 'error'; error: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  factura: FacturaListado | null;
  sociedadNombre: string;
  /** CIF normalizado de la sociedad del grupo de la factura ('' si no resuelve). */
  cifSociedad: string;
  /** Empresa del grupo del almacén de una coincidencia de Ágora. */
  empresaDeCoincidencia: ResolverEmpresaCoincidencia;
  puedeEditar: boolean;
  /** Permiso para consultar compras de Ágora; sin él se anota sin comprobar. */
  puedeComprobar: boolean;
  onGuardado: (facturaId: string, items: AlbaranFaltante[], version?: number) => void;
};

function parseImporte(txt: string): number | null | 'invalido' {
  const t = txt.trim().replace(/\s/g, '');
  if (!t) return null;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(norm);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 'invalido';
}

export function ModalAlbaranesFaltantes({
  visible,
  onClose,
  factura,
  sociedadNombre,
  cifSociedad,
  empresaDeCoincidencia,
  puedeEditar,
  puedeComprobar,
  onGuardado,
}: Props) {
  const { isPhone } = useBreakpoint();
  const { confirmar, ConfirmarView } = useConfirmar();

  const [numero, setNumero] = useState('');
  const [fecha, setFecha] = useState('');
  const [importe, setImporte] = useState('');
  const [nota, setNota] = useState('');
  const [comprobacion, setComprobacion] = useState<Comprobacion | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enVueloRef = useRef<{ clave: string; promesa: Promise<ClasificacionAgora> } | null>(null);

  const facturaId = factura?.id_factura ?? null;
  const notas = useMemo(() => factura?.albaranes_faltantes ?? [], [factura]);
  const anulada = factura?.estado === 'anulada';
  const editable = puedeEditar && !anulada;

  const resetForm = useCallback(() => {
    setNumero('');
    setFecha('');
    setImporte('');
    setNota('');
    setComprobacion(null);
    setError(null);
    enVueloRef.current = null;
  }, []);

  useEffect(() => {
    if (visible) resetForm();
  }, [visible, facturaId, resetForm]);

  const numeroNorm = normDocProveedor(numero);
  const conProveedor = !!factura && facturaConProveedor(factura);
  const anios = useMemo(() => (factura ? aniosConsulta(fecha, fechaFacturaIso(factura)) : []), [factura, fecha]);
  const sePuedeComprobar = puedeComprobar && conProveedor && anios.length > 0;
  const claveActual = numeroNorm && sePuedeComprobar ? `${numeroNorm}|${anios.join(',')}` : '';
  const comprobacionActual = comprobacion && comprobacion.clave === claveActual ? comprobacion : null;
  const yaAnotado = !!numeroNorm && notas.some((n) => (n.numero_norm || normDocProveedor(n.numero_doc_proveedor)) === numeroNorm);

  const comprobar = useCallback(
    (clave: string, num: string, aniosC: number[]): Promise<ClasificacionAgora> => {
      if (enVueloRef.current?.clave === clave) return enVueloRef.current.promesa;
      if (!factura) return Promise.resolve({ tipo: 'ninguna' });
      const provCif = String(factura.empresa_cif ?? '').trim();
      const provNombre = String(factura.empresa_nombre ?? '').trim();
      setComprobacion({ clave, estado: 'cargando' });
      const promesa = comprobarAlbaranesFaltantes(
        aniosC.map((anio) => ({ proveedor_cif: provCif, proveedor_nombre: provNombre, anio, numeros: [num] })),
      ).then((indice) => {
        const lista = coincidenciasDe(indice, provCif, provNombre, aniosC, num);
        if (!lista) throw new Error('la consulta no es válida para Ágora');
        return clasificarCoincidencias(lista, cifSociedad, empresaDeCoincidencia);
      });
      enVueloRef.current = { clave, promesa };
      promesa
        .then((cls) => {
          setComprobacion((prev) => (prev?.clave === clave ? { clave, estado: 'ok', cls } : prev));
        })
        .catch((e: unknown) => {
          setComprobacion((prev) =>
            prev?.clave === clave ? { clave, estado: 'error', error: errorMessage(e, 'No se pudo comprobar en Ágora') } : prev,
          );
        })
        .finally(() => {
          if (enVueloRef.current?.clave === clave) enVueloRef.current = null;
        });
      return promesa;
    },
    [factura, cifSociedad, empresaDeCoincidencia],
  );

  const onBlurNumero = useCallback(() => {
    if (!claveActual || yaAnotado) return;
    if (comprobacionActual && comprobacionActual.estado !== 'error') return;
    void comprobar(claveActual, numeroNorm, anios).catch(() => {});
  }, [claveActual, yaAnotado, comprobacionActual, comprobar, numeroNorm, anios]);

  const versionFactura = factura?.version;
  const persistir = useCallback(
    async (items: AlbaranFaltanteInput[]): Promise<boolean> => {
      if (!facturaId) return false;
      setGuardando(true);
      setError(null);
      try {
        const saved = await guardarAlbaranesFaltantes(facturaId, items, versionFactura);
        onGuardado(facturaId, saved.albaranes_faltantes, saved.version);
        return true;
      } catch (e: unknown) {
        setError(errorMessage(e, 'No se pudieron guardar los albaranes que faltan'));
        return false;
      } finally {
        setGuardando(false);
      }
    },
    [facturaId, versionFactura, onGuardado],
  );

  const anotar = useCallback(
    async (enOtra: AlbaranFaltante['en_otra_empresa']) => {
      const imp = parseImporte(importe);
      if (imp === 'invalido') {
        setError('Importe no válido');
        return;
      }
      const nuevo: AlbaranFaltanteInput = {
        numero_doc_proveedor: numero.trim(),
        fecha_albaran: fecha || '',
        importe: imp,
        nota: nota.trim(),
        estado: 'pendiente',
        resuelta_por: null,
        resuelta_en: null,
        en_otra_empresa: enOtra,
      };
      const ok = await persistir([...notas, nuevo]);
      if (ok) resetForm();
    },
    [importe, numero, fecha, nota, notas, persistir, resetForm],
  );

  const onAnadir = useCallback(async () => {
    setError(null);
    if (!numeroNorm) {
      setError('Indica el Nº doc. prov. del albarán');
      return;
    }
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      setError('Indica una fecha válida (dd/mm/aaaa)');
      return;
    }
    if (parseImporte(importe) === 'invalido') {
      setError('Importe no válido');
      return;
    }
    if (yaAnotado) {
      setError('Ese albarán ya está anotado en esta factura.');
      return;
    }
    if (!claveActual) {
      await anotar(null);
      return;
    }
    let cls: ClasificacionAgora;
    if (comprobacionActual?.estado === 'ok') {
      cls = comprobacionActual.cls;
    } else {
      try {
        cls = await comprobar(claveActual, numeroNorm, anios);
      } catch {
        return;
      }
    }
    if (cls.tipo === 'ninguna') await anotar(null);
  }, [numeroNorm, fecha, importe, yaAnotado, comprobacionActual, comprobar, claveActual, anios, anotar]);

  const cambiarEstado = useCallback(
    async (nota: AlbaranFaltante, resolver: boolean) => {
      const items = notas.map((n) =>
        n.id !== nota.id
          ? n
          : resolver
            ? { ...n, estado: 'resuelta' as const, resuelta_por: 'manual' as const, resuelta_en: new Date().toISOString() }
            : { ...n, estado: 'pendiente' as const, resuelta_por: null, resuelta_en: null },
      );
      await persistir(items);
    },
    [notas, persistir],
  );

  const borrar = useCallback(
    async (nota: AlbaranFaltante) => {
      const ok = await confirmar(
        'Borrar albarán anotado',
        `¿Borrar el albarán ${nota.numero_doc_proveedor} de la lista de albaranes que faltan de esta factura?`,
        { confirmarLabel: 'Borrar', variant: 'danger' },
      );
      if (!ok) return;
      await persistir(notas.filter((n) => n.id !== nota.id));
    },
    [confirmar, notas, persistir],
  );

  const tituloFactura = factura ? numeroFacturaVisible(factura) : '—';
  const cls = comprobacionActual?.estado === 'ok' ? comprobacionActual.cls : null;
  const bloqueadoMisma = cls?.tipo === 'misma';
  const avisoOtra = cls?.tipo === 'otra' || cls?.tipo === 'sin_empresa' ? cls : null;
  const comprobando = comprobacionActual?.estado === 'cargando';
  const btnTouch = isPhone ? { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH } : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, isPhone && styles.overlayPhone]}>
        <View style={[styles.card, isPhone && styles.cardPhone]}>
          <View style={styles.header}>
            <MaterialIcons name="report-problem" size={20} color="#d97706" />
            <Text style={styles.title} numberOfLines={2}>
              Albaranes que faltan — factura {tituloFactura}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} style={btnTouch} accessibilityLabel="Cerrar">
              <MaterialIcons name="close" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
            <View style={styles.infoGrid}>
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Sociedad</Text>
                <Text style={styles.infoValor} numberOfLines={1}>{sociedadNombre || 'Sin sociedad'}</Text>
              </View>
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Proveedor</Text>
                <Text style={styles.infoValor} numberOfLines={1}>
                  {String(factura?.empresa_nombre ?? '').trim() || '—'}
                  {factura?.empresa_cif ? ` · ${factura.empresa_cif}` : ''}
                </Text>
              </View>
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Nº factura</Text>
                <Text style={styles.infoValor} numberOfLines={1}>
                  {tituloFactura}
                  {factura?.fecha_emision ? ` · ${formatFecha(fechaFacturaIso(factura))}` : ''}
                </Text>
              </View>
            </View>

            {anulada ? (
              <View style={[styles.aviso, styles.avisoGris]}>
                <MaterialIcons name="block" size={16} color="#475569" />
                <Text style={[styles.avisoTexto, { color: '#475569' }]}>La factura está anulada: no se pueden anotar albaranes.</Text>
              </View>
            ) : null}

            <View style={{ gap: 6 }}>
              <Text style={styles.seccion}>Anotados ({notas.length})</Text>
              {notas.length === 0 ? (
                <Text style={styles.vacio}>No hay albaranes anotados en esta factura.</Text>
              ) : (
                <View style={styles.lista}>
                  {notas.map((n) => (
                    <View key={n.id || n.numero_norm} style={styles.fila}>
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <View style={styles.filaLinea}>
                          <Text style={styles.filaNumero} numberOfLines={1}>{n.numero_doc_proveedor}</Text>
                          <Text style={styles.filaDato}>{formatFecha(n.fecha_albaran)}</Text>
                          <Text style={styles.filaDato}>{n.importe != null ? formatMoneda(n.importe) : '—'}</Text>
                          <PastillaAlbaranFaltante estado={n.estado} resueltaPor={n.resuelta_por} enOtraEmpresa={n.en_otra_empresa} />
                        </View>
                        {n.en_otra_empresa && n.estado === 'pendiente' ? (
                          <Text style={styles.filaSub} numberOfLines={2}>
                            En Ágora: {n.en_otra_empresa.empresa_nombre}
                            {n.en_otra_empresa.almacen ? ` · almacén ${n.en_otra_empresa.almacen}` : ''}
                            {n.en_otra_empresa.fecha ? ` · ${formatFecha(n.en_otra_empresa.fecha)}` : ''}
                          </Text>
                        ) : null}
                        {n.nota ? <Text style={styles.filaSub} numberOfLines={3}>{n.nota}</Text> : null}
                      </View>
                      {editable ? (
                        <View style={styles.filaAcciones}>
                          {n.estado === 'pendiente' ? (
                            <TouchableOpacity
                              style={[styles.iconBtn, btnTouch]}
                              onPress={() => void cambiarEstado(n, true)}
                              disabled={guardando}
                              accessibilityLabel="Marcar como resuelta"
                            >
                              <MaterialIcons name="check-circle-outline" size={18} color="#16a34a" />
                            </TouchableOpacity>
                          ) : (
                            <TouchableOpacity
                              style={[styles.iconBtn, btnTouch]}
                              onPress={() => void cambiarEstado(n, false)}
                              disabled={guardando}
                              accessibilityLabel="Reabrir"
                            >
                              <MaterialIcons name="undo" size={18} color="#d97706" />
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            style={[styles.iconBtn, btnTouch]}
                            onPress={() => void borrar(n)}
                            disabled={guardando}
                            accessibilityLabel="Borrar"
                          >
                            <MaterialIcons name="delete-outline" size={18} color="#dc2626" />
                          </TouchableOpacity>
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
            </View>

            {editable ? (
              <View style={styles.form}>
                <Text style={styles.seccion}>Añadir albarán que falta</Text>
                <View style={[styles.formRow, isPhone && { flexDirection: 'column' }]}>
                  <View style={[styles.campo, { flex: 2 }]}>
                    <Text style={styles.campoLabel}>Nº doc. prov. *</Text>
                    <TextInput
                      style={[styles.input, isPhone && { minHeight: MIN_TOUCH }]}
                      value={numero}
                      onChangeText={(v) => { setNumero(v); setError(null); }}
                      onBlur={onBlurNumero}
                      placeholder="p. ej. 142700"
                      placeholderTextColor="#94a3b8"
                      autoCapitalize="characters"
                      editable={!guardando}
                    />
                    <Text style={styles.ayuda}>El número de albarán del proveedor que aparece en la factura</Text>
                  </View>
                  <View style={[styles.campo, { flex: 1, minWidth: 140 }]}>
                    <Text style={styles.campoLabel}>Fecha albarán</Text>
                    <InputFecha
                      compact
                      valueIso={fecha}
                      onChangeIso={setFecha}
                      placeholder="dd/mm/aaaa"
                      editable={!guardando}
                      style={estiloCampoFechaCompacto}
                    />
                  </View>
                  <View style={[styles.campo, { flex: 1, minWidth: 110 }]}>
                    <Text style={styles.campoLabel}>Importe (opcional)</Text>
                    <TextInput
                      style={[styles.input, isPhone && { minHeight: MIN_TOUCH }]}
                      value={importe}
                      onChangeText={setImporte}
                      placeholder="0,00"
                      placeholderTextColor="#94a3b8"
                      keyboardType="decimal-pad"
                      editable={!guardando}
                    />
                  </View>
                </View>
                <View style={styles.campo}>
                  <Text style={styles.campoLabel}>Nota (opcional)</Text>
                  <TextInput
                    style={[styles.input, isPhone && { minHeight: MIN_TOUCH }]}
                    value={nota}
                    onChangeText={setNota}
                    placeholder="Observaciones para economato o el proveedor"
                    placeholderTextColor="#94a3b8"
                    editable={!guardando}
                  />
                </View>

                {!conProveedor ? (
                  <View style={[styles.aviso, styles.avisoGris]}>
                    <MaterialIcons name="info-outline" size={16} color="#475569" />
                    <Text style={[styles.avisoTexto, { color: '#475569' }]}>
                      La factura no tiene proveedor identificado; no se puede comprobar en Ágora.
                    </Text>
                  </View>
                ) : !puedeComprobar ? (
                  <View style={[styles.aviso, styles.avisoGris]}>
                    <MaterialIcons name="info-outline" size={16} color="#475569" />
                    <Text style={[styles.avisoTexto, { color: '#475569' }]}>
                      No tienes permiso para consultar las compras de Ágora; el albarán se anotará sin comprobar.
                    </Text>
                  </View>
                ) : null}

                {comprobando ? (
                  <View style={[styles.aviso, styles.avisoGris]}>
                    <ActivityIndicator size="small" color="#0ea5e9" />
                    <Text style={[styles.avisoTexto, { color: '#475569' }]}>Comprobando en Ágora…</Text>
                  </View>
                ) : null}

                {bloqueadoMisma && cls?.tipo === 'misma' ? (
                  <View style={[styles.aviso, styles.avisoAzul]}>
                    <MaterialIcons name="info-outline" size={16} color="#0369a1" />
                    <Text style={[styles.avisoTexto, { color: '#0369a1' }]}>
                      Ese albarán ya está en Ágora ({cls.coincidencia.albaran || 'sin nº'}, {formatFecha(cls.coincidencia.fecha)}).
                      Márcalo en la lista de la izquierda en lugar de anotarlo.
                    </Text>
                  </View>
                ) : null}

                {avisoOtra ? (
                  <View style={[styles.aviso, styles.avisoAmbar, { flexDirection: 'column', alignItems: 'stretch' }]}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <MaterialIcons name="warning-amber" size={16} color="#b45309" />
                      <Text style={[styles.avisoTexto, { color: '#92400e' }]}>
                        {avisoOtra.tipo === 'sin_empresa'
                          ? `Está en Ágora en el almacén ${avisoOtra.coincidencia.almacen || '—'} (sin empresa asociada), ${formatFecha(avisoOtra.coincidencia.fecha)}. Revisa a qué sociedad pertenece ese almacén.`
                          : `El ${numero.trim()} ya está en Ágora en ${avisoOtra.ubicacion.empresa_nombre}, almacén ${avisoOtra.coincidencia.almacen || '—'}, ${formatFecha(avisoOtra.coincidencia.fecha)}. Puede que se haya cargado en el almacén equivocado.`}
                      </Text>
                    </View>
                    <View style={styles.avisoBotones}>
                      <TouchableOpacity style={[styles.btnSec, btnTouch]} onPress={resetForm} disabled={guardando}>
                        <Text style={styles.btnSecText}>No anotar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.btnAmbar, btnTouch, guardando && styles.btnDisabled]}
                        onPress={() => void anotar(avisoOtra.ubicacion)}
                        disabled={guardando}
                      >
                        <Text style={styles.btnPrimText}>Anotar igualmente</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : null}

                {comprobacionActual?.estado === 'error' ? (
                  <View style={[styles.aviso, styles.avisoRojo, { flexDirection: 'column', alignItems: 'stretch' }]}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
                      <Text style={[styles.avisoTexto, { color: '#b91c1c' }]}>
                        No se pudo comprobar en Ágora: {comprobacionActual.error}
                      </Text>
                    </View>
                    <View style={styles.avisoBotones}>
                      <TouchableOpacity
                        style={[styles.btnSec, btnTouch]}
                        onPress={() => void comprobar(claveActual, numeroNorm, anios).catch(() => {})}
                        disabled={guardando}
                      >
                        <Text style={styles.btnSecText}>Reintentar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.btnSec, btnTouch]} onPress={() => void anotar(null)} disabled={guardando}>
                        <Text style={styles.btnSecText}>Anotar sin comprobar</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : null}

                {error ? (
                  <View style={[styles.aviso, styles.avisoRojo]}>
                    <MaterialIcons name="error-outline" size={16} color="#b91c1c" />
                    <Text style={[styles.avisoTexto, { color: '#b91c1c' }]}>{error}</Text>
                  </View>
                ) : null}

                <View style={styles.formPie}>
                  <TouchableOpacity
                    style={[
                      styles.btnPrim,
                      btnTouch,
                      (guardando || comprobando || bloqueadoMisma || !!avisoOtra || !numeroNorm) && styles.btnDisabled,
                    ]}
                    onPress={() => void onAnadir()}
                    disabled={guardando || comprobando || bloqueadoMisma || !!avisoOtra || !numeroNorm}
                  >
                    {guardando ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <MaterialIcons name="playlist-add" size={18} color="#fff" />
                    )}
                    <Text style={styles.btnPrimText}>Añadir</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : !anulada && !puedeEditar ? (
              <Text style={styles.vacio}>Necesitas permiso para emitir facturas para anotar albaranes que faltan.</Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
      {ConfirmarView}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  overlayPhone: { padding: 0 },
  card: {
    width: '100%',
    maxWidth: 680,
    maxHeight: '92%',
    backgroundColor: '#fff',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...(Platform.OS === 'web' ? { boxShadow: '0 12px 32px rgba(15,23,42,0.18)' } : { elevation: 12 }),
  },
  cardPhone: { maxWidth: '100%', maxHeight: '100%', height: '100%', borderRadius: 0, borderWidth: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: { flex: 1, fontSize: 15, fontWeight: '700', color: '#0f172a' },
  body: { flexGrow: 0, flexShrink: 1 },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  infoItem: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  infoLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  infoValor: { fontSize: 13, color: '#0f172a', fontWeight: '600', marginTop: 2 },
  seccion: { fontSize: 12, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 },
  vacio: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  lista: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, overflow: 'hidden' },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    backgroundColor: '#fff',
  },
  filaLinea: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  filaNumero: { fontSize: 13, fontWeight: '700', color: '#0f172a', maxWidth: 180 },
  filaDato: { fontSize: 12, color: '#475569' },
  filaSub: { fontSize: 12, color: '#64748b' },
  filaAcciones: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: {
    padding: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  form: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  formRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  campo: { gap: 3, minWidth: 0 },
  campoLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: '#0f172a',
    minHeight: 32,
  },
  ayuda: { fontSize: 11, color: '#94a3b8' },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  avisoTexto: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  avisoAzul: { backgroundColor: '#eff6ff', borderColor: '#bfdbfe' },
  avisoAmbar: { backgroundColor: '#fffbeb', borderColor: '#fcd34d', gap: 10 },
  avisoRojo: { backgroundColor: '#fef2f2', borderColor: '#fecaca', gap: 10 },
  avisoGris: { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
  avisoBotones: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  formPie: { flexDirection: 'row', justifyContent: 'flex-end' },
  btnPrim: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#0ea5e9',
  },
  btnAmbar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#d97706',
  },
  btnPrimText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  btnSec: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  btnSecText: { fontSize: 13, fontWeight: '600', color: '#475569' },
  btnDisabled: { opacity: 0.5 },
});
