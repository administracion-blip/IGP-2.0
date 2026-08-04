import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  Image,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../../contexts/AuthContext';
import { useBreakpoint } from '../../../hooks/useBreakpoint';
import { MIN_TOUCH } from '../../../constants/layout';
import { SelectorDesplegable } from '../../../components/SelectorDesplegable';
import { useLocalToast, detectToastType } from '../../../components/Toast';
import { apiFetch, errorMessage } from '../../../utils/api';
import { formatMoneda, esEmpresaSedeGrupoParipe } from '../../../utils/facturacion';
import {
  INCREMENTO_REFACTURACION_PCT,
  guardarHandoffOcr,
  mapLineasDesdeOcrConMeta,
  pareceFactura,
  recalcularLineaPreview,
} from '../../../lib/refacturacion';

type EmpresaOpt = { id: string; nombre: string; cif: string };

type LineaLocal = {
  localId: string;
  descripcion: string;
  cantidad: string;
  precio_base_unitario: string;
  tipo_iva: string;
  descuento_pct: string;
  empresa_destino_id: string;
};

type DocLocal = {
  localId: string;
  archivo: {
    fileKey: string;
    nombre: string;
    tipo: string;
    size: number;
    previewUrl?: string;
  };
  /** Object URL local (web) para preview inmediata; revocar al quitar. */
  previewLocalUrl?: string;
  datos: Record<string, unknown>;
  sociedad_id: string;
  lineas: LineaLocal[];
  parece_factura: boolean;
  /** Aviso breve de lectura OCR limitada (IA saltada / fallback totales). */
  avisoOcr?: string;
};

function revokePreviewLocalUrl(url?: string) {
  if (!url || Platform.OS !== 'web') return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

function resolvePreviewUrl(doc: DocLocal): string | undefined {
  const signed = String(doc.archivo?.previewUrl || '').trim();
  if (signed) return signed;
  const local = String(doc.previewLocalUrl || '').trim();
  return local || undefined;
}

function esPdfArchivo(tipo: string, nombre: string): boolean {
  const t = (tipo || '').toLowerCase();
  const n = (nombre || '').toLowerCase();
  return t.includes('pdf') || n.endsWith('.pdf');
}

function esImagenArchivo(tipo: string, nombre: string): boolean {
  const t = (tipo || '').toLowerCase();
  const n = (nombre || '').toLowerCase();
  if (/^image\/(jpeg|jpg|png)/.test(t)) return true;
  if (t.includes('jpeg') || t.includes('jpg') || t.includes('png')) return true;
  return /\.(jpe?g|png)$/i.test(n);
}

function DocPreviewPane({
  doc,
  stacked,
}: {
  doc: DocLocal;
  stacked: boolean;
}) {
  const url = resolvePreviewUrl(doc);
  const nombre = doc.archivo?.nombre || 'documento';
  const tipo = doc.archivo?.tipo || '';
  const esPdf = esPdfArchivo(tipo, nombre);
  const esImg = esImagenArchivo(tipo, nombre);

  const fallback = (
    <View style={styles.previewFallback}>
      <MaterialIcons name="image-not-supported" size={36} color="#a78bfa" />
      <Text style={styles.previewFallbackTitle}>Sin previsualización</Text>
      <Text style={styles.previewFallbackName} numberOfLines={2}>{nombre}</Text>
    </View>
  );

  let content: React.ReactNode = fallback;
  if (url && esPdf && Platform.OS === 'web') {
    content = (
      <iframe
        src={url}
        title={`Vista previa ${nombre}`}
        style={{
          width: '100%',
          minHeight: stacked ? 320 : 480,
          height: '100%',
          border: 'none',
          borderRadius: 8,
          backgroundColor: '#fff',
          flex: 1,
        } as React.CSSProperties}
      />
    );
  } else if (url && esImg) {
    if (Platform.OS === 'web') {
      content = (
        <img
          src={url}
          alt={nombre}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            minHeight: stacked ? 280 : 420,
            objectFit: 'contain',
            display: 'block',
            margin: '0 auto',
          } as React.CSSProperties}
        />
      );
    } else {
      content = (
        <Image
          source={{ uri: url }}
          style={[styles.previewImage, stacked ? styles.previewImageStacked : null]}
          resizeMode="contain"
          accessibilityLabel={nombre}
        />
      );
    }
  }

  const paneStyle = [
    styles.previewPane,
    stacked ? styles.previewPaneStacked : styles.previewPaneSide,
  ];

  if (Platform.OS === 'web') {
    return (
      <View style={paneStyle}>
        <div
          style={{
            width: '100%',
            height: '100%',
            minHeight: stacked ? 320 : 480,
            overflow: 'auto',
            display: 'flex',
            alignItems: esPdf ? 'stretch' : 'center',
            justifyContent: esPdf ? 'flex-start' : 'center',
            padding: 8,
            boxSizing: 'border-box',
          } as React.CSSProperties}
        >
          {content}
        </div>
      </View>
    );
  }

  return (
    <View style={paneStyle}>
      <ScrollView
        style={styles.previewScroll}
        contentContainerStyle={styles.previewScrollContent}
        nestedScrollEnabled
      >
        {content}
      </ScrollView>
    </View>
  );
}

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function lineaVacia(sociedadId = ''): LineaLocal {
  return {
    localId: newId(),
    descripcion: '',
    cantidad: '1',
    precio_base_unitario: '0',
    tipo_iva: '21',
    descuento_pct: '0',
    empresa_destino_id: sociedadId,
  };
}

function aceptaArchivo(f: File): boolean {
  const name = (f.name || '').toLowerCase();
  const type = (f.type || '').toLowerCase();
  if (/\.(pdf|jpe?g|png)$/i.test(name)) return true;
  if (type === 'application/pdf') return true;
  if (/^image\/(jpeg|jpg|png)$/.test(type)) return true;
  return false;
}

/** Estilos CSS para la zona de drop en web (RN View no reenvía onDrop al DOM). */
function uploadAreaWebStyle(
  active: boolean,
  deshabilitado = false,
  compact = false,
): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: compact ? 16 : 40,
    border: `2px dashed ${deshabilitado ? '#e2e8f0' : active ? '#a78bfa' : '#c4b5fd'}`,
    borderRadius: 12,
    backgroundColor: deshabilitado ? '#f8fafc' : active ? '#ede9fe' : '#fff',
    gap: 8,
    minHeight: compact ? 72 : 220,
    boxSizing: 'border-box',
    cursor: deshabilitado ? 'not-allowed' : 'pointer',
    opacity: deshabilitado ? 0.92 : 1,
  };
}

export default function RefacturacionEscanearScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ facturaRegistrada?: string }>();
  const { user, hasPermiso } = useAuth();
  const { isPhone, shouldStackPanels } = useBreakpoint();
  const { show: showToast, ToastView } = useLocalToast();
  const alertMsg = useCallback(
    (t: string, m: string) => showToast(t, m, detectToastType(t, m)),
    [showToast],
  );

  const puedeVer = hasPermiso('refacturacion.ver');
  const puedeGestionar = hasPermiso('refacturacion.gestionar');
  const puedeCrearFactura = hasPermiso('facturacion.crear');

  const [empresas, setEmpresas] = useState<EmpresaOpt[]>([]);
  const [docs, setDocs] = useState<DocLocal[]>([]);
  const [procesando, setProcesando] = useState(false);
  const [procesandoArchivo, setProcesandoArchivo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [dragOverUpload, setDragOverUpload] = useState(false);
  const facturaToastRef = useRef(false);
  /** fileKey enviado a registro-masivo; se limpia del estado al volver. */
  const docEnviadoAFacturaRef = useRef<string | null>(null);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const subidaBloqueada = procesando || guardando;

  useEffect(() => {
    return () => {
      for (const d of docsRef.current) revokePreviewLocalUrl(d.previewLocalUrl);
    };
  }, []);

  useEffect(() => {
    apiFetch('/api/empresas')
      .then((r) => r.json())
      .then((d) => {
        const raw: unknown[] = d.empresas ?? d ?? [];
        const list: EmpresaOpt[] = raw
          .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
          .filter((e) => esEmpresaSedeGrupoParipe(e as { Sede?: string; sede?: string }))
          .map((e) => ({
            id: e.id_empresa != null ? String(e.id_empresa) : '',
            nombre: String(e.Nombre ?? e.nombre ?? '').trim(),
            cif: String(e.Cif ?? e.cif ?? '').trim(),
          }))
          .filter((x) => x.id)
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        setEmpresas(list);
      })
      .catch(() => setEmpresas([]));
  }, []);

  useEffect(() => {
    const flag = Array.isArray(params.facturaRegistrada)
      ? params.facturaRegistrada[0]
      : params.facturaRegistrada;
    if (flag !== '1') return;
    const enviadoKey = docEnviadoAFacturaRef.current;
    if (enviadoKey) {
      setDocs((prev) => {
        for (const d of prev) {
          if (d.archivo.fileKey === enviadoKey) revokePreviewLocalUrl(d.previewLocalUrl);
        }
        return prev.filter((d) => d.archivo.fileKey !== enviadoKey);
      });
      docEnviadoAFacturaRef.current = null;
    }
    if (!facturaToastRef.current) {
      facturaToastRef.current = true;
      showToast(
        'Factura registrada',
        'La factura se registró como recibida. Puedes seguir escaneando tickets.',
        'success',
      );
      setTimeout(() => {
        facturaToastRef.current = false;
      }, 800);
    }
    router.replace('/facturacion/refacturacion/escanear' as never);
  }, [params.facturaRegistrada, router, showToast]);

  const empresaById = useMemo(() => {
    const m = new Map<string, EmpresaOpt>();
    for (const e of empresas) m.set(e.id, e);
    return m;
  }, [empresas]);

  const opcionesSociedad = useMemo(
    () => [
      { id: '', titulo: 'Seleccionar sociedad…', icono: 'business' as const },
      ...empresas.map((e) => ({ id: e.id, titulo: e.nombre, icono: 'domain' as const })),
    ],
    [empresas],
  );

  const procesarArchivos = useCallback(
    async (fileList: FileList | File[]) => {
      if (!puedeGestionar) return;
      const files = Array.from(fileList).filter(aceptaArchivo);
      if (files.length === 0) {
        alertMsg('Info', 'Solo se aceptan PDF, JPG o PNG');
        return;
      }
      setProcesando(true);
      const nuevos: DocLocal[] = [];
      for (const file of files) {
        setProcesandoArchivo(file.name);
        try {
          const formData = new FormData();
          formData.append('file', file);
          const res = await apiFetch('/api/facturacion/ocr/extraer', {
            method: 'POST',
            body: formData,
            timeoutMs: 120_000,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Error OCR');
          let datos = (data.datos || {}) as Record<string, unknown>;
          let iaSaltada = false;
          try {
            const rIa = await apiFetch('/api/facturacion/ocr/enriquecer-ia', {
              method: 'POST',
              body: JSON.stringify({
                datos,
                texto_extraido:
                  typeof datos.texto_extraido === 'string' ? datos.texto_extraido : '',
              }),
              timeoutMs: 120_000,
            });
            const j = await rIa.json();
            if (rIa.ok && j.ok && j.datos && !j.skipped) {
              datos = j.datos as Record<string, unknown>;
            } else {
              iaSaltada = true;
            }
          } catch (iaErr) {
            console.warn('[Refacturación escanear] IA enriquecimiento:', iaErr);
            iaSaltada = true;
          }
          const { lineas: lineasOcr } = mapLineasDesdeOcrConMeta(datos);
          const avisos: string[] = [];
          if (iaSaltada) {
            avisos.push('IA no disponible');
            showToast(
              'Aviso OCR',
              'Capa IA no disponible: revisa/completa las líneas a mano (configure OPENAI_API_KEY).',
              'warning',
            );
          }
          /** Importes a 0: el usuario introduce precio; OCR solo aporta descripción e IVA. */
          const lineasDoc: LineaLocal[] = lineasOcr.length > 0
            ? lineasOcr.map((l) => {
                const ivaOcr = Number(l.tipo_iva);
                return {
                  localId: newId(),
                  descripcion: String(l.descripcion || '').trim(),
                  cantidad: '1',
                  precio_base_unitario: '0',
                  tipo_iva:
                    Number.isFinite(ivaOcr) && ivaOcr >= 0 ? String(ivaOcr) : '21',
                  descuento_pct: '0',
                  empresa_destino_id: '',
                };
              })
            : [lineaVacia()];
          const localId = newId();
          let previewLocalUrl: string | undefined;
          if (Platform.OS === 'web') {
            try {
              previewLocalUrl = URL.createObjectURL(file);
            } catch {
              previewLocalUrl = undefined;
            }
          }
          const archivoRaw = (data.archivo || {}) as Record<string, unknown>;
          nuevos.push({
            localId,
            archivo: {
              fileKey: String(archivoRaw.fileKey ?? ''),
              nombre: String(archivoRaw.nombre ?? file.name ?? ''),
              tipo: String(archivoRaw.tipo ?? file.type ?? ''),
              size: Number(archivoRaw.size ?? file.size ?? 0) || 0,
              previewUrl: archivoRaw.previewUrl
                ? String(archivoRaw.previewUrl)
                : undefined,
            },
            previewLocalUrl,
            datos,
            sociedad_id: '',
            lineas: lineasDoc,
            parece_factura: pareceFactura(datos),
            avisoOcr: avisos.length > 0 ? avisos.join(' · ') : undefined,
          });
        } catch (e: unknown) {
          alertMsg('Error', `${file.name}: ${errorMessage(e)}`);
        }
      }
      setDocs((prev) => [...prev, ...nuevos]);
      setProcesando(false);
      setProcesandoArchivo('');
      if (nuevos.length > 0) {
        showToast('OCR', `${nuevos.length} documento(s) listo(s) para editar`, 'success');
      }
    },
    [alertMsg, puedeGestionar, showToast],
  );

  const abrirSelectorArchivos = useCallback(() => {
    if (Platform.OS !== 'web' || !puedeGestionar || procesando || guardando) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
    input.multiple = true;
    input.onchange = () => {
      if (input.files?.length) void procesarArchivos(input.files);
    };
    input.click();
  }, [puedeGestionar, procesando, guardando, procesarArchivos]);

  /** Handlers nativos de drag & drop (solo web; View de RNW no los reenvía al DOM). */
  const fileDropHandlers = useMemo(() => {
    if (Platform.OS !== 'web') return {};
    return {
      onDragEnter: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (!subidaBloqueada) setDragOverUpload(true);
      },
      onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = subidaBloqueada ? 'none' : 'copy';
        if (!subidaBloqueada) setDragOverUpload(true);
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
        if (subidaBloqueada) {
          alertMsg(
            'Info',
            'Espera a que termine el procesamiento actual antes de subir más archivos',
          );
          return;
        }
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) void procesarArchivos(files);
      },
      onClick: () => {
        if (!subidaBloqueada) abrirSelectorArchivos();
      },
    };
  }, [alertMsg, abrirSelectorArchivos, procesarArchivos, subidaBloqueada]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const allowFileDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', allowFileDrop);
    return () => window.removeEventListener('dragover', allowFileDrop);
  }, []);

  const setSociedadDoc = (docId: string, sociedadId: string) => {
    setDocs((prev) =>
      prev.map((d) => {
        if (d.localId !== docId) return d;
        return {
          ...d,
          sociedad_id: sociedadId,
          lineas: d.lineas.map((l) =>
            !l.empresa_destino_id || l.empresa_destino_id === d.sociedad_id
              ? { ...l, empresa_destino_id: sociedadId }
              : l,
          ),
        };
      }),
    );
  };

  const updateLinea = (
    docId: string,
    lineaId: string,
    patch: Partial<LineaLocal>,
  ) => {
    setDocs((prev) =>
      prev.map((d) =>
        d.localId !== docId
          ? d
          : {
              ...d,
              lineas: d.lineas.map((l) =>
                l.localId === lineaId ? { ...l, ...patch } : l,
              ),
            },
      ),
    );
  };

  const addLinea = (docId: string) => {
    setDocs((prev) =>
      prev.map((d) =>
        d.localId !== docId
          ? d
          : { ...d, lineas: [...d.lineas, lineaVacia(d.sociedad_id)] },
      ),
    );
  };

  const removeLinea = (docId: string, lineaId: string) => {
    setDocs((prev) =>
      prev.map((d) => {
        if (d.localId !== docId) return d;
        const next = d.lineas.filter((l) => l.localId !== lineaId);
        return {
          ...d,
          lineas: next.length > 0 ? next : [lineaVacia(d.sociedad_id)],
        };
      }),
    );
  };

  const removeDoc = (docId: string) => {
    setDocs((prev) => {
      for (const d of prev) {
        if (d.localId === docId) revokePreviewLocalUrl(d.previewLocalUrl);
      }
      return prev.filter((d) => d.localId !== docId);
    });
  };

  const irARegistroFactura = (doc: DocLocal) => {
    if (!puedeCrearFactura) {
      alertMsg('Sin permiso', 'Necesitas permiso para crear facturas (facturacion.crear).');
      return;
    }
    const fileKey = doc.archivo?.fileKey;
    if (!fileKey) {
      alertMsg('Error', 'El documento no tiene clave S3');
      return;
    }
    const returnTo = '/facturacion/refacturacion/escanear';
    guardarHandoffOcr({
      archivo: doc.archivo,
      datos: doc.datos,
      returnTo,
    });
    docEnviadoAFacturaRef.current = fileKey;
    setDocs((prev) => {
      for (const d of prev) {
        if (d.archivo.fileKey === fileKey) revokePreviewLocalUrl(d.previewLocalUrl);
      }
      return prev.filter((d) => d.archivo.fileKey !== fileKey);
    });
    router.push({
      pathname: '/facturacion/registro-masivo',
      params: { returnTo, docS3Key: fileKey },
    } as never);
  };

  const confirmarLote = async () => {
    if (!puedeGestionar) return;
    const payload: Record<string, unknown>[] = [];
    for (const doc of docs) {
      for (const l of doc.lineas) {
        const destId = l.empresa_destino_id || doc.sociedad_id;
        if (!destId) {
          alertMsg('Falta sociedad', `Asigna sociedad en «${doc.archivo.nombre}»`);
          return;
        }
        if (!String(l.descripcion || '').trim()) {
          alertMsg('Línea incompleta', `Indica descripción en «${doc.archivo.nombre}»`);
          return;
        }
        const emp = empresaById.get(destId);
        payload.push({
          empresa_destino_id: destId,
          empresa_destino_nombre: emp?.nombre || '',
          empresa_destino_cif: emp?.cif || '',
          descripcion: String(l.descripcion).trim(),
          cantidad: Number(l.cantidad) || 0,
          precio_base_unitario: Number(l.precio_base_unitario) || 0,
          tipo_iva: Number(l.tipo_iva) || 0,
          descuento: Number(l.descuento_pct) || 0,
          doc_origen_s3_key: doc.archivo.fileKey || '',
          doc_origen_nombre: doc.archivo.nombre || '',
          proveedor_origen: String(
            doc.datos.proveedor_nombre
              ?? doc.datos.emisor_nombre
              ?? '',
          ).trim(),
          fecha_documento: String(
            doc.datos.fecha_emision ?? doc.datos.fecha ?? '',
          ).trim(),
        });
      }
    }
    if (payload.length === 0) {
      alertMsg('Info', 'No hay líneas para confirmar');
      return;
    }
    setGuardando(true);
    try {
      const res = await apiFetch('/api/refacturacion/lineas', {
        method: 'POST',
        body: JSON.stringify({
          lineas: payload,
          usuario_id: user?.id_usuario ?? '',
          usuario_nombre: user?.Nombre ?? '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      showToast('Guardado', `${data.lineas?.length ?? payload.length} línea(s) pendientes`, 'success');
      setDocs((prev) => {
        for (const d of prev) revokePreviewLocalUrl(d.previewLocalUrl);
        return [];
      });
      router.push('/facturacion/refacturacion/pendientes' as never);
    } catch (e: unknown) {
      alertMsg('Error', errorMessage(e));
    } finally {
      setGuardando(false);
    }
  };

  if (!puedeVer) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>No tienes permiso para ver refacturaciones.</Text>
      </View>
    );
  }

  if (!puedeGestionar) {
    return (
      <View style={styles.centered}>
        <Text style={styles.denied}>Necesitas permiso «Refacturación · Gestionar» para escanear.</Text>
        <TouchableOpacity
          style={styles.btnSecondary}
          onPress={() => router.push('/facturacion/refacturacion' as never)}
        >
          <Text style={styles.btnSecondaryText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      {ToastView}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.push('/facturacion/refacturacion' as never)}
            style={[styles.backBtn, isPhone && { minHeight: MIN_TOUCH }]}
          >
            <MaterialIcons name="arrow-back" size={22} color="#334155" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Escanear documentos</Text>
            <Text style={styles.subtitle}>
              OCR + IA (descripciones). Introduce importes; preview con +{INCREMENTO_REFACTURACION_PCT}% (el servidor recalcula al guardar).
            </Text>
          </View>
        </View>

        <View style={styles.toolbar}>
          <TouchableOpacity
            style={[styles.btnPrimary, subidaBloqueada && styles.btnDisabled]}
            disabled={subidaBloqueada}
            onPress={abrirSelectorArchivos}
          >
            <MaterialIcons name="upload-file" size={18} color="#fff" />
            <Text style={styles.btnPrimaryText}>
              {Platform.OS === 'web' ? 'Subir archivos' : 'Subir (solo web)'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnConfirm, (docs.length === 0 || subidaBloqueada) && styles.btnDisabled]}
            disabled={docs.length === 0 || subidaBloqueada}
            onPress={() => void confirmarLote()}
          >
            {guardando ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <MaterialIcons name="check" size={18} color="#fff" />
            )}
            <Text style={styles.btnPrimaryText}>Confirmar lote</Text>
          </TouchableOpacity>
        </View>

        {procesando ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color="#6d28d9" />
            <Text style={styles.loadingText}>
              Procesando OCR + IA{procesandoArchivo ? `: ${procesandoArchivo}` : '…'}
            </Text>
          </View>
        ) : null}

        {Platform.OS === 'web' ? (
          <div
            {...fileDropHandlers}
            style={uploadAreaWebStyle(
              dragOverUpload && !subidaBloqueada,
              subidaBloqueada,
              docs.length > 0,
            )}
          >
            <MaterialIcons
              name={docs.length === 0 ? 'document-scanner' : 'cloud-upload'}
              size={docs.length === 0 ? 48 : 28}
              color={dragOverUpload && !subidaBloqueada ? '#6d28d9' : '#a78bfa'}
            />
            <Text style={styles.uploadTitle}>
              {subidaBloqueada
                ? procesando
                  ? procesandoArchivo
                    ? `Procesando ${procesandoArchivo}…`
                    : 'Procesando archivos…'
                  : 'Guardando…'
                : dragOverUpload
                  ? 'Suelta aquí para procesar'
                  : docs.length === 0
                    ? 'Arrastra aquí PDF o imágenes, o pulsa para subir'
                    : 'Arrastra más archivos o pulsa para añadir'}
            </Text>
            {docs.length === 0 && !subidaBloqueada ? (
              <Text style={styles.uploadHint}>PDF, JPG o PNG</Text>
            ) : null}
          </div>
        ) : docs.length === 0 && !procesando ? (
          <View style={styles.empty}>
            <MaterialIcons name="document-scanner" size={48} color="#c4b5fd" />
            <Text style={styles.emptyText}>Sube uno o varios tickets/PDF para empezar</Text>
          </View>
        ) : null}

        {docs.map((doc) => (
          <View key={doc.localId} style={styles.docCard}>
            <View style={[styles.docHeader, shouldStackPanels && styles.docHeaderStack]}>
              <View style={{ flex: 1, minWidth: 160 }}>
                <Text style={styles.docName} numberOfLines={1}>{doc.archivo.nombre}</Text>
                {doc.avisoOcr ? (
                  <Text style={styles.avisoOcrChip} numberOfLines={2}>{doc.avisoOcr}</Text>
                ) : null}
                {doc.parece_factura ? (
                  <Text style={styles.pareceFacturaTag}>Parece factura</Text>
                ) : null}
              </View>
              <View style={styles.docActions}>
                {doc.parece_factura && puedeCrearFactura ? (
                  <TouchableOpacity
                    style={styles.btnFactura}
                    onPress={() => irARegistroFactura(doc)}
                  >
                    <MaterialIcons name="receipt" size={16} color="#6d28d9" />
                    <Text style={styles.btnFacturaText}>Es una factura</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity onPress={() => removeDoc(doc.localId)} style={styles.iconBtn}>
                  <MaterialIcons name="delete-outline" size={20} color="#dc2626" />
                </TouchableOpacity>
              </View>
            </View>

            <View
              style={[
                styles.docBody,
                shouldStackPanels ? styles.docBodyStack : styles.docBodyRow,
              ]}
            >
              <DocPreviewPane doc={doc} stacked={shouldStackPanels} />

              <View style={[styles.docForm, !shouldStackPanels && styles.docFormSide]}>
                <SelectorDesplegable
                  style={styles.sociedadSelect}
                  icono="business"
                  tituloLista="Sociedad destino"
                  iconoLista="business"
                  placeholder="Sociedad destino"
                  valorId={doc.sociedad_id}
                  opciones={opcionesSociedad}
                  onSeleccionar={(id) => setSociedadDoc(doc.localId, id)}
                />

                {doc.lineas.map((l) => {
                  const calc = recalcularLineaPreview({
                    cantidad: l.cantidad,
                    precio_base_unitario: l.precio_base_unitario,
                    tipo_iva: l.tipo_iva,
                    descuento_pct: l.descuento_pct,
                  });
                  return (
                    <View key={l.localId} style={styles.lineaBox}>
                      <View style={styles.lineaRow}>
                        <View style={[styles.fieldCol, styles.fieldDesc]}>
                          <Text style={styles.fieldLabel}>Descripción</Text>
                          <TextInput
                            style={[styles.input, styles.inputDesc]}
                            placeholder="Concepto"
                            value={l.descripcion}
                            onChangeText={(t) =>
                              updateLinea(doc.localId, l.localId, { descripcion: t })
                            }
                          />
                        </View>
                        <View style={[styles.fieldCol, styles.fieldCant]}>
                          <Text style={styles.fieldLabel}>Cantidad</Text>
                          <TextInput
                            style={[styles.input, styles.inputNum]}
                            keyboardType="decimal-pad"
                            value={l.cantidad}
                            onChangeText={(t) =>
                              updateLinea(doc.localId, l.localId, { cantidad: t })
                            }
                          />
                        </View>
                        <View style={[styles.fieldCol, styles.fieldPrecio]}>
                          <Text style={styles.fieldLabel}>Precio base</Text>
                          <TextInput
                            style={[styles.input, styles.inputNum]}
                            keyboardType="decimal-pad"
                            value={l.precio_base_unitario}
                            onChangeText={(t) =>
                              updateLinea(doc.localId, l.localId, { precio_base_unitario: t })
                            }
                          />
                        </View>
                        <View style={[styles.fieldCol, styles.fieldIncr]}>
                          <Text style={styles.fieldLabel}>% incr.</Text>
                          <Text style={[styles.input, styles.inputReadonly, styles.inputNum]}>
                            {INCREMENTO_REFACTURACION_PCT}
                          </Text>
                        </View>
                        <View style={[styles.fieldCol, styles.fieldTotal]}>
                          <Text style={styles.fieldLabel}>Total</Text>
                          <Text style={[styles.input, styles.inputReadonly, styles.inputTotal]}>
                            {formatMoneda(calc.base_linea)}
                          </Text>
                        </View>
                        <View style={[styles.fieldCol, styles.fieldIva]}>
                          <Text style={styles.fieldLabel}>% IVA</Text>
                          <TextInput
                            style={[styles.input, styles.inputNum]}
                            keyboardType="decimal-pad"
                            value={l.tipo_iva}
                            onChangeText={(t) =>
                              updateLinea(doc.localId, l.localId, { tipo_iva: t })
                            }
                          />
                        </View>
                        <TouchableOpacity
                          onPress={() => removeLinea(doc.localId, l.localId)}
                          style={[styles.iconBtn, styles.lineaDeleteBtn]}
                          accessibilityLabel="Eliminar línea"
                        >
                          <MaterialIcons name="delete-outline" size={18} color="#94a3b8" />
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.lineaIvaHint}>
                        IVA: {formatMoneda(calc.iva_linea)} · Total c/IVA: {formatMoneda(calc.total_linea)}
                      </Text>
                    </View>
                  );
                })}

                <TouchableOpacity style={styles.btnAddLinea} onPress={() => addLinea(doc.localId)}>
                  <MaterialIcons name="add" size={18} color="#6d28d9" />
                  <Text style={styles.btnAddLineaText}>Añadir línea</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  denied: { fontSize: 14, color: '#64748b', textAlign: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  backBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#334155' },
  subtitle: { fontSize: 12, color: '#64748b', marginTop: 2 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#7c3aed',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnConfirm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#16a34a',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnDisabled: { opacity: 0.5 },
  btnSecondary: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  btnSecondaryText: { color: '#334155', fontWeight: '600' },
  loadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    backgroundColor: '#ede9fe',
    borderRadius: 8,
  },
  loadingText: { fontSize: 13, color: '#5b21b6' },
  empty: { alignItems: 'center', padding: 40, gap: 8 },
  emptyText: { fontSize: 13, color: '#94a3b8' },
  uploadTitle: { fontSize: 14, fontWeight: '500', color: '#334155', textAlign: 'center' },
  uploadHint: { fontSize: 12, color: '#94a3b8' },
  docCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#c4b5fd',
    padding: 12,
    gap: 10,
  },
  docHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    position: 'relative',
    zIndex: 20,
  },
  docHeaderStack: { flexDirection: 'column', alignItems: 'stretch' },
  docName: { fontSize: 14, fontWeight: '600', color: '#334155' },
  avisoOcrChip: {
    marginTop: 4,
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: '600',
    color: '#b45309',
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fcd34d',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  pareceFacturaTag: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '600',
    color: '#6d28d9',
  },
  docBody: { gap: 12, position: 'relative', zIndex: 0 },
  docBodyRow: { flexDirection: 'row', alignItems: 'stretch' },
  docBodyStack: { flexDirection: 'column' },
  previewPane: {
    borderWidth: 1,
    borderColor: '#ddd6fe',
    borderRadius: 10,
    backgroundColor: '#f5f3ff',
    overflow: 'hidden',
  },
  previewPaneStacked: { width: '100%', height: 340, minHeight: 320 },
  previewPaneSide: { flex: 1, minWidth: 0, minHeight: 480 },
  previewScroll: { flex: 1 },
  previewScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  previewImage: { width: '100%', height: 420 },
  previewImageStacked: { height: 300 },
  previewFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 16,
    minHeight: 180,
  },
  previewFallbackTitle: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  previewFallbackName: { fontSize: 12, color: '#94a3b8', textAlign: 'center' },
  docForm: { gap: 10, position: 'relative', zIndex: 10 },
  docFormSide: { flex: 1, minWidth: 0, minHeight: 420 },
  sociedadSelect: { minWidth: 200, alignSelf: 'stretch', position: 'relative', zIndex: 30 },
  docActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  btnFactura: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#ede9fe',
    borderWidth: 1,
    borderColor: '#c4b5fd',
  },
  btnFacturaText: { fontSize: 12, fontWeight: '600', color: '#6d28d9' },
  iconBtn: { padding: 6 },
  lineaDeleteBtn: { alignSelf: 'flex-end', marginBottom: 2 },
  lineaBox: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 8,
    gap: 4,
    backgroundColor: '#fafafa',
  },
  lineaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: 6,
  },
  fieldCol: { gap: 2 },
  fieldLabel: { fontSize: 10, fontWeight: '600', color: '#64748b' },
  fieldDesc: { flex: 1, minWidth: 140 },
  fieldCant: { width: 64 },
  fieldPrecio: { width: 88 },
  fieldIncr: { width: 52 },
  fieldTotal: { width: 88 },
  fieldIva: { width: 56 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 5,
    fontSize: 12,
    backgroundColor: '#fff',
    color: '#334155',
  },
  inputDesc: { width: '100%', minWidth: 140 },
  inputNum: { width: '100%', textAlign: 'right' },
  inputTotal: { width: '100%', textAlign: 'right', fontWeight: '600' },
  inputReadonly: {
    backgroundColor: '#f1f5f9',
    color: '#475569',
    overflow: 'hidden',
  },
  lineaIvaHint: { fontSize: 10, color: '#94a3b8', marginTop: 2 },
  btnAddLinea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  btnAddLineaText: { fontSize: 13, fontWeight: '600', color: '#6d28d9' },
});
