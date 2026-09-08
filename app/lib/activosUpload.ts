import { apiFetch } from '../utils/api';

type Presign = {
  upload_url?: string;
  s3_key?: string;
  foto_id?: string;
  error?: string;
};

function tipoSubida(contentType?: string) {
  const raw = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!raw || raw === 'image/jpg' || raw === 'image/pjpeg') return 'image/jpeg';
  if (raw === 'image/x-png') return 'image/png';
  return raw;
}

export async function subirFotoActivo(
  assetId: string,
  tipo: 'general' | 'placa_serie' | 'otra',
  uri: string,
  contentType = 'image/jpeg',
) {
  const mime = tipoSubida(contentType);
  const presignRes = await apiFetch(`/api/activos/${encodeURIComponent(assetId)}/fotos/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo, content_type: mime }),
  });
  const presign = (await presignRes.json().catch(() => ({}))) as Presign;
  if (!presignRes.ok || !presign.upload_url || !presign.s3_key || !presign.foto_id) {
    throw new Error(presign.error || 'No se pudo preparar la subida de la foto');
  }

  const blob = await (await fetch(uri)).blob();
  const putRes = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: blob,
  });
  if (!putRes.ok) throw new Error('No se pudo subir la foto');

  const confRes = await apiFetch(`/api/activos/${encodeURIComponent(assetId)}/fotos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ s3_key: presign.s3_key, foto_id: presign.foto_id, tipo }),
  });
  const conf = (await confRes.json().catch(() => ({}))) as { error?: string };
  if (!confRes.ok) throw new Error(conf.error || 'No se pudo registrar la foto');
  return conf;
}

export async function subirFotoModelo(modeloId: string, uri: string, contentType = 'image/jpeg') {
  const mime = tipoSubida(contentType);
  const presignRes = await apiFetch(`/api/activos/modelos/${encodeURIComponent(modeloId)}/fotos/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: mime }),
  });
  const presign = (await presignRes.json().catch(() => ({}))) as Presign;
  if (!presignRes.ok || !presign.upload_url || !presign.s3_key || !presign.foto_id) {
    throw new Error(presign.error || 'No se pudo preparar la subida de la foto');
  }

  const blob = await (await fetch(uri)).blob();
  const putRes = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: blob,
  });
  if (!putRes.ok) throw new Error('No se pudo subir la foto');

  const confRes = await apiFetch(`/api/activos/modelos/${encodeURIComponent(modeloId)}/fotos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ s3_key: presign.s3_key, foto_id: presign.foto_id }),
  });
  const conf = (await confRes.json().catch(() => ({}))) as { error?: string };
  if (!confRes.ok) throw new Error(conf.error || 'No se pudo registrar la foto');
  return conf;
}
