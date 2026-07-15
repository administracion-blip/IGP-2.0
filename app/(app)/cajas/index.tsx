import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { EstrellaFavorito } from '../../components/EstrellaFavorito';

const OPCIONES: { id: string; label: string; icon: React.ComponentProps<typeof MaterialIcons>['name']; descripcion: string; permiso: string }[] = [
  {
    id: 'cierres-teoricos',
    label: 'Cierres de ventas teóricas',
    icon: 'receipt-long',
    descripcion: 'Cierres teóricos de ventas',
    permiso: 'cierres.ver',
  },
  {
    id: 'revision-formas-pago',
    label: 'Revisión formas de pago',
    icon: 'payments',
    descripcion: 'Desglose de pagos por ticket (consulta en vivo a Ágora)',
    permiso: 'cierres.ver',
  },
  {
    id: 'arqueo-caja',
    label: 'Arqueo de Caja',
    icon: 'account-balance-wallet',
    descripcion: 'Arqueo y conteo de caja',
    permiso: 'cierres.ver',
  },
  {
    id: 'movimientos-caja',
    label: 'Movimientos de caja',
    icon: 'swap-horiz',
    descripcion: 'Retiradas de efectivo y transferencias de prepago por TPV',
    permiso: 'cierres.ver',
  },
  {
    id: 'revision-cajas',
    label: 'Revisión de cajas',
    icon: 'fact-check',
    descripcion: 'Centro de mando: teórico vs real por local, TPV y día con alertas',
    permiso: 'cierres.ver',
  },
  {
    id: 'comparativa-fechas-cajas',
    label: 'Comparativa Fechas Cajas',
    icon: 'event',
    descripcion: 'Festivos y estimaciones de ventas (Igp_Gestionfestivosyestimaciones)',
    permiso: 'comparativa.ver',
  },
  {
    id: 'objetivos',
    label: 'Objetivos',
    icon: 'flag',
    descripcion: 'Comparativa de facturación real vs año anterior por local',
    permiso: 'objetivos.ver',
  },
  {
    id: 'incentivos-producto',
    label: 'Incentivos por producto',
    icon: 'redeem',
    descripcion: 'Premios al equipo por vender productos concretos',
    permiso: 'incentivos_producto.ver',
  },
  {
    id: 'franjas-horarias',
    label: 'Plantillas de franjas',
    icon: 'schedule',
    descripcion: 'Franjas horarias reutilizables para el desglose de ventas por horas en Objetivos',
    permiso: 'objetivos.ver',
  },
  {
    id: 'control-excepciones',
    label: 'Control de Excepciones',
    icon: 'rule',
    descripcion: 'Invitaciones, descuentos manuales y anulaciones por fecha y local',
    permiso: 'excepciones.ver',
  },
  {
    id: 'top',
    label: 'Top',
    icon: 'emoji-events',
    descripcion: 'Top ventas locales, objetivos, camareros y clientes por rango de fechas',
    permiso: 'top.ver',
  },
];

export default function CajasIndexScreen() {
  const router = useRouter();
  const { hasPermiso } = useAuth();

  function handleSeleccionar(id: string) {
    if (id === 'cierres-teoricos') router.push('/cajas/cierres-teoricos');
    if (id === 'revision-formas-pago') router.push('/cajas/revision-formas-pago');
    if (id === 'arqueo-caja') router.push('/cajas/arqueo-caja');
    if (id === 'movimientos-caja') router.push('/cajas/movimientos-caja');
    if (id === 'revision-cajas') router.push('/cajas/revision-cajas');
    if (id === 'comparativa-fechas-cajas') router.push('/cajas/comparativa-fechas-cajas');
    if (id === 'objetivos') router.push('/cajas/objetivos');
    if (id === 'incentivos-producto') router.push('/cajas/incentivos-producto');
    if (id === 'franjas-horarias') router.push('/cajas/franjas-horarias');
    if (id === 'control-excepciones') router.push('/cajas/control-excepciones');
    if (id === 'top') router.push('/cajas/top');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Cajas</Text>
      <Text style={styles.subtitle}>Selecciona una opción</Text>

      <View style={styles.grid}>
        {OPCIONES.filter((o) => hasPermiso(o.permiso)).map((opcion) => (
          <TouchableOpacity
            key={opcion.id}
            style={styles.card}
            onPress={() => handleSeleccionar(opcion.id)}
            activeOpacity={0.7}
          >
            <View style={styles.cardLeft}>
              <EstrellaFavorito
                favorito={{ route: `/cajas/${opcion.id}`, label: opcion.label, icon: opcion.icon, permiso: opcion.permiso }}
              />
              <MaterialIcons name={opcion.icon} size={24} color="#0ea5e9" />
              <Text style={styles.cardLabel}>{opcion.label}</Text>
            </View>
            <Text style={styles.cardDescripcion} numberOfLines={2}>
              {opcion.descripcion}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '47%',
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 10,
  },
  cardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  cardLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: '#334155',
  },
  cardDescripcion: {
    flex: 1,
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'italic',
    color: '#94a3b8',
    marginLeft: 8,
    textAlign: 'right',
  },
});
