import { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoneda } from '../../utils/facturacion';
import { useLocalToast, detectToastType } from '../../components/Toast';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Confianza = Record<string, string>;

type Borrador = {
  idx: number;
  archivo: { fileKey: string; nombre: string; tipo: string; size: number; previewUrl: string };
  proveedor_cif: string;
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
  total_iva: number;
  total_factura: number;
  observaciones: string;
  confianza: Confianza;
  /** Origen del texto: texto embebido del PDF, OCR de imagen u OCR tras rasterizar PDF escaneado */
  metodo_extraccion?: string;
  ocr_confianza_global?: number;
  descartado: boolean;
  duplicados: { id_factura: string; numero_factura: string; empresa_nombre: string; total_factura: number }[];
  checkingDup: boolean;
};


function confColor(level: string) {
  if (level === 'alta') return '#059669';
  if (level === 'media') return '#b45309';
  return '#dc2626';
}

function isoToDmy(iso: string): string {
  if (!iso || iso.length < 10) return iso || '';
  const [y, m, d] = iso.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function metodoExtraccionLabel(m: string | undefined): string {
  if (!m) return '';
  if (m === 'pdf_text') return 'Texto embebido (PDF)';
  if (m === 'image_ocr') return 'OCR (imagen)';
  if (m === 'pdf_ocr_fallback') return 'OCR (PDF escaneado, pág. 1)';
  return m;
}

export default function RegistroMasivoScreen() {
  const router = useRouter();
  const { user, hasPermiso } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  const { show: showToast, ToastView } = useLocalToast();
  const alertMsg = useCallback((t: string, m: string) => {
    showToast(t, m, detectToastType(t, m));
  }, [showToast]);

  const [borradores, setBorradores] = useState<Borrador[]>([]);
  const [procesando, setProcesando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [step, setStep] = useState<'upload' | 'review'>('upload');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [modalEmpresaIdx, setModalEmpresaIdx] = useState<number | null>(null);
  const [nombreNuevaEmpresa, setNombreNuevaEmpresa] = useState('');
  const [creandoEmpresa, setCreandoEmpresa] = useState(false);

  const selectedBorrador = selectedIdx !== null ? borradores.find((b) => b.idx === selectedIdx) : null;
  const borradorModalEmpresa = modalEmpresaIdx !== null ? borradores.find((b) => b.idx === modalEmpresaIdx) : null;

  const subirArchivos = useCallback(() => {
    if (Platform.OS !== 'web') {
      alertMsg('Info', 'Solo disponible en versión web');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.png';
    input.multiple = true;
    input.onchange = async () => {
      const files = input.files;
      if (!files || files.length === 0) return;

      setProcesando(true);
      const nuevos: Borrador[] = [];
      const baseIdx = borradores.length;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const formData = new FormData();
          formData.append('file', file);
          const res = await fetch(`${API_URL}/api/facturacion/ocr/extraer`, {
            method: 'POST',
            body: formData,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Error OCR');

          const d = data.datos;
          nuevos.push({
            idx: baseIdx + i,
            archivo: data.archivo,
            proveedor_cif: d.proveedor_cif || '',
            proveedor_nombre: d.proveedor_nombre || '',
            empresa_id: d.empresa_id || '',
            proveedor_en_maestros: Boolean(d.proveedor_en_maestros),
            nombre_sugerido_ocr: d.nombre_sugerido_ocr || '',
            numero_factura_proveedor: d.numero_factura_proveedor || '',
            fecha_emision: d.fecha_emision ? isoToDmy(d.fecha_emision) : '',
            base_imponible: d.base_imponible || 0,
            total_iva: d.total_iva || 0,
            total_factura: d.total_factura || 0,
            observaciones: '',
            confianza: d.confianza || {},
            metodo_extraccion: d.metodo_extraccion,
            ocr_confianza_global: typeof d.ocr_confianza_global === 'number' ? d.ocr_confianza_global : undefined,
            descartado: false,
            duplicados: [],
            checkingDup: false,
          });
        } catch (e: any) {
          alertMsg('Error', `${file.name}: ${e.message}`);
        }
      }

      setBorradores((prev) => [...prev, ...nuevos]);
      if (nuevos.length > 0) {
        setStep('review');
        setSelectedIdx(nuevos[0].idx);
      }
      setProcesando(false);

      for (const b of nuevos) {
        checkDuplicados(b);
      }
    };
    input.click();
  }, [borradores.length]);

  const checkDuplicados = async (borrador: Borrador) => {
    setBorradores((prev) =>
      prev.map((b) => b.idx === borrador.idx ? { ...b, checkingDup: true } : b)
    );
    try {
      const res = await fetch(`${API_URL}/api/facturacion/check-duplicados`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proveedor_cif: borrador.proveedor_cif,
          numero_factura_proveedor: borrador.numero_factura_proveedor,
          fecha_emision: borrador.fecha_emision,
          total_factura: borrador.total_factura,
        }),
      });
      const data = await res.json();
      setBorradores((prev) =>
        prev.map((b) => b.idx === borrador.idx ? { ...b, duplicados: data.duplicados || [], checkingDup: false } : b)
      );
    } catch {
      setBorradores((prev) =>
        prev.map((b) => b.idx === borrador.idx ? { ...b, checkingDup: false } : b)
      );
    }
  };

  const updateBorrador = (idx: number, field: string, value: any) => {
    setBorradores((prev) =>
      prev.map((b) => b.idx === idx ? { ...b, [field]: value } : b)
    );
  };

  const abrirModalCrearEmpresa = (b: Borrador) => {
    setNombreNuevaEmpresa((b.nombre_sugerido_ocr || '').trim());
    setModalEmpresaIdx(b.idx);
  };

  const cerrarModalCrearEmpresa = () => {
    setModalEmpresaIdx(null);
    setNombreNuevaEmpresa('');
    setCreandoEmpresa(false);
  };

  const crearEmpresaDesdeOcr = async () => {
    if (!borradorModalEmpresa?.proveedor_cif) return;
    const nombre = nombreNuevaEmpresa.trim();
    if (!nombre) {
      alertMsg('Falta nombre', 'Indica el nombre de la empresa para darla de alta.');
      return;
    }
    setCreandoEmpresa(true);
    try {
      const res = await fetch(`${API_URL}/api/empresas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Nombre: nombre,
          Cif: borradorModalEmpresa.proveedor_cif,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo crear la empresa');
      const emp = data.empresa;
      const id = modalEmpresaIdx;
      if (id != null) {
        setBorradores((prev) =>
          prev.map((b) =>
            b.idx === id
              ? {
                  ...b,
                  proveedor_nombre: emp?.Nombre != null ? String(emp.Nombre) : nombre,
                  empresa_id: emp?.id_empresa != null ? String(emp.id_empresa) : '',
                  proveedor_en_maestros: true,
                  nombre_sugerido_ocr: '',
                  confianza: {
                    ...b.confianza,
                    proveedor_nombre: 'alta',
                  },
                }
              : b
          )
        );
      }
      showToast('Empresa creada', `${nombre} vinculada al CIF ${borradorModalEmpresa.proveedor_cif}`, 'success');
      cerrarModalCrearEmpresa();
    } catch (e: any) {
      alertMsg('Error', e.message || 'Error al crear empresa');
    } finally {
      setCreandoEmpresa(false);
    }
  };

  const confirmar = async () => {
    const activos = borradores.filter((b) => !b.descartado);
    if (activos.length === 0) {
      alertMsg('Info', 'No hay borradores activos para confirmar');
      return;
    }
    setGuardando(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/ocr/confirmar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          borradores: activos.map((b) => ({
            ...b,
            serie: '',
            forma_pago: '',
            condiciones_pago: '',
            observaciones: b.observaciones || `Archivo: ${b.archivo.nombre}`,
          })),
          usuario_id: user?.id_usuario,
          usuario_nombre: user?.Nombre,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error');
      alertMsg('Creados', `${data.creados} factura(s) creada(s) como borradores pendientes de revisión`);
      router.push('/facturacion/facturas-gasto' as any);
    } catch (e: any) {
      alertMsg('Error', e.message);
    } finally {
      setGuardando(false);
    }
  };

  const navPrev = () => {
    if (selectedIdx === null) return;
    const cur = borradores.findIndex((b) => b.idx === selectedIdx);
    if (cur > 0) setSelectedIdx(borradores[cur - 1].idx);
  };
  const navNext = () => {
    if (selectedIdx === null) return;
    const cur = borradores.findIndex((b) => b.idx === selectedIdx);
    if (cur < borradores.length - 1) setSelectedIdx(borradores[cur + 1].idx);
  };

  if (!hasPermiso('facturacion.crear')) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>No tienes permisos para esta función</Text>
      </View>
    );
  }

  const currentPos = selectedIdx !== null ? borradores.findIndex((b) => b.idx === selectedIdx) + 1 : 0;

  return (
    <View style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity onPress={() => router.push('/facturacion/facturas-gasto' as any)} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={20} color="#334155" />
          </TouchableOpacity>
          <View>
            <Text style={styles.title}>Registro masivo de facturas</Text>
            <Text style={styles.subtitle}>Sube PDFs o imágenes — extracción automática con revisión</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {step === 'review' && (
            <View style={styles.navBtns}>
              <TouchableOpacity onPress={navPrev} disabled={currentPos <= 1} style={styles.navArrow}>
                <MaterialIcons name="chevron-left" size={20} color={currentPos <= 1 ? '#cbd5e1' : '#334155'} />
              </TouchableOpacity>
              <Text style={styles.navLabel}>{currentPos} / {borradores.length}</Text>
              <TouchableOpacity onPress={navNext} disabled={currentPos >= borradores.length} style={styles.navArrow}>
                <MaterialIcons name="chevron-right" size={20} color={currentPos >= borradores.length ? '#cbd5e1' : '#334155'} />
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity style={styles.addMoreBtn} onPress={subirArchivos} disabled={procesando}>
            {procesando ? <ActivityIndicator size="small" color="#0ea5e9" /> : (
              <>
                <MaterialIcons name="cloud-upload" size={16} color="#0ea5e9" />
                <Text style={styles.addMoreText}>{step === 'upload' ? 'Seleccionar archivos' : 'Añadir más'}</Text>
              </>
            )}
          </TouchableOpacity>
          {step === 'review' && (
            <TouchableOpacity style={styles.confirmBtn} onPress={confirmar} disabled={guardando}>
              {guardando ? <ActivityIndicator size="small" color="#fff" /> : (
                <>
                  <MaterialIcons name="check" size={16} color="#fff" />
                  <Text style={styles.confirmBtnText}>
                    Confirmar {borradores.filter((b) => !b.descartado).length}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>

      {step === 'upload' && (
        <View style={styles.uploadArea}>
          <MaterialIcons name="cloud-upload" size={48} color="#94a3b8" />
          <Text style={styles.uploadTitle}>Arrastra archivos o pulsa el botón superior</Text>
          <Text style={styles.uploadHint}>PDF, JPG, PNG — máximo 20 MB por archivo</Text>
        </View>
      )}

      {step === 'review' && selectedBorrador && (
        <View style={styles.splitHorizontal}>
          {/* LEFT: Editable form */}
          <View style={styles.formPane}>
            <ScrollView contentContainerStyle={styles.formScroll} horizontal={false}>
              {/* File info bar */}
              <View style={styles.fileInfoBar}>
                <MaterialIcons
                  name={selectedBorrador.archivo.tipo.includes('pdf') ? 'picture-as-pdf' : 'image'}
                  size={16}
                  color={selectedBorrador.archivo.tipo.includes('pdf') ? '#dc2626' : '#0ea5e9'}
                />
                <Text style={styles.fileInfoName} numberOfLines={1}>{selectedBorrador.archivo.nombre}</Text>
                {selectedBorrador.descartado ? (
                  <TouchableOpacity style={styles.restoreBtn} onPress={() => updateBorrador(selectedBorrador.idx, 'descartado', false)}>
                    <MaterialIcons name="undo" size={14} color="#059669" />
                    <Text style={{ fontSize: 11, color: '#059669', fontWeight: '500' }}>Restaurar</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={styles.discardBtn} onPress={() => updateBorrador(selectedBorrador.idx, 'descartado', true)}>
                    <MaterialIcons name="close" size={14} color="#dc2626" />
                    <Text style={{ fontSize: 11, color: '#dc2626', fontWeight: '500' }}>Descartar</Text>
                  </TouchableOpacity>
                )}
              </View>

              {selectedBorrador.duplicados.length > 0 && (
                <View style={styles.dupWarn}>
                  <MaterialIcons name="warning" size={14} color="#b45309" />
                  <Text style={styles.dupWarnText}>
                    Posible(s) duplicado(s): {selectedBorrador.duplicados.map((d) => d.empresa_nombre || d.id_factura).join(', ')}
                  </Text>
                </View>
              )}

              {selectedBorrador.proveedor_cif && !selectedBorrador.proveedor_en_maestros && (
                <View style={styles.maestroWarn}>
                  <MaterialIcons name="store" size={16} color="#c2410c" />
                  <View style={styles.maestroWarnBody}>
                    <Text style={styles.maestroWarnTitle}>Proveedor no encontrado en empresas</Text>
                    <Text style={styles.maestroWarnText}>
                      El CIF {selectedBorrador.proveedor_cif} no existe en el maestro. El nombre queda vacío; puedes darlo de alta ahora.
                    </Text>
                    {hasPermiso('empresas.crear') ? (
                      <TouchableOpacity
                        style={styles.maestroBtn}
                        onPress={() => abrirModalCrearEmpresa(selectedBorrador)}
                        activeOpacity={0.85}
                      >
                        <MaterialIcons name="add-business" size={16} color="#fff" />
                        <Text style={styles.maestroBtnText}>Crear empresa en maestro</Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={styles.maestroNoPerm}>Sin permiso para crear empresas. Pídeselo a un administrador.</Text>
                    )}
                  </View>
                </View>
              )}

              <View style={styles.legendRow}>
                <Text style={styles.legendText}>
                  Confianza OCR: <Text style={{ color: '#059669' }}>●</Text> Alta{'  '}
                  <Text style={{ color: '#b45309' }}>●</Text> Media{'  '}
                  <Text style={{ color: '#dc2626' }}>●</Text> Baja
                  {selectedBorrador.metodo_extraccion ? (
                    <Text style={styles.metodoHint}>
                      {'  ·  '}
                      {metodoExtraccionLabel(selectedBorrador.metodo_extraccion)}
                      {selectedBorrador.ocr_confianza_global != null
                        ? ` (${Math.round(selectedBorrador.ocr_confianza_global * 100)}% global)`
                        : ''}
                    </Text>
                  ) : null}
                </Text>
              </View>

              <View style={styles.formGrid}>
                <FieldRow label="CIF Proveedor" value={selectedBorrador.proveedor_cif} conf={selectedBorrador.confianza.proveedor_cif} onChange={(v) => updateBorrador(selectedBorrador.idx, 'proveedor_cif', v)} />
                <FieldRow label="Nombre proveedor" value={selectedBorrador.proveedor_nombre} conf={selectedBorrador.confianza.proveedor_nombre} onChange={(v) => updateBorrador(selectedBorrador.idx, 'proveedor_nombre', v)} />
                <FieldRow label="Nº Factura" value={selectedBorrador.numero_factura_proveedor} conf={selectedBorrador.confianza.numero_factura} onChange={(v) => updateBorrador(selectedBorrador.idx, 'numero_factura_proveedor', v)} />
                <FieldRow label="Fecha emisión" value={selectedBorrador.fecha_emision} conf={selectedBorrador.confianza.fecha} onChange={(v) => updateBorrador(selectedBorrador.idx, 'fecha_emision', v)} placeholder="dd/mm/aaaa" />
                <FieldRow label="Base imponible" value={String(selectedBorrador.base_imponible || '')} conf={selectedBorrador.confianza.base_imponible} onChange={(v) => updateBorrador(selectedBorrador.idx, 'base_imponible', parseFloat(v) || 0)} numeric />
                <FieldRow label="IVA" value={String(selectedBorrador.total_iva || '')} conf={selectedBorrador.confianza.total_iva} onChange={(v) => updateBorrador(selectedBorrador.idx, 'total_iva', parseFloat(v) || 0)} numeric />
                <FieldRow label="Total factura" value={String(selectedBorrador.total_factura || '')} conf={selectedBorrador.confianza.total} onChange={(v) => updateBorrador(selectedBorrador.idx, 'total_factura', parseFloat(v) || 0)} numeric />
                <FieldRow label="Observaciones" value={selectedBorrador.observaciones} onChange={(v) => updateBorrador(selectedBorrador.idx, 'observaciones', v)} placeholder="Notas adicionales…" />
              </View>
            </ScrollView>
          </View>

          {/* RIGHT: Preview */}
          <View style={styles.previewPane}>
            {selectedBorrador.archivo.previewUrl ? (
              selectedBorrador.archivo.tipo.includes('pdf') ? (
                Platform.OS === 'web' ? (
                  <iframe
                    src={selectedBorrador.archivo.previewUrl}
                    style={{ width: '100%', height: '100%', border: 'none' } as any}
                    title="Vista previa"
                  />
                ) : (
                  <View style={styles.previewFallbackWrap}>
                    <Text style={styles.previewFallback}>Vista previa no disponible en esta plataforma</Text>
                  </View>
                )
              ) : (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                  <img
                    src={selectedBorrador.archivo.previewUrl}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } as any}
                    alt="Vista previa"
                  />
                </View>
              )
            ) : (
              <View style={styles.previewFallbackWrap}>
                <Text style={styles.previewFallback}>Sin vista previa disponible</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {step === 'review' && !selectedBorrador && (
        <View style={styles.emptyDetail}>
          <MaterialIcons name="description" size={40} color="#cbd5e1" />
          <Text style={styles.emptyDetailText}>Selecciona un archivo para revisar</Text>
        </View>
      )}

      <Modal
        visible={modalEmpresaIdx !== null}
        transparent
        animationType="fade"
        onRequestClose={cerrarModalCrearEmpresa}
      >
        <KeyboardAvoidingView
          style={styles.modalKb}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalOverlay}>
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              activeOpacity={1}
              onPress={cerrarModalCrearEmpresa}
            />
            <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Nueva empresa</Text>
            <Text style={styles.modalSubtitle}>
              Se creará un registro en el maestro de empresas con el CIF detectado por OCR.
            </Text>
            <Text style={styles.modalCifLabel}>
              CIF: <Text style={styles.modalCifValue}>{borradorModalEmpresa?.proveedor_cif || '—'}</Text>
            </Text>
            <Text style={styles.modalFieldLabel}>Nombre fiscal *</Text>
            <TextInput
              style={styles.modalInput}
              value={nombreNuevaEmpresa}
              onChangeText={setNombreNuevaEmpresa}
              placeholder="Razón social"
              placeholderTextColor="#94a3b8"
              autoFocus={Platform.OS === 'web'}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnSecondary} onPress={cerrarModalCrearEmpresa}>
                <Text style={styles.modalBtnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnPrimary, creandoEmpresa && { opacity: 0.7 }]}
                onPress={crearEmpresaDesdeOcr}
                disabled={creandoEmpresa}
              >
                {creandoEmpresa ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>Guardar empresa</Text>
                )}
              </TouchableOpacity>
            </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {ToastView}
    </View>
  );
}

function FieldRow({ label, value, conf, onChange, numeric, placeholder }: {
  label: string;
  value: string;
  conf?: string;
  onChange: (v: string) => void;
  numeric?: boolean;
  placeholder?: string;
}) {
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldLabelWrap}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {conf && <View style={[styles.confDot, { backgroundColor: confColor(conf) }]} />}
      </View>
      <TextInput
        style={[styles.fieldInput, numeric && { textAlign: 'right' as const }]}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 14, color: '#dc2626' },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    flexWrap: 'wrap',
    gap: 8,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { padding: 4 },
  title: { fontSize: 15, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 10, color: '#64748b', marginTop: 1 },
  headerActions: { flexDirection: 'row', gap: 8, alignItems: 'center' },

  navBtns: { flexDirection: 'row', alignItems: 'center', gap: 2, marginRight: 4 },
  navArrow: { padding: 2 },
  navLabel: { fontSize: 11, fontWeight: '600', color: '#64748b', minWidth: 40, textAlign: 'center' },

  addMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    borderRadius: 6,
    backgroundColor: '#f0f9ff',
  },
  addMoreText: { fontSize: 11, color: '#0ea5e9', fontWeight: '500' },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#059669',
  },
  confirmBtnText: { color: '#fff', fontSize: 11, fontWeight: '600' },

  uploadArea: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    margin: 16,
    borderWidth: 2,
    borderColor: '#e2e8f0',
    borderStyle: 'dashed',
    borderRadius: 12,
    backgroundColor: '#fff',
    gap: 8,
  },
  uploadTitle: { fontSize: 14, fontWeight: '500', color: '#334155' },
  uploadHint: { fontSize: 12, color: '#94a3b8' },

  splitHorizontal: {
    flex: 1,
    flexDirection: 'row',
  },

  formPane: {
    width: 380,
    backgroundColor: '#fff',
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
  },

  previewPane: {
    flex: 1,
    backgroundColor: '#e2e8f0',
  },
  previewFallbackWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  previewFallback: { fontSize: 12, color: '#94a3b8', fontStyle: 'italic' },
  formScroll: {
    padding: 12,
    gap: 8,
  },

  fileInfoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    marginBottom: 2,
  },
  fileInfoName: { flex: 1, fontSize: 12, fontWeight: '600', color: '#334155' },
  discardBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca' },
  restoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0' },

  dupWarn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#fffbeb',
    borderRadius: 6,
    padding: 6,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  dupWarnText: { fontSize: 10, color: '#b45309', flex: 1 },

  maestroWarn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#fff7ed',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#fdba74',
    marginBottom: 6,
  },
  maestroWarnBody: { flex: 1, gap: 6 },
  maestroWarnTitle: { fontSize: 12, fontWeight: '700' as const, color: '#9a3412' },
  maestroWarnText: { fontSize: 10, color: '#7c2d12', lineHeight: 14 },
  maestroBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: '#ea580c',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    marginTop: 4,
  },
  maestroBtnText: { fontSize: 11, color: '#fff', fontWeight: '600' as const },
  maestroNoPerm: { fontSize: 10, color: '#9a3412', fontStyle: 'italic' as const, marginTop: 2 },

  modalKb: { flex: 1 },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    zIndex: 2,
  },
  modalTitle: { fontSize: 16, fontWeight: '700' as const, color: '#334155', marginBottom: 6 },
  modalSubtitle: { fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 16 },
  modalCifLabel: { fontSize: 12, color: '#64748b', marginBottom: 10 },
  modalCifValue: { fontWeight: '700' as const, color: '#0f172a' },
  modalFieldLabel: { fontSize: 11, color: '#64748b', marginBottom: 4, fontWeight: '500' as const },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#334155',
    marginBottom: 16,
    backgroundColor: '#f8fafc',
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  modalBtnSecondary: { paddingVertical: 8, paddingHorizontal: 12 },
  modalBtnSecondaryText: { fontSize: 13, color: '#64748b', fontWeight: '500' as const },
  modalBtnPrimary: {
    backgroundColor: '#059669',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    minWidth: 120,
    alignItems: 'center',
  },
  modalBtnPrimaryText: { fontSize: 13, color: '#fff', fontWeight: '600' as const },

  legendRow: { paddingVertical: 2 },
  legendText: { fontSize: 10, color: '#64748b', flexWrap: 'wrap' as const },
  metodoHint: { fontSize: 10, color: '#0ea5e9', fontWeight: '500' as const },

  formGrid: { gap: 6 },

  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 280 },
  fieldLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 3, width: 110 },
  fieldLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  confDot: { width: 7, height: 7, borderRadius: 4 },
  fieldInput: {
    flex: 1,
    fontSize: 12,
    color: '#334155',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#f8fafc',
  },

  emptyDetail: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    padding: 40,
  },
  emptyDetailText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
});
