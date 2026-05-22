/**
 * Pub/sub mínimo para eventos de autenticación.
 *
 * Permite que `apiFetch` (utilidad sin estado de React) notifique a
 * `AuthContext` cuando recibe un 401 del backend, sin crear dependencia
 * circular entre ambos módulos. `AuthContext` se suscribe en su mount y
 * ejecuta `logout()` que dispara la redirección a /login en `_layout.tsx`.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export const authEvents = {
  /** Suscribe un listener al evento `unauthorized`. Devuelve función de unsubscribe. */
  onUnauthorized(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Dispara el evento `unauthorized` a todos los listeners registrados. */
  emitUnauthorized(): void {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* ignore listener errors */
      }
    }
  },
};
