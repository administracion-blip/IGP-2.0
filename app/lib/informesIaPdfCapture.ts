/**
 * PDF de Informes IA capturando la vista web (html-to-image + jsPDF paginado).
 * Preferencia: secciones `[data-pdf-section]` enteras (sin partir). Fallback: slice vertical.
 * Si una sección supera la página, se parte solo esa captura (mejor que encoger ilegible).
 */

import { Platform } from 'react-native';
import { toPng } from 'html-to-image';

const MARGIN_MM = 10;
const GAP_MM = 3;
const PIXEL_RATIO = 2;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar la captura del informe'));
    img.src = dataUrl;
  });
}

function slugFile(fileBase: string): string {
  const fecha = new Date().toISOString().slice(0, 10);
  const slug = String(fileBase || 'informe_ia')
    .replace(/\s+/g, '_')
    .replace(/[^\w\-]/g, '')
    .slice(0, 48) || 'informe_ia';
  return `${slug}_${fecha}.pdf`;
}

type CapturaSeccion = {
  id: string;
  dataUrl: string;
  pxW: number;
  pxH: number;
};

type PiezaPdf = {
  id: string;
  dataUrl: string;
  wMm: number;
  hMm: number;
};

async function capturarSeccion(el: HTMLElement): Promise<CapturaSeccion> {
  const id = el.getAttribute('data-pdf-section') || '';
  const dataUrl = await toPng(el, { cacheBust: true, pixelRatio: PIXEL_RATIO });
  const img = await loadImage(dataUrl);
  const pxW = img.naturalWidth || img.width;
  const pxH = img.naturalHeight || img.height;
  if (!pxW || !pxH) {
    throw new Error(`La sección «${id || 'sin id'}» está vacía`);
  }
  return { id, dataUrl, pxW, pxH };
}

/** Altura en mm a ancho útil completo (sin encoger). */
function alturaMm(pxW: number, pxH: number, usableW: number): number {
  return pxH * (usableW / pxW);
}

/**
 * Si la captura cabe en una página → una pieza.
 * Si supera usableH → slices verticales de esa sección (no del informe entero).
 */
async function piezasDesdeCaptura(
  cap: CapturaSeccion,
  usableW: number,
  usableH: number,
): Promise<PiezaPdf[]> {
  const hMm = alturaMm(cap.pxW, cap.pxH, usableW);
  if (hMm <= usableH + 0.05) {
    return [{ id: cap.id, dataUrl: cap.dataUrl, wMm: usableW, hMm }];
  }

  const mmPerPx = usableW / cap.pxW;
  const pageHeightPx = usableH / mmPerPx;
  const img = await loadImage(cap.dataUrl);
  const out: PiezaPdf[] = [];
  let sourceY = 0;

  while (sourceY < cap.pxH) {
    const sliceH = Math.min(pageHeightPx, cap.pxH - sourceY);
    const canvas = document.createElement('canvas');
    canvas.width = cap.pxW;
    canvas.height = Math.max(1, Math.ceil(sliceH));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`No se pudo partir la sección «${cap.id || 'sin id'}»`);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, sourceY, cap.pxW, sliceH, 0, 0, cap.pxW, sliceH);

    out.push({
      id: cap.id,
      dataUrl: canvas.toDataURL('image/png'),
      wMm: usableW,
      hMm: sliceH * mmPerPx,
    });
    sourceY += sliceH;
  }

  return out;
}

async function descargarPdfPorSlices(
  node: HTMLElement,
  fileBase: string,
  JsPDF: typeof import('jspdf').jsPDF,
): Promise<void> {
  const dataUrl = await toPng(node, { cacheBust: true, pixelRatio: PIXEL_RATIO });
  const img = await loadImage(dataUrl);
  const pxW = img.naturalWidth || img.width;
  const pxH = img.naturalHeight || img.height;
  if (!pxW || !pxH) {
    throw new Error('La captura del informe está vacía');
  }

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const usableW = pageW - MARGIN_MM * 2;
  const usableH = pageH - MARGIN_MM * 2;
  const mmPerPx = usableW / pxW;
  const pageHeightPx = usableH / mmPerPx;

  let sourceY = 0;
  let pageIndex = 0;

  while (sourceY < pxH) {
    if (pageIndex > 0) doc.addPage();

    const sliceH = Math.min(pageHeightPx, pxH - sourceY);
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = Math.max(1, Math.ceil(sliceH));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo preparar la página del PDF');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, sourceY, pxW, sliceH, 0, 0, pxW, sliceH);

    const sliceData = canvas.toDataURL('image/png');
    const sliceHmm = sliceH * mmPerPx;
    doc.addImage(sliceData, 'PNG', MARGIN_MM, MARGIN_MM, usableW, sliceHmm);

    sourceY += sliceH;
    pageIndex += 1;
  }

  doc.save(slugFile(fileBase));
}

async function descargarPdfPorSecciones(
  secciones: HTMLElement[],
  fileBase: string,
  JsPDF: typeof import('jspdf').jsPDF,
): Promise<void> {
  const captures: CapturaSeccion[] = [];
  for (const el of secciones) {
    // eslint-disable-next-line no-await-in-loop
    captures.push(await capturarSeccion(el));
  }

  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const usableW = pageW - MARGIN_MM * 2;
  const usableH = pageH - MARGIN_MM * 2;

  let y = MARGIN_MM;
  let pageEmpty = true;

  const nuevaPagina = () => {
    doc.addPage();
    y = MARGIN_MM;
    pageEmpty = true;
  };

  const colocarPieza = (pieza: PiezaPdf) => {
    const remaining = pageH - MARGIN_MM - y;
    if (!pageEmpty && pieza.hMm > remaining) {
      nuevaPagina();
    }
    const x = MARGIN_MM + (usableW - pieza.wMm) / 2;
    doc.addImage(pieza.dataUrl, 'PNG', x, y, pieza.wMm, pieza.hMm);
    y += pieza.hMm + GAP_MM;
    pageEmpty = false;
  };

  const colocarCaptura = async (cap: CapturaSeccion) => {
    const piezas = await piezasDesdeCaptura(cap, usableW, usableH);
    for (const pieza of piezas) {
      colocarPieza(pieza);
    }
  };

  for (let i = 0; i < captures.length; i += 1) {
    const cap = captures[i];
    const next = captures[i + 1];

    // Pág.1: intentar cabecera + objetivos-grupo juntos; si grupo no cabe → página nueva para grupo
    if (
      cap.id === 'cabecera-kpis-facturacion'
      && next?.id === 'objetivos-grupo'
    ) {
      // eslint-disable-next-line no-await-in-loop
      await colocarCaptura(cap);
      const grupoHMm = Math.min(alturaMm(next.pxW, next.pxH, usableW), usableH);
      const remaining = pageH - MARGIN_MM - y;
      if (grupoHMm > remaining) {
        nuevaPagina();
      }
      // eslint-disable-next-line no-await-in-loop
      await colocarCaptura(next);
      i += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await colocarCaptura(cap);
  }

  doc.save(slugFile(fileBase));
}

/**
 * Genera y descarga un PDF A4 portrait a partir de un nodo DOM (solo web).
 * Usa `[data-pdf-section]` en orden DOM (secciones enteras). Sin secciones → slice vertical.
 * RN Web: dataSet.pdfSection → atributo data-pdf-section.
 */
export async function descargarPdfDesdeNodo(node: HTMLElement, fileBase: string): Promise<void> {
  if (Platform.OS !== 'web') {
    throw new Error('Disponible en web');
  }
  if (typeof document === 'undefined') {
    throw new Error('Disponible en web');
  }

  const { jsPDF: JsPDF } = await import('jspdf');
  const secciones = Array.from(
    node.querySelectorAll('[data-pdf-section]'),
  ) as HTMLElement[];

  if (secciones.length === 0) {
    await descargarPdfPorSlices(node, fileBase, JsPDF);
    return;
  }

  await descargarPdfPorSecciones(secciones, fileBase, JsPDF);
}
