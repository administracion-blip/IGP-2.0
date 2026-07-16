import { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Props = {
  emails: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
  hint?: string;
};

function normalizarEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function esEmailValido(raw: string): boolean {
  return RE_EMAIL.test(normalizarEmail(raw));
}

export function EmailChipsInput({ emails, onChange, placeholder, hint }: Props) {
  const [draft, setDraft] = useState('');

  const commitDraft = useCallback(() => {
    const email = normalizarEmail(draft);
    if (!email) return;
    if (!esEmailValido(email)) return;
    if (emails.includes(email)) {
      setDraft('');
      return;
    }
    onChange([...emails, email]);
    setDraft('');
  }, [draft, emails, onChange]);

  const onKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = e.nativeEvent.key;
    if (key === 'Tab' || key === 'Enter' || key === ',') {
      if (Platform.OS === 'web') {
        e.preventDefault?.();
      }
      commitDraft();
    }
  };

  return (
    <View>
      <View style={styles.wrap}>
        {emails.map((email) => (
          <View key={email} style={styles.chip}>
            <Text style={styles.chipText}>{email}</Text>
            <TouchableOpacity
              onPress={() => onChange(emails.filter((x) => x !== email))}
              hitSlop={8}
              accessibilityLabel={`Quitar ${email}`}
            >
              <MaterialIcons name="close" size={14} color="#0369a1" />
            </TouchableOpacity>
          </View>
        ))}
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={(t) => {
            if (t.includes(',') || t.includes(';')) {
              const parts = t.split(/[,;]+/);
              const last = parts.pop() ?? '';
              const nuevos = [...emails];
              for (const p of parts) {
                const email = normalizarEmail(p);
                if (esEmailValido(email) && !nuevos.includes(email)) nuevos.push(email);
              }
              onChange(nuevos);
              setDraft(last);
              return;
            }
            setDraft(t);
          }}
          onSubmitEditing={commitDraft}
          onBlur={commitDraft}
          onKeyPress={onKeyPress}
          placeholder={emails.length === 0 ? placeholder : 'Añadir otro…'}
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 44,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#e0f2fe',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { fontSize: 12, color: '#0369a1', fontWeight: '600' },
  input: {
    flex: 1,
    minWidth: 120,
    fontSize: 14,
    color: '#334155',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  hint: { fontSize: 11, color: '#94a3b8', marginTop: 4, fontStyle: 'italic' },
});
