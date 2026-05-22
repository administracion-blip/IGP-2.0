import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { Acuerdo } from '../types/acuerdo';
import { apiFetch, errorMessage } from '../utils/api';
import {
  NOTAS_CONTENIDO_FONT_SIZE,
  fechaHoyDmy,
  plainNotasToHtmlForEditor,
} from '../lib/acuerdoNotas';

type Args = {
  /** Acuerdo cuyas notas se editan. Si pasa a `null` el modal se cierra automáticamente. */
  seleccionado: Acuerdo | null;
  /** Callback ejecutado tras guardar exitosamente (típicamente recargar listado). */
  onSaved: () => Promise<void> | void;
};

export type UseAcuerdoNotasReturn = ReturnType<typeof useAcuerdoNotas>;

/**
 * Lógica del modal de edición de notas de un acuerdo. Encapsula:
 *  - Visibilidad / draft / error / flag de guardado.
 *  - Ref del editor `contentEditable` web.
 *  - Sincronización del HTML con `seleccionado.Notas` al abrir (web).
 *  - Cierre automático cuando la pantalla principal pierde el `seleccionado`.
 *  - Atajo Ctrl+espacio para insertar la fecha del día (handler nativo y web).
 *  - Llamada PATCH al backend y callback de recarga.
 *
 * El componente que renderiza es `<AcuerdoNotasModal>`, que recibe este bag.
 */
export function useAcuerdoNotas({ seleccionado, onSaved }: Args) {
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const editorWebRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!seleccionado) setVisible(false);
  }, [seleccionado]);

  useLayoutEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const el = editorWebRef.current;
    if (!el) return;
    el.innerHTML = plainNotasToHtmlForEditor(seleccionado?.Notas || '');
  }, [visible, seleccionado?.PK, seleccionado?.Notas]);

  const abrir = useCallback(() => {
    if (!seleccionado) return;
    setDraft(seleccionado.Notas || '');
    setError('');
    setVisible(true);
  }, [seleccionado]);

  const cerrar = useCallback(() => {
    if (guardando) return;
    setVisible(false);
  }, [guardando]);

  const guardar = useCallback(async () => {
    if (!seleccionado) return;
    setGuardando(true);
    setError('');
    const textoNotas =
      Platform.OS === 'web' && editorWebRef.current
        ? editorWebRef.current.innerText.trim()
        : draft.trim();
    try {
      const res = await apiFetch(`/api/acuerdos/${encodeURIComponent(seleccionado.PK)}`, {
        method: 'PATCH',
        body: JSON.stringify({ Notas: textoNotas }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      setVisible(false);
      await onSaved();
    } catch (e: unknown) {
      setError(errorMessage(e, 'Error'));
    } finally {
      setGuardando(false);
    }
  }, [seleccionado, draft, onSaved]);

  /** Nativo: Ctrl+espacio inserta `dd/mm/aaaa - ` en el TextInput.
   *  Handler defensivo cross-platform: el `onKeyPress` de RN tiene shape
   *  distinto del KeyboardEvent DOM, así que se intentan ambos. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mezcla runtime nativo/DOM
  const handleKeyPress = useCallback((e: any) => {
    if (Platform.OS === 'web') return;
    if (guardando) return;
    const dom = e?.nativeEvent ?? e;
    const ctrl = !!(dom?.ctrlKey ?? e?.ctrlKey);
    const isSpace =
      dom?.code === 'Space' || dom?.key === ' ' || e?.code === 'Space' || e?.key === ' ';
    if (!ctrl || !isSpace) return;
    e?.preventDefault?.();
    if (typeof dom?.preventDefault === 'function') dom.preventDefault();
    const insert = `${fechaHoyDmy()} - `;
    const target = (e?.target ?? dom?.target) as HTMLTextAreaElement;
    if (target && typeof target.selectionStart === 'number') {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const v = String(target.value ?? '');
      const next = v.slice(0, start) + insert + v.slice(end);
      setDraft(next);
      requestAnimationFrame(() => {
        try {
          const pos = start + insert.length;
          target.setSelectionRange(pos, pos);
        } catch {
          /* noop */
        }
      });
    } else {
      setDraft((prev) => (prev ? `${prev}${insert}` : insert));
    }
  }, [guardando]);

  /** Web: Ctrl+espacio inserta el span con la fecha resaltada en el editor. */
  const handleWebKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (guardando) return;
      if (e.ctrlKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        const html = `<span style="font-size:${NOTAS_CONTENIDO_FONT_SIZE}px;color:#2563eb;font-weight:700;font-style:italic">${fechaHoyDmy()}</span> - `;
        document.execCommand('insertHTML', false, html);
      }
    },
    [guardando],
  );

  return {
    visible,
    draft,
    setDraft,
    error,
    guardando,
    editorWebRef,
    abrir,
    cerrar,
    guardar,
    handleKeyPress,
    handleWebKeyDown,
  };
}
