import { useCallback, useRef, useState, type ReactNode } from 'react';
import { View, Text, StyleSheet, Platform, type StyleProp, type ViewStyle } from 'react-native';

const IS_WEB = Platform.OS === 'web';

function portalToBody(children: ReactNode): ReactNode {
  if (!IS_WEB || typeof document === 'undefined') return children;
  const { createPortal } = require('react-dom') as typeof import('react-dom');
  return createPortal(children, document.body);
}

type Props = {
  text: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function PostitTooltip({ text, children, style }: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, maxWidth: 280 });
  const anchorRef = useRef<View>(null);

  const updatePos = useCallback(() => {
    if (!IS_WEB || !anchorRef.current) return;
    const el = anchorRef.current as unknown as HTMLElement;
    const rect = el.getBoundingClientRect?.();
    if (!rect) return;
    const maxWidth = Math.min(320, Math.max(200, window.innerWidth - 24));
    let left = rect.left + rect.width / 2 - maxWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - maxWidth - 8));
    const top = rect.bottom + 6;
    setPos({ top, left, maxWidth });
  }, []);

  const show = () => {
    updatePos();
    setVisible(true);
  };

  const hide = () => setVisible(false);

  const webProps = IS_WEB
    ? { onMouseEnter: show, onMouseLeave: hide }
    : {};

  const bubble = visible ? (
    <View
      style={[
        styles.postit,
        {
          position: 'fixed' as never,
          top: pos.top,
          left: pos.left,
          maxWidth: pos.maxWidth,
          zIndex: 2147483647,
        },
      ]}
      pointerEvents="none"
    >
      <Text style={styles.postitText}>{text}</Text>
    </View>
  ) : null;

  return (
    <>
      <View ref={anchorRef} style={[styles.anchor, style]} {...webProps}>
        {children}
      </View>
      {IS_WEB && visible ? portalToBody(bubble) : null}
    </>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'relative' as const,
    ...(IS_WEB ? ({ cursor: 'help' } as object) : {}),
  },
  postit: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    shadowColor: '#92400e',
    shadowOffset: { width: 2, height: 3 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 16,
    ...(IS_WEB
      ? ({
          boxShadow: '2px 3px 8px rgba(146, 64, 14, 0.22)',
          transform: 'rotate(-0.5deg)',
        } as object)
      : {}),
  },
  postitText: {
    fontSize: 11,
    lineHeight: 15,
    color: '#78350f',
    fontWeight: '500',
  },
});
