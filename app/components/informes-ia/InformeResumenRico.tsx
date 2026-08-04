import { Fragment, type ReactNode } from 'react';
import { View, Text, StyleSheet } from 'react-native';

type Props = { texto: string };

const RE_BRACKET_BADGE = /^\s*\[([^\]]{1,24})\]\s*$/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = /(\*\*(.+?)\*\*|«([^»]{1,40})»)/g;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    if (m[0].startsWith('**')) {
      nodes.push(
        <Text key={`${keyPrefix}-b-${i}`} style={styles.bold}>
          {m[2]}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={`${keyPrefix}-c-${i}`} style={styles.chipInline}>
          «{m[3]}»
        </Text>,
      );
    }
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

function parseBlocks(texto: string): { tipo: 'h2' | 'li' | 'badge' | 'p' | 'spacer'; content: string }[] {
  const lines = String(texto || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: { tipo: 'h2' | 'li' | 'badge' | 'p' | 'spacer'; content: string }[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const content = para.join(' ').trim();
    if (content) blocks.push({ tipo: 'p', content });
    para = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      if (blocks.length && blocks[blocks.length - 1].tipo !== 'spacer') {
        blocks.push({ tipo: 'spacer', content: '' });
      }
      continue;
    }
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      flushPara();
      blocks.push({ tipo: 'h2', content: h2[1].trim() });
      continue;
    }
    const li = trimmed.match(/^[-*]\s+(.+)$/);
    if (li) {
      flushPara();
      blocks.push({ tipo: 'li', content: li[1].trim() });
      continue;
    }
    const badge = trimmed.match(RE_BRACKET_BADGE);
    if (badge) {
      flushPara();
      blocks.push({ tipo: 'badge', content: badge[1].trim() });
      continue;
    }
    para.push(trimmed);
  }
  flushPara();
  return blocks;
}

/** Renderiza markdown ligero de resúmenes IA (##, listas, **negrita**, chips «»). */
export function InformeResumenRico({ texto }: Props) {
  const blocks = parseBlocks(texto);
  if (!blocks.length) return null;

  return (
    <View style={styles.wrap}>
      {blocks.map((b, idx) => {
        if (b.tipo === 'spacer') {
          return <View key={`sp-${idx}`} style={styles.spacer} />;
        }
        if (b.tipo === 'h2') {
          return (
            <View key={`h-${idx}`} style={styles.h2Row}>
              <View style={styles.h2Bar} />
              <Text style={styles.h2}>{renderInline(b.content, `h${idx}`)}</Text>
            </View>
          );
        }
        if (b.tipo === 'li') {
          return (
            <View key={`li-${idx}`} style={styles.liRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.liText}>{renderInline(b.content, `li${idx}`)}</Text>
            </View>
          );
        }
        if (b.tipo === 'badge') {
          const upper = b.content.toUpperCase();
          const tone =
            upper === 'OK' || upper === 'BIEN'
              ? styles.badgeOk
              : upper === 'KO' || upper === 'ALERTA' || upper === 'MAL'
                ? styles.badgeKo
                : styles.badgeNeutral;
          return (
            <View key={`bd-${idx}`} style={styles.badgeRow}>
              <View style={[styles.badge, tone]}>
                <Text style={styles.badgeText}>{b.content}</Text>
              </View>
            </View>
          );
        }
        return (
          <Text key={`p-${idx}`} style={styles.p}>
            {renderInline(b.content, `p${idx}`).map((n, i) =>
              typeof n === 'string' ? <Fragment key={`t-${idx}-${i}`}>{n}</Fragment> : n,
            )}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12, gap: 6 },
  spacer: { height: 6 },
  h2Row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    marginBottom: 2,
  },
  h2Bar: {
    width: 3,
    alignSelf: 'stretch',
    minHeight: 16,
    borderRadius: 2,
    backgroundColor: '#f59e0b',
  },
  h2: {
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    color: '#92400e',
    lineHeight: 22,
  },
  liRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingLeft: 2,
  },
  bullet: {
    fontSize: 14,
    color: '#d97706',
    fontWeight: '700',
    lineHeight: 22,
    width: 12,
  },
  liText: {
    flex: 1,
    fontSize: 14,
    color: '#1e293b',
    lineHeight: 22,
  },
  p: {
    fontSize: 14,
    color: '#1e293b',
    lineHeight: 22,
  },
  bold: {
    fontWeight: '700',
    color: '#0f172a',
  },
  chipInline: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
    fontWeight: '700',
    fontSize: 12,
  },
  badgeRow: { flexDirection: 'row', marginVertical: 2 },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeOk: { backgroundColor: '#dcfce7' },
  badgeKo: { backgroundColor: '#fee2e2' },
  badgeNeutral: { backgroundColor: '#e0f2fe' },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#334155',
    letterSpacing: 0.3,
  },
});
