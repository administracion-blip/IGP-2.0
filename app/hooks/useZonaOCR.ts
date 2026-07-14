import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
import { parseImporteTexto } from '../lib/registroMasivo';
import type { Borrador, ZonaRect, ZonaTarget } from '../types/registroMasivo';

/**
 * Hook que encapsula la herramienta "Selección de zona OCR" del registro
 * masivo. Permite al usuario dibujar un rectángulo sobre el preview del
 * documento para enviar al API la región y rellenar un campo concreto del
 * borrador con el texto extraído.
 *
 * Detalles de implementación:
 * - Se mantienen `rectRef` y `draggingRef` para que los handlers de mouse
 *   accedan al estado en mutación dentro del mismo gesto sin depender de
 *   re-renders entre `mousedown` y `mouseup`.
 * - `imgSrc` resuelve a un PNG rasterizado por el API si el documento es
 *   un PDF (no se puede usar `<img>` con un PDF directamente), o a la URL
 *   firmada si es una imagen. El PNG del PDF se descarga con `apiFetch`
 *   (adjunta el Bearer) y se expone como blob URL: un `<img src>` directo
 *   contra el API devolvía 401 porque no envía el token.
 *
 * El hook NO toca `borradores`: cuando se extrae texto, llama a
 * `onCampoExtraido(field, value, isNumeric)` y el padre decide si aplicar
 * `usuarioEditaCampo` o `patchBorrador`, y si disparar lookups extra (p. ej.
 * `lookupCifEnMaestro` cuando el campo extraído es `proveedor_cif`).
 */

export type UseZonaOCRReturn = {
  activa: ZonaTarget;
  rect: ZonaRect | null;
  extracting: boolean;
  previewLoaded: boolean;
  setPreviewLoaded: (v: boolean) => void;
  imgSrc: string | null;
  activar: (field: string, numeric?: boolean) => void;
  cancelar: () => void;
  handleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleMouseUp: (e: React.MouseEvent<HTMLDivElement>) => Promise<void>;
};

export function useZonaOCR(opts: {
  selectedBorrador: Borrador | null;
  /** URL base del API (para componer el endpoint del PNG rasterizado). */
  apiUrl: string;
  onCampoExtraido: (field: string, value: string | number, isNumeric: boolean) => void;
  /** Mensaje neutro (UX) al completarse o quedar sin texto. */
  onMessage?: (titulo: string, msg: string) => void;
  onError?: (msg: string) => void;
}): UseZonaOCRReturn {
  const [activa, setActiva] = useState<ZonaTarget>(null);
  const [rect, setRect] = useState<ZonaRect | null>(null);
  const [extracting, setExtracting] = useState<boolean>(false);
  const [previewLoaded, setPreviewLoaded] = useState<boolean>(false);
  const rectRef = useRef<ZonaRect | null>(null);
  const draggingRef = useRef<boolean>(false);

  const sb = opts.selectedBorrador;

  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const archivoFileKey = sb?.archivo?.fileKey;
  const archivoPreviewUrl = sb?.archivo?.previewUrl;
  const archivoEsPdf = Boolean(sb?.archivo?.tipo?.includes('pdf'));
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  useEffect(() => {
    if (!activa || !archivoPreviewUrl) {
      setImgSrc(null);
      return;
    }
    if (!archivoEsPdf) {
      setImgSrc(archivoPreviewUrl);
      return;
    }
    let cancelado = false;
    let blobUrl: string | null = null;
    setImgSrc(null);
    apiFetch(`/api/facturacion/ocr/preview-png?fileKey=${encodeURIComponent(archivoFileKey || '')}`)
      .then(async (res) => {
        if (!res.ok) {
          const d = await res.json().catch(() => ({} as { error?: string }));
          throw new Error(d.error || 'No se pudo generar la vista previa del PDF');
        }
        const blob = await res.blob();
        if (cancelado) return;
        blobUrl = URL.createObjectURL(blob);
        setImgSrc(blobUrl);
      })
      .catch((err: unknown) => {
        if (!cancelado) onErrorRef.current?.(errorMessage(err));
      });
    return () => {
      cancelado = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [activa, archivoFileKey, archivoPreviewUrl, archivoEsPdf]);

  useEffect(() => {
    setPreviewLoaded(false);
  }, [activa, imgSrc]);

  const activar = useCallback((field: string, numeric?: boolean) => {
    setActiva({ field, numeric });
    setRect(null);
    rectRef.current = null;
    draggingRef.current = false;
  }, []);

  const cancelar = useCallback(() => {
    setActiva(null);
    setRect(null);
    rectRef.current = null;
    draggingRef.current = false;
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!activa || extracting) return;
      e.preventDefault();
      const x = e.nativeEvent.offsetX;
      const y = e.nativeEvent.offsetY;
      const r: ZonaRect = { startX: x, startY: y, endX: x, endY: y };
      rectRef.current = r;
      setRect(r);
      draggingRef.current = true;
    },
    [activa, extracting],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !rectRef.current) return;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const r: ZonaRect = { ...rectRef.current, endX: x, endY: y };
    rectRef.current = r;
    setRect(r);
  }, []);

  const handleMouseUp = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      if (!activa || !sb) return;
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const x = e.nativeEvent.offsetX;
      const y = e.nativeEvent.offsetY;
      if (!rectRef.current) return;
      const prev: ZonaRect = { ...rectRef.current, endX: x, endY: y };
      rectRef.current = prev;
      setRect(prev);

      const overlay = e.currentTarget;
      const pageWidth = overlay.offsetWidth;
      const pageHeight = overlay.offsetHeight;
      const rx = Math.min(prev.startX, prev.endX);
      const ry = Math.min(prev.startY, prev.endY);
      const w = Math.abs(prev.endX - prev.startX);
      const h = Math.abs(prev.endY - prev.startY);
      if (w < 10 || h < 10) {
        setRect(null);
        rectRef.current = null;
        return;
      }

      setExtracting(true);
      try {
        const res = await apiFetch(`/api/facturacion/ocr/extraer-zona`, {
          method: 'POST',
          body: JSON.stringify({
            fileKey: sb.archivo.fileKey,
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
        const texto: string = data.texto || '';
        if (texto) {
          const field = activa.field;
          if (activa.numeric) {
            const numVal = parseImporteTexto(texto);
            opts.onCampoExtraido(field, numVal, true);
          } else {
            opts.onCampoExtraido(field, texto, false);
          }
          opts.onMessage?.('Zona OCR', `Campo actualizado: "${texto}"`);
        } else {
          opts.onMessage?.('Sin texto', 'No se pudo extraer texto de la zona seleccionada');
        }
      } catch (err: unknown) {
        opts.onError?.(errorMessage(err));
      } finally {
        setExtracting(false);
        setActiva(null);
        setRect(null);
        rectRef.current = null;
        draggingRef.current = false;
      }
    },
    [activa, sb, opts],
  );

  return {
    activa,
    rect,
    extracting,
    previewLoaded,
    setPreviewLoaded,
    imgSrc,
    activar,
    cancelar,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
  };
}
