import { Platform } from 'react-native';
import type { ActivoFicha, PreviewEtiquetaActivo } from '../types/activos';

export function previewDesdeFicha(item: ActivoFicha): PreviewEtiquetaActivo {
  return {
    asset_id: item.asset_id,
    etiqueta_legible: item.etiqueta_legible,
    marca: item.marca,
    nombre_modelo: item.nombre_modelo,
    numero_serie: item.numero_serie,
    formato_etiqueta: 'completa',
    ya_impresa: item.etiqueta_impresa === true,
    qr_url: `/a/${item.asset_id}`,
  };
}

export function urlQrEtiqueta(qrUrl: string, size = 160): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(qrUrl)}`;
}

export function imprimirEtiquetaEnNavegador(et: PreviewEtiquetaActivo): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const qr = urlQrEtiqueta(et.qr_url, 200);
  const modelo = [et.marca, et.nombre_modelo].filter(Boolean).join(' ');
  const serie = et.numero_serie ? `S/N ${et.numero_serie}` : '';
  const minima = et.formato_etiqueta === 'minima';
  const reducida = et.formato_etiqueta === 'reducida';
  const w = window.open('', '_blank', 'width=420,height=320');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><title>${et.etiqueta_legible}</title>
<style>
  body{margin:16px;font-family:system-ui,Segoe UI,sans-serif;color:#0f172a}
  .tag{display:flex;gap:12px;align-items:center;border:2px solid #0f172a;padding:10px 12px;width:320px}
  .id{font-size:22px;font-weight:800;letter-spacing:.04em}
  .meta{font-size:13px;margin-top:4px}
</style></head><body>
<div class="tag">
  ${minima ? '' : `<img src="${qr}" width="96" height="96" alt="QR" />`}
  <div>
    <div class="id">${et.etiqueta_legible}</div>
    ${!minima && !reducida && modelo ? `<div class="meta">${modelo}</div>` : ''}
    ${!minima && !reducida && serie ? `<div class="meta">${serie}</div>` : ''}
  </div>
</div>
<script>window.onload=function(){window.print();}</script>
</body></html>`);
  w.document.close();
  return true;
}
