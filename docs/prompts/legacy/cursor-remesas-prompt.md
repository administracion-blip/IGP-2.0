# Prompt para Cursor: Remesas de pago a proveedores (módulo Facturación)

## Nombre en producto (obligatorio en UI)

- **Nombre visible:** «Remesas de pago»
- **Subtítulo sugerido:** «Agrupa facturas pendientes y genera el fichero para el banco»
- **Ruta frontend:** `app/(app)/facturacion/remesas/` (`index.tsx`, `[remesaId].tsx`) + acción "Añadir a remesa" en `facturas-gasto.tsx`
- **Slug técnico API/tabla:** `remesas` / `Igp_Remesas`

## Contexto del proyecto

- Framework: React Native / Expo con backend Node.js/Express en `/api`, DynamoDB.
- **Objetivo**: seleccionar facturas de gasto pendientes de pago y generar un fichero Excel descargable en el formato de carga masiva del banco (v1: **BBVA Net Cash, formato FIT** — transferencias SEPA). Al confirmar la ejecución de la remesa, registrar automáticamente los pagos en cada factura.
- **Ya existe en el proyecto (reutilizar, no reinventar):**
  - Facturas de gasto (tipo IN) en `Igp_Facturas` con `fecha_vencimiento`, `estado` (`pendiente_pago` | `parcialmente_pagada` | `vencida` | `pagada`), `emisor_nombre`, `emisor_cif`, `emisor_iban`, `emisor_iban_alternativo` (el emisor de una factura de gasto ES el proveedor), y `empresa_*` (la sociedad del grupo receptora).
  - Pagos por factura en `Igp_FacturasPagos` vía `POST /api/facturacion/facturas/:id/pagos` (con `metodo_pago`, `referencia`).
  - Maestro `igp_Empresas` con `Iban`, `IbanAlternativo`, `Cif` — sirve tanto para sociedades propias (cuenta ordenante) como para proveedores (IBAN de respaldo si la factura no lo trae).
  - Patrón de permisos `hasPermiso('permiso.accion')`; patrón de rutas/errores de `api/routes/facturacion.js`.
- **Plantilla del banco**: `api/assets/remesas/bbva-fit-plantilla.xlsx` (ya está en el repo). Estructura:
  - Hoja `Remesa Transferencia SEPA`. Fila 1 contiene marcadores `TRANSFERENCIAS_SEPA` (H1 y O1) que el parser de BBVA usa — **no eliminarlos**.
  - Cabecera (fila 6, bajo los rótulos de la fila 5): `CIF` (A6), `SUFIJO ORDENANTE` (B6), `NOMBRE` (C6), `CUENTA` (D6, IBAN ordenante), `MOMENTO DEL ENVÍO` (E6), `FECHA ESPECÍFICA dd/mm/aaaa` (F6), `SEPA VALOR DÍA` (G6), `AGRUPAR LOS CARGOS EN UNO` (H6), `IMPORTE TOTAL` (I6), `DIVISA` (J6, "EUR").
  - Detalle desde la fila 10 (rótulos en fila 9): `NOMBRE DEL BENEFICIARIO` (A), `CUENTA DEL BENEFICIARIO` (B, IBAN), `IMPORTE (EUR)` (C), `CONCEPTO` (D, máx 140).
  - La hoja Instrucciones del banco exige: **sin fórmulas** (solo valores), nombre emisor máx 25 caracteres, concepto máx 140, IBAN completo.
- **Generación del fichero**: SIEMPRE partir de la plantilla y rellenar celdas (nunca crear el workbook desde cero: se perderían los marcadores y formatos que valida el banco). Hacerlo **en el backend** con una librería que preserve el contenido existente del workbook (`exceljs` — añadir a `api/package.json`; el `xlsx`/SheetJS del frontend no preserva bien plantillas). El endpoint devuelve el binario con `Content-Disposition: attachment`.

---

## Modelo de datos

### Tabla `Igp_Remesas`

```
remesaId          (PK, UUID)
nombre            string  — ej. "Pagos proveedores 15/08"
banco             string  — v1: "BBVA_FIT" (clave del generador de formato)
estado            string  — "Borrador" | "Generada" | "Ejecutada" | "Anulada"
sociedadId        string  — id_empresa de la sociedad ordenante (igp_Empresas)
sociedadNombre    string  — denormalizado, truncado a 25 chars para el fichero
sociedadCif       string
cuentaOrdenante   string  — IBAN de la sociedad (editable al crear; default Iban del maestro)
fechaEjecucion    string? — YYYY-MM-DD; si vacía, momento de envío = "Ahora"
lineas            array   — [{
                    id_factura, numero_factura, proveedorNombre, proveedorCif,
                    ibanBeneficiario, importe, concepto
                  }]
importeTotal      number  — suma de líneas
generadaEn        string? — ISO datetime del último fichero generado
ejecutadaEn       string? — ISO datetime de la confirmación
creadoPor / creadoEn / actualizadoEn
```

Las líneas se congelan dentro de la remesa (snapshot). Si una factura cambia después, la remesa en Borrador debe refrescarse manualmente (botón "revalidar").

---

## Tarea 1 — Registrar tabla y dependencia

- `DDB_REMESAS_TABLE` (default `Igp_Remesas`) en `api/lib/db.js` + `api/scripts/create-remesas-table.js` (patrón de los scripts existentes).
- Añadir `exceljs` a `api/package.json`.

## Tarea 2 — Backend `api/routes/remesas.js`

Patrón de auth/errores de `api/routes/facturacion.js`. Permisos nuevos: `remesas.ver`, `remesas.gestionar` registrados en roles/permisos.

**`GET /api/remesas`** — lista con filtro `?estado=`.

**`GET /api/remesas/:remesaId`** — ficha completa.

**`POST /api/remesas`** — crea en Borrador. Body: `{ nombre, sociedadId, facturaIds: [] }`. Por cada factura:
- Validar que es de gasto, estado `pendiente_pago` | `parcialmente_pagada` | `vencida`, y que pertenece a la sociedad indicada (si no, rechazar con detalle por factura).
- Importe de línea = **pendiente real** (total − suma de pagos registrados), no el total de la factura.
- IBAN beneficiario: prioridad `emisor_iban` de la factura → `Iban` del proveedor en `igp_Empresas` (match por CIF). Si no hay IBAN o no pasa la validación (ver Tarea 4), la factura entra en la respuesta como `excluida` con motivo, no rompe la remesa.
- Concepto por defecto: `"<numero_factura_proveedor || numero_factura> <proveedorNombre>"` truncado a 140.
- Una factura no puede estar en dos remesas no-Anuladas a la vez (guardar `remesaId` como marca en la factura o comprobar contra remesas activas).

**`PATCH /api/remesas/:remesaId`** — editar Borrador (añadir/quitar líneas, editar concepto/importe de línea con tope el pendiente, fechaEjecucion, cuentaOrdenante). Prohibido editar en estado Generada+ (hay que volver a Borrador con acción explícita `reabrir`).

**`GET /api/remesas/:remesaId/fichero`** — genera y devuelve el Excel:
- Carga `api/assets/remesas/bbva-fit-plantilla.xlsx`, rellena cabecera (fila 6) y detalle (desde fila 10), solo valores, sin fórmulas.
- `MOMENTO DEL ENVÍO`: valor `2` + `FECHA ESPECÍFICA` si `fechaEjecucion` informada; el valor "Ahora" que corresponda si no (verificar el valor exacto contra la hoja Instrucciones de la plantilla).
- `IMPORTE TOTAL` = suma de líneas; `DIVISA` = EUR; `AGRUPAR LOS CARGOS EN UNO` = False por defecto.
- Importes como número con 2 decimales (no strings).
- Marca la remesa como `Generada` y `generadaEn`. Nombre de descarga: `remesa-<sociedadCif>-<YYYYMMDD>.xlsx`.

**`POST /api/remesas/:remesaId/ejecutar`** — confirmación manual de que el banco procesó la remesa. Body: `{ fecha }`. Por cada línea crea un pago en la factura vía la lógica existente de pagos (`metodo_pago: "Transferencia"`, `referencia: "Remesa <remesaId>"`, importe de la línea). Estado → `Ejecutada`. **Idempotente**: si ya está Ejecutada, 409.

**`POST /api/remesas/:remesaId/anular`** — solo Borrador/Generada. No toca facturas.

## Tarea 3 — Arquitectura multi-banco (dejar preparada, implementar solo BBVA)

- `api/lib/remesas/formatos/` con un módulo por formato: `bbvaFit.js` exporta `{ clave: "BBVA_FIT", nombre: "BBVA Net Cash (FIT)", plantilla, generar(remesa) => Buffer }`.
- Registro de formatos en `api/lib/remesas/index.js`; el endpoint de fichero resuelve el generador por `remesa.banco`.
- Futuro (NO implementar ahora, solo dejar el hueco): `Cuaderno 34 / SEPA XML (pain.001)` — formato universal que aceptan todos los bancos españoles; otros Excel de otros bancos.

## Tarea 4 — Validación de IBAN (crítica, es dinero)

Utilidad `api/lib/remesas/iban.js`:
- Normalizar (quitar espacios, mayúsculas) y validar módulo 97 (ISO 13616) — algoritmo estándar, sin dependencias.
- Rechazar IBAN no-SEPA en v1 (la plantilla es de transferencia SEPA).
- El fichero **nunca** incluye una línea con IBAN inválido: la factura queda excluida con motivo visible en la UI.

## Tarea 5 — Frontend

- **En `facturas-gasto.tsx`**: modo selección múltiple (checkboxes) sobre facturas en estado pagable + botón "Crear remesa" que abre el formulario (nombre, sociedad — preseleccionada si todas las facturas son de la misma —, fecha de ejecución opcional).
- **Lista** (`remesas/index.tsx`): tarjetas con estado (chips Borrador/Generada/Ejecutada), sociedad, nº facturas, importe total.
- **Detalle** (`remesas/[remesaId].tsx`): cabecera con sociedad/cuenta/fecha, tabla de líneas mostrando por factura **total / pagado / pendiente** e **importe a remesar editable** (default el pendiente, tope el pendiente — permite pagos parciales desde la remesa), IBAN con badge de validación, excluidas con motivo, y acciones según estado: Descargar fichero / Marcar como ejecutada / Reabrir / Anular. La descarga en Expo: bajar el binario del endpoint y compartir con `expo-file-system` + `expo-sharing` (patrón de los PDFs existentes si ya lo hay en el proyecto).
- Confirmación con doble paso en "Marcar como ejecutada" (crea pagos en todas las facturas; irreversible salvo borrando pagos a mano).

## Tarea 6 — Reglas de negocio que NO son opcionales

1. El importe de cada línea es el **pendiente real** de la factura en el momento de crear/revalidar la remesa, nunca el total a ciegas.
2. Sin IBAN válido no hay línea. Sin excepciones.
3. Una remesa mezcla facturas de **una sola sociedad ordenante** (el fichero FIT tiene un único emisor en cabecera). Varias sociedades = varias remesas.
4. Generar el fichero NO marca las facturas como pagadas. Solo `ejecutar` crea pagos, y es una acción humana consciente posterior a la carga en el banco.
5. El sistema genera ficheros; **no ejecuta pagos ni se conecta al banco**.

---

## Criterios de aceptación

- Un fichero generado con 3 facturas de prueba se carga en BBVA Net Cash sin errores de validación (verificación manual del usuario).
- Los marcadores `TRANSFERENCIAS_SEPA` de la fila 1 y la hoja Instrucciones permanecen intactos en el fichero generado.
- Una factura con IBAN inválido aparece como excluida con motivo y no está en el Excel.
- `ejecutar` sobre una remesa de 2 facturas crea exactamente 2 pagos con referencia a la remesa, y las facturas pasan a `pagada` (o `parcialmente_pagada` si el pendiente no era el total).
- Repetir `ejecutar` devuelve 409 y no duplica pagos.
- Un usuario sin `remesas.gestionar` puede ver remesas pero no crear, generar ni ejecutar.
