# Prompt para Cursor: Card de objetivo mensual en Planning del Día

## Objetivo

Card horizontal en la parte superior de **Planning del Día** (`app/(app)/planning-dia/index.tsx`, encima del grid de `TARJETAS`) que muestre el **grado de consecución del objetivo mensual del mes en curso** de cada local visible para el usuario, con una barra de progreso. **Sin importes facturados en ningún sitio: solo porcentaje.** Si el usuario ve varios locales, navegación dentro del card con `‹ ›` en orden alfabético por nombre de local.

## Contexto (verificado en el código)

- Planning del Día ya filtra tarjetas por permiso: `TARJETAS.filter((t) => hasPermiso(t.permiso))` con el patrón `hasPermiso('permiso.accion')` de `useAuth()`.
- La métrica de consecución existe en la pantalla Objetivos (`app/(app)/cajas/objetivos-opcion-a.tsx`): real del mes vs. periodo comparable del año anterior usando `/api/gestion-festivos` (mapeo día→`FechaComparativa`, con fallback `fechaComparacion(fecha)`) y `/api/agora/closeouts/totals-by-local-range` por `workplaceId` (= `agoraCode` del local). Calcula tanto el mes completo como el corte **«hasta ayer»** (`sumRealHastaAyer` / `sumCompHastaAyer`).
- Acceso usuario→local: `usuarioPuedeAccederLocal(user, idLocal)` en `api/lib/usuarioLocales.js` (Administrador o `Locales` vacío = todos; si no, match por nombre de local).
- Parte de la lógica de filas de objetivos está compartida en `app/lib/objetivosFilasApi`.

## Decisiones de diseño (no cambiar)

1. **Métrica = consecución «hasta ayer»**: real acumulado del mes hasta ayer ÷ comparable del año anterior de esos mismos días (con mapeo de festivos). Comparar el mes completo a día 5 no informa de nada.
2. **El porcentaje se calcula en el backend** y el endpoint devuelve SOLO porcentajes, nunca importes. Así un usuario con permiso para ver el card pero sin permiso de cierres/objetivos jamás recibe cifras de facturación por red (mirar la respuesta en las DevTools no puede revelar importes).
3. El filtrado de locales visibles se hace **en el servidor** con `usuarioPuedeAccederLocal`, no en el cliente.

## Tarea 1 — Permiso nuevo

- Registrar `planning_dia.objetivo_card` en el sistema de roles/permisos existente (misma mecánica que el resto).
- Sin ese permiso: el card no se renderiza y el endpoint devuelve 403.

## Tarea 2 — Endpoint

**`GET /api/agora/closeouts/objetivo-mensual-card`** (en `api/routes/agora.js`, junto al resto de endpoints de closeouts)

- Sin parámetros: el mes es siempre el **mes en curso** del servidor y los locales son los visibles del usuario del token.
- Lógica: replicar el cálculo «hasta ayer» de objetivos-opcion-a en servidor — construir el rango comparable con `gestion-festivos` (`FechaComparativa` con fallback a la regla estándar) y sumar closeouts reales y comparables por local. Extraer a `api/lib/agora/objetivoMensual.js` lo que se pueda compartir; si la lógica cliente de `objetivosFilasApi` y esta divergen en el futuro, este módulo es la fuente de verdad del card.
- Respuesta (ordenada alfabéticamente por nombre, **sin importes**):

```
{
  mes: "2026-07",
  hastaFecha: "2026-07-14",
  locales: [{
    localId, nombre,
    pctConsecucion,      — número o null (redondeado a 1 decimal, ej. 103.4)
    sinDatos: boolean    — true si el local no tiene workplace configurado
                           o no hay closeouts sincronizados en el rango
  }]
}
```

- `pctConsecucion = null` cuando el comparable es 0 o no hay datos (la UI muestra «Sin datos», nunca 0% ni Infinity).
- Permiso `planning_dia.objetivo_card` verificado en el endpoint (403 si falta).
- Cachear la respuesta en memoria por usuario+día unos minutos si el cálculo resulta pesado (opcional, solo si se nota).

## Tarea 3 — Componente `ObjetivoMensualCard`

Crear `app/components/ObjetivoMensualCard.tsx` y montarlo en `planning-dia/index.tsx` encima del grid, solo si `hasPermiso('planning_dia.objetivo_card')`:

- **Card horizontal** (ancho completo, altura contenida ~90-110 px) con:
  - Cabecera: nombre del local + etiqueta del periodo («Julio 2026 · hasta ayer»).
  - **Barra de progreso** con el `pctConsecucion`: la barra se llena hasta `min(pct, 120)` sobre una escala 0–120% con una marca vertical en el 100%. Color por tramo: rojo < 95, ámbar 95–100, verde ≥ 100 (mismos umbrales que el sistema de objetivos).
  - El porcentaje en texto grande junto a la barra («103,4 %»). **Nada de importes, ni en tooltips, ni en accesibilidad labels.**
  - Estado «Sin datos» para `pctConsecucion: null`.
- **Navegación multi-local**: flechas `‹ ›` a los lados si `locales.length > 1` (circular: del último pasa al primero), respetando el orden alfabético que ya viene del backend, e indicador de posición («2/5» o dots). Swipe horizontal opcional si el patrón ya existe en el proyecto; las flechas son lo obligatorio.
- Un solo local: sin flechas ni indicador.
- Carga: skeleton/spinner discreto; si el endpoint falla o devuelve 403, el card no se muestra (sin mensaje de error en el planning).
- Recordar el último local visto en el estado local de la pantalla (no persistir).

## Reglas no opcionales

1. Ni un importe en €: ni en la respuesta del endpoint, ni en la UI, ni en logs del cliente.
2. Mes en curso fijo: el card no tiene selector de fechas. Para análisis está la pantalla Objetivos.
3. Orden alfabético por nombre de local, resuelto en el backend.
4. El card no bloquea el render del planning: se carga en paralelo y aparece cuando está listo.

## Criterios de aceptación

- Usuario con permiso y 3 locales: card visible, flechas funcionan en círculo, orden alfabético, «2/3» al navegar.
- Usuario con permiso y 1 local: sin flechas.
- Usuario sin permiso: no hay card y el endpoint responde 403.
- Usuario restringido a un local: el endpoint solo devuelve ese local aunque pida con un token manipulado en el cliente.
- La respuesta del endpoint inspeccionada en red no contiene ningún importe.
- El % del card coincide con el «hasta ayer» de la pantalla Objetivos para el mismo local y mes.
- Local sin workplace o sin datos: «Sin datos», sin romper la navegación.
