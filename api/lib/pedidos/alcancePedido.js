/**
 * Alcance por local de un pedido: lo ve y actúa sobre él quien tenga su local
 * destino (`LocalId`) o un local dueño de su almacén origen (`AlmacenOrigenId`,
 * vía mapa local ↔ almacén), porque el almacén prepara los pedidos de todos los
 * locales. La decisión sigue en `lib/alcance.js` / `lib/alcanceLecturas.js`.
 *
 * Pedido inexistente (`null`): sin local, denegado a restringidos.
 */

import { cargarAlcance, permiteLocal, permiteAlgunLocal } from '../alcance.js';
import { filtrarLecturaPorLocal, permiteLecturaLocal } from '../alcanceLecturas.js';
import { refsAlmacen } from '../alcanceAlmacenes.js';

function refDestino(pedido) {
  return { idLocal: pedido?.LocalId };
}

async function refsPedido(req, pedido) {
  return [refDestino(pedido), ...(await refsAlmacen(req, pedido?.AlmacenOrigenId))];
}

/** Escrituras y acciones sobre el pedido: bloquean siempre. */
export async function permitePedido(req, pedido) {
  const alcance = await cargarAlcance(req);
  if (permiteLocal(alcance, refDestino(pedido))) return true;
  return permiteAlgunLocal(alcance, await refsPedido(req, pedido));
}

/**
 * Pedido tal como va a quedar escrito al crearlo o editarlo: tiene que ser suyo y,
 * si es una devolución, además el local que devuelve (`LocalId`), porque la
 * devolución resta en las ventas y el rappel de ese local. Ser dueño del almacén
 * origen no basta para dejarla a nombre de otro.
 */
export async function permiteEscribirPedido(req, pedido) {
  if (!(await permitePedido(req, pedido))) return false;
  if (String(pedido?.Tipo ?? '').trim() !== 'Devolucion') return true;
  return permiteLocal(await cargarAlcance(req), refDestino(pedido));
}

/** Lectura de un pedido: sigue `modoLecturas()`. */
export async function permiteLecturaPedido(req, pedido) {
  const alcance = await cargarAlcance(req);
  if (permiteLocal(alcance, refDestino(pedido))) return true;
  return permiteLecturaLocal(req, await refsPedido(req, pedido));
}

/** Listado de pedidos: todo + aviso en 'observar'; solo los permitidos en 'bloquear'. */
export async function filtrarPedidosLectura(req, pedidos) {
  const lista = Array.isArray(pedidos) ? pedidos : [];
  const alcance = await cargarAlcance(req);
  if (alcance.global) return lista;
  const refs = new Map();
  for (const p of lista) {
    refs.set(p, permiteLocal(alcance, refDestino(p)) ? refDestino(p) : await refsPedido(req, p));
  }
  return filtrarLecturaPorLocal(req, lista, (p) => refs.get(p));
}
