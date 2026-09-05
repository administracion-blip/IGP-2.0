/**
 * Acta de reunión en PDF (Fase 4).
 *
 * Genera el PDF con jsPDF (mismo patrón que informes/cashflow), lo sube a
 * `tasks/reuniones/<id>/acta.pdf` con AES256 y persiste `acta_pdf_s3_key`.
 * Cada GET regenera y sobrescribe para no servir un PDF stale.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../../db.js';
import { PK, SK } from '../tipos.js';
import { obtenerFichaReunion } from '../reuniones.js';

const PREFIJO_S3 = process.env.TASKS_S3_PREFIX || 'tasks';
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });

const HEAD_COLOR = [14, 165, 233];
const COLOR_BORRADOR = [185, 28, 28];

/** Clave canónica: `tasks/reuniones/<id>/acta.pdf`. */
export function claveActaPdfReunion(idReunion) {
  const id = String(idReunion || '').trim();
  return `${PREFIJO_S3}/reuniones/${id}/acta.pdf`;
}

/**
 * Parámetros PutObject del acta (SSE explícito, como enlaces/adjuntos).
 */
export function parametrosSubidaActaPdf({ key, cuerpo }) {
  return {
    Bucket: S3_BUCKET,
    Key: key,
    Body: cuerpo,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'AES256',
  };
}

export const almacenActaPdf = {
  putPdf: async ({ key, cuerpo }) => {
    await s3.send(new PutObjectCommand(parametrosSubidaActaPdf({ key, cuerpo })));
  },
};

/** Sustituye parte del almacén y devuelve la función que lo restaura. */
export function configurarAlmacenActaPdf(parcial = {}) {
  const previo = { ...almacenActaPdf };
  Object.assign(almacenActaPdf, parcial);
  return () => Object.assign(almacenActaPdf, previo);
}

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function rechazar(status, error) {
  return { ok: false, status, error };
}

function esErrorCondicion(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

function formatFecha(iso) {
  if (!iso || String(iso).length < 10) return iso || '—';
  try {
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    return d.toLocaleDateString('es-ES', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function etiquetaEstado(estado) {
  const e = texto(estado);
  if (e === 'acta_borrador') return 'Acta borrador';
  if (e === 'acta_validada') return 'Acta validada';
  return e || '—';
}

function etiquetaEstadoAcuerdo(estado) {
  const e = texto(estado);
  if (e === 'abierto') return 'Abierto';
  if (e === 'cumplido') return 'Cumplido';
  if (e === 'incumplido') return 'Incumplido';
  return e || '—';
}

/**
 * Parte el resumen en bloques numerados (`1.` / `2.`) o un único párrafo.
 * @returns {{ numerado: boolean, bloques: string[] }}
 */
export function partirResumen(resumen) {
  const raw = texto(resumen);
  if (!raw) return { numerado: false, bloques: [] };

  const lineas = raw.split(/\r?\n/);
  const indices = [];
  for (let i = 0; i < lineas.length; i += 1) {
    if (/^\s*\d+\.\s/.test(lineas[i])) indices.push(i);
  }

  if (indices.length === 0) {
    return { numerado: false, bloques: [raw] };
  }

  const bloques = [];
  for (let b = 0; b < indices.length; b += 1) {
    const desde = indices[b];
    const hasta = b + 1 < indices.length ? indices[b + 1] : lineas.length;
    bloques.push(lineas.slice(desde, hasta).join('\n').trim());
  }
  return { numerado: true, bloques };
}

function slugNombreArchivo(titulo, fecha) {
  const base = texto(titulo)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase();
  const f = texto(fecha).slice(0, 10) || 'sin-fecha';
  const parte = base || 'reunion';
  return `acta-${f}-${parte}.pdf`;
}

/**
 * @param {object} reunion
 * @param {object[]} asistentes — con `usuario_nombre` / `nombre`
 * @param {object[]} acuerdos — con `responsable_nombre`, texto, fecha_limite, estado
 * @returns {Promise<Buffer>}
 */
export async function generarPdfActa(reunion, asistentes = [], acuerdos = []) {
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const mx = 14;
  const innerW = pageW - mx * 2;
  let y = 16;

  const esBorrador = texto(reunion?.estado) === 'acta_borrador';

  const ensureSpace = (need) => {
    if (y + need > pageH - 16) {
      doc.addPage();
      y = 16;
    }
  };

  // Marca BORRADOR en cabecera (y en páginas siguientes vía footer simple).
  if (esBorrador) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR_BORRADOR);
    doc.text('BORRADOR', pageW - mx, 12, { align: 'right' });
    doc.setTextColor(0);
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text('Acta de reunión', mx, y);
  y += 8;

  doc.setFontSize(13);
  const tituloLines = doc.splitTextToSize(texto(reunion?.titulo) || 'Sin título', innerW);
  doc.text(tituloLines, mx, y);
  y += tituloLines.length * 6 + 2;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(60);
  doc.text(`Fecha: ${formatFecha(reunion?.fecha)}`, mx, y);
  y += 5;
  const horaIni = texto(reunion?.hora_inicio);
  const horaFin = texto(reunion?.hora_fin);
  if (horaIni || horaFin) {
    doc.text(`Horario: ${horaIni || '—'} – ${horaFin || '—'}`, mx, y);
    y += 5;
  }
  doc.text(`Estado: ${etiquetaEstado(reunion?.estado)}`, mx, y);
  y += 5;

  const nombresAsist = (asistentes || [])
    .map((a) => texto(a.usuario_nombre) || texto(a.nombre) || texto(a.usuario_id))
    .filter(Boolean);
  if (nombresAsist.length) {
    const asisTxt = `Asistentes: ${nombresAsist.join(', ')}`;
    const asisLines = doc.splitTextToSize(asisTxt, innerW);
    ensureSpace(asisLines.length * 5 + 2);
    doc.text(asisLines, mx, y);
    y += asisLines.length * 5 + 2;
  }

  doc.setFontSize(8.5);
  doc.setTextColor(120);
  doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, mx, y);
  y += 8;
  doc.setTextColor(0);

  // ─── Resumen ───
  ensureSpace(14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...HEAD_COLOR);
  doc.text('Resumen', mx, y);
  y += 6;
  doc.setTextColor(0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);

  const { bloques } = partirResumen(reunion?.resumen);
  for (const bloque of bloques) {
    const lines = doc.splitTextToSize(bloque, innerW);
    ensureSpace(lines.length * 4.8 + 3);
    doc.text(lines, mx, y);
    y += lines.length * 4.8 + 3;
  }

  // ─── Acuerdos ───
  const listaAcuerdos = Array.isArray(acuerdos) ? acuerdos : [];
  if (listaAcuerdos.length > 0) {
    y += 4;
    ensureSpace(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...HEAD_COLOR);
    doc.text('Acuerdos', mx, y);
    y += 6;
    doc.setTextColor(0);

    listaAcuerdos.forEach((ac, idx) => {
      const textoAc = texto(ac.texto) || '—';
      const resp = texto(ac.responsable_nombre) || texto(ac.responsable_id) || '—';
      const limite = texto(ac.fecha_limite) || '—';
      const est = etiquetaEstadoAcuerdo(ac.estado);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      const cab = `${idx + 1}. ${textoAc}`;
      const cabLines = doc.splitTextToSize(cab, innerW);
      ensureSpace(cabLines.length * 4.8 + 12);
      doc.text(cabLines, mx, y);
      y += cabLines.length * 4.8 + 1;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(60);
      doc.text(`Responsable: ${resp}`, mx + 2, y);
      y += 4.5;
      doc.text(`Fecha límite: ${limite}`, mx + 2, y);
      y += 4.5;
      doc.text(`Estado: ${est}`, mx + 2, y);
      y += 6;
      doc.setTextColor(0);
    });
  }

  // Pie BORRADOR en cada página
  if (esBorrador) {
    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p += 1) {
      doc.setPage(p);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...COLOR_BORRADOR);
      doc.text('BORRADOR', pageW / 2, pageH - 8, { align: 'center' });
    }
  }

  return Buffer.from(doc.output('arraybuffer'));
}

/**
 * Carga ficha con ACL, genera PDF, sube a S3 y guarda la clave.
 * @returns {{ ok: true, buffer: Buffer, filename: string, s3_key: string }
 *   | { ok: false, status: number, error: string }}
 */
export async function obtenerActaPdf(ctx, idReunion) {
  const ficha = await obtenerFichaReunion(ctx, idReunion);
  if (!ficha.ok) return ficha;

  const resumen = texto(ficha.reunion?.resumen);
  if (!resumen) {
    return rechazar(409, 'Aún no hay acta para descargar');
  }

  const buffer = await generarPdfActa(ficha.reunion, ficha.asistentes, ficha.acuerdos);
  const key = claveActaPdfReunion(ficha.reunion.id_reunion || idReunion);

  await almacenActaPdf.putPdf({ key, cuerpo: buffer });

  const instante = new Date().toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tables.reuniones,
        Key: { PK: PK.reunion(texto(idReunion)), SK: SK.meta },
        UpdateExpression: 'SET acta_pdf_s3_key = :k, actualizado_en = :act',
        ExpressionAttributeValues: { ':k': key, ':act': instante },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
  } catch (err) {
    if (!esErrorCondicion(err)) throw err;
    // Carrera: la reunión desapareció tras generar el PDF. Servir descarga sin persistir clave.
  }

  return {
    ok: true,
    buffer,
    filename: slugNombreArchivo(ficha.reunion.titulo, ficha.reunion.fecha),
    s3_key: key,
  };
}
