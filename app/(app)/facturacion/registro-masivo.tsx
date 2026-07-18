import React, { useState, useCallback, useEffect, useMemo } from 'react';
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
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoneda, round2 } from '../../utils/facturacion';
import { useLocalToast, detectToastType } from '../../components/Toast';
import { apiFetch, errorMessage } from '../../utils/api';
import type {
  Borrador,
  CamposManuales,
  EmpresaCatalogo,
} from '../../types/registroMasivo';
import {
  derivarPctDesdeImportes,
  esDesgloseMulti,
  metodoExtraccionLabel,
  recalcImportesDesdePct,
} from '../../lib/registroMasivo';
import { fechaEmisionFacturaAIso } from '../../utils/formatFecha';
import { FieldRow } from '../../components/registroMasivo/FieldRow';
import { FieldRowZona } from '../../components/registroMasivo/FieldRowZona';
import { FieldRowZonaFecha } from '../../components/registroMasivo/FieldRowZonaFecha';
import { ProveedorDropdownField } from '../../components/registroMasivo/ProveedorDropdownField';
import { CrearEmpresaModal } from '../../components/registroMasivo/CrearEmpresaModal';
import { useCrearEmpresaModal } from '../../hooks/useCrearEmpresaModal';
import { EmpresaGrupoSelector } from '../../components/registroMasivo/EmpresaGrupoSelector';
import { useEmpresasGrupo } from '../../hooks/useEmpresasGrupo';
import { mergeReconciliacion } from '../../lib/registroMasivo';
import { useZonaOCR } from '../../hooks/useZonaOCR';
import { ZonaOCRPreview } from '../../components/registroMasivo/ZonaOCRPreview';
import { DesgloseFiscalEditor } from '../../components/registroMasivo/DesgloseFiscalEditor';
import { CampoIdDocumentoFacturaRecibida } from '../../components/CampoIdDocumentoFacturaRecibida';
import {
  RegistrarPagoModal,
  type RegistrarPagoInitial,
  type RegistrarPagoPayloadFactura,
} from '../../components/RegistrarPagoModal';
import { hoyISO } from '../../utils/facturaFormLogic';
import { mapTipoReciboToFormaPago } from '../../utils/facturacion';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

/** Estilos CSS para la zona de drop en web (RN View no reenvía onDrop al DOM). */
function uploadAreaWebStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    margin: 16,
    border: `2px dashed ${active ? '#0ea5e9' : '#e2e8f0'}`,
    borderRadius: 12,
    backgroundColor: active ? '#f0f9ff' : '#fff',
    gap: 8,
    minHeight: 220,
    boxSizing: 'border-box',
  };
}

function previewPaneWebStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    flexShrink: 1,
    minWidth: 260,
    backgroundColor: active ? '#dbeafe' : '#e2e8f0',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    boxSizing: 'border-box',
  };
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
  const [dragOverUpload, setDragOverUpload] = useState(false);

  const [empresasCatalogo, setEmpresasCatalogo] = useState<EmpresaCatalogo[]>([]);
  /** Si está activo y el API tiene OPENAI_API_KEY, se llama a /ocr/enriquecer-ia tras cada extracción. */
  const [usarEnriquecimientoIa, setUsarEnriquecimientoIa] = useState(true);
  const [modalPagoBorradorIdx, setModalPagoBorradorIdx] = useState<number | null>(null);

  const puedeRegistrarPago = hasPermiso('facturacion.cobrar_pagar');

  const selectedBorrador = selectedIdx !== null ? borradores.find((b) => b.idx === selectedIdx) : null;

  const empGrupo = useEmpresasGrupo({
    empresasCatalogo,
    selectedIdx,
    onSociedadAsignada: (idx, sociedad) => {
      setBorradores((prev) =>
        prev.map((b) =>
          b.idx === idx
            ? {
                ...b,
                sociedad_grupo_id: sociedad.id,
                sociedad_grupo_nombre: sociedad.nombre,
                sociedad_grupo_cif: sociedad.cif,
              }
            : b,
        ),
      );
    },
    onReconciliacion: (idx, datos) => {
      setBorradores((prev) =>
        prev.map((row) => (row.idx === idx ? mergeReconciliacion(row, datos) : row)),
      );
    },
    onError: (msg) => alertMsg('Reconciliación', msg),
  });

  const crearEmpresaModal = useCrearEmpresaModal({
    onCreated: (idx, emp, nombre) => {
      setBorradores((prev) =>
        prev.map((b) =>
          b.idx === idx
            ? {
                ...b,
                proveedor_nombre: emp?.Nombre != null ? String(emp.Nombre) : nombre,
                empresa_id: emp?.id_empresa != null ? String(emp.id_empresa) : '',
                proveedor_en_maestros: true,
                nombre_sugerido_ocr: '',
                confianza: { ...b.confianza, proveedor_nombre: 'alta' },
              }
            : b,
        ),
      );
    },
    onSuccess: (msg) => showToast('Empresa creada', msg, 'success'),
    onError: (msg) => alertMsg('Error', msg),
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/empresas');
        const data = await res.json();
        if (!cancelled && Array.isArray(data.empresas)) setEmpresasCatalogo(data.empresas);
      } catch {
        /* silencioso */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const checkDuplicados = async (borrador: Borrador) => {
    setBorradores((prev) =>
      prev.map((b) => b.idx === borrador.idx ? { ...b, checkingDup: true } : b)
    );
    try {
      const res = await apiFetch(`/api/facturacion/check-duplicados`, {
        method: 'POST',
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

  const procesarArchivosLista = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((f) =>
        /\.(pdf|jpe?g|png)$/i.test(f.name || '') ||
        /^(application\/pdf|image\/(jpeg|png))$/i.test(f.type || ''),
      );
      if (files.length === 0) {
        alertMsg('Info', 'Solo se aceptan PDF, JPG o PNG');
        return;
      }

      setProcesando(true);
      const nuevos: Borrador[] = [];
      const baseIdx = borradores.length;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const formData = new FormData();
          formData.append('file', file);
          const res = await apiFetch(`/api/facturacion/ocr/extraer`, {
            method: 'POST',
            body: formData,
            timeoutMs: 120_000,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Error OCR');

          let d = data.datos;
          if (usarEnriquecimientoIa) {
            try {
              const rIa = await apiFetch(`/api/facturacion/ocr/enriquecer-ia`, {
                method: 'POST',
                body: JSON.stringify({
                  datos: d,
                  texto_extraido: typeof d.texto_extraido === 'string' ? d.texto_extraido : '',
                }),
                timeoutMs: 60_000,
              });
              const j = await rIa.json();
              if (rIa.ok && j.ok && j.datos && !j.skipped) {
                d = j.datos;
              }
            } catch (iaErr) {
              console.warn('[Registro masivo] IA enriquecimiento:', iaErr);
            }
          }

          const extSnap = {
            ...(d.extraction_snapshot || {
              proveedor_cif: d.proveedor_cif || '',
              numero_factura_proveedor: d.numero_factura_proveedor || '',
              fecha_emision: d.fecha_emision || '',
              base_imponible: d.base_imponible ?? 0,
              total_iva: d.total_iva ?? 0,
              retencion: d.retencion ?? 0,
              total_factura: d.total_factura ?? 0,
              confianza: d.confianza || {},
              base_imponible_total: d.base_imponible_total ?? d.base_imponible ?? 0,
              recargo_equivalencia_total: d.recargo_equivalencia_total ?? 0,
            }),
            desglose_impuestos: [],
          };
          const base0 = d.base_imponible || 0;
          const iva0 = d.total_iva || 0;
          const ret0 = typeof d.retencion === 'number' ? d.retencion : 0;
          const pct0 = derivarPctDesdeImportes(base0, iva0, ret0, d);
          nuevos.push({
            idx: baseIdx + i,
            archivo: data.archivo,
            sociedad_grupo_id: '',
            sociedad_grupo_nombre: '',
            sociedad_grupo_cif: '',
            proveedor_cif: d.proveedor_cif || '',
            proveedor_provisional_cif: d.proveedor_cif || '',
            proveedor_nombre: d.proveedor_nombre || '',
            empresa_id: d.empresa_id || '',
            proveedor_en_maestros: Boolean(d.proveedor_en_maestros),
            nombre_sugerido_ocr: d.nombre_sugerido_ocr || '',
            numero_factura_proveedor: d.numero_factura_proveedor || '',
            fecha_emision: d.fecha_emision ? (fechaEmisionFacturaAIso(String(d.fecha_emision)) ?? '') : '',
            base_imponible: base0,
            base_imponible_total: typeof d.base_imponible_total === 'number' ? d.base_imponible_total : base0,
            tipo_iva_pct: pct0.tipo_iva_pct,
            retencion_pct: pct0.retencion_pct,
            total_iva: iva0,
            retencion: ret0,
            recargo_equivalencia_total: typeof d.recargo_equivalencia_total === 'number' ? d.recargo_equivalencia_total : 0,
            desglose_impuestos: [],
            total_factura: d.total_factura || 0,
            observaciones: '',
            confianza: d.confianza || {},
            campos_manuales: {},
            entidades_candidatas: Array.isArray(d.entidades_candidatas) ? d.entidades_candidatas : [],
            texto_extraido: typeof d.texto_extraido === 'string' ? d.texto_extraido : '',
            extraction_snapshot: extSnap,
            reconciliacion_warning: '',
            metodo_extraccion: d.metodo_extraccion,
            ocr_confianza_global: typeof d.ocr_confianza_global === 'number' ? d.ocr_confianza_global : undefined,
            ia_meta: d.ia_meta && typeof d.ia_meta === 'object' ? d.ia_meta : undefined,
            ocr_pipeline_meta:
              d.ocr_pipeline_meta && typeof d.ocr_pipeline_meta === 'object' ? d.ocr_pipeline_meta : undefined,
            descartado: false,
            duplicados: [],
            checkingDup: false,
          });
        } catch (e: unknown) {
          alertMsg('Error', `${file.name}: ${errorMessage(e)}`);
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
    },
    [alertMsg, borradores.length, usarEnriquecimientoIa],
  );

  const subirArchivos = useCallback(() => {
    if (Platform.OS !== 'web') {
      alertMsg('Info', 'Solo disponible en versión web');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.png';
    input.multiple = true;
    input.onchange = () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      void procesarArchivosLista(files);
    };
    input.click();
  }, [alertMsg, procesarArchivosLista]);

  /** Handlers nativos de drag & drop (solo web; View de RNW no los reenvía al DOM). */
  const fileDropHandlers = useMemo(() => {
    if (Platform.OS !== 'web') return {};
    return {
      onDragEnter: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOverUpload(true);
      },
      onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setDragOverUpload(true);
      },
      onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const related = e.relatedTarget as Node | null;
        if (!related || !e.currentTarget.contains(related)) {
          setDragOverUpload(false);
        }
      },
      onDrop: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOverUpload(false);
        if (procesando) return;
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) void procesarArchivosLista(files);
      },
    };
  }, [procesando, procesarArchivosLista]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const allowFileDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', allowFileDrop);
    return () => window.removeEventListener('dragover', allowFileDrop);
  }, []);

  /** Actualización desde API/OCR/reconciliación (no marca campos manuales). */
  const patchBorrador = (idx: number, patch: Partial<Borrador>) => {
    setBorradores((prev) =>
      prev.map((b) => (b.idx === idx ? { ...b, ...patch } : b)),
    );
  };

  /** Edición explícita del usuario en formulario (importes coherentes con % IVA y % retención sobre la base). */
  const usuarioEditaCampo = (idx: number, field: keyof CamposManuales, value: unknown) => {
    setBorradores((prev) =>
      prev.map((b) => {
        if (b.idx !== idx) return b;
        const campos_manuales = { ...b.campos_manuales, [field]: true } as CamposManuales;
        let next: Borrador = { ...b, [field]: value, campos_manuales } as Borrador;

        if (field === 'tipo_iva_pct' || field === 'retencion_pct' || field === 'base_imponible') {
          next = recalcImportesDesdePct(next);
        } else if (field === 'total_iva') {
          const base = round2(Number(next.base_imponible) || 0);
          const ti = round2(Number(value) || 0);
          const pct = base > 0 ? round2((100 * ti) / base) : next.tipo_iva_pct;
          const ret = round2(Number(next.retencion) || 0);
          next = { ...next, total_iva: ti, tipo_iva_pct: pct, total_factura: round2(base + ti - ret) };
        } else if (field === 'retencion') {
          const base = round2(Number(next.base_imponible) || 0);
          const ret = round2(Number(value) || 0);
          const pct = base > 0 ? round2((100 * ret) / base) : next.retencion_pct;
          const iva = round2(Number(next.total_iva) || 0);
          next = { ...next, retencion: ret, retencion_pct: pct, total_factura: round2(base + iva - ret) };
        } else if (field === 'total_factura') {
          next = { ...next, total_factura: round2(Number(value) || 0) };
        }
        return next;
      }),
    );
  };

  const lookupCifEnMaestro = useCallback(
    (idx: number, cifOverride?: string) => {
      const cifRaw = cifOverride ?? borradores.find((b) => b.idx === idx)?.proveedor_cif;
      if (!cifRaw) return;
      const cifNorm = cifRaw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (cifNorm.length < 6) return;
      const match = empresasCatalogo.find((e) => {
        const ec = (e.Cif || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        return ec && ec === cifNorm;
      });
      if (match) {
        setBorradores((prev) =>
          prev.map((b) =>
            b.idx === idx
              ? {
                  ...b,
                  proveedor_nombre: String(match.Nombre || '').trim(),
                  empresa_id: match.id_empresa != null ? String(match.id_empresa) : '',
                  proveedor_en_maestros: true,
                  nombre_sugerido_ocr: '',
                  confianza: {
                    ...b.confianza,
                    proveedor_nombre: 'alta',
                    proveedor_cif: 'alta',
                  },
                }
              : b,
          ),
        );
      }
    },
    [borradores, empresasCatalogo],
  );

  /** Campos numéricos cuyo recálculo IVA/retención lo dispara `usuarioEditaCampo`. */
  const IMPORTES_KEYS: (keyof CamposManuales)[] = [
    'tipo_iva_pct',
    'retencion_pct',
    'base_imponible',
    'total_iva',
    'retencion',
    'total_factura',
  ];

  const zona = useZonaOCR({
    selectedBorrador: selectedBorrador ?? null,
    apiUrl: API_URL,
    onCampoExtraido: (field, value, isNumeric) => {
      if (!selectedBorrador) return;
      if (isNumeric && IMPORTES_KEYS.includes(field as keyof CamposManuales)) {
        usuarioEditaCampo(selectedBorrador.idx, field as keyof CamposManuales, value);
      } else {
        patchBorrador(selectedBorrador.idx, { [field]: value } as Partial<Borrador>);
      }
      if (field === 'proveedor_cif' && typeof value === 'string') {
        setTimeout(() => lookupCifEnMaestro(selectedBorrador.idx, value), 100);
      }
    },
    onMessage: (titulo, msg) => alertMsg(titulo, msg),
    onError: (msg) => alertMsg('Error OCR zona', msg),
  });

  const confirmar = async () => {
    const activos = borradores.filter((b) => !b.descartado);
    if (activos.length === 0) {
      alertMsg('Info', 'No hay borradores activos para confirmar');
      return;
    }
    const sinSociedad = activos.find((b) => !String(b.sociedad_grupo_id || '').trim());
    if (sinSociedad) {
      alertMsg(
        'Falta empresa',
        'Selecciona la sociedad del grupo (GRUPO PARIPE) en todos los borradores activos.',
      );
      return;
    }
    const pagoSinDatos = activos.find((b) => b.pago_al_confirmar && !b.pago_datos);
    if (pagoSinDatos) {
      alertMsg(
        'Falta pago',
        `Indica los datos de pago del borrador «${pagoSinDatos.archivo?.nombre || pagoSinDatos.numero_factura_proveedor || 'sin nombre'}».`,
      );
      return;
    }
    const conPago = activos.filter((b) => b.pago_al_confirmar && b.pago_datos);
    if (conPago.length > 0 && !puedeRegistrarPago) {
      alertMsg('Sin permiso', 'No tienes permiso para registrar pagos al confirmar.');
      return;
    }
    setGuardando(true);
    try {
      const res = await apiFetch(`/api/facturacion/ocr/confirmar`, {
        method: 'POST',
        body: JSON.stringify({
          borradores: activos.map((b) => ({
            ...b,
            serie: '',
            forma_pago: b.pago_datos?.metodo_pago || '',
            condiciones_pago: b.pago_al_confirmar ? 'contado' : '',
            observaciones: String(b.observaciones ?? '').trim(),
            archivo: b.archivo
              ? {
                  fileKey: b.archivo.fileKey,
                  nombre: b.archivo.nombre,
                  tipo: b.archivo.tipo,
                  size: b.archivo.size,
                }
              : undefined,
          })),
          usuario_id: user?.id_usuario,
          usuario_nombre: user?.Nombre,
        }),
        timeoutMs: 120_000,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Error');

      const ids: string[] = Array.isArray(data.ids) ? data.ids : [];
      let pagadasOk = 0;
      let pagadasFallidas = 0;

      for (let i = 0; i < activos.length; i += 1) {
        const b = activos[i];
        const idFactura = ids[i];
        if (!b.pago_al_confirmar || !b.pago_datos || !idFactura) continue;

        const valRes = await apiFetch('/api/facturacion/facturas/validar-revision', {
          method: 'POST',
          body: JSON.stringify({
            facturaIds: [idFactura],
            usuario_id: user?.id_usuario ?? '',
            usuario_nombre: user?.Nombre ?? '',
          }),
        });
        const valData = await valRes.json();
        if (!valRes.ok || valData.fallidas > 0) {
          pagadasFallidas += 1;
          continue;
        }

        const pago = b.pago_datos;
        const pagRes = await apiFetch(`/api/facturacion/facturas/${idFactura}/pagos`, {
          method: 'POST',
          body: JSON.stringify({
            fecha: pago.fecha,
            importe: pago.importe,
            metodo_pago: pago.metodo_pago,
            referencia: pago.referencia,
            observaciones: pago.observaciones,
            usuario_id: user?.id_usuario ?? '',
            usuario_nombre: user?.Nombre ?? '',
          }),
        });
        if (!pagRes.ok) {
          pagadasFallidas += 1;
        } else {
          pagadasOk += 1;
        }
      }

      const pendientesRevision = activos.length - conPago.length;
      if (conPago.length === 0) {
        alertMsg('Creados', `${data.creados} factura(s) importada(s). Revísalas y pulsa «Validar revisión» en Facturas recibidas.`);
      } else if (pagadasFallidas === 0) {
        alertMsg(
          'Registro completado',
          `${data.creados} factura(s) creada(s): ${pagadasOk} pagada(s) al registrar${pendientesRevision > 0 ? `, ${pendientesRevision} pendiente(s) de revisión` : ''}.`,
        );
      } else {
        showToast(
          'Registro parcial',
          `${data.creados} creada(s). ${pagadasOk} pagada(s), ${pagadasFallidas} con error al validar/pagar. Revisa en Facturas recibidas.`,
          'warning',
        );
      }
      router.push('/facturacion/facturas-gasto' as any);
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setGuardando(false);
    }
  };

  const borradorParaModalPago = modalPagoBorradorIdx != null
    ? borradores.find((b) => b.idx === modalPagoBorradorIdx) ?? null
    : null;

  const pagoInitialBorrador = useMemo((): RegistrarPagoInitial | undefined => {
    if (!borradorParaModalPago) return undefined;
    const b = borradorParaModalPago;
    if (b.pago_datos) {
      const { clave, otroTexto } = mapTipoReciboToFormaPago(b.pago_datos.metodo_pago);
      return {
        fecha: b.pago_datos.fecha,
        importe: String(b.pago_datos.importe),
        metodo: clave,
        metodoOtro: clave === 'otro' ? otroTexto || b.pago_datos.metodo_pago : '',
        referencia: b.pago_datos.referencia,
        observaciones: b.pago_datos.observaciones,
      };
    }
    const hoy = hoyISO();
    const fechaFactura = fechaEmisionFacturaAIso(b.fecha_emision ?? '') ?? hoy;
    return {
      fecha: fechaFactura,
      importe: String(b.total_factura || 0),
      metodo: 'tarjeta',
      referencia: '',
      observaciones: '',
    };
  }, [borradorParaModalPago]);

  const togglePagoAlConfirmar = (idx: number, activo: boolean) => {
    if (activo && !puedeRegistrarPago) {
      alertMsg('Sin permiso', 'No tienes permiso para registrar pagos.');
      return;
    }
    setBorradores((prev) =>
      prev.map((b) =>
        b.idx === idx
          ? {
              ...b,
              pago_al_confirmar: activo,
              pago_datos: activo ? b.pago_datos : undefined,
            }
          : b,
      ),
    );
    if (activo) setModalPagoBorradorIdx(idx);
  };

  const guardarPagoBorrador = (idx: number, payload: RegistrarPagoPayloadFactura) => {
    setBorradores((prev) =>
      prev.map((b) =>
        b.idx === idx
          ? {
              ...b,
              pago_al_confirmar: true,
              pago_datos: {
                fecha: payload.fecha,
                importe: payload.importe,
                metodo_pago: payload.metodo_pago,
                referencia: payload.referencia,
                observaciones: payload.observaciones,
              },
            }
          : b,
      ),
    );
    setModalPagoBorradorIdx(null);
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
            <View style={styles.iaToggleRow}>
              <Text style={styles.iaToggleLabel}>Validación IA</Text>
              <Switch
                value={usarEnriquecimientoIa}
                onValueChange={setUsarEnriquecimientoIa}
                trackColor={{ false: '#cbd5e1', true: '#bae6fd' }}
                thumbColor={usarEnriquecimientoIa ? '#0ea5e9' : '#f4f4f5'}
              />
              <Text style={styles.iaToggleHint}>Requiere OPENAI_API_KEY en el API</Text>
            </View>
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
        Platform.OS === 'web' ? (
          <div {...fileDropHandlers} style={uploadAreaWebStyle(dragOverUpload)}>
            {procesando ? (
              <ActivityIndicator size="large" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="cloud-upload" size={48} color={dragOverUpload ? '#0ea5e9' : '#94a3b8'} />
            )}
            <Text style={styles.uploadTitle}>
              {procesando
                ? 'Procesando archivos…'
                : dragOverUpload
                  ? 'Suelta aquí para procesar'
                  : 'Arrastra archivos o pulsa el botón superior'}
            </Text>
            <Text style={styles.uploadHint}>PDF, JPG, PNG — máximo 20 MB por archivo</Text>
          </div>
        ) : (
          <View style={[styles.uploadArea, dragOverUpload && styles.uploadAreaActive]}>
            {procesando ? (
              <ActivityIndicator size="large" color="#0ea5e9" />
            ) : (
              <MaterialIcons name="cloud-upload" size={48} color={dragOverUpload ? '#0ea5e9' : '#94a3b8'} />
            )}
            <Text style={styles.uploadTitle}>
              {procesando
                ? 'Procesando archivos…'
                : 'Arrastra archivos o pulsa el botón superior'}
            </Text>
            <Text style={styles.uploadHint}>PDF, JPG, PNG — máximo 20 MB por archivo</Text>
          </View>
        )
      )}

      {step === 'review' && selectedBorrador && (
        <View style={styles.splitHorizontal}>
          {/* LEFT: Editable form — ancho ~45–50% ventana (mín. 400, máx. 620) para desglose en una línea */}
          <View
            style={[
              styles.formPane,
              { width: Math.min(620, Math.max(400, Math.round(width * 0.48))) },
            ]}
          >
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
                  <TouchableOpacity style={styles.restoreBtn} onPress={() => patchBorrador(selectedBorrador.idx, { descartado: false })}>
                    <MaterialIcons name="undo" size={14} color="#059669" />
                    <Text style={{ fontSize: 11, color: '#059669', fontWeight: '500' }}>Restaurar</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={styles.discardBtn} onPress={() => patchBorrador(selectedBorrador.idx, { descartado: true })}>
                    <MaterialIcons name="close" size={14} color="#dc2626" />
                    <Text style={{ fontSize: 11, color: '#dc2626', fontWeight: '500' }}>Descartar</Text>
                  </TouchableOpacity>
                )}
              </View>

              {selectedBorrador.ocr_pipeline_meta ? (
                <View
                  style={[
                    styles.pipelineBanner,
                    selectedBorrador.ocr_pipeline_meta.revision_obligatoria && styles.pipelineBannerWarn,
                  ]}
                >
                  <View style={styles.pipelineRow}>
                    <MaterialIcons
                      name={selectedBorrador.ocr_pipeline_meta.importes_coherentes ? 'check-circle' : 'error-outline'}
                      size={16}
                      color={selectedBorrador.ocr_pipeline_meta.importes_coherentes ? '#059669' : '#b45309'}
                    />
                    <Text style={styles.pipelineTitle}>
                      {selectedBorrador.ocr_pipeline_meta.importes_coherentes
                        ? selectedBorrador.ocr_pipeline_meta.tiene_desglose_multiple
                          ? 'Importes cuadran (desglose múltiple: bases + IVA + R.E. − retención ≈ total)'
                          : 'Importes cuadran (base + IVA − retención ≈ total)'
                        : 'Importes incoherentes — revisión obligatoria'}
                    </Text>
                  </View>
                  {selectedBorrador.ocr_pipeline_meta.diferencia_importes != null &&
                  !selectedBorrador.ocr_pipeline_meta.importes_coherentes ? (
                    <Text style={styles.pipelineDetail}>
                      Diferencia: {selectedBorrador.ocr_pipeline_meta.diferencia_importes.toFixed(2)} €
                      {selectedBorrador.ocr_pipeline_meta.formula_usada
                        ? ` · ${selectedBorrador.ocr_pipeline_meta.formula_usada}`
                        : ''}
                    </Text>
                  ) : null}
                  {selectedBorrador.ocr_pipeline_meta.numero_factura_fue_normalizado ? (
                    <Text style={styles.pipelineDetail}>Nº factura normalizado (se eliminaron datos colindantes)</Text>
                  ) : null}
                  {selectedBorrador.ocr_pipeline_meta.retencion_sospechosa ? (
                    <Text style={styles.pipelineDetail}>
                      Retención: posible confusión con IVA — comprobar en el PDF
                    </Text>
                  ) : null}
                  {selectedBorrador.ocr_pipeline_meta.motivos_revision &&
                  selectedBorrador.ocr_pipeline_meta.motivos_revision.length > 0 ? (
                    <Text style={styles.pipelineMotivos}>
                      {selectedBorrador.ocr_pipeline_meta.motivos_revision.join(' · ')}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {selectedBorrador.ia_meta?.aplicada ? (
                <View style={styles.iaBanner}>
                  <View style={styles.iaBadge}>
                    <MaterialIcons name="auto-awesome" size={12} color="#0369a1" />
                    <Text style={styles.iaBadgeText}>IA aplicada</Text>
                  </View>
                  {selectedBorrador.ia_meta.tipo_documento ? (
                    <Text style={styles.iaTipoDoc}>{selectedBorrador.ia_meta.tipo_documento}</Text>
                  ) : null}
                  {selectedBorrador.ia_meta.revision_obligatoria || selectedBorrador.ia_meta.revision_sugerida ? (
                    <Text style={styles.iaRevision}>
                      {selectedBorrador.ia_meta.revision_obligatoria ? 'Revisión obligatoria: ' : 'Revisar: '}
                      {selectedBorrador.ia_meta.motivos?.length
                        ? selectedBorrador.ia_meta.motivos.join(' · ')
                        : 'incoherencias o baja confianza en algún campo'}
                    </Text>
                  ) : (
                    <Text style={styles.iaOk}>Modelo sin incidencias obligatorias</Text>
                  )}
                </View>
              ) : null}

              <EmpresaGrupoSelector
                empGrupo={empGrupo}
                borrador={selectedBorrador}
                onSeleccionar={(e) => empGrupo.seleccionar(selectedBorrador.idx, e, selectedBorrador)}
                onLimpiarAsignada={() =>
                  setBorradores((prev) =>
                    prev.map((b) =>
                      b.idx === selectedBorrador.idx
                        ? { ...b, sociedad_grupo_id: '', sociedad_grupo_nombre: '', sociedad_grupo_cif: '' }
                        : b,
                    ),
                  )
                }
              />

              {selectedBorrador.duplicados.length > 0 && (
                <View style={styles.dupWarn}>
                  <MaterialIcons name="warning" size={14} color="#dc2626" />
                  <Text style={styles.dupWarnText}>
                    Posible(s) duplicado(s): {selectedBorrador.duplicados.map((d) => d.empresa_nombre || d.id_factura).join(', ')}
                  </Text>
                </View>
              )}

              {!!selectedBorrador.reconciliacion_warning?.trim() && (
                <View style={styles.reconWarn}>
                  <MaterialIcons name="info-outline" size={14} color="#0369a1" />
                  <Text style={styles.reconWarnText}>{selectedBorrador.reconciliacion_warning}</Text>
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
                        onPress={() => crearEmpresaModal.abrir(selectedBorrador)}
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

              {zona.activa && (
                <View style={styles.zonaActivaBanner}>
                  <MaterialIcons name="crop-free" size={14} color="#0369a1" />
                  <Text style={styles.zonaActivaText}>
                    Dibuja un rectángulo sobre el documento para capturar «{zona.activa.field}»
                  </Text>
                  <TouchableOpacity onPress={zona.cancelar} style={styles.zonaActivaCancelBtn}>
                    <Text style={styles.zonaActivaCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={styles.formGrid}>
                <FieldRowZona label="CIF Proveedor" value={selectedBorrador.proveedor_cif} conf={selectedBorrador.confianza.proveedor_cif} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'proveedor_cif', v)} onBlur={() => lookupCifEnMaestro(selectedBorrador.idx)} onZona={() => zona.activar('proveedor_cif')} zonaActiva={zona.activa?.field === 'proveedor_cif'} />
                <ProveedorDropdownField
                  borrador={selectedBorrador}
                  empresas={empresasCatalogo}
                  onSelect={(emp) => {
                    setBorradores((prev) =>
                      prev.map((b) =>
                        b.idx === selectedBorrador.idx
                          ? {
                              ...b,
                              proveedor_nombre: String(emp.Nombre || '').trim(),
                              proveedor_cif: String(emp.Cif || '').trim(),
                              empresa_id: emp.id_empresa != null ? String(emp.id_empresa) : '',
                              proveedor_en_maestros: true,
                              nombre_sugerido_ocr: '',
                              campos_manuales: { ...b.campos_manuales, proveedor_nombre: true, proveedor_cif: true },
                              confianza: { ...b.confianza, proveedor_nombre: 'alta', proveedor_cif: 'alta' },
                            }
                          : b,
                      ),
                    );
                  }}
                  onManualChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'proveedor_nombre', v)}
                  onZona={() => zona.activar('proveedor_nombre')}
                  zonaActiva={zona.activa?.field === 'proveedor_nombre'}
                />
                <FieldRowZona label="Nº Factura" value={selectedBorrador.numero_factura_proveedor} conf={selectedBorrador.confianza.numero_factura} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'numero_factura_proveedor', v)} onZona={() => zona.activar('numero_factura_proveedor')} zonaActiva={zona.activa?.field === 'numero_factura_proveedor'} />
                <FieldRowZonaFecha
                  label="Fecha emisión"
                  valueIso={selectedBorrador.fecha_emision}
                  conf={selectedBorrador.confianza.fecha}
                  onChangeIso={(v) => usuarioEditaCampo(selectedBorrador.idx, 'fecha_emision', v)}
                  onZona={() => zona.activar('fecha_emision')}
                  zonaActiva={zona.activa?.field === 'fecha_emision'}
                />
                <CampoIdDocumentoFacturaRecibida
                  empresaNombre={selectedBorrador.sociedad_grupo_nombre}
                  fechaEmision={selectedBorrador.fecha_emision}
                  numeroFacturaProveedor={selectedBorrador.numero_factura_proveedor}
                />
              </View>

              <DesgloseFiscalEditor
                lineas={selectedBorrador.desglose_impuestos ?? []}
                onChange={(lineas, totales) => {
                  setBorradores((prev) =>
                    prev.map((b) =>
                      b.idx === selectedBorrador.idx
                        ? { ...b, desglose_impuestos: lineas, ...totales }
                        : b,
                    ),
                  );
                }}
              />

              <View style={styles.formGrid}>
                <View style={styles.fieldRow}>
                  <View style={styles.fieldLabelWrap}>
                    <Text style={styles.fieldLabel}>Total factura</Text>
                  </View>
                  <Text style={styles.totalFacturaReadonly}>{formatMoneda(selectedBorrador.total_factura || 0)}</Text>
                </View>
                <FieldRow label="Observaciones" value={selectedBorrador.observaciones} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'observaciones', v)} placeholder="Notas adicionales…" />
              </View>

              {puedeRegistrarPago ? (
                <View style={styles.pagoIntegradoBlock}>
                  <View style={styles.pagoIntegradoHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pagoIntegradoTitle}>Ya está pagada</Text>
                      <Text style={styles.pagoIntegradoHint}>
                        Registra el pago al confirmar (tarjeta, efectivo…) y la factura quedará pagada.
                      </Text>
                    </View>
                    <Switch
                      value={!!selectedBorrador.pago_al_confirmar}
                      onValueChange={(v) => togglePagoAlConfirmar(selectedBorrador.idx, v)}
                      trackColor={{ false: '#cbd5e1', true: '#86efac' }}
                      thumbColor={selectedBorrador.pago_al_confirmar ? '#16a34a' : '#fff'}
                    />
                  </View>
                  {selectedBorrador.pago_al_confirmar ? (
                    <View style={styles.pagoIntegradoResumen}>
                      {selectedBorrador.pago_datos ? (
                        <Text style={styles.pagoIntegradoResumenText}>
                          {selectedBorrador.pago_datos.metodo_pago}
                          {' · '}{formatMoneda(selectedBorrador.pago_datos.importe)}
                          {' · '}{selectedBorrador.pago_datos.fecha}
                        </Text>
                      ) : (
                        <Text style={styles.pagoIntegradoResumenPending}>Completa los datos de pago</Text>
                      )}
                      <TouchableOpacity
                        style={styles.pagoIntegradoBtn}
                        onPress={() => setModalPagoBorradorIdx(selectedBorrador.idx)}
                      >
                        <MaterialIcons name="payments" size={16} color="#0369a1" />
                        <Text style={styles.pagoIntegradoBtnText}>
                          {selectedBorrador.pago_datos ? 'Editar pago' : 'Registrar pago'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </ScrollView>
          </View>

          {/* RIGHT: Preview con selección de zona (PDF → PNG vía API; coordenadas sobre capa = misma referencia que extraer-zona) */}
          {Platform.OS === 'web' ? (
            <div {...fileDropHandlers} style={previewPaneWebStyle(dragOverUpload)}>
              {dragOverUpload && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(14, 165, 233, 0.12)',
                    border: '2px dashed #0ea5e9',
                    borderRadius: 8,
                    margin: 8,
                    pointerEvents: 'none',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#0369a1' }}>
                    Suelta para añadir más archivos
                  </span>
                </div>
              )}
              <View style={styles.previewPaneInner}>
                <ZonaOCRPreview
                  borrador={selectedBorrador}
                  zona={zona}
                  onPreviewLoadError={(msg) => alertMsg('Vista previa', msg)}
                />
              </View>
            </div>
          ) : (
            <View style={styles.previewPane}>
              <ZonaOCRPreview
                borrador={selectedBorrador}
                zona={zona}
                onPreviewLoadError={(msg) => alertMsg('Vista previa', msg)}
              />
            </View>
          )}
        </View>
      )}

      {step === 'review' && !selectedBorrador && (
        <View style={styles.emptyDetail}>
          <MaterialIcons name="description" size={40} color="#cbd5e1" />
          <Text style={styles.emptyDetailText}>Selecciona un archivo para revisar</Text>
        </View>
      )}

      <CrearEmpresaModal modal={crearEmpresaModal} />

      <RegistrarPagoModal
        visible={modalPagoBorradorIdx != null && borradorParaModalPago != null}
        modo="factura"
        variant="pago"
        initial={pagoInitialBorrador}
        fechaReferenciaTarjeta={borradorParaModalPago ? fechaEmisionFacturaAIso(borradorParaModalPago.fecha_emision ?? '') ?? undefined : undefined}
        submitting={false}
        onClose={() => setModalPagoBorradorIdx(null)}
        onValidationError={alertMsg}
        onSubmit={(payload) => {
          if (modalPagoBorradorIdx == null) return;
          guardarPagoBorrador(modalPagoBorradorIdx, payload);
        }}
      />

      {ToastView}
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
  iaToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  iaToggleLabel: { fontSize: 11, fontWeight: '600', color: '#475569' },
  iaToggleHint: { fontSize: 9, color: '#94a3b8', flexShrink: 1 },
  iaBanner: {
    backgroundColor: '#f0f9ff',
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    gap: 6,
  },
  iaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    backgroundColor: '#e0f2fe',
    borderWidth: 1,
    borderColor: '#7dd3fc',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  iaBadgeText: { fontSize: 10, fontWeight: '800', color: '#0369a1' },
  iaTipoDoc: { fontSize: 10, color: '#64748b', textTransform: 'capitalize' as const },
  iaRevision: { fontSize: 10, color: '#b45309', lineHeight: 14 },
  iaOk: { fontSize: 10, color: '#059669' },
  pipelineBanner: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    gap: 6,
  },
  pipelineBannerWarn: {
    backgroundColor: '#fffbeb',
    borderColor: '#fcd34d',
  },
  pipelineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pipelineTitle: { fontSize: 12, fontWeight: '700', color: '#14532d', flex: 1 },
  pipelineDetail: { fontSize: 10, color: '#64748b', lineHeight: 14 },
  pipelineMotivos: { fontSize: 10, color: '#92400e', lineHeight: 14 },
  totalFacturaReadonly: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 14,
    color: '#0f172a',
    backgroundColor: '#f1f5f9',
    textAlign: 'right' as const,
    fontWeight: '700',
  },
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

  pagoIntegradoBlock: {
    marginTop: 8,
    marginBottom: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#bae6fd',
    borderRadius: 8,
    backgroundColor: '#f0f9ff',
    gap: 8,
  },
  pagoIntegradoHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pagoIntegradoTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  pagoIntegradoHint: { fontSize: 11, color: '#64748b', marginTop: 2, lineHeight: 15 },
  pagoIntegradoResumen: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  pagoIntegradoResumenText: { flex: 1, fontSize: 12, color: '#0369a1', fontWeight: '600', minWidth: 140 },
  pagoIntegradoResumenPending: { flex: 1, fontSize: 12, color: '#b45309', fontStyle: 'italic' },
  pagoIntegradoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#7dd3fc',
    backgroundColor: '#fff',
  },
  pagoIntegradoBtnText: { fontSize: 12, fontWeight: '600', color: '#0369a1' },

  uploadArea: {
    flex: 1,
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
    minHeight: 220,
  },
  uploadAreaActive: {
    borderColor: '#0ea5e9',
    backgroundColor: '#f0f9ff',
  },
  uploadTitle: { fontSize: 14, fontWeight: '500', color: '#334155' },
  uploadHint: { fontSize: 12, color: '#94a3b8' },

  splitHorizontal: {
    flex: 1,
    flexDirection: 'row',
  },

  formPane: {
    flexShrink: 0,
    backgroundColor: '#fff',
    borderRightWidth: 1,
    borderRightColor: '#e2e8f0',
    overflow: 'visible' as const,
    zIndex: 1,
  },

  previewPane: {
    flex: 1,
    flexShrink: 1,
    minWidth: 260,
    backgroundColor: '#e2e8f0',
  },
  previewPaneInner: {
    flex: 1,
    minWidth: 260,
    backgroundColor: '#e2e8f0',
  },
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
    backgroundColor: '#fef2f2',
    borderRadius: 6,
    padding: 6,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  dupWarnText: { fontSize: 10, color: '#b91c1c', flex: 1 },

  reconWarn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 5,
    backgroundColor: '#f0f9ff',
    borderRadius: 6,
    padding: 6,
    borderWidth: 1,
    borderColor: '#bae6fd',
    marginBottom: 4,
  },
  reconWarnText: { fontSize: 10, color: '#0c4a6e', flex: 1, lineHeight: 14 },

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

  legendRow: { paddingVertical: 2 },
  legendText: { fontSize: 10, color: '#64748b', flexWrap: 'wrap' as const },
  metodoHint: { fontSize: 10, color: '#0ea5e9', fontWeight: '500' as const },

  formGrid: { gap: 6, zIndex: 1 },

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

  zonaBtn: {
    width: 26,
    height: 26,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#0ea5e9',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f0f9ff',
  },
  zonaBtnActive: {
    backgroundColor: '#0ea5e9',
    borderColor: '#0369a1',
  },
  zonaActivaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#e0f2fe',
    borderRadius: 6,
    padding: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#7dd3fc',
  },
  zonaActivaText: { flex: 1, fontSize: 10, color: '#0369a1', fontWeight: '500' },
  zonaActivaCancelBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: '#bae6fd' },
  zonaActivaCancelText: { fontSize: 10, color: '#0369a1', fontWeight: '600' },

  emptyDetail: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    padding: 40,
  },
  emptyDetailText: { fontSize: 13, color: '#94a3b8', textAlign: 'center' },
});
