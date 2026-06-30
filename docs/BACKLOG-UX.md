# Backlog UX móvil / tablet

Seguimiento del trabajo para mejorar densidad y usabilidad en teléfono y tablet.

> Las **convenciones** (cómo hacerlo) viven en `.cursor/rules/ui-responsive.mdc`.
> Este documento es solo el **roadmap** (qué falta por hacer).

## Infraestructura ya disponible

- `app/constants/layout.ts` — breakpoints, `MIN_TOUCH`, orientación, helpers de layout.
- `app/hooks/useBreakpoint.ts` — `isPhone` / `isTablet` / `isDesktop` + `isPortrait` / `isLandscape` / `shouldStackPanels` / `hubGridColumns`.
- `.cursor/rules/ui-responsive.mdc` — regla de usabilidad y responsividad.
- `.cursor/rules/arquitectura-igp.mdc` — contexto global (sección orientación).
- `TablaBasica` — modo "cómodo" automático en teléfono y tablet vertical.

## Hecho

- Orientación aplicada en: hubs `compras` / `planning`, detalle de pedidos, toolbar de `abonos-rappel`.
- Migración de campos de fecha a `InputFecha` (ISO + calendario) en toda la app.

## Pendiente por fases

### Fase 1 — Umbrales sueltos
Migrar pantallas que comparan `width` con números sueltos (768 / 900 / 1024) a `useBreakpoint()` + orientación.

### Fase 2 — Listados densos en móvil
En móvil, listados con muchas columnas → vista de tarjetas (como opción en `TablaBasica`).

### Fase 3 — Formularios / modales
Tamaño táctil cómodo y modal a pantalla completa en móvil vertical.

## Pantallas a revisar (densas)

- `app/(app)/facturacion/*`
- `app/(app)/cajas/*`
- `app/(app)/mantenimiento/*`
- `app/(app)/acuerdos.tsx`
