import { Redirect } from 'expo-router';

/** Ruta legacy: el catálogo vive en Tipos y objetos. */
export default function CatalogoLimpiezaRedirect() {
  return <Redirect href="/mantenimiento/limpieza/maestros" />;
}
