# 03 · Contrato de API

Todos los endpoints del módulo, **incluidos los que no se implementan todavía**.
La columna «Fase» dice cuándo existe cada uno. Un endpoint documentado aquí y no
implementado es correcto; uno implementado y no documentado aquí, no.

Ningún agente cambia este contrato por su cuenta. Si detecta que hace falta, se
para y lo plantea.

## Convenciones

| Aspecto | Regla |
|---|---|
| Routers | `api/routes/proyectos.js` y `api/routes/reuniones.js`, `export default router`, montados con `app.use('/api', xRouter)` **después** del `requireAuth` global |
| Autenticación | Heredada del `requireAuth` global. No repetirla en el router |
| Permisos | `requirePermission(cod)` en la ruta + ACL de fila dentro del handler. Ver [04](04-permisos-y-acceso.md) |
| Llamadas del cliente | Siempre `apiFetch` (`app/utils/api.ts`). La única excepción es el `PUT` a la URL prefirmada de S3 |
| Paginación | `?cursor=<opaco>&limite=<n>` (por defecto 50, máximo 200). La respuesta devuelve `{ items, cursor }`; `cursor` a `null` cuando no hay más. El cursor es el `LastEvaluatedKey` codificado, nunca un número de página |
| Errores | `{ error: '<mensaje en español>' }`. `400` datos inválidos · `403` sin permiso o sin visibilidad · `404` no existe **o no es visible** · `409` conflicto de estado · `422` transición no permitida |
| No filtrar en cliente | El filtrado por visibilidad se aplica **siempre** en el servidor, al listar y al leer detalle |
| Fechas | ISO en la API. La conversión a `dd/mm/aaaa` es cosa de la interfaz |

Sobre el `404` en lugar de `403` al leer una entidad no visible: es intencionado.
Un `403` confirma que la reunión existe, y en reuniones de dirección eso ya es
información.

---

## Departamentos

Maestro pequeño, guardado en `Igp_Ajustes`. Es **etiqueta organizativa**, no
control de acceso.

| Método | Ruta | Fase | Permiso | Notas |
|---|---|---|---|---|
| GET | `/api/tasks/departamentos` | 1A | `proyectos.ver` | Lista para desplegables |
| POST | `/api/tasks/departamentos` | 1A | `base_datos.editar` | `{ nombre, responsable_id }` |
| PATCH | `/api/tasks/departamentos/:id` | 1A | `base_datos.editar` | |
| DELETE | `/api/tasks/departamentos/:id` | 1A | `base_datos.editar` | Baja lógica (`activo: false`) si hay proyectos que lo usan |

---

## Proyectos

| Método | Ruta | Fase | Permiso | Notas |
|---|---|---|---|---|
| GET | `/api/proyectos` | 1A | `proyectos.ver` | Filtros `estado`, `departamento`, `responsable`. Solo los visibles |
| GET | `/api/proyectos/mios` | 1A | `proyectos.ver` | Vía `Miembro-index` |
| POST | `/api/proyectos` | 1A | `proyectos.crear` | Quien lo crea queda como miembro `responsable` salvo que indique otro |
| GET | `/api/proyectos/:id` | 1A | `proyectos.ver` + visibilidad | Una sola Query: `META` + miembros + compras + vínculos. Incluye `gasto_comprometido` y `gasto_real` calculados |
| PATCH | `/api/proyectos/:id` | 1A | `proyectos.editar` + ser responsable o miembro | |
| DELETE | `/api/proyectos/:id` | 1A | `proyectos.borrar` | Pasa a `cancelado`. Borrado físico **solo** si no tiene tareas; si las tiene, `409` |
| POST | `/api/proyectos/:id/miembros` | 1A | `proyectos.editar` | `{ usuario_id, rol_proyecto }` |
| DELETE | `/api/proyectos/:id/miembros/:usuarioId` | 1A | `proyectos.editar` | `409` si es el único responsable |
| GET | `/api/proyectos/:id/actividad` | 1A | `proyectos.ver` + visibilidad | Paginado, más reciente primero |
| POST | `/api/proyectos/:id/vinculos` | 1A | `proyectos.editar` | `{ tipo, id, etiqueta }` |
| DELETE | `/api/proyectos/:id/vinculos/:tipo/:entidadId` | 1A | `proyectos.editar` | |

### Compras y presupuesto (Fase 4)

Esquema disponible desde 1A, endpoints implementados en Fase 4.

| Método | Ruta | Permiso | Notas |
|---|---|---|---|
| GET | `/api/proyectos/:id/compras` | `proyectos.ver` + visibilidad | Líneas del proyecto con totales |
| POST | `/api/proyectos/:id/compras` | `proyectos.editar` | Calcula `nivel_aprobacion_requerido` según los umbrales de configuración |
| PATCH | `/api/proyectos/:id/compras/:lineaId` | `proyectos.editar` | Solo en estado `propuesta`, salvo `precio_real`, editable en `pedida` y `recibida` |
| POST | `/api/proyectos/:id/compras/:lineaId/aprobar` | `proyectos.compras_aprobar` + nivel suficiente | `422` si quien aprueba no alcanza el nivel requerido |
| POST | `/api/proyectos/:id/compras/:lineaId/rechazar` | `proyectos.compras_aprobar` | Exige `motivo` |
| POST | `/api/proyectos/:id/compras/:lineaId/estado` | `proyectos.editar` | `pedida` / `recibida`. `recibida` exige `precio_real` |
| GET | `/api/proyectos/compras/pendientes` | `proyectos.compras_aprobar` | Cola de aprobación vía `Compras-Estado-index`, solo las que el usuario puede aprobar |

Toda aprobación y todo cambio de estado escriben en `Igp_Actividad` con autor e
importe. Sin excepción.

### Plantillas (Fase 4)

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/api/proyectos/plantillas` | `proyectos.ver` |
| POST | `/api/proyectos/plantillas` | `proyectos.plantillas` |
| PATCH | `/api/proyectos/plantillas/:id` | `proyectos.plantillas` |
| DELETE | `/api/proyectos/plantillas/:id` | `proyectos.plantillas` |
| POST | `/api/proyectos/plantillas/:id/instanciar` | `proyectos.crear` |

`instanciar` crea el proyecto y sus tareas **a través de la creación en lote**, no
con un camino propio.

---

## Tareas

| Método | Ruta | Fase | Permiso | Notas |
|---|---|---|---|---|
| GET | `/api/tareas/mias` | 1A | `proyectos.ver` | **Vista personal.** Solo abiertas, ordenadas por vencimiento, vía `Responsable-Vencimiento-index`. Devuelve además el recuento de vencidas |
| GET | `/api/tareas` | 1A | `proyectos.ver` | Filtros `proyecto`, `responsable`, `estado`, `departamento`. Ver otra persona exige `tareas.ver_todas` o ser miembro del proyecto |
| POST | `/api/tareas` | 1A | `proyectos.editar` | |
| POST | `/api/tareas/lote` | 1A | `proyectos.editar` | **Creación en lote.** Ver abajo |
| GET | `/api/tareas/:id` | 1A | `proyectos.ver` + visibilidad | `META` + checklist + enlaces + vínculos en una Query |
| PATCH | `/api/tareas/:id` | 1A | ser responsable, o miembro del proyecto, o `tareas.editar_todas` | |
| POST | `/api/tareas/:id/estado` | 1A | igual que PATCH | Transiciones validadas. `bloqueada` exige motivo. Mantiene `vencimiento_orden` y `sk_proyecto` |
| POST | `/api/tareas/:id/reasignar` | 1A | `proyectos.editar` | Cambia el responsable único y avisa al nuevo |
| DELETE | `/api/tareas/:id` | 1A | `proyectos.borrar` | `409` si tiene subtareas abiertas |
| GET | `/api/tareas/:id/subtareas` | 1A | `proyectos.ver` | Vía `Padre-index` |
| GET | `/api/tareas/:id/actividad` | 1A | `proyectos.ver` + visibilidad | |

### Lista de comprobación

| Método | Ruta | Fase | Notas |
|---|---|---|---|
| POST | `/api/tareas/:id/checklist` | 1A | Añade elemento. `409` por encima de 50 |
| PATCH | `/api/tareas/:id/checklist/:itemId` | 1A | Marcar, desmarcar, renombrar, reordenar |
| DELETE | `/api/tareas/:id/checklist/:itemId` | 1A | |

Marcar un elemento **no** cambia el estado de la tarea, y completar todos tampoco
la cierra automáticamente. Cerrarla es una decisión de la persona.

### Comentarios

| Método | Ruta | Fase | Notas |
|---|---|---|---|
| GET | `/api/tareas/:id/comentarios` | 1A | Paginado |
| POST | `/api/tareas/:id/comentarios` | 1A | Extrae `@menciones` y genera avisos (Fase 3; en 1A solo se guardan) |

### Enlaces con captura

| Método | Ruta | Fase | Notas |
|---|---|---|---|
| POST | `/api/tareas/:id/enlaces` | 1A | Crea el enlace en `pendiente` y **responde de inmediato**. La captura va detrás |
| POST | `/api/tareas/:id/enlaces/:enlaceId/recapturar` | 1A | Manual y explícito. Nunca automático |
| DELETE | `/api/tareas/:id/enlaces/:enlaceId` | 1A | Borra también la imagen de S3 |

**Reglas de la descarga. Se hace en el servidor y nunca desde el cliente.**

- Solo esquemas `http` y `https`. Cualquier otro se rechaza con `400`.
- **Se resuelve el nombre de dominio y se rechazan las direcciones privadas o
  locales** (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`,
  IPv6 de ámbito local). Se comprueba **también en cada redirección**: si no, una
  redirección a `169.254.169.254` deja al servidor leyendo las credenciales de la
  instancia. Es la razón por la que este endpoint necesita revisión de seguridad.
- Máximo **2 redirecciones**.
- Tiempo máximo de espera y tamaño máximo, configurables (`Igp_Ajustes`,
  PK `proyectos`, SK `enlaces`).
- **No se descarga el cuerpo completo**: se leen solo los primeros KB, los
  suficientes para las etiquetas `<title>`, `og:*` y el precio, y se corta.
- La imagen se descarga aparte, con su propio límite de tamaño, comprobando que el
  tipo de contenido es realmente una imagen, y se guarda en S3.
- Un fallo de captura **no es un fallo del endpoint**: el enlace queda en `fallida`
  con su motivo y la tarea sigue viva.

### Adjuntos

| Método | Ruta | Fase | Notas |
|---|---|---|---|
| POST | `/api/tareas/:id/adjuntos/presign` | 1A | Devuelve URL prefirmada de `PUT`. Patrón de `api/routes/acuerdos.js` |
| POST | `/api/tareas/:id/adjuntos/confirmar` | 1A | Comprueba que el objeto existe y guarda los metadatos |
| GET | `/api/tareas/:id/adjuntos/:adjuntoId/url` | 1A | URL firmada de lectura, 1 hora |
| DELETE | `/api/tareas/:id/adjuntos/:adjuntoId` | 1A | |

Nunca base64 dentro del ítem de DynamoDB.

### Creación en lote — `POST /api/tareas/lote`

**Es el punto de unión entre el módulo de tareas y el de reuniones**, y también lo
que usan las plantillas. Un único camino de creación para que las validaciones,
los valores por defecto y el registro de actividad no se dupliquen.

Cuerpo: `{ proyecto_id?, reunion_origen_id?, tareas: [ { titulo, descripcion?,
responsable_id, fecha_limite?, prioridad?, checklist?, propuesta_origen_id?,
cita_origen? } ] }`

- Máximo 50 tareas por llamada.
- **Validación previa de todas**: si alguna es inválida, no se crea ninguna y se
  responde `400` indicando el índice y el motivo de cada fallo.
- Escritura por lotes de 25 (límite de DynamoDB), con reintento de los elementos no
  procesados.
- **Idempotencia**: si viene `propuesta_origen_id` y ya existe una tarea con ese
  valor, no se duplica; se devuelve la existente. Así una doble pulsación de
  «validar» no crea dos tareas.
- Respuesta: `{ creadas: [...], omitidas: [...] }`.

---

## Reuniones

| Método | Ruta | Fase | Permiso | Notas |
|---|---|---|---|---|
| GET | `/api/reuniones` | 1B | `reuniones.ver` | Filtros `desde`, `hasta`, `proyecto`, `estado`. **Filtrado de visibilidad en servidor** |
| POST | `/api/reuniones` | 1B | `reuniones.gestionar` | Crea la reunión, el evento en Calendar con el orden del día en la descripción y detecta la sala |
| GET | `/api/reuniones/:id` | 1B | `reuniones.ver` + visibilidad | `META` + asistentes + acuerdos + puntos + vínculos |
| PATCH | `/api/reuniones/:id` | 1B | `reuniones.gestionar` | El orden del día solo es editable **antes** de que empiece; después, `409` |
| DELETE | `/api/reuniones/:id` | 1B | `reuniones.gestionar` | Borra el registro, el evento de Calendar y el audio (derecho de supresión) |
| POST | `/api/reuniones/:id/asistentes` | 1B | `reuniones.gestionar` | |
| POST | `/api/reuniones/:id/aviso-grabacion` | 1B | `reuniones.gestionar` | Registra informados y quién acepta. **Sin esto no se emite URL de subida de audio** |
| GET | `/api/reuniones/:id/sugerencia-orden-del-dia` | 1B | `reuniones.gestionar` | Devuelve acuerdos pendientes y temas aplazados de la reunión anterior de la serie, como **texto editable**. En Fase 4 pasa a generarse solo |
| POST | `/api/reuniones/:id/acuerdos` | 1B | `reuniones.gestionar` | En 1B se escriben a mano |
| PATCH | `/api/reuniones/:id/acuerdos/:acuerdoId` | 1B | `reuniones.gestionar` | Estado `cumplido` / `incumplido` |
| GET | `/api/reuniones/:id/tareas` | 1B | `reuniones.ver` | Qué salió de la reunión, vía `Reunion-index` |

### Pipeline de audio (Fase 2)

| Método | Ruta | Permiso | Notas |
|---|---|---|---|
| POST | `/api/reuniones/:id/audio/presign` | `reuniones.gestionar` | Exige aviso de grabación aceptado. Valida extensión y tamaño declarado |
| POST | `/api/reuniones/:id/procesar` | `reuniones.gestionar` | Confirma que el objeto está en S3 y arranca. **Idempotente**: si ya hay `transcripcion_job_id`, no relanza |
| POST | `/api/reuniones/:id/reintentar` | `reuniones.gestionar` | Solo desde `error`. Respeta el máximo de intentos |
| GET | `/api/reuniones/:id/transcripcion` | `reuniones.ver` + visibilidad | URL firmada del JSON en S3 |
| DELETE | `/api/reuniones/:id/audio` | `reuniones.borrar_audio` | Solo con acta validada y audio presente; si no, `409`. Conserva transcripción y acta |
| GET | `/api/reuniones/:id/acta.pdf` | `reuniones.ver` + visibilidad | Fase 4 |

### Cola de validación de propuestas (Fase 2)

| Método | Ruta | Permiso | Notas |
|---|---|---|---|
| GET | `/api/reuniones/propuestas/pendientes` | `reuniones.gestionar` | Cola global vía `Propuesta-Estado-index`, filtrada por visibilidad de la reunión de origen |
| GET | `/api/reuniones/:id/propuestas` | `reuniones.ver` + visibilidad | Propuestas de una reunión, con su cita |
| POST | `/api/reuniones/:id/propuestas/resolver` | `reuniones.gestionar` | Resuelve varias de golpe |

Cuerpo de `resolver`: `{ decisiones: [ { id_propuesta, accion: 'aceptar' \| 'rechazar',
titulo?, descripcion?, responsable_id?, fecha_limite? } ] }`

- Aceptar con campos editados equivale a `editada_y_aceptada`: queda constancia de
  que la persona corrigió a la IA.
- Las aceptadas se convierten en tareas mediante `POST /api/tareas/lote`, con
  `propuesta_origen_id` y `cita_origen`.
- Rechazar **no borra** la propuesta: la marca. La cita se conserva.
- Operación idempotente: reenviar la misma decisión no duplica nada.

---

## Vencimientos en calendario (Fase 3)

| Método | Ruta | Autenticación | Notas |
|---|---|---|---|
| GET | `/api/tasks/vencimientos.ics?token=<firmado>` | **Token propio en la URL**, no JWT | Feed de calendario suscribible con las tareas abiertas del usuario |
| POST | `/api/tasks/vencimientos/token` | `proyectos.ver` | Genera o rota el token del usuario |

El feed se monta **antes** del `requireAuth` global (como `publicRouter`), porque
lo consume un cliente de calendario que no sabe de JWT. Por eso el token es
opaco, por usuario, revocable y sin permisos asociados más allá de leer las
tareas de ese usuario. En los eventos van título y fecha; **nunca** el contenido
de una reunión de dirección.

---

## Avisos (Fase 3)

| Método | Ruta | Permiso | Notas |
|---|---|---|---|
| GET | `/api/notificaciones` | Sesión | Las del usuario, paginadas |
| GET | `/api/notificaciones/no-leidas` | Sesión | Contador para la campana, vía `NoLeidas-index` |
| POST | `/api/notificaciones/leer` | Sesión | `{ ids }` o `{ todas: true }` |

---

## Endpoints internos (cron)

Los llama el propio proceso con `internalSyncFetchHeaders()`. Para que el bypass
funcione hay que **dar de alta el path exacto en `INTERNAL_SYNC_POST_PATHS`** de
`api/lib/internalSync.js`, que es una lista blanca: sin ese alta, el cron recibe
`401`.

| Método | Ruta | Fase | Qué hace |
|---|---|---|---|
| POST | `/api/reuniones/pipeline/tick` | 2 | Avanza las reuniones en vuelo. Consulta `Pipeline-index`, nunca `Scan` |
| POST | `/api/reuniones/audio/purgar` | 2 | Borra audio pasado el plazo de retención, solo con acta validada |
| POST | `/api/proyectos/avisos/enviar` | 3 | Avisos de vencimiento y de asignación |

Todos son idempotentes y usan el cerrojo descrito en [05](05-pipeline-reuniones.md).

---

## Qué NO existe en la API

Para que nadie lo dé por supuesto:

- No hay endpoint que cree tareas **sin** intervención humana. La IA escribe
  propuestas; solo `POST /api/tareas/lote`, invocado por una acción de una
  persona, crea tareas.
- No hay endpoint que refresque la captura de un enlace de forma automática.
- No hay borrado físico de proyectos con tareas, ni de propuestas, ni de
  actividad.
- No hay endpoint que devuelva la transcripción completa en el cuerpo de la
  respuesta: siempre URL firmada.
