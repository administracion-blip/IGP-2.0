import { useState, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

type Props = {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function CollapsibleSection({ title, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.head} onPress={() => setOpen((o) => !o)} activeOpacity={0.7}>
        <Text style={styles.title}>{title}</Text>
        <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={22} color="#64748b" />
      </TouchableOpacity>
      {open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    paddingTop: 10,
    marginTop: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  title: { fontSize: 12, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  body: { paddingTop: 8 },
});
