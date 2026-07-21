import { Redirect } from 'expo-router';

/** Ruta legacy: objetos por local viven en Tipos y objetos. */
export default function ObjetosLimpiezaRedirect() {
  return <Redirect href="/mantenimiento/limpieza/maestros" />;
}
