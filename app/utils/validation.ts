/** Valida que el campo Email contenga "@". Se usa en login y formularios de usuarios. */
export function emailValido(email: string): boolean {
  return (email ?? '').trim().includes('@');
}
