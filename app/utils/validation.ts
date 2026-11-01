/** Longitud mínima de contraseña nueva; debe coincidir con la que exige el backend. */
export const MIN_PASSWORD_LENGTH = 8;

/** Valida que el campo Email contenga "@". Se usa en login y formularios de usuarios. */
export function emailValido(email: string): boolean {
  return (email ?? '').trim().includes('@');
}
