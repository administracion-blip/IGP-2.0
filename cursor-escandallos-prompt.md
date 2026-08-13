# Módulo Escandallos (food cost e ingeniería de menú)

> Pega en Cursor (modo Agent, repo abierto). **FASE 1 es investigación: no escribas código hasta reportar hallazgos.** Reutiliza los patrones existentes del proyecto y aplica seguridad desde el inicio.

---

Actúa como **ingeniero senior full-stack** con experiencia en software de restauración. Vas a diseñar y construir el módulo de **Escandallos** (ficha técnica de plato + food cost + ingeniería de menú) para este ERP de hostelería (API Express en `api/`, cliente Expo/RN en `app/`, datos en DynamoDB, POS **Ágora**).

## Qué es y para qué (contexto de negocio)
Un **escandallo** es la ficha de coste de un producto de venta: qué ingredientes (materias primas) lleva, en qué cantidad, y cuánto cuesta cada uno. Con eso se calcula:
- **Coste del plato** = Σ (cantidad ingrediente × coste unitario × (1 + % merma)).
- **Food cost %** = coste del plato / precio de venta sin IVA.
- **Margen bruto** = precio sin IVA − coste.
- **Ingeniería de menú:** cruzar margen × popularidad (unidades vendidas) para clasificar cada plato (Estrella / Vaca / Puzzle / Perro) y decidir carta.

Objetivo del módulo: dar por local el food cost teórico por plato y global, y la ingeniería de menú, **reutilizando datos que la app ya tiene** (productos, compras por producto, líneas de venta de Ágora).

---

## FASE 1 — Investigación (OBLIGATORIA, antes de codificar)
Explora el código y la integración de Ágora y **entrégame un informe** con lo que encuentres. NO escribas todavía el módulo.

1. **Ágora – recetas/composición.** Revisa `docs/agora-guia-integracion.md`, `docs/Guía del Integrador Agora *.pdf`, `api/lib/agora/client.js` y las rutas `api/routes/agora.js`. Determina:
   - ¿La API de Ágora expone la **composición/receta** de un producto (elaboraciones, ingredientes, cantidades)? La guía menciona `RemovedIngredients` ("en caso de que el producto sea una receta…"), así que el concepto existe — confirma si hay endpoint/nodo XML para **leer la receta completa** de un producto, no solo los ingredientes eliminados en una venta.
   - ¿Expone **precio de coste** por producto y por almacén (`ProductCostPrice`, `CostPrices`, `WeightedAvgCostPrice`)? **Verifica si vienen con valor real o a 0.00** (en los ejemplos de la guía aparecen a `0.00`).
2. **Qué hay ya sincronizado en Dynamo.** Identifica las tablas y qué contienen: productos Ágora (`DDB_AGORA_PRODUCTS_TABLE` y `/agora/products`), **compras por producto** (`/agora/purchases/por-producto`, con `ProductCostPrice`/albarán/fecha — posible fuente del coste de ingrediente), **líneas de venta** (`/agora/sales-lines/sync` — posible fuente de popularidad/unidades vendidas). Documenta el esquema real (PK/SK/GSI) de cada una.
3. **Unidades y almacén.** Cómo se identifican productos entre venta y compra (¿mismo `ProductId`?, ¿unidades de compra vs unidades de receta, p. ej. compras en kg y receta en g?). Señala el problema de conversión de unidades.
4. **Multi-local.** Confirma si el coste puede variar por local/almacén (`CostPrices` por almacén) para calcular food cost por local.

**Entrega de Fase 1:** un documento `ESCANDALLOS-INVESTIGACION.md` con: qué da Ágora (receta sí/no, coste sí/no/0.00), qué tablas Dynamo reutilizamos, el problema de unidades, y **una recomendación de arquitectura** entre estos escenarios:
- **A)** Ágora da receta + coste reales → sincronizar y calcular automático.
- **B)** Ágora da coste pero NO receta → editor de receta en la app + coste automático desde Ágora/compras.
- **C)** Ágora no da coste fiable → editor de receta en la app + coste del ingrediente desde **media ponderada de compras** (`purchases/por-producto`) con opción de coste manual.

**Espera mi visto bueno del escenario antes de la Fase 2.**

---

## FASE 2 — Construcción (tras aprobar la arquitectura)

### Modelo de datos (nueva tabla DynamoDB, sin tocar las existentes)
Diseña una tabla de escandallos, p. ej. `Igp_Escandallos` (patrón PK/SK como el resto del proyecto):
- Cabecera de receta por producto de venta: `productoVentaId`, nombre, rendimiento/raciones, notas, fechas, autor.
- Líneas de ingrediente: `ingredienteId` (producto de compra/materia prima), cantidad, unidad, **% merma**, y origen del coste (auto/manual).
- Soporta **sub-escandallos** (una elaboración que es ingrediente de otra: p. ej. una salsa) — un ingrediente puede ser a su vez un producto con su propia receta.
- Guarda el coste calculado con su fecha para histórico, pero recalcula bajo demanda con el coste vigente.

### Backend (`api/`)
- Rutas nuevas en `api/routes/escandallos.js` montadas en `server.js` **después** de `requireAuth` (como el resto).
- **Seguridad desde el inicio** (aplica el mismo patrón que la remediación reciente): cada ruta con `requirePermission`, denegar por defecto, `Administrador` pasa, `req.isInternal` respetado. Códigos nuevos: `escandallos.ver` (lecturas), `escandallos.editar` (crear/editar/borrar recetas) y `escandallos.ver` como permiso de menú lateral. Añádelos al catálogo (`app/constants/modulos.ts` y la doc de `ROLES-PERMISOS.md`) pero **NO** los asignes a roles a ciegas: indícame qué roles deberían tenerlos.
- Cálculo del coste en una función de `api/lib/escandallos/` reutilizando la fuente de coste que decidamos en Fase 1 (Ágora cost price o media ponderada de `purchases/por-producto`). Aísla la conversión de unidades en una utilidad testeable.
- Endpoints mínimos: CRUD de receta; cálculo de food cost de un producto y de todos; informe de **ingeniería de menú** (cruce con unidades vendidas de sales-lines en un rango); food cost **por local** si el coste varía por almacén.
- **Multi-tenant:** aplica el filtro por `Locales` del usuario igual que el resto del backend.
- Añade **tests** (`api/tests/`) del cálculo de coste, merma, sub-escandallos y conversión de unidades (usa el runner `node --test` que ya existe).

### Frontend (`app/`)
- Nueva pantalla de módulo (o submódulo dentro de **Compras**, según encaje mejor — propónlo) con:
  - Editor de ficha técnica: buscar producto de venta, añadir ingredientes con cantidad/unidad/merma, ver coste en vivo.
  - Vista de food cost por plato: coste, precio venta, food cost %, margen; semáforo por umbral (p. ej. objetivo food cost configurable).
  - Vista de **ingeniería de menú**: matriz margen × popularidad con la clasificación Estrella/Vaca/Puzzle/Perro.
- Respeta el sistema de permisos del cliente (`hasPermiso`) para mostrar/ocultar, reutilizando `escandallos.ver`/`escandallos.editar`.
- Sigue los patrones de UI, navegación (`expo-router`) y estilos ya existentes en el proyecto; no introduzcas librerías nuevas sin justificarlo.

## Reglas transversales (no romper nada)
- Trabaja en rama nueva (`feature/escandallos`), commits pequeños.
- **No modifiques** las tablas ni las rutas de Ágora/compras/productos existentes; solo **lee** de ellas. Si necesitas un dato que no está sincronizado, propón un endpoint de lectura nuevo, no cambies los actuales.
- No cambies contratos de API existentes.
- No imprimas secretos; usa las credenciales de Ágora/AWS ya configuradas por entorno.
- Rendimiento: los cálculos masivos (food cost de toda la carta, ingeniería de menú) deben paginar/batch sobre Dynamo como hacen las rutas actuales, no cargar todo en memoria sin control.

## Entregables
1. `ESCANDALLOS-INVESTIGACION.md` (Fase 1) — y **para aquí** hasta mi OK.
2. Tras aprobación: el módulo en `feature/escandallos` + un `ESCANDALLOS-MODULO.md` con el modelo de datos final, endpoints, permisos nuevos (y a qué roles asignarlos), fuente de coste elegida, supuestos de unidades y cómo verificarlo.

Empieza por la **Fase 1**: investiga Ágora y el código, y entrégame el informe con la recomendación de arquitectura. No escribas el módulo todavía.
