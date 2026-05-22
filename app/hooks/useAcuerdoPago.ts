import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import type { Acuerdo, LocalAcuerdo, PagoImagen } from '../types/acuerdo';
import { apiFetch, errorMessage } from '../utils/api';

/** Acciones predefinidas que se pueden marcar en un pago/justificante. */
export const ACCIONES_IMAGEN = [
  'Inversión',
  'Prescripción',
  'Visibilidad',
  'Cocktail/Carta',
  'RRSS',
  'Activaciones',
];

type ImgForm = {
  Locales: string[];
  Acciones: string[];
  Importe: string;
  Descripcion: string;
};

const EMPTY_IMG_FORM: ImgForm = { Locales: [], Acciones: [], Importe: '', Descripcion: '' };

type Args = {
  /** Acuerdo activo. Cuando es `null` la lista se vacía y el modal se cierra. */
  seleccionado: Acuerdo | null;
  /** Filtro de locales del usuario actual (`useAuth().localPermitido`). */
  localPermitido: (nombre: string) => boolean;
  /** Callback opcional para propagar errores no recuperables al estado del padre. */
  onError?: (msg: string) => void;
};

export type UseAcuerdoPagoReturn = ReturnType<typeof useAcuerdoPago>;

/**
 * Lógica del flujo de "pago por imagen / justificante" de un acuerdo.
 * Encapsula:
 *  - Lista de pagos del acuerdo activo (`pagosImagen`, `cargar`).
 *  - Catálogo de locales para el dropdown (carga perezosa, filtrado por `localPermitido`).
 *  - Estado del modal de creación/edición (form, archivos, dropdowns internos).
 *  - Handlers de guardar, eliminar y selección de archivos en web.
 *
 * El componente que renderiza es `<AcuerdoPagoModal>`.
 * La lista del panel principal lee `pagosImagen` + `localNombre` directamente del bag.
 */
export function useAcuerdoPago({ seleccionado, localPermitido, onError }: Args) {
  const [pagosImagen, setPagosImagen] = useState<PagoImagen[]>([]);
  const [loadingPagos, setLoadingPagos] = useState(false);

  const [locales, setLocales] = useState<LocalAcuerdo[]>([]);
  const [localesLoaded, setLocalesLoaded] = useState(false);

  const [modalVisible, setModalVisible] = useState(false);
  const [editSK, setEditSK] = useState<string | null>(null);
  const [form, setForm] = useState<ImgForm>(EMPTY_IMG_FORM);
  const [files, setFiles] = useState<{ name: string; data: string }[]>([]);
  const [guardando, setGuardando] = useState(false);

  const [localDropdownOpen, setLocalDropdownOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState('');
  const [accionDropdownOpen, setAccionDropdownOpen] = useState(false);

  useEffect(() => {
    if (!seleccionado) setModalVisible(false);
  }, [seleccionado]);

  const cargar = useCallback(async (acuerdoPK: string) => {
    setLoadingPagos(true);
    try {
      const res = await apiFetch(`/api/acuerdos/${acuerdoPK}/imagen`);
      const data = await res.json();
      if (res.ok) setPagosImagen(data.items || []);
    } catch (_) { /* silencioso: panel sin pagos */ }
    finally { setLoadingPagos(false); }
  }, []);

  const cargarLocales = useCallback(async () => {
    if (localesLoaded) return;
    try {
      const res = await apiFetch('/api/locales?minimal=1');
      const data = await res.json();
      const raw: Record<string, unknown>[] = data.locales || [];
      const list: LocalAcuerdo[] = raw.map((l) => ({
        id: String(l.id_Locales ?? l.Id ?? ''),
        nombre: String(l.nombre ?? l.Nombre ?? ''),
      }));
      list.sort((a, b) => a.nombre.localeCompare(b.nombre));
      setLocales(list.filter((l) => localPermitido(l.nombre)));
      setLocalesLoaded(true);
    } catch (_) { /* silencioso: dropdown vacío */ }
  }, [localesLoaded, localPermitido]);

  const localNombre = useCallback((id: string) => {
    const l = locales.find((loc) => loc.id === id);
    return l ? l.nombre : id;
  }, [locales]);

  const localesFiltrados = useMemo(() => {
    const q = localSearch.trim().toLowerCase();
    if (!q) return locales.slice(0, 60);
    return locales.filter((l) => l.nombre.toLowerCase().includes(q) || l.id.includes(q)).slice(0, 60);
  }, [locales, localSearch]);

  const abrirNuevo = useCallback(() => {
    cargarLocales();
    setEditSK(null);
    setForm(EMPTY_IMG_FORM);
    setFiles([]);
    setLocalDropdownOpen(false);
    setLocalSearch('');
    setAccionDropdownOpen(false);
    setModalVisible(true);
  }, [cargarLocales]);

  const abrirEditar = useCallback((pago: PagoImagen) => {
    cargarLocales();
    setEditSK(pago.SK);
    setForm({
      Locales: pago.Locales || [],
      Acciones: pago.Acciones || [],
      Importe: String(pago.Importe || ''),
      Descripcion: pago.Descripcion || '',
    });
    setFiles(pago.Justificantes || []);
    setLocalDropdownOpen(false);
    setLocalSearch('');
    setAccionDropdownOpen(false);
    setModalVisible(true);
  }, [cargarLocales]);

  const cerrarModal = useCallback(() => {
    setModalVisible(false);
  }, []);

  const guardar = useCallback(async () => {
    if (!seleccionado) return;
    setGuardando(true);
    try {
      const payload = {
        Locales: form.Locales,
        Acciones: form.Acciones,
        Importe: parseFloat(form.Importe) || 0,
        Justificantes: files,
        Descripcion: form.Descripcion,
      };
      const url = editSK
        ? `/api/acuerdos/${seleccionado.PK}/imagen/${editSK}`
        : `/api/acuerdos/${seleccionado.PK}/imagen`;
      const method = editSK ? 'PATCH' : 'POST';
      const res = await apiFetch(url, { method, body: JSON.stringify(payload) });
      if (res.ok) {
        setModalVisible(false);
        await cargar(seleccionado.PK);
      }
    } catch (err: unknown) {
      onError?.(errorMessage(err));
    } finally {
      setGuardando(false);
    }
  }, [seleccionado, form, files, editSK, cargar, onError]);

  const eliminar = useCallback(async (sk: string) => {
    if (!seleccionado) return;
    try {
      await apiFetch(`/api/acuerdos/${seleccionado.PK}/imagen/${sk}`, { method: 'DELETE' });
      await cargar(seleccionado.PK);
    } catch (err: unknown) {
      onError?.(errorMessage(err));
    }
  }, [seleccionado, cargar, onError]);

  /** Marca / desmarca un pago como realizado (optimistic update + PATCH). */
  const marcarRealizado = useCallback(async (sk: string, realizado: boolean) => {
    if (!seleccionado) return;
    setPagosImagen((prev) => prev.map((x) => (x.SK === sk ? { ...x, Realizado: realizado } : x)));
    try {
      await apiFetch(`/api/acuerdos/${seleccionado.PK}/imagen/${sk}`, {
        method: 'PATCH',
        body: JSON.stringify({ Realizado: realizado }),
      });
    } catch (err: unknown) {
      onError?.(errorMessage(err));
      // Si el PATCH falla, recargar para revertir el optimistic update.
      await cargar(seleccionado.PK);
    }
  }, [seleccionado, cargar, onError]);

  /** Web: abre el selector nativo de archivos y los carga como Data URLs. */
  const handleFileSelect = useCallback(() => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      const inputFiles = input.files;
      if (!inputFiles) return;
      Array.from(inputFiles).forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          setFiles((prev) => [...prev, { name: file.name, data: reader.result as string }]);
        };
        reader.readAsDataURL(file);
      });
    };
    input.click();
  }, []);

  return {
    pagosImagen,
    loadingPagos,
    locales,
    localesFiltrados,
    localNombre,
    cargar,
    cargarLocales,
    modalVisible,
    editSK,
    form,
    setForm,
    files,
    setFiles,
    guardando,
    localDropdownOpen,
    setLocalDropdownOpen,
    localSearch,
    setLocalSearch,
    accionDropdownOpen,
    setAccionDropdownOpen,
    abrirNuevo,
    abrirEditar,
    cerrarModal,
    guardar,
    eliminar,
    marcarRealizado,
    handleFileSelect,
  };
}
