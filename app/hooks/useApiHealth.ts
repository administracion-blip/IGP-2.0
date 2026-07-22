import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';
const POLL_MS = 60_000;
const CHECK_TIMEOUT_MS = 8000;

export type ApiHealthStatus = 'checking' | 'ok' | 'error';

export function useApiHealth() {
  const [status, setStatus] = useState<ApiHealthStatus>('checking');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const recheck = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) {
      setStatus((prev) => (prev === 'ok' ? prev : 'checking'));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await apiFetch('/api/health', { method: 'GET', signal: controller.signal });
      let data: { ok?: boolean } | null = null;
      try {
        data = res.ok ? await res.json() : null;
      } catch {
        data = null;
      }
      if (!mountedRef.current) return;
      if (data?.ok === true) {
        setStatus('ok');
        setErrorDetail(null);
      } else {
        setStatus('error');
        setErrorDetail(
          `No se puede conectar al servidor. Las tablas y datos no cargarán correctamente.\n\nURL: ${API_URL}\n\nArranca la API con: npm run dev`,
        );
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setStatus('error');
      const raw = e instanceof Error ? e.message : 'Error de conexión';
      setErrorDetail(
        `No se puede conectar al servidor.\n\nURL: ${API_URL}\n\nArranca la API con: npm run dev\n\nDetalle: ${raw}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    recheck();
    const id = setInterval(() => recheck({ silent: true }), POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [recheck]);

  return { status, errorDetail, apiUrl: API_URL, recheck };
}
