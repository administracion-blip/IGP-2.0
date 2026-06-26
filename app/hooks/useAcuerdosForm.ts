import { useCallback, useState } from 'react';
import type { Acuerdo, EmpresaAcuerdo } from '../types/acuerdo';
import { apiFetch, errorMessage } from '../utils/api';
import { fechaEmisionFacturaAIso } from '../utils/formatFecha';

/** Estados válidos en el selector del form. */
export const ESTADOS_ACUERDO = ['Activo', 'Completado', 'Cancelado', 'Vencido'] as const;

/** Estructura editable (todo string para input controlado, sin null). */
export type AcuerdoForm = {
  Nombre: string;
  Marca: string;
  FechaInicio: string;
  FechaFin: string;
  Contacto: string;
  Telefono: string;
  Email: string;
  Notas: string;
  Estado: string;
};

const EMPTY_FORM: AcuerdoForm = {
  Nombre: '',
  Marca: '',
  FechaInicio: '',
  FechaFin: '',
  Contacto: '',
  Telefono: '',
  Email: '',
  Notas: '',
  Estado: 'Activo',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Args = {
  /**
   * Se invoca tras guardar correctamente. `isNew=true` si era un acuerdo
   * nuevo; el padre puede entonces seleccionar el creado y cargar sus
   * subentidades (detalles, pagos, archivos).
   */
  onSaved: (acuerdo: Acuerdo, isNew: boolean) => void | Promise<void>;
  /** Callback opcional para propagar errores de validación o de red al padre. */
  onError?: (msg: string) => void;
};

export type UseAcuerdosFormReturn = ReturnType<typeof useAcuerdosForm>;

/**
 * Lógica del modal de creación / edición de un acuerdo. Encapsula:
 *  - Estado del modal (visibilidad, modo edit/nuevo, form, PK).
 *  - Catálogo de empresas para el selector de marca (carga perezosa).
 *  - Estado del dropdown de marca (visibilidad + búsqueda).
 *  - Validación de fechas y llamada PATCH/POST al backend.
 *
 * El componente que renderiza es `<AcuerdoFormModal>`. La pantalla principal
 * llama `abrirCrear()` desde el botón "Nuevo" y `abrirEditar(a)` desde la
 * acción de editar de cada card.
 */
export function useAcuerdosForm({ onSaved, onError }: Args) {
  const [modalVisible, setModalVisible] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<AcuerdoForm>(EMPTY_FORM);
  const [formPK, setFormPK] = useState('');
  const [guardando, setGuardando] = useState(false);

  const [empresas, setEmpresas] = useState<EmpresaAcuerdo[]>([]);
  const [loadingEmpresas, setLoadingEmpresas] = useState(false);

  const cargarEmpresas = useCallback(async () => {
    if (empresas.length > 0) return;
    setLoadingEmpresas(true);
    try {
      const res = await apiFetch('/api/empresas');
      const data = await res.json();
      const list: EmpresaAcuerdo[] = data.empresas || [];
      list.sort((a, b) => (a.Alias || a.Nombre || '').localeCompare(b.Alias || b.Nombre || ''));
      setEmpresas(list);
    } catch (_) { /* silencioso: dropdown se mostrará vacío */ }
    finally { setLoadingEmpresas(false); }
  }, [empresas.length]);

  const abrirCrear = useCallback(() => {
    setEditId(null);
    setFormPK(crypto.randomUUID());
    setForm(EMPTY_FORM);
    setModalVisible(true);
    cargarEmpresas();
  }, [cargarEmpresas]);

  const abrirEditar = useCallback((a: Acuerdo) => {
    setEditId(a.PK);
    setFormPK(a.PK);
    setForm({
      Nombre: a.Nombre || '',
      Marca: a.Marca || '',
      FechaInicio: fechaEmisionFacturaAIso(a.FechaInicio) ?? '',
      FechaFin: fechaEmisionFacturaAIso(a.FechaFin) ?? '',
      Contacto: a.Contacto || '',
      Telefono: a.Telefono || '',
      Email: a.Email || '',
      Notas: a.Notas || '',
      Estado: a.Estado || 'Activo',
    });
    setModalVisible(true);
    cargarEmpresas();
  }, [cargarEmpresas]);

  const cerrar = useCallback(() => {
    setModalVisible(false);
  }, []);

  const guardar = useCallback(async () => {
    if (!formPK.trim()) return;
    if ((form.FechaInicio && !ISO_DATE_RE.test(form.FechaInicio)) ||
        (form.FechaFin && !ISO_DATE_RE.test(form.FechaFin))) {
      onError?.('Revisa las fechas (formato dd/mm/aaaa)');
      return;
    }
    if (form.FechaInicio && form.FechaFin && form.FechaInicio > form.FechaFin) {
      onError?.('La fecha de inicio no puede ser mayor que la fecha final');
      return;
    }
    setGuardando(true);
    onError?.('');
    try {
      const payload: Record<string, string> = {
        Nombre: form.Nombre,
        Marca: form.Marca,
        FechaInicio: form.FechaInicio,
        FechaFin: form.FechaFin,
        Contacto: form.Contacto,
        Telefono: form.Telefono,
        Email: form.Email,
        Notas: form.Notas,
        Estado: form.Estado,
      };
      const isNew = !editId;
      if (isNew) payload.PK = formPK;
      const url = isNew ? '/api/acuerdos' : `/api/acuerdos/${editId}`;
      const method = isNew ? 'POST' : 'PATCH';
      const res = await apiFetch(url, { method, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      setModalVisible(false);
      const acuerdo = isNew ? (data.item as Acuerdo) : ({ ...form, PK: editId } as unknown as Acuerdo);
      await onSaved(acuerdo, isNew);
    } catch (err: unknown) {
      onError?.(errorMessage(err));
    } finally {
      setGuardando(false);
    }
  }, [form, formPK, editId, onSaved, onError]);

  return {
    modalVisible,
    editId,
    form,
    setForm,
    formPK,
    guardando,
    empresas,
    loadingEmpresas,
    abrirCrear,
    abrirEditar,
    cerrar,
    guardar,
  };
}
