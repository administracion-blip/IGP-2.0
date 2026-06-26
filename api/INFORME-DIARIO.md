# Informe diario de jornadas por email

Envío automático (y manual) de un **informe diario en PDF** con la situación de las jornadas de los locales del **día anterior**. Cada destinatario recibe un PDF con **solo sus locales asignados**.

Contenido del PDF:

- Facturación real vs **comparativa** (con fecha comparativa/festivos) y % de variación.
- **Grado de cumplimiento** por local.
- Resumen de **invitaciones, descuentos y anulaciones**.
- **Top de ventas por usuario** (camareros/operadores).

## Configuración (tabla `Igp_Ajustes`)

Un único ítem editable desde **Ajustes → Informe diario por email**:

- **PK:** `informes`
- **SK:** `informe_diario`
- **Atributos:**
  - `Enabled` (Bool) — activa el envío automático
  - `Days` (List) — días de envío (`mon`..`sun`)
  - `Times` (List) — horas de envío (`["08:00"]`)
  - `Roles` (List) — roles que reciben el informe (por defecto `["Administrador"]`)
  - `TopLimit` (Number) — nº de usuarios en el top (por defecto 10)
  - `UltimaEjecucion`, `Estado`, `Resultado` — estado del último envío

## Destinatarios

Se resuelven en cada envío:

1. Usuarios de `igp_usuarios` cuyo `Rol` está en `Roles`.
2. Con `Email` válido y campo `Local` **no vacío**.
3. Los nombres de `Local` se mapean a `agoraCode` con el maestro `igp_Locales`.
4. Si un usuario no tiene locales resolubles, **no se le envía nada** (evita fugas de datos entre locales).

## Variables de entorno (api/.env / api/.env.local)

Reutiliza el SMTP existente:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `INTERNAL_SYNC_SECRET` — necesario para que el job interno pueda disparar el envío
- `JWT_SECRET` — usado para firmar el token de sistema en llamadas internas

## Endpoints

- **POST** `/api/informes/diario/enviar` — genera y envía el informe.
  - Body opcional: `{ businessDay: "YYYY-MM-DD" }` (por defecto, ayer).
  - Autorización: token de **Administrador** (botón "Forzar envío") **o** cabecera `X-Internal-Secret` (job).
  - Respuesta: `{ ok, businessDay, enviados, total, errores }`
- **GET** `/api/informes/diario/destinatarios` — previsualiza destinatarios resueltos con la config actual (solo Administrador).

La configuración se gestiona con el router genérico de ajustes:

- **GET** `/api/ajustes/informes/informe_diario`
- **POST** `/api/ajustes` con `{ PK:"informes", SK:"informe_diario", ... }`

## Arquitectura (archivos)

- `api/lib/email.js` — transporte SMTP compartido (`enviarEmail`), extraído de facturación.
- `api/lib/informes/informeDiario.js` — resolución de destinatarios y agregación de datos.
- `api/lib/informes/pdfInformeDiario.js` — generación del PDF con jsPDF + autotable (backend).
- `api/routes/informes.js` — endpoints de envío y destinatarios.
- `api/lib/jobs/scheduledTasks.js` — `checkInformeDiario` (scheduler, patrón día/hora).
- `app/(app)/ajustes.tsx` — sección de configuración + botón **Forzar envío ahora**.

## Reutilización

La agregación **no duplica lógica**: llama por HTTP interno a los endpoints existentes
`/api/cajas/top` (facturación, comparativa, cumplimiento, top por usuario) y
`/api/agora/invoices/exceptions` (invitaciones/descuentos/anulaciones), reenviando el token
del usuario o firmando uno de sistema (rol Administrador) en las ejecuciones del job.

## Flujo

```
checkInformeDiario() cada 60s
  └─ config Igp_Ajustes (Enabled + Days/Times) → POST interno /api/informes/diario/enviar
        ├─ businessDay = ayer
        ├─ destinatarios = usuarios por Rol con locales asignados
        └─ por destinatario: datos (top + exceptions) → PDF → email (1 PDF con sus locales)
```
