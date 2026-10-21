import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import {
  consultarCreditoSinAplicar,
  type CreditoSinAplicarRemesa,
  type GrupoCreditoRemesa,
} from '../../lib/creditoRemesa';
import { formatMoneda } from '../../utils/facturacion';

const MAX_LINEAS = 6;

export type EstadoAvisoCreditoRemesa =
  | { fase: 'idle' }
  | { fase: 'cargando' }
  | { fase: 'error' }
  | { fase: 'ok'; datos: CreditoSinAplicarRemesa };

function claveFacturaIds(facturaIds: readonly string[]): string {
  return [...new Set(facturaIds.map((id) => String(id).trim()).filter(Boolean))].sort().join('\n');
}

/**
 * Consulta el crédito sin aplicar al abrir el modal y si cambia el conjunto de
 * facturas con el modal abierto. Con el modal cerrado no llama al API.
 */
export function useAvisoCreditoRemesa(
  visible: boolean,
  facturaIds: readonly string[],
): EstadoAvisoCreditoRemesa {
  const idsKey = claveFacturaIds(facturaIds);
  const [cicloAbierto, setCicloAbierto] = useState(() => (visible ? 1 : 0));
  const [visibleAnterior, setVisibleAnterior] = useState(visible);
  if (visible !== visibleAnterior) {
    setVisibleAnterior(visible);
    if (visible) setCicloAbierto((n) => n + 1);
  }

  const [resuelto, setResuelto] = useState<{
    ciclo: number;
    idsKey: string;
    estado: EstadoAvisoCreditoRemesa;
  } | null>(null);

  useEffect(() => {
    if (!visible) return;
    const ciclo = cicloAbierto;
    const clave = idsKey;
    const ids = clave ? clave.split('\n') : [];
    const ac = new AbortController();
    let vivo = true;

    if (ids.length === 0) {
      setResuelto({
        ciclo,
        idsKey: clave,
        estado: { fase: 'ok', datos: { grupos: [], total: 0 } },
      });
      return () => {
        vivo = false;
      };
    }

    setResuelto({ ciclo, idsKey: clave, estado: { fase: 'cargando' } });
    consultarCreditoSinAplicar(ids, ac.signal)
      .then((datos) => {
        if (!vivo) return;
        setResuelto({ ciclo, idsKey: clave, estado: { fase: 'ok', datos } });
      })
      .catch(() => {
        if (!vivo) return;
        setResuelto({ ciclo, idsKey: clave, estado: { fase: 'error' } });
      });

    return () => {
      vivo = false;
      ac.abort();
    };
  }, [visible, cicloAbierto, idsKey]);

  if (!visible) return { fase: 'idle' };
  if (!resuelto || resuelto.ciclo !== cicloAbierto || resuelto.idsKey !== idsKey) {
    return { fase: 'cargando' };
  }
  return resuelto.estado;
}

type LineaPlana = {
  grupo: GrupoCreditoRemesa;
  idLinea: string;
  numero: string;
  motivo: 'exceso' | 'abono';
  importe: number;
};

function aplanarLineas(grupos: GrupoCreditoRemesa[]): LineaPlana[] {
  const planas: LineaPlana[] = [];
  grupos.forEach((grupo, gi) => {
    grupo.lineas.forEach((linea, li) => {
      planas.push({
        grupo,
        idLinea: `${linea.id_factura}-${gi}-${li}`,
        numero: linea.numero,
        motivo: linea.motivo,
        importe: linea.importe,
      });
    });
  });
  return planas;
}

type Props = {
  estado: EstadoAvisoCreditoRemesa;
  /** Hay más de una sociedad ordenante en la remesa. */
  mostrarSociedad: boolean;
};

export function AvisoCreditoRemesa({ estado, mostrarSociedad }: Props) {
  if (estado.fase === 'idle') return null;

  if (estado.fase === 'cargando') {
    return (
      <View style={styles.cargando}>
        <ActivityIndicator size="small" color="#64748b" />
        <Text style={styles.cargandoTexto}>Comprobando abonos y excesos…</Text>
      </View>
    );
  }

  if (estado.fase === 'error') {
    return (
      <View style={styles.caja}>
        <MaterialIcons name="warning" size={18} color="#dc2626" />
        <Text style={styles.errorTexto}>
          No se han podido comprobar abonos ni excesos. Revísalos antes de crear la remesa.
        </Text>
      </View>
    );
  }

  if (!(estado.datos.total > 0)) return null;

  const planas = aplanarLineas(estado.datos.grupos);
  const visibles = planas.slice(0, MAX_LINEAS);
  const ocultas = planas.length - visibles.length;

  return (
    <View style={styles.caja}>
      <MaterialIcons name="warning" size={18} color="#dc2626" style={styles.icono} />
      <View style={styles.cuerpo}>
        <Text style={styles.titulo}>
          Hay crédito sin aplicar. Si continúas puedes volver a pagar de más.
        </Text>
        <Text style={styles.texto}>
          Estos proveedores tienen abonos o pagos en exceso que esta remesa no descuenta. La transferencia saldrá por el saldo pendiente entero.
        </Text>
        {visibles.map((linea, index) => {
          const nuevaCabecera = linea.grupo !== visibles[index - 1]?.grupo;
          const importe = linea.motivo === 'abono' ? -Math.abs(linea.importe) : Math.abs(linea.importe);
          return (
            <View key={linea.idLinea}>
              {nuevaCabecera ? (
                <Text style={styles.proveedor}>
                  {linea.grupo.proveedorNombre}
                  {mostrarSociedad && linea.grupo.sociedadNombre ? (
                    <Text style={styles.sociedad}> · {linea.grupo.sociedadNombre}</Text>
                  ) : null}
                </Text>
              ) : null}
              <View style={styles.linea}>
                <Text style={styles.lineaTexto}>
                  · Factura {linea.numero} — {linea.motivo === 'exceso' ? 'Pagada en exceso' : 'Abono'}
                </Text>
                <Text style={styles.importe}>{formatMoneda(importe)}</Text>
              </View>
            </View>
          );
        })}
        {ocultas > 0 ? (
          <Text style={styles.mas}>… y {ocultas} más</Text>
        ) : null}
        <Text style={styles.pie}>
          Crédito sin aplicar: {formatMoneda(estado.datos.total)}. La remesa no lo resta.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cargando: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  cargandoTexto: {
    fontSize: 12,
    color: '#64748b',
  },
  caja: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    width: '100%',
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderLeftWidth: 4,
    borderLeftColor: '#dc2626',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  icono: { marginTop: 1 },
  cuerpo: { flex: 1 },
  titulo: {
    fontSize: 13,
    fontWeight: '700',
    color: '#dc2626',
    marginBottom: 4,
  },
  texto: {
    fontSize: 12,
    color: '#7f1d1d',
    lineHeight: 17,
    marginBottom: 8,
  },
  errorTexto: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: '#7f1d1d',
    lineHeight: 17,
  },
  proveedor: {
    fontSize: 12,
    fontWeight: '600',
    color: '#7f1d1d',
    marginTop: 6,
  },
  sociedad: {
    fontSize: 12,
    fontWeight: '400',
    color: '#64748b',
  },
  linea: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 2,
  },
  lineaTexto: {
    flex: 1,
    fontSize: 12,
    color: '#7f1d1d',
    lineHeight: 16,
  },
  importe: {
    fontSize: 12,
    fontWeight: '600',
    color: '#dc2626',
  },
  mas: {
    fontSize: 12,
    color: '#7f1d1d',
    marginTop: 4,
  },
  pie: {
    fontSize: 12,
    fontWeight: '600',
    color: '#991b1b',
    marginTop: 8,
  },
});
