import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import SignatureCanvas, { type SignatureViewRef } from 'react-native-signature-canvas';
import type { SignaturePadProps } from './types';
import { normalizeSignatureDataUrl } from './normalizeDataUrl';

const WEB_STYLE = `
  .m-signature-pad { box-shadow: none; border: none; border-radius: 8px; }
  .m-signature-pad--body { border: none; }
  .m-signature-pad--footer { display: none !important; height: 0 !important; overflow: hidden !important; }
  body { background: #fff; margin: 0; }
`;

const DEFAULT_HEIGHT = 220;

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
  const sigRef = useRef<SignatureViewRef | null>(null);
  const prevValueRef = useRef(value);
  const [canvasKey, setCanvasKey] = useState(0);
  const [emptyHint, setEmptyHint] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const bgSrc = normalizeSignatureDataUrl(value) ?? undefined;

  useEffect(() => {
    setHasInk(!!value);
  }, [value]);

  useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value;
      setCanvasKey((k) => k + 1);
    }
  }, [value]);

  const handleOK = useCallback(
    (signature: string) => {
      const trimmed = signature.trim();
      const raw = trimmed.replace(/^data:image\/png;base64,/, '').trim();
      if (!raw) {
        setEmptyHint(true);
        return;
      }
      setEmptyHint(false);
      const dataUrl = trimmed.startsWith('data:') ? trimmed : `data:image/png;base64,${raw}`;
      onSave?.(dataUrl);
      onChange?.(dataUrl);
    },
    [onChange, onSave]
  );

  const handleEmpty = useCallback(() => {
    setEmptyHint(true);
  }, []);

  const handleClearPress = useCallback(() => {
    setEmptyHint(false);
    sigRef.current?.clearSignature();
    setCanvasKey((k) => k + 1);
    onClear?.();
    onChange?.(null);
    setHasInk(false);
  }, [onChange, onClear]);

  const handleSavePress = useCallback(() => {
    setEmptyHint(false);
    sigRef.current?.readSignature();
  }, []);

  const handleDraw = useCallback(() => {
    setHasInk(true);
    setEmptyHint(false);
  }, []);

  if (disabled) {
    const uri = normalizeSignatureDataUrl(value);
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

  const showPlaceholder = !hasInk && !bgSrc;

  return (
    <View style={[styles.root, style]}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <View style={[styles.padOuter, { height }]}>
        <View style={styles.canvasStack}>
          <SignatureCanvas
            key={canvasKey}
            ref={sigRef}
            onOK={handleOK}
            onEmpty={handleEmpty}
            onDraw={handleDraw}
            autoClear={false}
            descriptionText=""
            clearText=""
            confirmText=""
            webStyle={WEB_STYLE}
            bgSrc={bgSrc}
            backgroundColor="#ffffff"
            penColor="#0f172a"
            minWidth={1.5}
            maxWidth={3}
            imageType="image/png"
            nestedScrollEnabled
            style={styles.signature}
          />
          {showPlaceholder ? (
            <View style={styles.placeholderWrap} pointerEvents="none">
              <Text style={styles.placeholderText}>Firme aquí</Text>
            </View>
          ) : null}
        </View>
      </View>
      {emptyHint ? <Text style={styles.warn}>Dibuje una firma antes de guardar.</Text> : null}
      <View style={styles.actions}>
        <Pressable style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]} onPress={handleClearPress}>
          <Text style={styles.btnGhostText}>Limpiar</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]} onPress={handleSavePress}>
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
  canvasStack: { flex: 1, position: 'relative' },
  signature: { flex: 1 },
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
