import React, { useCallback, useEffect, useRef, useState, createElement } from 'react';
import { View, Text, Pressable, StyleSheet, Image, type LayoutChangeEvent } from 'react-native';
import type { SignaturePadProps } from './types';
import { normalizeSignatureDataUrl } from './normalizeDataUrl';

const DEFAULT_HEIGHT = 220;
const PEN = '#0f172a';

export function SignaturePad({
  value,
  onChange,
  onSave,
  onClear,
  disabled = false,
  title,
  height = DEFAULT_HEIGHT,
  style,
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [emptyHint, setEmptyHint] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [layout, setLayout] = useState({ w: 0, h: 0 });
  const prevValueRef = useRef(value);
  const prevLayoutSizeRef = useRef({ w: 0, h: 0 });

  const resizeAndClear = useCallback((w: number, h: number) => {
    const canvas = canvasRef.current;
    if (!canvas || w < 1 || h < 1) return;
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = PEN;
    ctx.lineWidth = 2.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const onCanvasLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height: h } = e.nativeEvent.layout;
      setLayout({ w: width, h: h });
    },
    []
  );

  const paintFromValue = useCallback(
    (dataUrl: string, w: number, h: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        resizeAndClear(w, h);
        const c = canvasRef.current;
        const cctx = c?.getContext('2d');
        if (!c || !cctx) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cw = c.width / dpr;
        const ch = c.height / dpr;
        cctx.drawImage(img, 0, 0, cw, ch);
        setHasInk(true);
      };
      img.onerror = () => setHasInk(false);
      img.src = dataUrl;
    },
    [resizeAndClear]
  );

  useEffect(() => {
    if (layout.w < 1 || layout.h < 1) return;
    const normalized = normalizeSignatureDataUrl(value);
    const valueChanged = prevValueRef.current !== value;
    prevValueRef.current = value;
    const prevL = prevLayoutSizeRef.current;
    const firstLayout = prevL.w === 0 && prevL.h === 0 && layout.w > 0 && layout.h > 0;
    prevLayoutSizeRef.current = { w: layout.w, h: layout.h };

    if (normalized) {
      paintFromValue(normalized, layout.w, layout.h);
      return;
    }
    if (firstLayout || valueChanged) {
      resizeAndClear(layout.w, layout.h);
      setHasInk(false);
    }
  }, [value, layout.w, layout.h, paintFromValue, resizeAndClear]);

  const getCanvasCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const startStroke = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const p = getCanvasCoords(clientX, clientY);
    if (!p) return;
    drawingRef.current = true;
    lastRef.current = p;
    setHasInk(true);
    setEmptyHint(false);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };

  const moveStroke = (clientX: number, clientY: number) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const p = getCanvasCoords(clientX, clientY);
    if (!p || !lastRef.current) return;
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
  };

  const endStroke = () => {
    drawingRef.current = false;
    lastRef.current = null;
  };

  const canvasHandlers = {
    onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      startStroke(e.clientX, e.clientY);
    },
    onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      if (!drawingRef.current) return;
      e.preventDefault();
      moveStroke(e.clientX, e.clientY);
    },
    onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      e.preventDefault();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      endStroke();
    },
  };

  const handleClear = () => {
    setEmptyHint(false);
    if (layout.w > 0 && layout.h > 0) resizeAndClear(layout.w, layout.h);
    setHasInk(false);
    onClear?.();
    onChange?.(null);
  };

  const handleSave = () => {
    if (!hasInk) {
      setEmptyHint(true);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const raw = dataUrl.replace(/^data:image\/png;base64,/, '').trim();
    if (!raw) {
      setEmptyHint(true);
      return;
    }
    setEmptyHint(false);
    onSave?.(dataUrl);
    onChange?.(dataUrl);
  };

  const uri = normalizeSignatureDataUrl(value);

  if (disabled) {
    return (
      <View style={[styles.root, style]}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <View style={[styles.padOuter, { height }]}>
          {uri ? (
            <Image source={{ uri }} style={styles.disabledImage} resizeMode="contain" />
          ) : (
            <View style={styles.disabledEmpty} />
          )}
        </View>
      </View>
    );
  }

  const showPlaceholder = !hasInk && !uri;

  return (
    <View style={[styles.root, style]}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <View style={[styles.padOuter, { height }]}>
        <View style={styles.canvasStack} onLayout={onCanvasLayout}>
          {layout.w > 0 && layout.h > 0
            ? createElement('canvas', {
                ref: canvasRef,
                style: {
                  width: '100%',
                  height: '100%',
                  display: 'block',
                  touchAction: 'none',
                  cursor: 'crosshair',
                },
                ...canvasHandlers,
              })
            : null}
          {showPlaceholder ? (
            <View style={styles.placeholderWrap} pointerEvents="none">
              <Text style={styles.placeholderText}>Firme aquí</Text>
            </View>
          ) : null}
        </View>
      </View>
      {emptyHint ? <Text style={styles.warn}>Dibuje una firma antes de guardar.</Text> : null}
      <View style={styles.actions}>
        <Pressable style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]} onPress={handleClear}>
          <Text style={styles.btnGhostText}>Limpiar</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]} onPress={handleSave}>
          <Text style={styles.btnPrimaryText}>Guardar</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%' },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  padOuter: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  canvasStack: { flex: 1, width: '100%', position: 'relative', minHeight: 1 },
  placeholderWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    fontSize: 14,
    color: '#94a3b8',
    fontWeight: '500',
  },
  warn: {
    fontSize: 12,
    color: '#dc2626',
    marginTop: 6,
    paddingHorizontal: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    justifyContent: 'flex-end',
  },
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    minWidth: 96,
    alignItems: 'center',
  },
  btnGhost: {
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  btnGhostText: { fontSize: 14, fontWeight: '600', color: '#475569' },
  btnPrimary: { backgroundColor: '#0ea5e9' },
  btnPrimaryText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  pressed: { opacity: 0.88 },
  disabledImage: { width: '100%', height: '100%' },
  disabledEmpty: { flex: 1, backgroundColor: '#f8fafc' },
});
