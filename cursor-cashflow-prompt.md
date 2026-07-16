# Prompt para Cursor: Módulo Cashflow (efectivo fuera de caja con recibí firmado)

## Nombre en producto

- **Nombre visible:** «Cashflow» (la pantalla placeholder `app/(app)/cashflow.tsx` ya existe con menú y permiso `cashflow.ver` — se sustituye su contenido)
- **Rutas frontend:** convertir en carpeta `app/(app)/cashflow/` (`index.tsx` lista, `nuevo.tsx` alta+firma, `[movimientoId].tsx` detalle)

## Objetivo

Registrar pagos y cobros **en efectivo fuera de las cajas de los bares** (ej. pagar a un músico, cobrar un evento privado en mano):

1. Cada **pago** genera un **recibí** en PDF que el beneficiario firma en la pantalla del móvil; el documento queda archivado.
2. Los movimientos firmados **ajustan el «efectivo a ingresar»** del local/sociedad en el rango: los pagos restan; los cobros suman, salvo que se marquen como «reparto entre socios» (que no van al banco).
3. Todo queda auditado: quién registró, quién firmó, quién anuló y por qué.

## Contexto (verificado en el código)

- `GET /api/cajas/efectivo-ingresar` en `api/routes/arqueosReales.js` (~línea 876) calcula hoy: `aIngresar = conteo del arqueo + retiradas TPV`, agrupado local→sociedad usando `agoraCode→empresa` de locales y el maestro `igp_Empresas`. **Este endpoint es el punto de integración.**
- `Igp_MovimientosCaja` (`api/routes/movimientosCaja.js`) son movimientos **del TPV** (retirada/transferencia por POS y jornada). NO tocar ni reutilizar esa tabla: el cashflow es dinero fuera del TPV. Sí imitar sus patrones (justificante a S3, tipos validados).
- Actuaciones/artistas existen (`api/routes/artistasActuaciones.js`, `tarifaActuacion.js`): un pago puede vincularse a una actuación.
- PDFs server-side: patrón de `api/lib/informes/pdfInformeDiario.js`. Subidas S3 + URL firmada: patrón de adjuntos de facturación.
- Permisos: mecanismo `Igp_RolesPermisos` + `requirePermission` (backend) + `GRUPOS_PERMISOS`/`MODULOS` en `app/constants/modulos.ts` (matriz de la pantalla Permisos).

## Permisos

| Código | Qué habilita |
|---|---|
| `cashflow.ver` | (ya existe, menú) Ver movimientos de los locales visibles del usuario |
| `cashflow.registrar` | Crear movimientos y completar el flujo de firma |
| `cashflow.validar` | Aprobar movimientos que superen el umbral, anular movimientos |

Registrar los dos nuevos en el grupo «Cashflow» de `GRUPOS_PERMISOS` y documentar en `api/ROLES-PERMISOS.md`. Los locales visibles se filtran en servidor con `usuarioPuedeAccederLocal` (`api/lib/usuarioLocales.js`).

## Modelo de datos — `Igp_Cashflow`

```
PK              string — "LOCAL#<localId>"
SK              string — "FECHA#<YYYY-MM-DD>#<movimientoId(uuid)>"
movimientoId
tipo            string — "pago" | "cobro"
importe         number — positivo siempre; el signo lo da `tipo`
fecha           string — YYYY-MM-DD (jornada a la que imputa)
localId / localNombre / empresaId / empresaNombre  (denormalizados al crear,
                resueltos del maestro local→empresa que ya usa efectivo-ingresar)
categoria       string — "actuacion" | "proveedor" | "evento" | "otros"
concepto        string — texto libre obligatorio
contraparte     { nombre, nif, telefono? } — obligatorio nombre+nif en pagos;
                en cobros nif opcional
destinoCobro    string? — solo cobros:
                "banco"          → el efectivo va a la caja fuerte y se suma al a-ingresar
                "reparto_socios" → no suma; requiere `cashflow.validar` para elegirlo
                "caja_tpv"       → el efectivo se metió físicamente en la caja de un TPV
                                   (ej. prepago de un evento cobrado en barra): NO suma al
                                   a-ingresar (ya está dentro del conteo del arqueo de esa
                                   caja) y debe conciliarse con ese arqueo (ver Tarea 3b)
cajaTpv         { workplaceId, posId, jornada }? — obligatorio si destinoCobro="caja_tpv"
actuacionId     string? — vínculo opcional a actuación (precarga artista y tarifa)
estado          string — "Pendiente_firma" | "Firmado" | "Pendiente_validacion" | "Anulado"
firmaS3Key      string? — PNG de la firma capturada
reciboS3Key     string? — PDF del recibí generado
anulacion       { motivo, usuarioId, fecha }? — anular NO borra (auditoría)
validadoPor     string? — si superó el umbral
creadoPor / creadoEn / actualizadoEn
```

**GSI:** `EmpresaId-Fecha-index` (PK `empresaId`, SK `fecha`) para agregación por sociedad en rangos.

## Modelo de datos — `Igp_CashflowPlantillas` (plantillas de recibí)

El texto fijo del recibí es personalizable y se guarda como plantillas con nombre; al crear un movimiento se elige cuál usar. Las **variables** se escriben como placeholders y las rellena el sistema — el usuario edita solo la rúbrica, nunca los datos.

```
plantillaId   (PK, UUID)
nombre        string  — ej. "Recibí actuación musical", "Entrega prepago evento"
tipo          string  — "pago" | "cobro" | "ambos" (filtra el selector según el movimiento)
titulo        string  — encabezado del PDF (ej. "RECIBÍ")
cuerpo        string  — texto con placeholders. Disponibles:
              {{numero_recibo}} {{fecha}} {{importe}} {{importe_letra}}
              {{concepto}} {{categoria}} {{contraparte_nombre}} {{contraparte_nif}}
              {{empresa_nombre}} {{empresa_cif}} {{local_nombre}} {{empleado_nombre}}
piePagina     string? — texto legal/nota al pie
esDefault     boolean — una por tipo como máximo
creadoPor / creadoEn / actualizadoEn
```

Validación al guardar: el cuerpo debe contener como mínimo `{{importe}}`, `{{fecha}}` y `{{contraparte_nombre}}` (un recibí sin esos datos no justifica nada); placeholder desconocido → error con el listado de válidos. Seed inicial: script que crea las dos plantillas por defecto (pago y cobro) con los textos estándar de la Tarea 2.

**Regla de inmutabilidad:** al firmar, el movimiento guarda `plantillaId` + el **texto ya renderizado** (`reciboTextoSnapshot`). Editar o borrar una plantilla después NUNCA altera recibís ya emitidos — el PDF y su snapshot son la verdad histórica.

## Tarea 1 — Tabla y registro

`DDB_CASHFLOW_TABLE` (default `Igp_Cashflow`) y `DDB_CASHFLOW_PLANTILLAS_TABLE` (default `Igp_CashflowPlantillas`) en `api/lib/db.js` + scripts de creación. Env: `CASHFLOW_UMBRAL_VALIDACION` (default 300 — importe a partir del cual un movimiento requiere validación).

## Tarea 2 — Backend `api/routes/cashflow.js`

- `GET /api/cashflow?dateFrom=&dateTo=&localId=&tipo=&estado=` (`cashflow.ver`) — solo locales visibles del usuario; orden fecha desc.
- `POST /api/cashflow` (`cashflow.registrar`) — crea en `Pendiente_firma`. Validaciones: importe > 0, contraparte con NIF en pagos, local visible. Si `importe > CASHFLOW_UMBRAL_VALIDACION` → tras la firma pasa a `Pendiente_validacion` en lugar de `Firmado`.
- `POST /api/cashflow/:id/firmar` — recibe la firma (PNG base64 o multipart): sube firma a S3, **genera el PDF del recibí en servidor** y lo sube a S3, transiciona a `Firmado` (o `Pendiente_validacion`). Contenido del recibí: nº de recibo (`CF-<año>-<secuencial>`), fecha, sociedad pagadora (nombre + CIF del maestro empresas), local, concepto, categoría, importe en cifra **y en letra**, nombre y NIF de la contraparte, leyenda «Recibí la cantidad indicada en concepto de…» para pagos / «Entregué…» para cobros, imagen de la firma, y nombre del empleado que registra.
- `POST /api/cashflow/:id/validar` (`cashflow.validar`) — `Pendiente_validacion` → `Firmado`. Genera notificación al creador si el sistema de notificaciones (módulo Proyectos) ya está desplegado; si no, omitir sin fallar.
- `POST /api/cashflow/:id/anular` (`cashflow.validar`) — motivo obligatorio; conserva PDF y firma.
- `GET /api/cashflow/:id/recibo` — URL firmada del PDF.
- `GET /api/cashflow/resumen?dateFrom=&dateTo=` — agregado por local y sociedad: pagos, cobros a banco, cobros a reparto, neto. Para el dashboard del módulo.

**Plantillas** (`GET` lista con `cashflow.ver`; crear/editar/borrar con `cashflow.validar`):
- `GET /api/cashflow/plantillas?tipo=` · `POST /api/cashflow/plantillas` · `PUT /api/cashflow/plantillas/:id` · `DELETE /api/cashflow/plantillas/:id` (borrar no afecta a recibís emitidos; si era default, la estándar del seed vuelve a ser default).
- El movimiento acepta `plantillaId` opcional en el POST; sin él usa la default de su tipo. `firmar` renderiza el cuerpo sustituyendo placeholders, guarda `reciboTextoSnapshot` y genera el PDF con ese texto.

**Regla de estados:** solo `Firmado` computa en el efectivo a ingresar. `Pendiente_firma`, `Pendiente_validacion` y `Anulado` no ajustan nada.

## Tarea 3 — Integración con efectivo a ingresar (LA CLAVE DEL MÓDULO)

En `GET /api/cajas/efectivo-ingresar` (arqueosReales.js):

- Query a `Igp_Cashflow` por los locales del rango (movimientos `Firmado` con `fecha` en [dateFrom, dateTo]).
- Nueva fórmula por local:
  `aIngresar = conteo + retiradasTPV − pagosCashflow + cobrosCashflow(destinoCobro="banco")`
- Los cobros con `destinoCobro="reparto_socios"` NO suman, pero se devuelven aparte.
- Los cobros con `destinoCobro="caja_tpv"` NO suman al a-ingresar del cashflow (su efectivo ya viene dentro del conteo del arqueo de esa caja); se devuelven en su propia columna informativa.

## Tarea 3b — Conciliación de cobros metidos en caja TPV

En el cálculo de diferencias del arqueo (`api/routes/arqueosReales.js`, donde hoy `real efectivo = contado + retiradas`):

- Consultar los cobros `Firmado` del cashflow con `destinoCobro="caja_tpv"` cuya `cajaTpv` coincida con el workplaceId + posId + jornada del arqueo.
- Sumarlos al **teórico esperado de efectivo** de ese arqueo (el dinero está en el cajón pero no viene de ventas del TPV), de modo que el arqueo cuadre en lugar de arrojar descuadre positivo.
- Mostrar en la revisión de ese arqueo una línea informativa «Cobros externos en caja: +X € (cashflow)» con enlace al movimiento — el revisor debe ver de un vistazo por qué hay más efectivo del que dice Ágora.
- Límite claro de responsabilidades: si un **pago** sale del cajón de un TPV, eso es una **retirada de caja** del módulo existente (`Igp_MovimientosCaja`), NO un movimiento de cashflow. El cashflow solo registra pagos desde fuera de las cajas.
- Ampliar la respuesta con desglose transparente por local y en los totales por sociedad: `{ ..., pagosFueraCaja, cobrosFueraCaja, cobrosRepartoSocios, aIngresar }`. La UI de revisiones/efectivo a ingresar muestra las nuevas columnas — nadie debe preguntarse por qué el número no cuadra con el arqueo.
- `aIngresar` puede quedar **negativo** (semana floja + pago gordo): mostrarlo en rojo, no truncar a 0 — significa que el local necesitó más efectivo del que generó.

## Tarea 4 — Frontend

- **Lista** (`cashflow/index.tsx`): filtros rango/local/tipo/estado, tarjetas con chip de estado y categoría, resumen superior (pagos, cobros, neto del rango). FAB «+» con `cashflow.registrar`.
- **Alta + firma** (`nuevo.tsx`): formulario (tipo, local, fecha, categoría, concepto, importe, contraparte, destino si cobro, vínculo a actuación opcional que precargue artista/tarifa) → pantalla de firma a pantalla completa (`react-native-signature-canvas` u otra compatible Expo; si requiere WebView, documentarlo) con el resumen del recibí visible encima de la zona de firma → confirmar llama a `firmar` y muestra el PDF resultante (compartir con expo-sharing, patrón PDFs existentes).
- **Detalle** (`[movimientoId].tsx`): datos completos, botón ver/compartir recibo, validar (si `cashflow.validar` y `Pendiente_validacion`), anular con motivo.
- **Plantillas de recibí** (`plantillas.tsx`, visible con `cashflow.validar`): lista + editor con el cuerpo en un textarea, chips tocables que insertan cada placeholder en el cursor, y **vista previa en vivo** renderizada con datos de ejemplo. En el alta de movimiento: selector de plantilla (default preseleccionada) con vista previa del texto ya sustituido antes de pasar a la firma.
- Aviso bloqueante en pagos > 1.000 €: «Supera el límite legal de pagos en efectivo a profesionales/empresas (Ley 11/2021)». Configurable con `CASHFLOW_LIMITE_LEGAL` (default 1000); se puede continuar solo si la contraparte se marca como «particular» (el límite aplica a empresarios/profesionales).

## Reglas no opcionales

1. Sin firma no hay ajuste: solo `Firmado` toca el efectivo a ingresar.
2. Anular nunca borra; el recibo y la firma se conservan.
3. `reparto_socios` requiere `cashflow.validar` y queda siempre identificado por separado en los desgloses (rastro completo de quién decidió y cuándo).
4. El desglose del efectivo a ingresar siempre muestra los ajustes del cashflow por separado — el número final debe ser explicable a simple vista.
5. NIF obligatorio en pagos: sin NIF de la contraparte no se puede generar el recibí.
6. Los recibís emitidos son inmutables: editar/borrar plantillas jamás cambia un PDF firmado ni su snapshot.

## Criterios de aceptación

- Pago de 200 € a un músico: firma en pantalla, PDF con importe en letra y firma embebida, descargable; el efectivo a ingresar de esa semana/local baja exactamente 200 € con la columna `pagosFueraCaja` mostrándolo.
- Cobro de 500 € con destino banco: sube 500 €. El mismo cobro con `reparto_socios`: no sube, y aparece en su columna.
- Cobro de 300 € con destino `caja_tpv` sobre una caja/jornada concreta: el a-ingresar del cashflow no cambia, y el arqueo de esa caja cuadra mostrando la línea «Cobros externos en caja: +300 €» en lugar de descuadre positivo.
- Movimiento de 400 € (umbral 300): queda `Pendiente_validacion` tras la firma y no ajusta hasta validarse.
- Anulado un movimiento firmado: el efectivo a ingresar vuelve a su valor previo; el PDF sigue accesible.
- Usuario con `cashflow.ver` de un solo local no ve movimientos de otros; sin `cashflow.registrar` no ve el FAB y el POST devuelve 403.
- Pago de 1.200 € a contraparte profesional: bloqueado con el aviso legal.
- Crear plantilla «Recibí actuación» con texto propio, usarla en un pago: el PDF muestra ese texto con las variables sustituidas. Editar la plantilla después: el PDF del pago firmado no cambia.
- Guardar una plantilla sin `{{importe}}` devuelve error indicando los placeholders obligatorios.

## Mejoras futuras (NO implementar)

1. **Saldo de caja auxiliar por local**: saldo acumulado de la caja fuerte (entradas/salidas/ingresos a banco) con recuento periódico — el paso natural siguiente.
2. Export mensual a gestoría (Excel con recibís adjuntos).
3. Foto del DNI de la contraparte adjunta al recibí.
4. Integración con Proyectos/Agenda vía refs (`entidad: "cashflow"`).
5. Retención IRPF en el recibí para actuaciones (cálculo y desglose) — validar antes con la gestoría.
