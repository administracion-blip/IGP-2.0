/**
 * URL base del API Express (`api/server.js`).
 * Por defecto coincide con `PORT` del servidor (3002 si no hay variable en api/.env).
 * Sobrescribe con `EXPO_PUBLIC_API_URL` en `.env` en la raíz del proyecto Expo.
 */
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';
