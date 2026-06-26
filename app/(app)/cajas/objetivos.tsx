/**
 * Punto de entrada — pantalla Objetivos (Cajas).
 *
 * REVERTIR a la UI anterior:
 *   1. Cambia USE_OBJETIVOS_UI_OPCION_A a `false` abajo, o
 *   2. `git checkout main -- "app/(app)/cajas/objetivos.tsx"` y borra opcion-a si quieres, o
 *   3. Renombra objetivos.pre-opcion-a.tsx → objetivos.tsx
 *
 * La copia intacta de la UI previa está en objetivos.pre-opcion-a.tsx
 * (rama git: experiment/objetivos-opcion-a).
 */
import ObjetivosLegacy from './objetivos.pre-opcion-a';
import ObjetivosOpcionA from './objetivos-opcion-a';

/** `true` = layout Opción A (controles → KPIs → global → detalle con pestañas). */
export const USE_OBJETIVOS_UI_OPCION_A = true;

export default USE_OBJETIVOS_UI_OPCION_A ? ObjetivosOpcionA : ObjetivosLegacy;
