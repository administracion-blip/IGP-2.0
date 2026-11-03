/**
 * PDF de un pedido de proveedor del conteo de stock máximo.
 * Se genera en el cliente. El zip de todos los proveedores también.
 */

import { Platform } from 'react-native';
import type { jsPDF } from 'jspdf';
import { formatMoneda } from '../utils/formatMoneda';

export type LineaPedidoPdf = {
  nombre: string;
  cantidad: number;
  unit: string;
  costeUnitario: number | null;
};

export type PedidoPdf = {
  proveedorNombre: string;
  almacenNombre: string;
  fecha: string;
  estado: string;
  serie?: string | null;
  number?: number | string | null;
  lineas: LineaPedidoPdf[];
};

type AutoTable = typeof import('jspdf-autotable').default;

const ESTADO: Record<string, string> = {
  generado: 'Generado',
  enviando: 'Enviando',
  pedido: 'Pedido',
  confirmado: 'Confirmado',
};

export function slugArchivo(nombre: string, vacio: string): string {
  const s = String(nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || vacio;
}

function diaArchivo(fecha: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : 'sin-fecha';
}

export function nombrePdfPedido(proveedor: string, almacen: string, fecha: string): string {
  return `Pedido_${slugArchivo(proveedor, 'Proveedor')}_${slugArchivo(almacen, 'Almacen')}_${diaArchivo(fecha)}.pdf`;
}

export function nombreZipPedidos(almacen: string, fecha: string): string {
  return `Pedidos_${slugArchivo(almacen, 'Almacen')}_${diaArchivo(fecha)}.zip`;
}

function eurPdf(n: number): string {
  return `${formatMoneda(n, { sinSimbolo: true })} EUR`;
}

function qtyPdf(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-ES', { maximumFractionDigits: 3 });
}

function importeLinea(linea: LineaPedidoPdf): number | null {
  const precio = Number(linea.costeUnitario);
  if (!Number.isFinite(precio)) return null;
  return Math.round(linea.cantidad * precio * 100) / 100;
}

async function documento(pedido: PedidoPdf): Promise<{ doc: jsPDF; filename: string }> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const filename = nombrePdfPedido(pedido.proveedorNombre, pedido.almacenNombre, pedido.fecha);
  const lineas = pedido.lineas || [];
  const importes = lineas.map(importeLinea);
  const conPrecio = importes.some((n) => n != null);
  const total = importes.reduce<number>((acc, n) => acc + (n ?? 0), 0);
  const numero = pedido.number == null || String(pedido.number).trim() === ''
    ? ''
    : `${pedido.serie || 'MIA'} ${pedido.number}`;

  let y = 16;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text('Pedido de aprovisionamiento', 14, y);
  y += 8;
  doc.setFontSize(12);
  doc.text(pedido.proveedorNombre || 'Proveedor', 14, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text(pedido.almacenNombre || 'Almacén', 14, y);
  y += 4.5;
  doc.text(`Fecha: ${diaArchivo(pedido.fecha) === 'sin-fecha' ? '—' : pedido.fecha.split('-').reverse().join('/')}`, 14, y);
  y += 4.5;
  doc.text(`Estado: ${ESTADO[pedido.estado] || pedido.estado || '—'}`, 14, y);
  y += 4.5;
  doc.text(numero ? `Pedido: ${numero}` : 'Pedido: sin número', 14, y);
  y += 4.5;
  doc.text(
    conPrecio ? `Importe: ${eurPdf(total)} · ${lineas.length} líneas` : `${lineas.length} líneas · sin precio`,
    14,
    y,
  );
  y += 6;
  doc.setTextColor(0);

  const tabla = autoTable as AutoTable;
  tabla(doc, {
    startY: y,
    head: [['Producto', 'Cantidad', 'Unidad', 'Importe']],
    body: lineas.length
      ? lineas.map((linea, i) => [
        linea.nombre || '—',
        qtyPdf(linea.cantidad),
        linea.unit || '—',
        importes[i] == null ? '—' : eurPdf(importes[i] as number),
      ])
      : [['No hay líneas para pedir', '—', '—', '—']],
    styles: { fontSize: 8, cellPadding: 1.8 },
    headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    columnStyles: {
      1: { halign: 'right', cellWidth: 28 },
      2: { cellWidth: 28 },
      3: { halign: 'right', cellWidth: 32 },
    },
    margin: { left: 14, right: 14 },
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text(
      `Pág. ${i}/${pages} · ${pedido.proveedorNombre || 'Proveedor'}`,
      14,
      doc.internal.pageSize.getHeight() - 8,
    );
  }
  return { doc, filename };
}

function aBase64(datos: Uint8Array): string {
  const tabla = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < datos.length; i += 3) {
    const a = datos[i];
    const b = i + 1 < datos.length ? datos[i + 1] : 0;
    const c = i + 2 < datos.length ? datos[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += tabla[(triple >> 18) & 63];
    out += tabla[(triple >> 12) & 63];
    out += i + 1 < datos.length ? tabla[(triple >> 6) & 63] : '=';
    out += i + 2 < datos.length ? tabla[triple & 63] : '=';
  }
  return out;
}

async function bytesDe(doc: jsPDF): Promise<Uint8Array> {
  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}

async function guardarBytes(nombre: string, datos: Uint8Array, mime: string): Promise<void> {
  if (Platform.OS === 'web') {
    const copia = new Uint8Array(datos);
    const blob = new Blob([copia.buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
    return;
  }
  const FileSystemLegacy = await import('expo-file-system/legacy');
  const Sharing = await import('expo-sharing');
  const fileUri = `${FileSystemLegacy.cacheDirectory ?? ''}${nombre}`;
  await FileSystemLegacy.writeAsStringAsync(fileUri, aBase64(datos), {
    encoding: FileSystemLegacy.EncodingType.Base64,
  });
  await Sharing.shareAsync(fileUri, { mimeType: mime, dialogTitle: nombre });
}

export async function descargarPdfPedido(pedido: PedidoPdf): Promise<void> {
  const { doc, filename } = await documento(pedido);
  await guardarBytes(filename, await bytesDe(doc), 'application/pdf');
}

export async function descargarZipPedidos(almacen: string, fecha: string, pedidos: PedidoPdf[]): Promise<void> {
  const modulo = await import('jszip') as unknown as { default?: new () => import('jszip') };
  const JSZip = modulo.default ?? (modulo as unknown as new () => import('jszip'));
  const zip = new JSZip();
  const usados = new Set<string>();
  for (const pedido of pedidos) {
    const { doc, filename } = await documento({ ...pedido, almacenNombre: almacen, fecha });
    let nombre = filename;
    let n = 2;
    while (usados.has(nombre)) {
      nombre = filename.replace(/\.pdf$/, `-${n}.pdf`);
      n += 1;
    }
    usados.add(nombre);
    zip.file(nombre, await bytesDe(doc));
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  await guardarBytes(nombreZipPedidos(almacen, fecha), bytes, 'application/zip');
}
