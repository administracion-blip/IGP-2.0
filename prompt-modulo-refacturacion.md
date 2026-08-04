# Prompt para Cursor — Módulo de Refacturación (IGP-2.0) · v2

> Pégalo en Cursor. Respeta `/.cursor/rules/arquitectura-igp.mdc` y `tabla-basica.mdc`.
> Prioriza **reutilizar** el motor de facturación interna entre sociedades que ya existe. No inventar un flujo fiscal ni una numeración paralela.
>
> **v2 — correcciones aplicadas tras revisión contra el repo real:** menú en `constants/modulos.ts` (no `_layout`); numeración OUT **al emitir**, no al crear; OCR interno a extraer o llamar por HTTP; permisos endurecidos en API con `requirePermission`; `parece_factura` a definir; crear la tabla en AWS; puente real a `ocr/confirmar`.

---

## 1. Objetivo

Módulo nuevo de **Refacturación**, independiente de Mantenimiento, que permite:

1. **Escanear** uno o varios tickets/facturas pagados con la tarjeta compartida (OCR).
2. **Asignar** las líneas a la **sociedad** que corresponde, aplicando **+5% sobre el precio base** de cada artículo.
3. **Revisar** las refacturaciones pendientes, agrupadas por sociedad.
4. **Emitir** una factura por sociedad, grabada en `Igp_Facturas` (`tipo: 'OUT'`) reutilizando series, numeración y flujo de emisión existentes.
5. Si un documento importado **es una factura**, **registrarlo como factura recibida** (`tipo: 'IN'`) por el flujo OCR existente.

---

## 2. Decisiones ya tomadas (no reabrir)

| Tema | Decisión |
|---|---|
| Reparto de líneas | **Mixto**: documento entero a una sociedad por defecto, con opción de **reasignar líneas sueltas** a otra sociedad. |
| Vínculo con incidencias | **Ninguno**. |
| Incremento | **5% fijo sobre el precio base unitario** (sin IVA); el IVA se recalcula sobre `base + 5%` con el **tipo de IVA original** de cada línea. Dejar el 5% en una **constante única** por si se parametriza en el futuro. |
| Emisor | **Seleccionable al emitir** (sociedad titular de la tarjeta). |
| Serie | **Elegir serie existente** al emitir. |
| Agrupación | **Por sociedad destino** (una factura por sociedad). |

---

## 3. El patrón más cercano YA existe (reutilizar, no reinventar)

El grupo ya factura internamente entre sociedades. Estudiar y reutilizar antes de escribir nada nuevo:

- `api/lib/facturacion/construirFactura.js` → **`construirFacturaConLineas({ id_factura, numero, numero_factura, datos })`** arma la factura + líneas.
- `api/lib/facturacion/emitirFactura.js` → **`emitirOValidarFacturaPorId(id, { usuario_id, usuario_nombre, soloRevision })`** valida y emite (aquí es donde se **reserva el número** en las OUT).
- `api/lib/facturacion/facturarVentasInternas.js`, `facturacionPeriodica.js`, `facturarMantenimiento.js` → política + motor de facturación entre sociedad emisora/receptora, con borrador sin número y correlativo al emitir. **Es el mismo dominio que la refacturación**: replicar su enfoque.

**OCR reutilizable** (en `api/routes/facturacion.js`):
- `POST /api/facturacion/ocr/extraer` (`multipart`, campo `file`) → texto + líneas + desglose. Internamente usa `extraerDatosBasicos(buffer, mimetype, filename)` (~L2374), **función interna no exportada**.
- `POST /api/facturacion/ocr/confirmar` (body `{ borradores: [...] }`) → **registra como factura recibida (`IN`)**. El shape de `borradores` es el de **registro masivo** (sociedad del grupo, proveedor, totales…), no una línea suelta.

---

## 4. Modelo de datos nuevo

### Tabla DynamoDB `Igp_Refacturaciones`

Registrar el nombre en `api/lib/db.js`:
`refacturaciones: process.env.DDB_REFACTURACIONES || 'Igp_Refacturaciones'`.
⚠️ **Registrar en `db.js` NO crea la tabla.** Hay que **crear `Igp_Refacturaciones` (+ GSI si aplica) en AWS/infra** como paso explícito.

**Claves (una línea = un ítem):**

| Atributo | Valor |
|---|---|
| **PK** | `SOCIEDAD#{empresa_destino_id}` |
| **SK** | `LINEA#{creado_en_iso}#{uuid}` (el estado **no** va en la SK) |

- **GSI `Estado-index`** (HASH `estado`, RANGE `empresa_destino_id`): opcional, para "todas las pendientes". Con volumen bajo basta Query por sociedad + filtro; documentar la decisión.
- **Reasignar sociedad** cambia la PK → en Dynamo es **Delete + Put** (no un simple Update). Documentarlo en el `PATCH`.

**Atributos:** `id_linea`, `estado` (`pendiente|refacturada|descartada`), `creado_en`, `creado_por_id/_nombre`; `empresa_destino_id/_nombre/_cif`; `descripcion`, `cantidad`, `precio_base_unitario`, `incremento_pct` (=5), `precio_refacturado_unitario`, `tipo_iva`, `base_linea`, `iva_linea`, `total_linea`; `doc_origen_s3_key`, `doc_origen_nombre`, `proveedor_origen?`, `fecha_documento?`; al emitir: `factura_id`, `factura_numero`, `refacturada_en`. Documento original en S3 bajo `refacturaciones/{uuid}/…`.

---

## 5. Backend — `api/routes/refacturacion.js`

Router nuevo, montado en `api/server.js` tras `requireAuth`. **Endurecer permisos por ruta** con `requirePermission(...)` de `api/middleware/auth.js` (como hace `facturacion.js`: `requirePermission('facturacion.emitir')`). No dejar el API abierto a cualquier autenticado.

**Endpoints:**

1. `POST /api/refacturacion/extraer` · `requirePermission('refacturacion.gestionar')`
   - Sube a S3 + extrae líneas. **OCR**: dos opciones — (a) **extraer `extraerDatosBasicos` a `api/lib/facturacion/ocrFacturaExtraer.js`** y usarlo desde facturación y refacturación (evita duplicar); o (b) **v1 más barata**: el front llama a `/facturacion/ocr/extraer` y este endpoint solo persiste. Elegir y documentar.
   - Devuelve líneas + `doc_origen_s3_key` + `parece_factura`.
   - **`parece_factura` no existe**: definir heurística simple (hay CIF emisor + nº de factura de proveedor + totales cuadrados, o score del parseo OCR).

2. `POST /api/refacturacion/lineas` · `requirePermission('refacturacion.gestionar')` — persiste líneas asignadas como `pendiente`. **Recalcular importes en servidor** (no confiar en el cliente).

3. `GET /api/refacturacion/lineas?empresa_destino_id=&estado=` · `requirePermission('refacturacion.ver')` — Query por PK sociedad (o GSI `Estado-index`).

4. `PATCH /api/refacturacion/lineas/:id` · `requirePermission('refacturacion.gestionar')` — editar / **reasignar sociedad (Delete+Put)** / descartar.

5. `DELETE /api/refacturacion/lineas/:id` · `requirePermission('refacturacion.gestionar')`.

6. `POST /api/refacturacion/emitir` · `requirePermission('refacturacion.gestionar')` — ver sección 6.

7. **Registrar como factura recibida** (decisión cerrada): **no** se implementa registro propio. La UI de escanear **redirige a `registro-masivo`** con el documento ya subido, y **al confirmar allí se vuelve al punto de refacturación** de origen. Detalle de navegación en la sección 7.

---

## 6. Emisión — flujo exacto (NO reimplementar numeración)

En `POST /api/refacturacion/emitir` con `{ emisor_id, serie, empresa_destino_id, lineas_ids[], fecha_emision }`:

1. Validar líneas `pendiente` de esa `empresa_destino_id`.
2. Armar el `datos` OUT (emisor = sociedad seleccionada; empresa/cliente = sociedad destino; `lineas` con `precio_unitario = precio_refacturado_unitario` y `tipo_iva` original) y crear el **borrador OUT con `construirFacturaConLineas`** — **sin número** (`numero = 0`, `numero_factura = ''`).
   - ⚠️ En OUT el número **se reserva al emitir**, no al crear (ver `facturacion.js`: *"Ventas (OUT): el número se reserva al emitir… para no dejar huecos en el correlativo"*; `calcNextNumeroPorScan` solo se llama si `tipo !== 'OUT'`). **No** reimplementar correlativos.
3. `Put` de factura + líneas (mismo patrón que el `POST` de facturación).
4. **`emitirOValidarFacturaPorId(id, { usuario_id, usuario_nombre })`** → aquí sale `numero_factura`, auditoría y hash.
5. Marcar las líneas como `refacturada` con `factura_id` / `factura_numero`.

**Consistencia:** si emite OK pero falla el marcado de líneas → **deuda anotada** (reintento / job de reconciliación). No hace falta transacción global en v1, pero dejarlo documentado.

---

## 7. Frontend — `app/(app)/refacturacion/`

Replicar el patrón de `app/(app)/facturacion/` (carpeta con `_layout.tsx`, `index.tsx`, subpantallas). Usar `apiFetch` y `TablaBasica`; mantener look & feel.

- `_layout.tsx`, `index.tsx` (hub + contadores).
- `escanear.tsx`: subir varios documentos (uno a uno), revisión con selector de sociedad (`igp_Empresas`), +5% ya aplicado, reasignar líneas, confirmar → `POST /refacturacion/lineas`. Si `parece_factura`, botón **"Registrar como factura"** → **redirige a `registro-masivo`** (ver abajo).

**"Registrar como factura" → `registro-masivo` con retorno (decisión cerrada):**
- Ruta destino: `/facturacion/registro-masivo` (existe en `app/(app)/facturacion/registro-masivo.tsx`). Navegar con `router.push({ pathname: '/facturacion/registro-masivo', params: { returnTo: '/refacturacion/escanear', docS3Key: '<doc_origen_s3_key>' } })`, pasando el documento **ya subido** (no re-subir).
- En `registro-masivo.tsx`: leer `returnTo`/`docS3Key` con `useLocalSearchParams`; si llega `docS3Key`, precargar ese documento en el flujo. **Al confirmar el registro**, si hay `returnTo`, hacer `router.replace({ pathname: returnTo, params: { facturaRegistrada: '1' } })` en lugar de la navegación por defecto.
- En `escanear.tsx`: al volver, detectar el parámetro de señal (`facturaRegistrada`) con `useLocalSearchParams` (mismo patrón que `maestroActualizado` en `facturas-gasto.tsx`/`facturas-venta.tsx`), refrescar/limpiar el documento ya registrado y avisar al usuario.
- Mantener `registro-masivo` 100% funcional en su uso normal (sin `returnTo` = comportamiento actual intacto).
- `pendientes.tsx`: `TablaBasica`, filtro por sociedad, editar/reasignar/descartar.
- `emitir.tsx`: sociedad destino + emisor + serie existente + líneas → `POST /refacturacion/emitir`; enlazar a la factura creada.

**Registro del módulo (código real):**
- **Menú**: añadir la entrada en **`app/constants/modulos.ts`** (array `MODULOS`; `_layout.tsx` solo lo importa y filtra, y `PERMISOS_MENU_LATERAL` se deriva de ahí). Ej.: `{ route: '/refacturacion', label: 'Refacturación', icon: 'currency-exchange', permiso: 'refacturacion.ver' }`.
- **Icono**: verificar que exista en la versión de `@expo/vector-icons` del proyecto. Candidatos: `currency-exchange`, `receipt-long`, `sync`. `sync-alt` puede no existir → comprobar antes.
- **Stack**: añadir `<Stack.Screen name="refacturacion" />` en `app/(app)/_layout.tsx`.

---

## 8. Permisos

Códigos nuevos:
- `refacturacion.ver` — ver módulo (menú + `GET`).
- `refacturacion.gestionar` — crear/editar/emitir.

Registrar en **los tres sitios**:
1. **`app/(app)/permisos.tsx`** — añadir los códigos al catálogo por módulo (arrays de rol, ~L183-190) **y** al mapa de etiquetas (~L315-321, p. ej. `'refacturacion.emitir': 'Refacturación · …'`).
2. **`api/ROLES-PERMISOS.md`** — documentar los códigos.
3. **Seed/asignación** a los roles que correspondan en `Igp_RolesPermisos`.

Gating: `requirePermission` en API (sección 5) **y** `hasPermiso` en el front.

---

## 9. Reglas de cálculo

- `precio_refacturado_unitario = round2(precio_base_unitario * 1.05)`.
- `tipo_iva` de la línea refacturada = el de la línea original del ticket.
- `base_linea = round2(cantidad * precio_refacturado_unitario * (1 - descuento/100))`; `iva_linea = round2(base_linea * tipo_iva / 100)`.
- Recalcular **siempre en servidor**; guardar `precio_base_unitario` y `precio_refacturado_unitario` para trazabilidad.

---

## 10. Puntos de producto/UX a cerrar antes de picar

1. **Emisor = destino**: ¿se permite emitir con la misma sociedad como emisora y receptora? (¿bloqueo/validación?)
2. **Borrador vs emitida directa**: el flujo por defecto emite. ¿Se quiere poder dejar el OUT en borrador sin emitir?
3. **Documento origen**: ¿se adjunta al PDF de la factura OUT (adjuntos de factura) o queda solo en el S3 de refacturación?
4. ~~**"Registrar como factura"**~~ **CERRADO**: redirige a `registro-masivo` con el archivo ya subido y, al confirmar, vuelve al origen de refacturación vía `returnTo` (ver sección 7).
5. **Tickets sin detalle de líneas OCR**: fallback a una línea única `"Ticket {proveedor}"` con el total.

---

## 11. Criterios de aceptación (QA)

1. Subir 2 documentos → revisión; asignar cada documento a una sociedad y **mover una línea a otra sociedad**.
2. +5% sobre base, IVA recalculado sobre `base+5%` con tipo original; totales cuadran al céntimo.
3. Al confirmar, líneas `pendiente` bajo su sociedad, visibles en Pendientes.
4. Emitir por sociedad crea factura `OUT` en `Igp_Facturas` **con número reservado al emitir** (vía `emitirOValidarFacturaPorId`), emisor seleccionado y cliente = sociedad destino; líneas → `refacturada` con `factura_id`.
5. La factura aparece en el listado de emitidas y respeta numeración/auditoría/hash.
6. Documento marcado como factura → registrado como `IN` por `ocr/confirmar`, sin duplicar lógica.
7. Menú solo con `refacturacion.ver`; gestión exige `refacturacion.gestionar` **también en el API**.
8. Pendientes por sociedad se resuelven por Query (sin Scan).

---

## 12. Orden de implementación

1. **Infra**: crear tabla `Igp_Refacturaciones` (+ GSI opcional) en AWS + `tables.refacturaciones` en `db.js`.
2. **OCR**: decidir extraer `extraerDatosBasicos` a `api/lib/facturacion/ocrFacturaExtraer.js` **o** que el front use `/facturacion/ocr/extraer`.
3. **Router** `refacturacion.js` + montaje en `server.js` + `requirePermission`.
4. **Emisión** vía `construirFacturaConLineas` + `Put` + `emitirOValidarFacturaPorId`.
5. **Permisos**: `permisos.tsx` (catálogo + etiquetas) + `ROLES-PERMISOS.md` + asignación a roles.
6. **Front**: `app/(app)/refacturacion/` + entrada en `modulos.ts` + `Stack.Screen`.
7. **QA** sección 11.

Perfil de trabajo sugerido: planner-arquitecto → backend-api → frontend-ui → code-reviewer. Tamaño: **módulo mediano** (varios días), no un hotfix. Al terminar, enumerar archivos tocados y señalar deuda técnica sin bloquear. Responder en español.
