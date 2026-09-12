/**
 * Fotos de activos: claves derivadas del asset_id, URLs firmadas de vida corta.
 * Nunca se persiste la URL firmada.
 *
 * La URL de subida no firma ServerSideEncryption: si se firma, el navegador
 * tiene que mandar x-amz-server-side-encryption en el PUT y, si no la manda,
 * S3 responde 403. El cifrado en reposo lo aplica el bucket por defecto
 * (mismo criterio que adjuntos de tareas y audio de reuniones).
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errorHttp } from './tipos.js';

const region = process.env.AWS_REGION || 'eu-west-3';
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';
const s3 = new S3Client({ region });

const TIPOS_PERMITIDOS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/pjpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/x-png', 'png'],
  ['image/webp', 'webp'],
]);

function tipoImagen(contentType) {
  const raw = String(contentType || '').toLowerCase().split(';')[0].trim();
  const ct = !raw
    ? 'image/jpeg'
    : raw === 'image/jpg' || raw === 'image/pjpeg'
      ? 'image/jpeg'
      : raw === 'image/x-png'
        ? 'image/png'
        : raw;
  const ext = TIPOS_PERMITIDOS.get(ct);
  if (!ext) throw errorHttp(400, 'Tipo de imagen no permitido (usa jpeg, png o webp)');
  return { ct, ext };
}

export function claveFoto(assetId, fotoId, ext) {
  return `activos/${assetId}/${fotoId}.${ext}`;
}

export function claveFotoModelo(modeloId, fotoId, ext) {
  return `activos/modelos/${modeloId}/${fotoId}.${ext}`;
}

export function clavePerteneceAlActivo(s3Key, assetId) {
  const key = String(s3Key || '');
  return key.startsWith(`activos/${assetId}/`) && !key.includes('..');
}

export function clavePerteneceAlModelo(s3Key, modeloId) {
  const key = String(s3Key || '');
  return key.startsWith(`activos/modelos/${modeloId}/`) && !key.includes('..');
}

async function presignarPut(s3Key, contentType) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: contentType,
    }),
    { expiresIn: 300 },
  );
}

export async function presignarSubida({ assetId, fotoId, contentType }) {
  const { ct, ext } = tipoImagen(contentType);
  const s3Key = claveFoto(assetId, fotoId, ext);
  return { upload_url: await presignarPut(s3Key, ct), s3_key: s3Key, foto_id: fotoId };
}

export async function presignarSubidaModelo({ modeloId, fotoId, contentType }) {
  const { ct, ext } = tipoImagen(contentType);
  const s3Key = claveFotoModelo(modeloId, fotoId, ext);
  return { upload_url: await presignarPut(s3Key, ct), s3_key: s3Key, foto_id: fotoId };
}

export async function urlFirmadaLectura(s3Key, { expiresIn = 900, filename, disposition } = {}) {
  if (!s3Key) return null;
  const params = { Bucket: S3_BUCKET, Key: s3Key };
  if (disposition === 'attachment' || filename) {
    const name = String(filename || 'documento').replace(/[^a-zA-Z0-9._-]/g, '_');
    params.ResponseContentDisposition = `attachment; filename="${name}"`;
  }
  return getSignedUrl(
    s3,
    new GetObjectCommand(params),
    { expiresIn },
  );
}

export function claveActaEntrega(entregaId, nombre) {
  const id = String(entregaId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const file = String(nombre || 'acta.pdf').replace(/[^a-zA-Z0-9._-]/g, '');
  return `activos/entregas/${id}/${file}`;
}

export async function subirObjeto(s3Key, body, contentType) {
  if (!s3Key || !body) throw errorHttp(400, 'Falta el fichero a guardar');
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  );
  return s3Key;
}

export async function borrarObjeto(s3Key) {
  if (!s3Key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: s3Key })).catch(() => {});
}

export async function urlsFirmadasDeFotos(fotos) {
  const lista = Array.isArray(fotos) ? fotos : [];
  const out = {};
  await Promise.all(
    lista.map(async (f) => {
      if (!f?.foto_id || !f?.s3_key) return;
      out[f.foto_id] = await urlFirmadaLectura(f.s3_key);
    }),
  );
  return out;
}
