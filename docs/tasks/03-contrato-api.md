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
| GET | `/api/departamentos` | 0 | solo sesión | Lista para desplegables. `?soloActivos=1` para los formularios. Incluye `responsable_nombre` resuelto |
| POST | `/api/departamentos` | 0 | `departamentos.editar` | `{ nombre, responsable_id?, orden? }` |
| PATCH | `/api/departamentos/:id` | 0 | `departamentos.editar` | |
| DELETE | `/api/departamentos/:id` | 0 | `departamentos.editar` | **Siempre baja lógica** (`activo: false`) |

Tres cosas que cambian respecto al primer borrador de este contrato:

La ruta es `/api/departamentos`, no `/api/tasks/departamentos`, por coherencia con
`/api/locales` y `/api/empresas` y con D-11: «tasks» se queda en los nombres de
fichero. Y adelanta a la **Fase 0** porque el campo `Departamentos` de la ficha de
usuario necesita el maestro para tener algo que elegir.

El permiso de escritura es `departamentos.editar`, el patrón real de los maestros
(`locales.editar`, `empresas.editar`). `base_datos.editar` no existe en el
repositorio. Uno solo para las tres escrituras, porque el maestro es diminuto y
tres permisos para cinco filas es burocracia.

La lectura solo pide sesión: alimenta desplegables de todo el módulo y de la ficha
de usuario, así que exigir permiso ahí solo consigue formularios con listas vacías.
No hay nada sensible en una lista de nombres de departamento. Por el mismo motivo
devuelve `responsable_nombre` ya resuelto: si la pantalla tuviera que cruzarlo con
`/api/usuarios`, que sí exige `usuarios.ver`, quien no tenga ese permiso vería el ID
crudo del responsable en la tabla. Vale `null` cuando el usuario ya no existe.

**El borrado es siempre lógico**, no solo cuando hay proyectos que lo usan. Un
`departamento_id` guardado en tareas, proyectos y fichas de usuario sin integridad
referencial no se puede quedar apuntando a nada, y comprobar los tres sitios en cada
borrado cuesta más que dejar la fila con `activo: false`. Los inactivos no salen en
los desplegables pero siguen resolviendo el nombre de lo ya grabado.

---

## Nombres y permisos de fila

Todo proyecto y toda tarea que salen de la API llevan, además de sus campos
guardados, lo que la interfaz necesita para pintar la fila **sin cruzar nada y sin
reimplementar la capa de acceso**. Aplica a listados, fichas y a las respuestas de
escritura, para que refrescar una fila tras editarla no la deje sin estos campos.

| Campo | Dónde | Valor |
|---|---|---|
| `responsable_nombre` | proyecto y tarea | Nombre visible del `responsable_id`. `null` si no hay responsable o el usuario ya no existe |
| `usuario_nombre` | cada fila de miembro de proyecto | Igual, sobre `usuario_id` |
| `proyecto_nombre` | tarea | Solo si la tarea tiene `proyecto_id`, igual que ese campo. `null` si el proyecto ya no se puede leer **o si quien pregunta no lo alcanza**: tener una tarea asignada no da acceso al proyecto del que cuelga, ni a su nombre |
| `permisos_fila` | proyecto: `{ editar, borrar }` · tarea: `{ editar, reasignar, borrar, crear_subtarea }` | Booleanos, sobre esa fila y para quien pregunta |

El nombre visible se compone igual que en el maestro de departamentos: `Nombre` y
`Apellidos`, y el email como último recurso. **Lo resuelve el servidor** porque las
pantallas del módulo se abren con `proyectos.ver` y cruzar los ids contra
`/api/usuarios` exigiría además `usuarios.ver`: quien tuviera el primero y no el
segundo vería «responsable no disponible» en todas las columnas.

Se resuelve **en lote, una vez por petición**: un listado de cincuenta tareas de
doce personas son doce claves en un `BatchGet`, nunca cincuenta lecturas. Los ids
que ya no están en `igp_usuarios` salen a `null`; no hay integridad referencial y
una persona dada de baja no puede tumbar un listado.

`permisos_fila` sale de `api/lib/tasks/acceso.js`, las mismas funciones que después
autorizan la escritura. Existe para que la interfaz **no lleve su propia copia de
las reglas de acceso**: dos implementaciones de la misma decisión divergen, y el
síntoma es un botón escondido a quien sí puede pulsarlo. Lo que dice `permisos_fila`
es lo que responde la escritura correspondiente.

`borrar` refleja el permiso global y la visibilidad, que es lo que comprueban
`borrarProyecto` y `borrarTarea`. En un **proyecto**, borrar se lleva también
las tareas. En una **tarea**, `borrar: true` puede acabar en `409` si tiene
subtareas abiertas: eso exige contarlas y no merece una lectura por fila. La
interfaz tiene que enseñar ese mensaje.

`crear_subtarea` **no coincide con `editar`**, y ahí está su motivo de existir:
colgar una subtarea es crear una tarea, y crear decide sobre el proyecto. Quien es
responsable de una tarea de un proyecto del que no es miembro puede cerrar esa tarea
y no puede añadir trabajo al proyecto. Sin este campo, la pantalla deducía el
permiso del de editar y ofrecía un botón que `POST /api/tareas` rechazaba.

`GET /api/proyectos` y `/api/proyectos/mios` **sí** incluyen `permisos_fila`: sale
del mapa de pertenencia que los dos listados ya leían para filtrar la visibilidad,
que trae la fila de miembro de quien pregunta —lo único que mira
`puedeEditarProyecto`—. Ninguna de estas resoluciones añade una lectura por fila.

---

## Proyectos

En proyectos y tareas, **una fila que no se alcanza responde `404`**, indistinguible
de que no exista; el `403` queda para «la veo pero no puedo tocarla» (D-16).

| Método | Ruta | Fase | Permiso | Notas |
|---|---|---|---|---|
| GET | `/api/proyectos` | 1A | `proyectos.ver` | Filtros `estado`, `departamento`, `responsable`. Solo los visibles |
| GET | `/api/proyectos/mios` | 1A | `proyectos.ver` | Vía `Miembro-index` |
| POST | `/api/proyectos` | 1A | `proyectos.crear` | Quien lo crea queda como miembro `responsable` salvo que indique otro |
| GET | `/api/proyectos/:id` | 1A | `proyectos.ver` + visibilidad | Una sola Query: `META` + miembros + compras + vínculos. Incluye `gasto_comprometido` y `gasto_real` calculados, y `usuario_nombre` en cada miembro |
| PATCH | `/api/proyectos/:id` | 1A | ser responsable, o miembro con `proyectos.editar` | |
| DELETE | `/api/proyectos/:id` | 1A | `proyectos.borrar` | Borrado físico del proyecto **y de sus tareas** (D-17). Cancelar sin borrar es `PATCH { estado: 'cancelado' }` |
| POST | `/api/proyectos/:id/miembros` | 1A | ser responsable, o miembro con `proyectos.editar` | `{ usuario_id, rol_proyecto }` |
| DELETE | `/api/proyectos/:id/miembros/:usuarioId` | 1A | ser responsable, o miembro con `proyectos.editar` | `409` si es el único responsable |
| GET | `/api/proyectos/:id/actividad` | 1A | `proyectos.ver` + visibilidad | Paginado, más reciente primero |
| POST | `/api/proyectos/:id/vinculos` | 1A | ser responsable, o miembro con `proyectos.editar` | `{ tipo, id, etiqueta }` |
| DELETE | `/api/proyectos/:id/vinculos/:tipo/:entidadId` | 1A | ser responsable, o miembro con `proyectos.editar` | |

**Las escrituras de proyecto no llevan `requirePermission`: decide la ACL de
fila** (`puedeEditarProyecto`), igual que en el router de tareas. El dueño de un
proyecto tiene que poder gestionarlo aunque solo tenga `proyectos.ver`; ver
[04](04-permisos-y-acceso.md) y D-16 para el `404`/`403`.

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
| GET | `/api/tareas/mias` | 1A | `proyectos.ver` | **Vista personal.** Solo abiertas, ordenadas por vencimiento, vía `Responsable-Vencimiento-index`. Devuelve además el recuento de vencidas. Incluye `proyecto_nombre`: la pantalla no necesita traerse el listado de proyectos para cruzarlo |
| GET | `/api/tareas` | 1A | `proyectos.ver` | **Exige `proyecto` o `responsable`** (D-18); además, filtros `estado` y `departamento`. Ver otra persona exige `tareas.ver_todas` o ser miembro del proyecto |
| POST | `/api/tareas` | 1A | poder editar el proyecto: ser responsable, o miembro con `proyectos.editar`. **Sin proyecto**, `proyectos.editar` | |
| POST | `/api/tareas/lote` | 1A | `proyectos.editar` | **Creación en lote.** Ver abajo |
| GET | `/api/tareas/:id` | 1A | `proyectos.ver` + visibilidad | `META` + checklist + enlaces + vínculos en una Query |
| PATCH | `/api/tareas/:id` | 1A | ser responsable, o miembro del proyecto, o `tareas.editar_todas` | |
| POST | `/api/tareas/:id/estado` | 1A | igual que PATCH | Transiciones validadas. `bloqueada` exige motivo. Mantiene `vencimiento_orden` y `sk_proyecto` |
| POST | `/api/tareas/:id/reasignar` | 1A | poder editar el proyecto de la tarea; en tarea suelta, haberla creado. **`tareas.editar_todas` no reasigna** (D-13) | Cambia el responsable único y avisa al nuevo |
| DELETE | `/api/tareas/:id` | 1A | `proyectos.borrar` | `409` si tiene subtareas abiertas. Se lleva la partición entera **y los objetos de S3** de sus enlaces y adjuntos |
| GET | `/api/tareas/:id/subtareas` | 1A | `proyectos.ver` | Vía `Padre-index` |
| GET | `/api/tareas/:id/actividad` | 1A | `proyectos.ver` + visibilidad | |

Borrar una tarea borra también los objetos de S3 de sus enlaces y adjuntos, por el
mismo camino que `DELETE` de un enlace o de un adjunto sueltos. Un fallo de S3 se
registra y **no impide** el borrado en DynamoDB: si lo impidiera, un objeto
inaccesible dejaría una tarea que nadie puede borrar nunca.

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
| GET | `/api/tareas/:id/enlaces/:enlaceId/imagen` | 1A | URL firmada de lectura de la captura, 1 hora. `404` si no hay `imagen_s3_key` |
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
| GET | `/api/reuniones` | 1B | `reuniones.ver` | Filtros `desde`, `hasta`, `proyecto`, `estado`. **Filtrado de visibilidad en servidor**. Cada ítem lleva `convocado_nombre` y `permisos_fila: { editar, borrar }` |
| POST | `/api/reuniones` | 1B | `reuniones.gestionar` | Crea la reunión e intenta el evento en Calendar. Si Google no está o falla (**D-21**), la reunión se guarda igual y la respuesta lleva `calendario_sincronizado: false` (más `calendario_error`, `calendar_disponible`) |
| GET | `/api/reuniones/:id` | 1B | `reuniones.ver` + visibilidad | `META` + asistentes + acuerdos + puntos + vínculos. Incluye `permisos_fila` y nombres resueltos |
| PATCH | `/api/reuniones/:id` | 1B | `reuniones.gestionar` | El orden del día solo es editable **antes** de `celebrada` / `acta_*` (**D-20**); después, `409`. Al pasar a esos estados se copia a `orden_del_dia_congelado` si no había |
| DELETE | `/api/reuniones/:id` | 1B | `reuniones.gestionar` | Borra el registro y el evento de Calendar (stub: no tumba si falla) |
| POST | `/api/reuniones/:id/asistentes` | 1B | `reuniones.gestionar` | Tras guardar ASIST#, si hay `calendar_event_id` sincroniza attendees (emails del ítem o de `igp_usuarios`). Fallo de Calendar (**D-21**): alta OK + `calendario_sincronizado: false` opcional |
| POST | `/api/reuniones/:id/aviso-grabacion` | 1B | `reuniones.gestionar` | Registra informados y quién acepta. **Sin esto no se emite URL de subida de audio** |
| GET | `/api/reuniones/:id/sugerencia-orden-del-dia` | 1B | `reuniones.gestionar` | Devuelve acuerdos pendientes y temas aplazados de la reunión anterior de la serie, como **texto editable**. En Fase 4 pasa a generarse solo |
| POST | `/api/reuniones/:id/acuerdos` | 1B | `reuniones.gestionar` | En 1B se escriben a mano |
| PATCH | `/api/reuniones/:id/acuerdos/:acuerdoId` | 1B | `reuniones.gestionar` | Estado `cumplido` / `incumplido` |
| POST | `/api/reuniones/:id/acuerdos/crear-tareas` | 1B | `reuniones.gestionar` | **D-23.** Convierte acuerdos abiertos sin `tarea_id` en tareas vía `crearTareasEnLote`, y enlaza `acuerdo.tarea_id`. Cuerpo opcional: `{ acuerdo_ids?: string[] }` (si no viene, todos los candidatos con responsable). Respuesta: `{ creadas, omitidas, enlazados }` |
| GET | `/api/reuniones/:id/tareas` | 1B | `reuniones.ver` | Qué salió de la reunión, vía `Reunion-index` |
| GET | `/api/reuniones/:id/actividad` | 1B | `reuniones.ver` + visibilidad | Paginado, más reciente primero |

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
