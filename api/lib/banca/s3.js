/**
 * Subida del extracto original a S3.
 *
 * Se guarda el fichero tal cual llegó: sirve para auditar una conciliación y
 * para reprocesar la carga si mejoramos el parser.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sanitizeUploadFileName } from '../uploadAllowlist.js';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';

/** Prefijo de los extractos bancarios en el bucket. */
export const PREFIJO_BANCA = 'banca';

/**
 * Key del original. Lleva el hash del fichero delante del nombre: dos extractos
 * distintos con el mismo nombre ("movimientos.q43" en todos los bancos) no se
 * pisan, y el mismo fichero siempre cae en la misma key.
 * @param {string} hashFichero
 * @param {string} nombreFichero
 */
export function keyExtracto(hashFichero, nombreFichero) {
  const hash = String(hashFichero || '').trim();
  const nombre = sanitizeUploadFileName(nombreFichero || 'extracto');
  return `${PREFIJO_BANCA}/${hash.slice(0, 2)}/${hash}_${nombre}`;
}

/**
 * Sube el extracto original y devuelve su key.
 * @param {{ buffer: Buffer, hashFichero: string, nombreFichero?: string, tipoMime?: string }} datos
 * @returns {Promise<string>}
 */
export async function subirExtractoOriginal({ buffer, hashFichero, nombreFichero, tipoMime }) {
  const key = keyExtracto(hashFichero, nombreFichero);
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: String(tipoMime || 'application/octet-stream'),
    }),
  );
  return key;
}

/** URL firmada para descargar un original guardado. */
export function urlExtractoOriginal(key, expiresIn = 3600) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn });
}

/**
 * Borra el original de S3. Si la key está vacía o el objeto no existe, no falla:
 * el objetivo es poder limpiar la carga aunque el fichero ya no esté.
 * @param {string} key
 */
export async function borrarExtractoOriginal(key) {
  const k = String(key || '').trim();
  if (!k) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: k }));
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return;
    throw err;
  }
}
