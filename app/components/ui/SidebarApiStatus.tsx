import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useApiHealth, type ApiHealthStatus } from '../../hooks/useApiHealth';
import { colors, iconSize, MIN_TOUCH, radius, sidebar, SPACING, typography } from '../../constants/theme';

const IS_WEB = Platform.OS === 'web';

type Props = {
  collapsed?: boolean;
};

function StatusIcon({ status }: { status: ApiHealthStatus }) {
  const pulse = useRef(new Animated.Value(1)).current;
  const fadeOk = useRef(new Animated.Value(0)).current;
  const prevStatus = useRef<ApiHealthStatus>(status);

  useEffect(() => {
    if (status === 'error') {
      fadeOk.setValue(0);
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 0.45,
            duration: 850,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: 850,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    }
    pulse.setValue(1);
    if (status === 'ok' && prevStatus.current !== 'ok') {
      fadeOk.setValue(0);
      Animated.timing(fadeOk, {
        toValue: 1,
        duration: 400,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    } else if (status === 'ok') {
      fadeOk.setValue(1);
    }
    prevStatus.current = status;
    return undefined;
  }, [status, pulse, fadeOk]);

  if (status === 'checking') {
    return <ActivityIndicator size="small" color="#0369a1" />;
  }

  if (status === 'error') {
    return (
      <Animated.View style={{ opacity: pulse }}>
        <MaterialIcons name="cloud-off" size={iconSize.nav} color="#fff" />
      </Animated.View>
    );
  }

  return (
    <Animated.View style={{ opacity: fadeOk, transform: [{ scale: fadeOk }] }}>
      <MaterialIcons name="cloud-done" size={iconSize.nav} color="#0f766e" />
    </Animated.View>
  );
}

export function SidebarApiStatus({ collapsed = false }: Props) {
  const { status, errorDetail, recheck } = useApiHealth();
  const [tipVisible, setTipVisible] = useState(false);

  useEffect(() => {
    if (status !== 'error') setTipVisible(false);
  }, [status]);

  const label =
    status === 'checking'
      ? 'Comprobando…'
      : status === 'ok'
        ? 'Conectado al servidor'
        : 'Sin conexión';

  const rowToneStyle =
    status === 'ok'
      ? styles.rowOk
      : status === 'error'
        ? styles.rowError
        : status === 'checking'
          ? styles.rowChecking
          : null;

  const labelColor =
    status === 'ok'
      ? '#0f766e'
      : status === 'error'
        ? '#fff'
        : '#0369a1';

  const showTip = status === 'error' && tipVisible && errorDetail;

  function handlePress() {
    if (status === 'error') {
      setTipVisible((v) => !v);
      return;
    }
    if (status === 'checking') return;
    recheck();
  }

  return (
    <View style={styles.wrap}>
      {showTip ? (
        <View style={[styles.tip, collapsed && styles.tipCollapsed]}>
          <Text style={styles.tipText}>{errorDetail}</Text>
          <Pressable
            onPress={() => recheck()}
            style={({ pressed }) => [styles.tipRetry, pressed && styles.tipRetryPressed]}
          >
            <Text style={styles.tipRetryText}>Reintentar</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        onPress={handlePress}
        accessibilityLabel={
          status === 'error'
            ? `Sin conexión al servidor. Pulsa para ver detalle. ${errorDetail ?? ''}`
            : status === 'ok'
              ? 'Conectado al servidor'
              : 'Comprobando conexión con el servidor'
        }
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.row,
          rowToneStyle,
          collapsed && styles.rowCollapsed,
          pressed && status === 'error' && styles.rowErrorPressed,
          pressed && status === 'ok' && styles.rowOkPressed,
          status === 'error' && IS_WEB && ({ cursor: 'pointer' } as object),
        ]}
      >
        <View style={[styles.iconWrap, collapsed && styles.iconWrapCollapsed]}>
          <StatusIcon status={status} />
        </View>
        {!collapsed ? (
          <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        {!collapsed && status === 'error' ? (
          <MaterialIcons name="info-outline" size={16} color="rgba(255,255,255,0.85)" />
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: sidebar.itemHeight + 4,
    marginHorizontal: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
  },
  rowOk: {
    backgroundColor: '#ccfbf1',
    borderColor: '#5eead4',
  },
  rowOkPressed: {
    backgroundColor: '#99f6e4',
  },
  rowError: {
    backgroundColor: '#dc2626',
    borderColor: '#b91c1c',
  },
  rowErrorPressed: {
    backgroundColor: '#b91c1c',
  },
  rowChecking: {
    backgroundColor: '#f0f9ff',
    borderColor: '#bae6fd',
  },
  rowCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
    paddingVertical: 8,
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    alignSelf: 'center',
    marginHorizontal: 6,
  },
  iconWrap: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconWrapCollapsed: {
    width: MIN_TOUCH,
  },
  label: {
    ...typography.nav,
    flex: 1,
    fontWeight: '600',
    fontSize: 12,
  },
  tip: {
    position: 'absolute',
    bottom: '100%',
    left: SPACING.sm,
    right: SPACING.sm,
    marginBottom: 6,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    zIndex: 20,
    ...Platform.select({
      web: { boxShadow: '2px 3px 8px rgba(146, 64, 14, 0.18)' } as object,
      default: {
        shadowColor: '#92400e',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 6,
        elevation: 8,
      },
    }),
  },
  tipCollapsed: {
    left: 4,
    right: 4,
    minWidth: 220,
  },
  tipText: {
    fontSize: 11,
    lineHeight: 15,
    color: '#78350f',
    fontWeight: '500',
  },
  tipRetry: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: radius.sm - 2,
    backgroundColor: '#fef3c7',
  },
  tipRetryPressed: {
    opacity: 0.85,
  },
  tipRetryText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#92400e',
  },
});
