import { Redirect } from 'expo-router';

/** La ruta antigua abre el módulo nuevo. El MIA de consumo está en /compras/mia-consumo. */
export default function MiaRedirect() {
  return <Redirect href="/compras/aprovisionamiento" />;
}
