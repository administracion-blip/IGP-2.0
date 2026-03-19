import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

export type ToastType = 'success' | 'error' | 'info' | 'warning';
type ToastData = { titulo: string; msg: string; tipo: ToastType };

const COLORS: Record<ToastType, { bg: string; border: string; icon: string }> = {
  success: { bg: '#f0fdf4', border: '#22c55e', icon: '#16a34a' },
  error:   { bg: '#fef2f2', border: '#ef4444', icon: '#dc2626' },
  info:    { bg: '#eff6ff', border: '#3b82f6', icon: '#2563eb' },
  warning: { bg: '#fffbeb', border: '#f59e0b', icon: '#d97706' },
};

const ICONS: Record<ToastType, string> = {
  success: 'check-circle',
  error: 'error',
  info: 'info',
  warning: 'warning',
};

export function detectToastType(titulo: string, msg: string): ToastType {
  const combined = `${titulo} ${msg}`;
  if (/error|obligatori|completa|indica|selecciona|sin series|no encontrad/i.test(combined)) return 'error';
  if (/guardad|registrad|emitid|duplicad|rectificativ|enviad|creado|actualiz/i.test(combined)) return 'success';
  if (/aviso|cuidado/i.test(combined)) return 'warning';
  return 'info';
}

export function useLocalToast() {
  const [data, setData] = useState<ToastData | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((titulo: string, msg: string, tipo?: ToastType) => {
    if (timer.current) clearTimeout(timer.current);
    const resolved = tipo ?? detectToastType(titulo, msg);
    setData({ titulo, msg, tipo: resolved });
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: false }).start();
    timer.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: false }).start(() => setData(null));
    }, 3500);
  }, [opacity]);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: false }).start(() => setData(null));
  }, [opacity]);

  const ToastView = data ? (
    <Animated.View
      pointerEvents="box-none"
      style={[
        s.wrapper,
        {
          opacity,
          borderLeftColor: COLORS[data.tipo].border,
          backgroundColor: COLORS[data.tipo].bg,
        },
      ]}
    >
      <MaterialIcons name={ICONS[data.tipo] as any} size={22} color={COLORS[data.tipo].icon} />
      <View style={s.textWrap}>
        <Text style={[s.title, { color: COLORS[data.tipo].icon }]}>{data.titulo}</Text>
        {!!data.msg && <Text style={s.msg}>{data.msg}</Text>}
      </View>
      <TouchableOpacity onPress={dismiss} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <MaterialIcons name="close" size={18} color="#94a3b8" />
      </TouchableOpacity>
    </Animated.View>
  ) : null;

  return { show, ToastView };
}

const s = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    top: 16,
    right: 16,
    minWidth: 320,
    maxWidth: 480,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
    zIndex: 99999,
  },
  textWrap: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
  },
  msg: {
    fontSize: 13,
    color: '#475569',
    marginTop: 2,
  },
});
