/**
 * Elección de repetición al crear una tarea o una reunión.
 * Semana y mes admiten varios días. No se edita después: cada fecha ya es una ficha.
 */
import { View, Text, TouchableOpacity } from 'react-native';
import { SelectorDesplegable, type OpcionDesplegable } from '../SelectorDesplegable';
import { estilosFormTasks as form } from './estilosTasks';
import { ETIQUETA_REPETICION } from '../../lib/tasksUi';
import { useBreakpoint } from '../../hooks/useBreakpoint';

const OPCIONES: OpcionDesplegable[] = [
  { id: 'ninguna', titulo: ETIQUETA_REPETICION.ninguna },
  { id: 'diaria', titulo: ETIQUETA_REPETICION.diaria },
  { id: 'semanal', titulo: ETIQUETA_REPETICION.semanal },
  { id: 'mensual', titulo: ETIQUETA_REPETICION.mensual },
  { id: 'ultimo_dia', titulo: ETIQUETA_REPETICION.ultimo_dia },
];

const DIAS = [
  { id: 1, titulo: 'Lun' },
  { id: 2, titulo: 'Mar' },
  { id: 3, titulo: 'Mié' },
  { id: 4, titulo: 'Jue' },
  { id: 5, titulo: 'Vie' },
  { id: 6, titulo: 'Sáb' },
  { id: 7, titulo: 'Dom' },
];

export function diaSemanaDeFecha(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 1;
  const [y, m, d] = iso.split('-').map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

export function diaMesDeFecha(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 1;
  return Number(iso.slice(8, 10));
}

function alternar(lista: number[], dia: number): number[] | null {
  const tiene = lista.includes(dia);
  if (tiene && lista.length === 1) return null;
  const next = tiene ? lista.filter((d) => d !== dia) : [...lista, dia];
  next.sort((a, b) => a - b);
  return next;
}

type Props = {
  frecuencia: string;
  diasSemana: number[];
  diasMes: number[];
  disabled?: boolean;
  onCambiarFrecuencia: (frecuencia: string) => void;
  onCambiarDiasSemana: (dias: number[]) => void;
  onCambiarDiasMes: (dias: number[]) => void;
};

export function SelectorRepeticion({
  frecuencia,
  diasSemana,
  diasMes,
  disabled,
  onCambiarFrecuencia,
  onCambiarDiasSemana,
  onCambiarDiasMes,
}: Props) {
  const { isCompact } = useBreakpoint();
  return (
    <View style={form.group}>
      <SelectorDesplegable
        label="Repetición"
        icono="event-repeat"
        tituloLista="Repetición"
        iconoLista="event-repeat"
        valorId={frecuencia || 'ninguna'}
        opciones={OPCIONES}
        disabled={disabled}
        onSeleccionar={onCambiarFrecuencia}
      />
      {frecuencia === 'semanal' ? (
        <View style={{ marginTop: 10 }}>
          <Text style={form.label}>Días de la semana</Text>
          <View style={form.chipsRow}>
            {DIAS.map((dia) => {
              const activo = diasSemana.includes(dia.id);
              return (
                <TouchableOpacity
                  key={dia.id}
                  style={[form.chip, isCompact && form.chipTactil, activo && form.chipActivo]}
                  disabled={disabled}
                  onPress={() => {
                    const next = alternar(diasSemana, dia.id);
                    if (next) onCambiarDiasSemana(next);
                  }}
                >
                  <Text style={[form.chipTexto, activo && form.chipTextoActivo]}>{dia.titulo}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ) : null}
      {frecuencia === 'mensual' ? (
        <View style={{ marginTop: 10 }}>
          <Text style={form.label}>Días del mes</Text>
          <View style={form.chipsRow}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((dia) => {
              const activo = diasMes.includes(dia);
              return (
                <TouchableOpacity
                  key={dia}
                  style={[form.chip, isCompact && form.chipTactil, activo && form.chipActivo, { minWidth: 40 }]}
                  disabled={disabled}
                  onPress={() => {
                    const next = alternar(diasMes, dia);
                    if (next) onCambiarDiasMes(next);
                  }}
                >
                  <Text style={[form.chipTexto, activo && form.chipTextoActivo]}>{dia}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ) : null}
      {frecuencia && frecuencia !== 'ninguna' ? (
        <Text style={form.help}>
          La agenda muestra cada fecha. En Google Calendar queda un solo evento que se repite, hasta
          400 días.
        </Text>
      ) : null}
    </View>
  );
}
