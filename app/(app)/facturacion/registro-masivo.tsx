import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { formatMoneda, round2 } from '../../utils/facturacion';
import { useLocalToast, detectToastType } from '../../components/Toast';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Confianza = Record<string, string>;

type EntidadCandidata = {
  id: string;
  cif: string;
  nombre_candidato?: string;
  direccion_candidata?: string;
  contexto?: string;
  score_emisor?: number;
  score_receptor?: number;
  rol_provisional?: string;
};

type EmpresaCatalogo = {
  id_empresa?: string;
  Nombre?: string;
  Cif?: string;
  Sede?: string;
};

type CamposManuales = Partial<Record<
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

type Borrador = {
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
  /** % tipo IVA sobre base imponible */
  tipo_iva_pct: number;
  /** % retención IRPF sobre base imponible */
  retencion_pct: number;
  total_iva: number;
  retencion: number;
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

function derivarPctDesdeImportes(base: number, total_iva: number, retencion: number) {
  if (base <= 0) return { tipo_iva_pct: 21, retencion_pct: 0 };
  return {
    tipo_iva_pct: round2((100 * total_iva) / base),
    retencion_pct: round2((100 * retencion) / base),
  };
}

function recalcImportesDesdePct(b: Borrador): Borrador {
  const base = round2(Number(b.base_imponible) || 0);
  const pctIva = Number(b.tipo_iva_pct) || 0;
  const pctRet = Number(b.retencion_pct) || 0;
  const total_iva = round2((base * pctIva) / 100);
  const retencion = round2((base * pctRet) / 100);
  const total_factura = round2(base + total_iva - retencion);
  return { ...b, base_imponible: base, total_iva, retencion, total_factura };
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

  const [empresasCatalogo, setEmpresasCatalogo] = useState<EmpresaCatalogo[]>([]);
  const [sociedadSearch, setSociedadSearch] = useState('');
  const [showSociedadDropdown, setShowSociedadDropdown] = useState(false);

  const selectedBorrador = selectedIdx !== null ? borradores.find((b) => b.idx === selectedIdx) : null;
  const borradorModalEmpresa = modalEmpresaIdx !== null ? borradores.find((b) => b.idx === modalEmpresaIdx) : null;

  // ── Selección de zona (tipo a3) ──
  type ZonaTarget = { field: string; numeric?: boolean } | null;
  const [zonaActiva, setZonaActiva] = useState<ZonaTarget>(null);
  const [zonaRect, setZonaRect] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const [zonaExtracting, setZonaExtracting] = useState(false);
  const [zonaPreviewLoaded, setZonaPreviewLoaded] = useState(false);
  const zonaRectRef = useRef<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const zonaDraggingRef = useRef(false);

  /** En modo zona: PDF → PNG rasterizado por API (no se puede usar <img> con URL de PDF). Imagen → URL firmada. */
  const zonaImgSrc = useMemo(() => {
    if (!zonaActiva || !selectedBorrador?.archivo?.previewUrl) return null;
    if (selectedBorrador.archivo.tipo.includes('pdf')) {
      return `${API_URL}/api/facturacion/ocr/preview-png?fileKey=${encodeURIComponent(selectedBorrador.archivo.fileKey)}`;
    }
    return selectedBorrador.archivo.previewUrl;
  }, [zonaActiva, selectedBorrador?.archivo?.fileKey, selectedBorrador?.archivo?.previewUrl, selectedBorrador?.archivo?.tipo]);

  useEffect(() => {
    if (!zonaActiva) {
      setZonaPreviewLoaded(false);
      return;
    }
    setZonaPreviewLoaded(false);
  }, [zonaActiva, zonaImgSrc]);

  const activarZona = (field: string, numeric?: boolean) => {
    setZonaActiva({ field, numeric });
    setZonaRect(null);
    zonaRectRef.current = null;
    zonaDraggingRef.current = false;
  };
  const cancelarZona = () => {
    setZonaActiva(null);
    setZonaRect(null);
    zonaRectRef.current = null;
    zonaDraggingRef.current = false;
  };

  const handleZonaMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!zonaActiva || zonaExtracting) return;
    e.preventDefault();
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const r = { startX: x, startY: y, endX: x, endY: y };
    zonaRectRef.current = r;
    setZonaRect(r);
    zonaDraggingRef.current = true;
  };

  const handleZonaMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!zonaDraggingRef.current || !zonaRectRef.current) return;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const r = { ...zonaRectRef.current, endX: x, endY: y };
    zonaRectRef.current = r;
    setZonaRect(r);
  };

  const handleZonaMouseUp = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!zonaActiva || !selectedBorrador) return;
    if (!zonaDraggingRef.current) return;
    zonaDraggingRef.current = false;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    if (!zonaRectRef.current) return;
    const prev = { ...zonaRectRef.current, endX: x, endY: y };
    zonaRectRef.current = prev;
    setZonaRect(prev);

    const overlay = e.currentTarget;
    const pageWidth = overlay.offsetWidth;
    const pageHeight = overlay.offsetHeight;
    const rx = Math.min(prev.startX, prev.endX);
    const ry = Math.min(prev.startY, prev.endY);
    const w = Math.abs(prev.endX - prev.startX);
    const h = Math.abs(prev.endY - prev.startY);
    if (w < 10 || h < 10) {
      setZonaRect(null);
      zonaRectRef.current = null;
      return;
    }

    setZonaExtracting(true);
    try {
      const res = await fetch(`${API_URL}/api/facturacion/ocr/extraer-zona`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileKey: selectedBorrador.archivo.fileKey,
          x: rx,
          y: ry,
          width: w,
          height: h,
          pageWidth,
          pageHeight,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error extrayendo zona');
      const texto = data.texto || '';
      if (texto) {
        const field = zonaActiva.field;
        if (zonaActiva.numeric) {
          const numVal = parseFloat(texto.replace(/[^\d.,\-]/g, '').replace(',', '.')) || 0;
          const importesKeys: (keyof CamposManuales)[] = [
            'tipo_iva_pct',
            'retencion_pct',
            'base_imponible',
            'total_iva',
            'retencion',
            'total_factura',
          ];
          if (importesKeys.includes(field as keyof CamposManuales)) {
            usuarioEditaCampo(selectedBorrador.idx, field as keyof CamposManuales, numVal);
          } else {
            patchBorrador(selectedBorrador.idx, { [field]: numVal } as Partial<Borrador>);
          }
        } else {
          patchBorrador(selectedBorrador.idx, { [field]: texto } as Partial<Borrador>);
        }
        if (field === 'proveedor_cif') {
          setTimeout(() => lookupCifEnMaestro(selectedBorrador.idx, texto), 100);
        }
        alertMsg('Zona OCR', `Campo actualizado: "${texto}"`);
      } else {
        alertMsg('Sin texto', 'No se pudo extraer texto de la zona seleccionada');
      }
    } catch (err: any) {
      alertMsg('Error OCR zona', err.message);
    } finally {
      setZonaExtracting(false);
      cancelarZona();
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/empresas`);
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

  const empresasGrupoParipe = useMemo(
    () =>
      empresasCatalogo.filter((e) => (e?.Sede || '').toUpperCase().includes('GRUPO PARIPE')),
    [empresasCatalogo],
  );

  const empresasGrupoFiltradas = useMemo(() => {
    if (!sociedadSearch.trim()) return empresasGrupoParipe;
    const q = sociedadSearch.toLowerCase();
    return empresasGrupoParipe.filter(
      (e) =>
        (e.Nombre || '').toLowerCase().includes(q) || (e.Cif || '').toLowerCase().includes(q),
    );
  }, [empresasGrupoParipe, sociedadSearch]);

  useEffect(() => {
    setSociedadSearch('');
    setShowSociedadDropdown(false);
  }, [selectedIdx]);

  const setSociedadGrupo = async (idx: number, e: EmpresaCatalogo) => {
    const id = e.id_empresa != null ? String(e.id_empresa) : '';
    const socCif = e.Cif != null ? String(e.Cif) : '';
    const socNombre = e.Nombre != null ? String(e.Nombre) : '';

    const prevRow = borradores.find((x) => x.idx === idx);

    setBorradores((prev) =>
      prev.map((b) =>
        b.idx === idx
          ? {
              ...b,
              sociedad_grupo_id: id,
              sociedad_grupo_nombre: socNombre,
              sociedad_grupo_cif: socCif,
            }
          : b,
      ),
    );
    setSociedadSearch('');
    setShowSociedadDropdown(false);

    if (!prevRow?.entidades_candidatas?.length) return;

    try {
      const res = await fetch(`${API_URL}/api/facturacion/ocr/reconciliar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sociedad_cif: socCif,
          sociedad_nombre: socNombre,
          entidades_candidatas: prevRow.entidades_candidatas,
          texto_extraido: prevRow.texto_extraido || '',
          extraction_snapshot: prevRow.extraction_snapshot,
          campos_manuales: prevRow.campos_manuales || {},
          proveedor_provisional_cif:
            prevRow.proveedor_provisional_cif || prevRow.extraction_snapshot?.proveedor_cif || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reconciliación fallida');
      const d = data.datos;
      if (!d) return;

      setBorradores((prev) =>
        prev.map((row) => {
          if (row.idx !== idx) return row;
          const m = row.campos_manuales || {};
          let next: Borrador = {
            ...row,
            reconciliacion_warning: typeof d.warning === 'string' ? d.warning : '',
          };
          if (!m.proveedor_cif && d.proveedor_cif != null) next.proveedor_cif = String(d.proveedor_cif);
          if (!m.proveedor_nombre && d.proveedor_nombre != null) next.proveedor_nombre = String(d.proveedor_nombre);
          if (!m.proveedor_cif && !m.proveedor_nombre && d.empresa_id != null) next.empresa_id = String(d.empresa_id);
          if (!m.proveedor_cif && !m.proveedor_nombre && typeof d.proveedor_en_maestros === 'boolean') {
            next.proveedor_en_maestros = d.proveedor_en_maestros;
          }
          if (!m.proveedor_nombre && d.nombre_sugerido_ocr != null) next.nombre_sugerido_ocr = String(d.nombre_sugerido_ocr);
          if (!m.numero_factura_proveedor && d.numero_factura_proveedor != null) {
            next.numero_factura_proveedor = String(d.numero_factura_proveedor);
          }
          if (!m.fecha_emision && d.fecha_emision != null) {
            const raw = String(d.fecha_emision);
            next.fecha_emision = /^\d{4}-\d{2}-\d{2}/.test(raw) ? isoToDmy(raw.substring(0, 10)) : raw;
          }
          if (!m.base_imponible && d.base_imponible != null) next.base_imponible = Number(d.base_imponible);
          if (!m.total_iva && d.total_iva != null) next.total_iva = Number(d.total_iva);
          if (!m.retencion && d.retencion != null) next.retencion = Number(d.retencion);
          if (!m.total_factura && d.total_factura != null) next.total_factura = Number(d.total_factura);
          if (d.confianza && typeof d.confianza === 'object') next.confianza = { ...next.confianza, ...d.confianza };
          const pctR = derivarPctDesdeImportes(
            Number(next.base_imponible) || 0,
            Number(next.total_iva) || 0,
            Number(next.retencion) || 0,
          );
          if (!m.tipo_iva_pct) next.tipo_iva_pct = pctR.tipo_iva_pct;
          if (!m.retencion_pct) next.retencion_pct = pctR.retencion_pct;
          if (m.tipo_iva_pct || m.retencion_pct) {
            next = recalcImportesDesdePct(next);
          }
          return next;
        }),
      );
    } catch (err: any) {
      alertMsg('Reconciliación', err.message || 'No se pudo reconciliar con el documento');
    }
  };

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
          const extSnap = d.extraction_snapshot || {
            proveedor_cif: d.proveedor_cif || '',
            numero_factura_proveedor: d.numero_factura_proveedor || '',
            fecha_emision: d.fecha_emision || '',
            base_imponible: d.base_imponible ?? 0,
            total_iva: d.total_iva ?? 0,
            retencion: d.retencion ?? 0,
            total_factura: d.total_factura ?? 0,
            confianza: d.confianza || {},
          };
          const base0 = d.base_imponible || 0;
          const iva0 = d.total_iva || 0;
          const ret0 = typeof d.retencion === 'number' ? d.retencion : 0;
          const pct0 = derivarPctDesdeImportes(base0, iva0, ret0);
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
            fecha_emision: d.fecha_emision ? isoToDmy(d.fecha_emision) : '',
            base_imponible: base0,
            tipo_iva_pct: pct0.tipo_iva_pct,
            retencion_pct: pct0.retencion_pct,
            total_iva: iva0,
            retencion: ret0,
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
                  confianza: { ...b.confianza, proveedor_nombre: 'alta' },
                }
              : b,
          ),
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
    const sinSociedad = activos.find((b) => !String(b.sociedad_grupo_id || '').trim());
    if (sinSociedad) {
      alertMsg(
        'Falta empresa',
        'Selecciona la sociedad del grupo (GRUPO PARIPE) en todos los borradores activos.',
      );
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

              <View style={styles.sociedadBlock}>
                <Text style={styles.sociedadTitle}>Empresa (GRUPO PARIPE) *</Text>
                <Text style={styles.sociedadHint}>Sociedad del grupo que recibe el gasto (se guarda como emisor)</Text>
                {empresasCatalogo.length > 0 && empresasGrupoParipe.length === 0 ? (
                  <Text style={styles.sociedadMaestroWarn}>
                    No hay empresas con sede «GRUPO PARIPE» en el maestro. Revisa el campo Sede en Empresas.
                  </Text>
                ) : null}
                <View style={styles.sociedadSelector}>
                  <TextInput
                    style={styles.sociedadInput}
                    placeholder="Buscar empresa por nombre o CIF…"
                    placeholderTextColor="#94a3b8"
                    value={sociedadSearch || selectedBorrador.sociedad_grupo_nombre || ''}
                    onChangeText={(t) => {
                      setSociedadSearch(t);
                      setShowSociedadDropdown(true);
                      setBorradores((prev) =>
                        prev.map((b) =>
                          b.idx === selectedBorrador.idx && b.sociedad_grupo_id
                            ? { ...b, sociedad_grupo_id: '', sociedad_grupo_nombre: '', sociedad_grupo_cif: '' }
                            : b,
                        ),
                      );
                    }}
                    onFocus={() => setShowSociedadDropdown(true)}
                  />
                  {showSociedadDropdown && empresasGrupoFiltradas.length > 0 && (
                    <ScrollView style={styles.sociedadDropdown} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                      {empresasGrupoFiltradas.slice(0, 25).map((e) => {
                        const id = e.id_empresa != null ? String(e.id_empresa) : '';
                        return (
                          <TouchableOpacity
                            key={id || e.Cif || e.Nombre}
                            style={styles.sociedadDropdownItem}
                            onPress={() => setSociedadGrupo(selectedBorrador.idx, e)}
                          >
                            <Text style={styles.sociedadDropdownName} numberOfLines={2}>
                              {e.Nombre || '—'}
                            </Text>
                            <Text style={styles.sociedadDropdownCif}>{e.Cif || ''}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
                {selectedBorrador.sociedad_grupo_id ? (
                  <Text style={styles.sociedadOk}>
                    {selectedBorrador.sociedad_grupo_cif ? `${selectedBorrador.sociedad_grupo_cif} · ` : ''}
                    {selectedBorrador.sociedad_grupo_nombre}
                  </Text>
                ) : (
                  <Text style={styles.sociedadWarn}>Obligatorio antes de confirmar</Text>
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

              {zonaActiva && (
                <View style={styles.zonaActivaBanner}>
                  <MaterialIcons name="crop-free" size={14} color="#0369a1" />
                  <Text style={styles.zonaActivaText}>
                    Dibuja un rectángulo sobre el documento para capturar «{zonaActiva.field}»
                  </Text>
                  <TouchableOpacity onPress={cancelarZona} style={styles.zonaActivaCancelBtn}>
                    <Text style={styles.zonaActivaCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={styles.formGrid}>
                <FieldRowZona label="CIF Proveedor" value={selectedBorrador.proveedor_cif} conf={selectedBorrador.confianza.proveedor_cif} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'proveedor_cif', v)} onBlur={() => lookupCifEnMaestro(selectedBorrador.idx)} onZona={() => activarZona('proveedor_cif')} zonaActiva={zonaActiva?.field === 'proveedor_cif'} />
                <FieldRowZona label="Nombre proveedor" value={selectedBorrador.proveedor_nombre} conf={selectedBorrador.confianza.proveedor_nombre} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'proveedor_nombre', v)} onZona={() => activarZona('proveedor_nombre')} zonaActiva={zonaActiva?.field === 'proveedor_nombre'} />
                <FieldRowZona label="Nº Factura" value={selectedBorrador.numero_factura_proveedor} conf={selectedBorrador.confianza.numero_factura} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'numero_factura_proveedor', v)} onZona={() => activarZona('numero_factura_proveedor')} zonaActiva={zonaActiva?.field === 'numero_factura_proveedor'} />
                <FieldRowZona label="Fecha emisión" value={selectedBorrador.fecha_emision} conf={selectedBorrador.confianza.fecha} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'fecha_emision', v)} placeholder="dd/mm/aaaa" onZona={() => activarZona('fecha_emision')} zonaActiva={zonaActiva?.field === 'fecha_emision'} />
                <FieldRowZona label="Base imponible" value={String(selectedBorrador.base_imponible || '')} conf={selectedBorrador.confianza.base_imponible} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'base_imponible', parseFloat(v) || 0)} numeric onZona={() => activarZona('base_imponible', true)} zonaActiva={zonaActiva?.field === 'base_imponible'} />
                <FieldRowZona label="% tipo IVA" value={String(selectedBorrador.tipo_iva_pct ?? '')} conf={selectedBorrador.confianza.tipo_iva_pct} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'tipo_iva_pct', parseFloat(v.replace(',', '.')) || 0)} numeric onZona={() => activarZona('tipo_iva_pct', true)} zonaActiva={zonaActiva?.field === 'tipo_iva_pct'} />
                <FieldRowZona label="IVA (€)" value={String(selectedBorrador.total_iva || '')} conf={selectedBorrador.confianza.total_iva} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'total_iva', parseFloat(v) || 0)} numeric onZona={() => activarZona('total_iva', true)} zonaActiva={zonaActiva?.field === 'total_iva'} />
                <FieldRowZona label="% retención IRPF" value={String(selectedBorrador.retencion_pct ?? '')} conf={selectedBorrador.confianza.retencion_pct} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'retencion_pct', parseFloat(v.replace(',', '.')) || 0)} numeric onZona={() => activarZona('retencion_pct', true)} zonaActiva={zonaActiva?.field === 'retencion_pct'} />
                <FieldRowZona label="Retención (€)" value={String(selectedBorrador.retencion ?? '')} conf={selectedBorrador.confianza.retencion} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'retencion', parseFloat(v) || 0)} numeric onZona={() => activarZona('retencion', true)} zonaActiva={zonaActiva?.field === 'retencion'} />
                <FieldRowZona label="Total factura" value={String(selectedBorrador.total_factura || '')} conf={selectedBorrador.confianza.total} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'total_factura', parseFloat(v) || 0)} numeric onZona={() => activarZona('total_factura', true)} zonaActiva={zonaActiva?.field === 'total_factura'} />
                <FieldRow label="Observaciones" value={selectedBorrador.observaciones} onChange={(v) => usuarioEditaCampo(selectedBorrador.idx, 'observaciones', v)} placeholder="Notas adicionales…" />
              </View>
            </ScrollView>
          </View>

          {/* RIGHT: Preview con selección de zona (PDF → PNG vía API; coordenadas sobre capa = misma referencia que extraer-zona) */}
          <View style={styles.previewPane}>
            {selectedBorrador.archivo.previewUrl ? (
              zonaActiva && Platform.OS === 'web' && zonaImgSrc ? (
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    height: '100%',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#e2e8f0',
                    userSelect: 'none',
                  } as any}
                >
                  {!zonaPreviewLoaded ? (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 } as any}>
                      <ActivityIndicator size="large" color="#0ea5e9" />
                      <span style={{ position: 'absolute', bottom: 24, fontSize: 11, color: '#64748b' } as any}>Generando vista para selección…</span>
                    </div>
                  ) : null}
                  <div
                    style={{
                      position: 'relative',
                      maxWidth: '100%',
                      maxHeight: '100%',
                      display: 'inline-block',
                    } as any}
                  >
                    <img
                      src={zonaImgSrc}
                      alt="Seleccionar zona"
                      onLoad={() => setZonaPreviewLoaded(true)}
                      onError={() => alertMsg('Vista previa', 'No se pudo cargar la imagen de selección')}
                      style={{
                        maxWidth: '100%',
                        maxHeight: '100%',
                        objectFit: 'contain',
                        display: 'block',
                      } as any}
                    />
                    {zonaPreviewLoaded ? (
                      <div
                        onMouseDown={handleZonaMouseDown as any}
                        onMouseMove={handleZonaMouseMove as any}
                        onMouseUp={handleZonaMouseUp as any}
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          width: '100%',
                          height: '100%',
                          cursor: zonaExtracting
                            ? 'wait'
                            : 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\'%3E%3Cline x1=\'12\' y1=\'0\' x2=\'12\' y2=\'24\' stroke=\'%23ff00ff\' stroke-width=\'2\'/%3E%3Cline x1=\'0\' y1=\'12\' x2=\'24\' y2=\'12\' stroke=\'%23ff00ff\' stroke-width=\'2\'/%3E%3C/svg%3E") 12 12, crosshair',
                          boxSizing: 'border-box',
                        } as any}
                      >
                        {zonaRect && (
                          <div
                            style={{
                              position: 'absolute',
                              left: Math.min(zonaRect.startX, zonaRect.endX),
                              top: Math.min(zonaRect.startY, zonaRect.endY),
                              width: Math.abs(zonaRect.endX - zonaRect.startX),
                              height: Math.abs(zonaRect.endY - zonaRect.startY),
                              border: '2px solid #ff00ff',
                              backgroundColor: 'rgba(255, 0, 255, 0.18)',
                              borderRadius: 3,
                              pointerEvents: 'none',
                            } as any}
                          />
                        )}
                      </div>
                    ) : null}
                  </div>
                  {zonaExtracting ? (
                    <div style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(255,255,255,0.65)',
                      zIndex: 4,
                    } as any}>
                      <ActivityIndicator size="large" color="#0ea5e9" />
                    </div>
                  ) : null}
                </div>
              ) : selectedBorrador.archivo.tipo.includes('pdf') ? (
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

function FieldRowZona({ label, value, conf, onChange, numeric, placeholder, onZona, zonaActiva, onBlur }: {
  label: string;
  value: string;
  conf?: string;
  onChange: (v: string) => void;
  numeric?: boolean;
  placeholder?: string;
  onZona: () => void;
  zonaActiva?: boolean;
  onBlur?: () => void;
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
        onBlur={onBlur}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
      />
      <TouchableOpacity
        onPress={onZona}
        style={[styles.zonaBtn, zonaActiva && styles.zonaBtnActive]}
        activeOpacity={0.7}
      >
        <MaterialIcons name="crop-free" size={14} color={zonaActiva ? '#fff' : '#0ea5e9'} />
      </TouchableOpacity>
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
    overflow: 'visible' as const,
    zIndex: 1,
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

  sociedadBlock: {
    marginBottom: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    zIndex: 40,
  },
  sociedadTitle: { fontSize: 12, fontWeight: '700' as const, color: '#334155', marginBottom: 4 },
  sociedadHint: { fontSize: 10, color: '#64748b', marginBottom: 6, lineHeight: 14 },
  sociedadMaestroWarn: {
    fontSize: 10,
    color: '#b45309',
    marginBottom: 8,
    lineHeight: 14,
    backgroundColor: '#fffbeb',
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  sociedadSelector: { position: 'relative' as const, zIndex: 50 },
  sociedadInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#334155',
    backgroundColor: '#f8fafc',
  },
  sociedadDropdown: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    maxHeight: 200,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    marginTop: 4,
    zIndex: 100,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  sociedadDropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  sociedadDropdownName: { fontSize: 12, fontWeight: '600' as const, color: '#334155' },
  sociedadDropdownCif: { fontSize: 10, color: '#64748b', marginTop: 2 },
  sociedadOk: { fontSize: 10, color: '#059669', marginTop: 6, fontWeight: '500' as const },
  sociedadWarn: { fontSize: 10, color: '#b45309', marginTop: 6 },

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
