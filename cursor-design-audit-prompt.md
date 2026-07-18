# Prompt para Cursor: Auditoría y mejora visual integral de IGP 2.0

Actúa como Senior Product/UX/UI Designer con experiencia en Stripe, Linear, Notion, Revolut, Apple, Airbnb y Arc Browser. Objetivo: interfaz premium, moderna y atemporal — claridad, rapidez de uso, consistencia absoluta, calidad percibida, menos ruido visual — **sin modificar lógica de negocio, backend, llamadas API, estado, permisos ni navegación**.

## Realidad del proyecto (verificada — condiciona el método)

- React Native / Expo (expo-router). **No es web**: no existe hover — los estados interactivos son `pressed` (Pressable) y `disabled`; contemplar safe areas e insets; móvil primero, tablet después.
- **139 archivos con `StyleSheet.create` locales** y miles de hex hardcodeados. La paleta de facto ya es consistente: Slate de Tailwind (`#334155`, `#64748b`, `#94a3b8`, `#e2e8f0`, `#f8fafc`, `#f1f5f9`) con acento `#0ea5e9`.
- Centralización parcial existente: `app/constants/layout.ts`, `app/constants/icons.ts`, `app/constants/cashflowFormStyles.ts`, y componentes compartidos en `app/components/` (`HubTile`, `BadgeEstado`, `TablaBasica`, `SelectorDesplegable`, `Toast`, modales…).
- Iconos: `@expo/vector-icons` (124 imports). Auditar qué familias se usan y consolidar en UNA.

**Conclusión de método: prohibido embellecer pantalla a pantalla sin sistema.** Primero tokens y componentes base (Fase 0); después migración pantalla a pantalla usando SOLO el sistema.

---

## FASE 0 — Sistema de diseño (obligatoria antes de tocar ninguna pantalla)

### 0.1 Tokens — `app/constants/theme.ts`

- **Color**: partir de la paleta Slate+sky existente y refinarla (no inventar una nueva de cero: hay miles de usos que migrar y la actual ya es sobria). Definir tokens semánticos, no crudos: `bg`, `bgSubtle`, `surface`, `border`, `textPrimary`, `textSecondary`, `textMuted`, `accent`, `accentPressed`, `success`, `warning`, `danger`, cada uno con su valor. Interfaz luminosa: fondos blanco/gris muy claro, negro-slate para lo importante, acción discreta. Máximo ~14 tokens de color.
- **Espaciado**: escala única múltiplos de 4 (`s4, s8, s12, s16, s20, s24, s32`). Nada fuera de escala.
- **Tipografía**: jerarquía cerrada — `titulo` (20/700), `subtitulo` (16/600), `cuerpo` (14/400), `etiqueta` (12/500 mayúsculas opcionales), `boton` (14/600), `tabla` (13/400). Fuente: evaluar coste de cargar Inter vía `expo-font` vs. system font (SF Pro en iOS ya cumple); proponer y esperar decisión.
- **Radios**: `r6` inputs/botones, `r10` cards, `r999` pills. Nada más redondeado.
- **Sombras**: UNA elevación sutil para cards (y su equivalente `elevation` Android). Prohibidas sombras dramáticas.
- **Animación**: 150–250 ms, solo con valor funcional (aparición de modales, colapso de secciones). Nada decorativo.

### 0.2 Componentes base — `app/components/ui/`

Crear (o refactorizar los existentes hacia): `Boton` (primario/secundario/fantasma/peligro; estados pressed, disabled, loading con spinner; tamaños m/s), `Card`, `Input` + `Select` + `Switch` + `Checkbox` (con label, error y helper uniformes), `Chip`, `EstadoVacio` (icono + mensaje + acción), `FilaTabla`/cabeceras para `TablaBasica`, `Titular` de pantalla. Todos consumen SOLO tokens.

### 0.3 Iconografía

Inventariar familias usadas; elegir UNA (recomendación: Ionicons o Lucide-RN, trazo uniforme); mapear en `app/constants/icons.ts` los equivalentes y migrar imports. Mismo tamaño/grosor por contexto (20 en botones, 22 en tabs, 18 en chips).

**Entregable de Fase 0**: `theme.ts` + componentes base + 1 pantalla piloto migrada como demostración (proponer: Planning del Día, es la home operativa). Mockup antes de implementar. **ESPERAR APROBACIÓN.**

---

## FASE 1+ — Pantalla por pantalla (el grueso)

**Nunca varias pantallas a la vez.** Orden por impacto (propuesto, ajustable): 1) Planning del Día, 2) Cajas/Objetivos, 3) Facturación (lista + detalle), 4) Compras, 5) Cuadrante/RRHH, 6) resto por uso.

Para CADA pantalla, el flujo es estrictamente:

1. **Auditoría UX/UI**: leer el código de la pantalla; listar problemas concretos (densidad, jerarquía, ruido, inconsistencias con el sistema, alineaciones fuera de escala).
2. **Justificación**: por qué cada elemento mejora, basado en los principios de abajo.
3. **Alternativas**: cuando haya varias soluciones razonables, proponer 2-3 con pros/contras.
4. **Mockup / propuesta visual** (descripción estructurada o imagen) ANTES de tocar código.
5. **ESPERAR APROBACIÓN.**
6. Implementar SOLO estilos/estructura visual: sustituir estilos locales por tokens y componentes base. Cero cambios de lógica, datos, permisos o navegación.
7. **Consistencia**: indicar qué otras pantallas comparten los componentes tocados y deben recibir el mismo tratamiento.

## Principios

Transmitir: elegancia, simplicidad, rapidez, profesionalidad, limpieza, tecnología moderna.
Evitar: interfaces recargadas, muchos colores, sombras exageradas, radios excesivos, iconos inconsistentes, animaciones gratuitas, gradientes llamativos.

**Test final antes de proponer cualquier cambio: ¿esta decisión mejoraría una app de Apple, Linear, Stripe o Notion? Si no, buscar una solución más limpia. Simplicidad por encima de impacto visual.**

## Detalle por tipo de componente

- **Botones**: tamaño, padding en escala, icono opcional a la izquierda, radio r6, pressed (oscurecer 8%), disabled (40% opacidad), loading (spinner sustituye texto, ancho fijo).
- **Cards**: sombra única sutil, separación s12/s16, alineación interna en escala, densidad: máximo 3 niveles de información por card.
- **Formularios**: inputs uniformes (alto 44, r6, borde `border`, focus con borde `accent`), errores en `danger` bajo el campo con icono, selects y switches del sistema.
- **Tablas** (`TablaBasica` y derivadas): cabecera `etiqueta` sobre fondo `bgSubtle`, filas con separador 1px `border`, alineación numérica a la derecha, estados vacíos con `EstadoVacio`, scroll horizontal señalizado en móvil.
- **Responsive**: móvil primero; en tablet/escritorio aprovechar ancho con columnas (listas → grid de cards donde aporte), sin estirar formularios a ancho completo (máx ~560).

## Restricciones duras

No modificar: lógica, backend, llamadas API, estado, estructura funcional, permisos, navegación. Si se detecta un problema GRAVE de usabilidad (no estético), explicarlo y esperar decisión antes de proponer nada.

## Criterios de aceptación por pantalla migrada

- Cero hex hardcodeados y cero tamaños fuera de la escala de espaciado en el archivo migrado.
- Solo componentes de `ui/` para botones, inputs, cards, chips y estados vacíos.
- El diff no toca ninguna línea de lógica (hooks de datos, handlers, navegación) salvo renombrado de estilos.
- Capturas antes/después presentadas al aprobar.
