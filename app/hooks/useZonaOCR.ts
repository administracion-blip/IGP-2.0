import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
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
 *   firmada si es una imagen.
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

  const imgSrc = useMemo(() => {
    if (!activa || !sb?.archivo?.previewUrl) return null;
    if (sb.archivo.tipo.includes('pdf')) {
      return `${opts.apiUrl}/api/facturacion/ocr/preview-png?fileKey=${encodeURIComponent(sb.archivo.fileKey)}`;
    }
    return sb.archivo.previewUrl;
  }, [activa, sb?.archivo?.fileKey, sb?.archivo?.previewUrl, sb?.archivo?.tipo, opts.apiUrl]);

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
            const numVal = parseFloat(texto.replace(/[^\d.,\-]/g, '').replace(',', '.')) || 0;
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
