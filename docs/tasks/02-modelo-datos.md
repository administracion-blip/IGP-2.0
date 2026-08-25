# 02 · Modelo de datos

Esquema **completo de todas las fases**. Diseñarlo entero desde el principio es lo
que evita migraciones dolorosas: un campo documentado aquí y todavía sin usar es
correcto, un campo inventado sobre la marcha no.

**Cada fase implementa solo lo suyo.** La columna «Fase» de cada tabla indica
cuándo se empieza a escribir cada campo.

## Convenciones

| Regla | Detalle |
|---|---|
| Nombres de tabla | `Igp_<Dominio>`, resueltos con `process.env.DDB_X \|\| 'Igp_X'` en el mapa `tables` de `api/lib/db.js` |
| Región | `eu-west-3`, facturación **bajo demanda** (`PAY_PER_REQUEST`) |
| IDs internos | UUID v4. Visibles al usuario con `formatId6()` |
| Fechas | ISO. Fecha sola `YYYY-MM-DD`; instantes en ISO 8601 con zona |
| Sin `Scan` | Toda consulta por índice y paginada. Ver la tabla consulta → índice de cada tabla |
| Prefijos de clave | `PROY#`, `TAREA#`, `REU#`, `PLANTILLA#`, `USER#`. El SK describe el tipo de fila (`META`, `MIEMBRO#…`, `COMPRA#…`) |
| Jornada de negocio | **No aplica** a este módulo. Las tareas y reuniones van por fecha natural, no por jornada operativa (corte 09:30). Es deliberado: una reunión de dirección a las 09:00 es de ese día, no del anterior |

### Por qué GSI con partición constante

Varias tablas usan un índice cuyo HASH es un valor fijo (`gsi_listado = 'PROY'`).
Es intencionado: permite listar «todos los proyectos» ordenados **por índice y con
paginación**, sin `Scan`. El volumen lo justifica (decenas de proyectos, decenas de
reuniones al año); una sola partición absorbe de sobra ese tráfico. Si algún día
crece, se reparte añadiendo sufijo al valor fijo, sin cambiar la clave primaria.

### Por qué casi todos los índices son dispersos

Un GSI solo contiene los ítems que llevan su atributo de clave. Como el módulo
guarda las filas hijas como ítems separados (`MIEMBRO#`, `COMPRA#`, `VINC#`), cada
índice indexa un subconjunto pequeño y el coste de escritura no se multiplica por
el número de índices. El caso más útil: `Responsable-Vencimiento-index` solo
contiene **tareas abiertas**, porque el atributo de orden se **borra** al cerrarlas.
La vista personal consulta un índice minúsculo, sin filtros.

---

## `Igp_Proyectos`

Proyectos, su gente, sus líneas de compra y las plantillas. Un proyecto y sus
filas hijas comparten partición, así que la ficha completa se lee con **una sola
Query**.

- **PK**: `PROY#<id_proyecto>` · para plantillas `PLANTILLA#<id_plantilla>`
- **SK**: `META` | `MIEMBRO#<id_usuario>` | `COMPRA#<id_linea>` | `VINC#<tipo>#<id>` | `TAREA#<orden>` (solo plantillas)

### Ítem `META` del proyecto

| Campo | Tipo | Fase | Notas |
|---|---|---|---|
| `id_proyecto` | string | 1A | UUID |
| `nombre` | string | 1A | |
| `descripcion` | string | 1A | Texto libre |
| `estado` | enum | 1A | `borrador` · `activo` · `en_pausa` · `cerrado` · `cancelado` |
| `departamento_id` | string | 1A | Etiqueta organizativa, no restringe nada |
| `responsable_id` | string | 1A | Responsable del proyecto. Relevante para aprobar compras |
| `fecha_inicio` | date | 1A | |
| `fecha_fin_prevista` | date | 1A | |
| `fecha_cierre` | date | 1A | Se rellena al cerrar |
| `empresa_id` | string | 1A | Opcional |
| `prioridad` | enum | 1A | `baja` · `media` · `alta` |
| `presupuesto_asignado` | number | 1A (campo) / 4 (uso) | Euros |
| `plantilla_origen_id` | string | 4 | Plantilla de la que nació |
| `creado_por` / `creado_en` | string | 1A | |
| `actualizado_en` | string | 1A | Clave de orden del índice de listado |
| `gsi_listado` | string | 1A | Constante `PROY` (o `PLANTILLA`). Solo en `META` |

`gasto_comprometido` y `gasto_real` **no se persisten**: se calculan al leer, sumando
las líneas `COMPRA#` de la misma partición (aprobadas y pedidas para el
comprometido; recibidas con precio real para el real). Un contador denormalizado
en un ítem que se actualiza desde varios sitios se desincroniza; la suma sobre
decenas de líneas ya leídas no cuesta nada.

### Ítem `MIEMBRO#<id_usuario>`

| Campo | Tipo | Fase | Notas |
|---|---|---|---|
| `usuario_id` | string | 1A | Clave del `Miembro-index` |
| `rol_proyecto` | enum | 1A | `responsable` · `miembro` · `observador` |
| `añadido_por` / `añadido_en` | string | 1A | |

Ser miembro **no** es un permiso: es lo que la capa de acceso consulta para decidir
visibilidad de fila. Ver [04](04-permisos-y-acceso.md).

### Ítem `COMPRA#<id_linea>` — línea de compra

Esquema en Fase 1A, **implementación en Fase 4**.

| Campo | Tipo | Notas |
|---|---|---|
| `id_linea` | string | UUID |
| `concepto` | string | |
| `cantidad` | number | |
| `enlace_url` | string | Opcional, alternativo al proveedor |
| `proveedor_ref` | objeto | Vínculo polimórfico `{ tipo: 'proveedor', id, etiqueta }` |
| `precio_unitario_estimado` | number | |
| `precio_total_estimado` | number | Calculado al guardar, para poder ordenar por importe |
| `precio_real` | number | Solo cuando se conoce |
| `solicitante_id` | string | Quién la pide |
| `compra_estado` | enum | `propuesta` · `aprobada` · `rechazada` · `pedida` · `recibida`. Clave del `Compras-Estado-index` |
| `fecha_necesaria` | date | Clave de orden del mismo índice |
| `nivel_aprobacion_requerido` | enum | `responsable_proyecto` · `responsable_departamento` · `direccion`. Se calcula al crear la línea según los umbrales de configuración |
| `aprobado_por` / `aprobado_en` | string | |
| `rechazo_motivo` | string | |
| `movimiento_bancario_id` | string | **Reservado**. Enganche futuro con conciliación bancaria. No se escribe todavía |
| `notas` | string | |

Todo cambio de estado y toda aprobación se registran en `Igp_Actividad` con autor
e importe.

### Ítem `VINC#<tipo>#<id>` — entidad de IGP vinculada

Ver [Vínculo polimórfico](#vínculo-polimórfico) más abajo.

### Plantillas de proyecto (Fase 4)

- PK `PLANTILLA#<id_plantilla>`, SK `META` con `nombre`, `descripcion`,
  `departamento_id`, `gsi_listado = 'PLANTILLA'`.
- SK `TAREA#<orden>` con `titulo`, `descripcion`, `dias_desde_inicio`,
  `rol_responsable_sugerido`, `checklist` (plantilla de la lista de comprobación).

Al instanciar una plantilla se crean tareas reales con fechas calculadas desde la
fecha de inicio del proyecto. La creación va por la misma **creación en lote** que
usa la validación de propuestas de reunión (ver [03](03-contrato-api.md)).

### Índices

| Índice | HASH | RANGE | Proyección | Resuelve |
|---|---|---|---|---|
| `Listado-index` | `gsi_listado` | `actualizado_en` | ALL | Listar proyectos o plantillas, ordenados por actividad reciente, paginado |
| `Miembro-index` | `usuario_id` | `PK` | KEYS_ONLY | «Mis proyectos» y la comprobación de pertenencia de la capa de acceso |
| `Compras-Estado-index` | `compra_estado` | `fecha_necesaria` | ALL | Cola de aprobación de compras (Fase 4) |
| `Vinculo-index` | `vinculo_clave` | `PK` | KEYS_ONLY | «Qué proyectos tocan a este proveedor» (Fase 4) |

Filtrar el listado por departamento, estado o responsable se hace **en memoria**
sobre el resultado del `Listado-index`: son decenas de ítems ya leídos y ahorra
tres índices.

---

## `Igp_Tareas`

La tabla con más movimiento del módulo. Vive aparte de los proyectos porque una
tarea puede existir sin proyecto (tarea suelta nacida de una reunión) y porque su
volumen es un orden de magnitud mayor.

- **PK**: `TAREA#<id_tarea>`
- **SK**: `META` | `ENLACE#<id_enlace>` | `COMENT#<iso>#<uuid>` | `VINC#<tipo>#<id>`

### Ítem `META`

| Campo | Tipo | Fase | Notas |
|---|---|---|---|
| `id_tarea` | string | 1A | UUID |
| `titulo` | string | 1A | |
| `descripcion` | string | 1A | Texto libre |
| `estado` | enum | 1A | `pendiente` · `en_curso` · `bloqueada` · `hecha` · `cancelada` |
| `responsable_id` | string | 1A | **Uno solo.** Obligatorio salvo en borrador |
| `proyecto_id` | string | 1A | Opcional (tarea suelta). Clave del `Proyecto-index` |
| `departamento_id` | string | 1A | Se hereda del proyecto al crear; editable |
| `fecha_limite` | date | 1A | Opcional |
| `prioridad` | enum | 1A | `baja` · `media` · `alta` |
| `checklist` | lista | 1A | Lista de comprobación interna. Ver abajo |
| `tarea_padre_id` | string | 1A | Subtarea. Clave del `Padre-index` |
| `menciones` | lista de string | 1A | `id_usuario` mencionados con `@`. Alimenta los avisos |
| `bloqueo_motivo` | string | 1A | Por qué está bloqueada |
| `reunion_origen_id` | string | 1B | Reunión de la que nació. Clave del `Reunion-index` |
| `propuesta_origen_id` | string | 2 | Propuesta de IA validada que la creó |
| `cita_origen` | string | 2 | Cita literal de la transcripción que la justificó. **Se conserva** aunque se edite la tarea |
| `vencimiento_orden` | string | 1A | **Disperso.** `<fecha_limite o 9999-12-31>#<id_tarea>`. Se **borra** al pasar a estado terminal |
| `sk_proyecto` | string | 1A | `<abierta\|cerrada>#<fecha_limite o 9999-12-31>#<id_tarea>` |
| `cerrada_en` | string | 1A | |
| `creado_por` / `creado_en` / `actualizado_en` | string | 1A | |

**Lista de comprobación** (`checklist`): atributo lista dentro de `META`, con
elementos `{ id, texto, hecho, hecho_por, hecho_en, orden }`. **No tienen
responsable ni fecha propios** y son distintos de las subtareas: sirven para
ejecutar una tarea con muchos pasos sin fragmentarla. Máximo 50 elementos; por
encima de eso, son subtareas.

### Ítem `ENLACE#<id_enlace>` — enlace externo con captura

Un ítem aparte y no un atributo de `META` porque el backend rellena la captura de
forma diferida y con reintentos: así no reescribe la tarea entera ni pisa
ediciones concurrentes.

| Campo | Tipo | Notas |
|---|---|---|
| `id_enlace` | string | UUID |
| `url` | string | Tal como la pegó el usuario |
| `url_host` | string | Para mostrar el origen sin parsear en el cliente |
| `captura_estado` | enum | `pendiente` · `ok` · `fallida` |
| `titulo` | string | Capturado del destino |
| `precio` | number | Capturado si está disponible |
| `moneda` | string | |
| `imagen_s3_key` | string | **La imagen se descarga y se guarda en S3**, no se enlaza la del destino |
| `capturado_en` | string | Fecha de la foto del momento |
| `captura_error` | string | Motivo si falló |
| `añadido_por` / `añadido_en` | string | |

Los datos capturados son **una foto del momento y no se refrescan**: si el destino
desaparece o cambia de precio, debe seguir constando qué se pidió y por cuánto.
De ahí que la imagen se guarde en S3: enlazar la del destino haría que la tarjeta
quedara rota en seis meses, justo cuando la prueba importa.

Reglas de la descarga en servidor (**nunca desde el cliente**) en
[03 · Contrato de API](03-contrato-api.md).

### Ítem `COMENT#<iso>#<uuid>`

`texto`, `autor_id`, `autor_nombre`, `menciones`, `creado_en`. No es un chat: es
el hilo de seguimiento de la tarea.

### Índices

| Índice | HASH | RANGE | Proyección | Resuelve |
|---|---|---|---|---|
| `Responsable-Vencimiento-index` | `responsable_id` | `vencimiento_orden` | ALL | **Vista personal.** Solo tareas abiertas, ya ordenadas por vencimiento |
| `Proyecto-index` | `proyecto_id` | `sk_proyecto` | ALL | Tareas de un proyecto, abiertas primero y por fecha |
| `Padre-index` | `tarea_padre_id` | `creado_en` | ALL | Subtareas de una tarea |
| `Reunion-index` | `reunion_origen_id` | `creado_en` | ALL | «Qué salió de esta reunión» y el seguimiento de acuerdos incumplidos |
| `Vinculo-index` | `vinculo_clave` | `PK` | KEYS_ONLY | «Qué tareas tocan a este proveedor / local / factura» |

El histórico de tareas cerradas de una persona **no** tiene índice propio: se
consulta desde el proyecto. Es deliberado, para que la vista personal siga siendo
barata y para no indexar datos que nadie mira a diario.

---

## `Igp_Reuniones`

- **PK**: `REU#<id_reunion>`
- **SK**: `META` | `ASIST#<id_usuario>` | `PUNTO#<orden>` | `ACUERDO#<id_acuerdo>` | `PROPUESTA#<id_propuesta>` | `VINC#<tipo>#<id>`

### Ítem `META`

| Campo | Tipo | Fase | Notas |
|---|---|---|---|
| `id_reunion` | string | 1B | UUID |
| `titulo` | string | 1B | |
| `fecha` | date | 1B | Clave de orden del listado |
| `hora_inicio` / `hora_fin` | string | 1B | `HH:mm` |
| `estado` | enum | 1B | `borrador` · `convocada` · `celebrada` · `acta_borrador` · `acta_validada` · `cancelada` |
| `visibilidad` | enum | 1B | `direccion` · `empresa` · `departamento` · `local` · `restringida` |
| `usuarios_autorizados` | lista | 1B | Solo si `visibilidad = restringida` |
| `departamento_id` | string | 1B | Ámbito si `visibilidad = departamento` |
| `local_id` | string | 1B | Ámbito si `visibilidad = local` |
| `empresa_id` | string | 1B | |
| `proyecto_id` | string | 1B | Opcional. Clave del `Proyecto-index` |
| `serie_id` | string | 1B | Comité recurrente. Clave del `Serie-index` |
| `convocada_por` | string | 1B | |
| **Orden del día** | | | |
| `orden_del_dia` | string | 1B | Texto libre y extenso. Editable hasta que empieza |
| `orden_del_dia_congelado` | string | 1B (campo) / 2 (uso) | Copia al arrancar la grabación |
| `orden_del_dia_congelado_en` | string | 1B | |
| **Google** | | | |
| `calendar_id` / `calendar_event_id` | string | 1B | Evento creado al convocar |
| `sala_recurso_email` | string | 1B | Recurso de sala reservado |
| `modalidad` | enum | 1B | `presencial` · `remota` · `mixta`. Derivada de la sala y del enlace de Meet |
| `meet_code` | string | 1B | |
| `conference_record_id` | string | 2 | Localiza la grabación en Meet |
| `drive_file_id` | string | 2 | Fichero de la grabación en Drive |
| **Audio y pipeline** | | | |
| `origen_audio` | enum | 2 | `meet` · `subida` · `grabacion_app` |
| `audio_estado` | enum | 2 | `ausente` · `presente` · `borrado` |
| `audio_s3_key` | string | 2 | |
| `audio_borrado_en` | string | 2 | |
| `duracion_seg` | number | 2 | |
| `aviso_grabacion` | objeto | 1B | `{ informados: string[], aceptado_por, aceptado_en }`. **Sin aceptación no se permite subir audio** |
| `pipeline_estado` | enum | 2 | **Disperso.** `audio_pendiente` · `transcribiendo` · `transcrita` · `resumiendo` · `error`. Se **borra** al terminar |
| `pipeline_desde` | string | 2 | Orden del índice del poller |
| `pipeline_error` / `pipeline_error_fase` | string | 2 | Distingue fallo de transcripción de fallo de IA |
| `intentos` | number | 2 | Límite de reintentos |
| `transcripcion_proveedor` | string | 2 | |
| `transcripcion_job_id` | string | 2 | Idempotencia: no relanzar si ya existe |
| `transcripcion_s3_key` | string | 2 | **La transcripción va a S3**, no al ítem |
| `transcripcion_hash` | string | 2 | Idempotencia del resumen: si no cambia, no se vuelve a pagar |
| `resumen` | string | 2 | Acta redactada. Cabe de sobra en el ítem |
| `vocabulario_esperado` | lista | 2 | Términos extraídos del orden del día |
| `acta_pdf_s3_key` | string | 4 | |
| `coste_ia` | objeto | 2 | `{ transcripcion_usd, resumen_usd, tokens_entrada, tokens_salida }`. Para medir coste real |
| `gsi_listado` | string | 1B | Constante `REU` |
| `creado_en` / `actualizado_en` | string | 1B | |

**La transcripción y los segmentos con hablantes van a S3** (`transcripcion.json`),
no a DynamoDB. Motivo: una reunión larga con segmentos y marcas de tiempo se acerca
al límite de 400 KB por ítem, y ese límite no avisa hasta que un día una reunión
importante falla al guardar. En S3 no hay techo, cuesta menos y el acta —que es lo
que se consulta a diario— sí queda en el ítem.

### Ítem `PUNTO#<orden>` — cobertura del orden del día (Fase 2)

`texto_punto`, `origen` (`previsto` · `emergente`), `cobertura`
(`tratado` · `parcial` · `no_tratado`), `cita`, `aplazado` (bool),
`candidato_siguiente` (bool).

Los puntos **no tratados** pasan a aplazados y quedan marcados como candidatos al
orden del día de la reunión siguiente.

### Ítem `ACUERDO#<id_acuerdo>`

`texto`, `cita`, `responsable_id`, `fecha_limite`, `estado`
(`abierto` · `cumplido` · `incumplido`), `tarea_id` (si generó tarea),
`validado_por`, `validado_en`. En Fase 1B se escriben a mano; en Fase 2 los
propone la IA y una persona los confirma.

### Ítem `PROPUESTA#<id_propuesta>` — cola de validación (Fase 2)

**Es el punto de unión entre reuniones y tareas.**

| Campo | Tipo | Notas |
|---|---|---|
| `id_propuesta` | string | UUID |
| `tipo` | enum | `tarea` · `acuerdo` |
| `titulo` / `descripcion` | string | Lo que propone la IA |
| `cita` | string | **Obligatoria.** Sin cita no se muestra |
| `responsable_sugerido_id` | string | |
| `fecha_limite_sugerida` | date | |
| `confianza` | number | 0-1, si el modelo la aporta |
| `propuesta_estado` | enum | **Disperso.** `pendiente` (solo entonces existe el atributo) · `aceptada` · `rechazada` · `editada_y_aceptada` |
| `resuelta_por` / `resuelta_en` | string | Quién decidió |
| `tarea_id` | string | Tarea creada al aceptar |
| `creado_en` | string | |

### Ítem `ASIST#<id_usuario>`

`usuario_id`, `nombre`, `asistio` (bool), `es_externo` (bool), `email` (si externo),
`rol_en_reunion`. Los asistentes también cuentan para la visibilidad: quien
asistió a una reunión puede verla.

### Índices

| Índice | HASH | RANGE | Proyección | Resuelve |
|---|---|---|---|---|
| `Listado-index` | `gsi_listado` | `fecha` | ALL | Listado de reuniones por fecha, paginado |
| `Pipeline-index` | `pipeline_estado` | `pipeline_desde` | ALL | **El poller.** Solo reuniones en vuelo: sin este índice haría falta un `Scan` |
| `Propuesta-Estado-index` | `propuesta_estado` | `creado_en` | ALL | Cola global de propuestas pendientes de validar |
| `Proyecto-index` | `proyecto_id` | `fecha` | ALL | Reuniones de un proyecto |
| `Serie-index` | `serie_id` | `fecha` | ALL | Reunión anterior de la serie, para el orden del día automático (Fase 4) |

---

## `Igp_Actividad`

Registro de actividad append-only, **transversal a las cuatro entidades** del
módulo (proyecto, tarea, línea de compra, reunión). Sigue el patrón probado de
`Igp_FacturasAuditoria`, pero genérico desde el principio para no acabar con
cuatro tablas de auditoría.

- **PK**: `<TIPO>#<id_entidad>` — `PROY#…`, `TAREA#…`, `COMPRA#…`, `REU#…`
- **SK**: `ACT#<iso>#<uuid>`
- Sin índices: siempre se consulta por entidad.

| Campo | Notas |
|---|---|
| `accion` | `creada`, `estado_cambiado`, `reasignada`, `compra_aprobada`, `audio_borrado`, `acta_validada`… |
| `usuario_id` / `usuario_nombre` | Autor. Nunca vacío salvo acción del sistema, que se marca como `sistema` |
| `detalle` | JSON en string, con el antes y el después |
| `importe` | Solo en acciones de compra. Obligatorio en aprobaciones |
| `creado_en` | |

---

## `Igp_Notificaciones` (Fase 3)

- **PK**: `USER#<id_usuario>`
- **SK**: `NOTIF#<iso>#<uuid>`
- **GSI `NoLeidas-index`**: HASH `usuario_no_leida` (disperso: contiene el
  `id_usuario` **solo mientras no está leída**), RANGE `creado_en`, KEYS_ONLY.
  Resuelve el contador de la campana con una Query mínima.

`tipo` (`mencion` · `asignacion` · `vencimiento` · `compra_pendiente` ·
`acta_lista`), `titulo`, `cuerpo`, `entidad_ref` (vínculo polimórfico para
navegar), `leida`, `leida_en`, `ttl` (epoch, purga automática a los 90 días).

Genérica a propósito: no acoplada a proyectos, para que la use cualquier módulo
más adelante.

---

## Configuración en `Igp_Ajustes`

Se reutiliza la tabla existente en lugar de crear maestros nuevos: son listas
cerradas y pequeñas, y así hay una tabla menos que crear y mantener.

| PK | SK | Contenido | Fase |
|---|---|---|---|
| `departamentos` | `DEP#<id>` | `{ nombre, responsable_id, activo, orden }` | 1A |
| `proyectos` | `compras` | `{ umbral_responsable, umbral_departamento, moneda }` | 1A (campo) / 4 (uso) |
| `proyectos` | `enlaces` | `{ timeout_ms, max_bytes, esquemas_permitidos }` | 1A |
| `reuniones` | `retencion_audio` | `{ Enabled, RetencionDias }` | 2 |
| `reuniones` | `pipeline` | `{ Enabled, proveedor_transcripcion, modelo_resumen, max_intentos }` | 2 |
| `reuniones` | `cerrojo_pipeline` | Ítem de cerrojo de `crearCerrojo()` | 2 |
| `proyectos` | `avisos` | `{ Enabled, Days, Times }` del job de vencimientos | 3 |

**Los umbrales de aprobación viven en configuración, nunca en el código.** Por
debajo del primer umbral aprueba el responsable del proyecto; por encima, el
responsable de departamento; a partir del segundo, dirección.

---

## Cambios en `igp_usuarios`

**Tabla crítica: sostiene el login.** Los dos cambios son **aditivos**, no tocan
`Email`, `Password`, `Rol` ni `Locales`, y **se proponen y se aprueban antes de
aplicarse**.

| Campo | Tipo | Fase | Notas |
|---|---|---|---|
| `Departamentos` | lista de string | 1A | **IDs** de departamento, no nombres. Deliberadamente distinto de `Locales`, que guarda nombres y obliga a comparar sin distinguir mayúsculas |
| `google_directory_id` | string | 3 | Reconciliación con Directory |

Sobre la identidad: **`igp_usuarios` es la única fuente de autorización.** Ya
existe un segundo censo de personas (`Igp_Empleados`, sincronizado desde Factorial
HR) y en Fase 3 aparecería un tercero (Google Directory). Directory solo
**enriquece** campos concretos y **nunca crea usuarios ni asigna permisos** de
forma automática.

---

## Vínculo polimórfico

Cómo una tarea, un proyecto, una reunión o una línea de compra apuntan a una
entidad de negocio de IGP. Sigue el precedente de `contraparteRef: { tipo, id }`
de cashflow.

**Forma**: `{ tipo, id, etiqueta }`. La `etiqueta` es el nombre en el momento de
vincular, para poder pintar la tarjeta sin resolver la entidad en cada lectura.

**Tipos admitidos**: `local` · `proveedor` · `articulo` · `actuacion` ·
`cuenta_bancaria` · `factura` · `incidencia` · `empresa` · `proyecto` · `tarea` ·
`reunion`.

**Cómo se guarda**: como ítem aparte en la partición de la entidad, con
`SK = VINC#<tipo>#<id>` y el atributo `vinculo_clave = '<tipo>#<id>'`, que es la
clave del `Vinculo-index`. Así se puede preguntar «qué tareas tocan a este
proveedor» sin `Scan`, y el índice solo contiene ítems de vínculo.

La navegación desde el vínculo hacia la pantalla correspondiente se resuelve con
un único mapa en frontend (`app/lib/tasksVinculoRutas.ts`), no con condicionales
repartidos por las pantallas.

---

## Objetos en S3

Sobre el bucket existente (`S3_BUCKET`), bajo el prefijo `tasks/`.

| Clave | Contenido | Retención |
|---|---|---|
| `tasks/reuniones/<id_reunion>/audio.<ext>` | Audio original | Configurable. Ver [05](05-pipeline-reuniones.md) |
| `tasks/reuniones/<id_reunion>/transcripcion.json` | Transcripción y segmentos con hablantes | Permanente |
| `tasks/reuniones/<id_reunion>/acta.pdf` | Acta generada (Fase 4) | Permanente |
| `tasks/tareas/<id_tarea>/enlaces/<id_enlace>.<ext>` | Imagen capturada del enlace | Permanente |
| `tasks/tareas/<id_tarea>/adjuntos/<uuid>-<nombre>` | Adjuntos de la tarea | Permanente |

Requisitos que **hoy no cumple ningún router del repositorio** y aquí sí son
obligatorios:

- `ServerSideEncryption: 'AES256'` explícito, por la sensibilidad del audio.
- **CORS del bucket con `PUT` permitido** desde los orígenes de la app, sin lo cual
  la subida directa desde web no funciona.
- Acceso público bloqueado.

---

## Tipos compartidos

El frontend es TypeScript y el backend JavaScript sin compilación, así que no
existe un tipo compartido literal. El acuerdo:

| Fichero | Papel |
|---|---|
| `app/types/tasks.ts` | **Fuente normativa.** Interfaces y uniones de estados |
| `api/lib/tasks/tipos.js` | Espejo con `@typedef` de JSDoc y las constantes de estado que el backend valida |
| Este documento | Árbitro si los dos divergen |

Los dos ficheros los toca **únicamente el agente integrador**. El resto los
consume.

Las constantes de estado se declaran una sola vez por lado y se importan; no se
escriben literales `'pendiente'` sueltos repartidos por los handlers.

---

## Entradas nuevas en el mapa `tables`

Para `api/lib/db.js`, siguiendo el patrón existente con su comentario de claves:

```
proyectos      → DDB_PROYECTOS      || 'Igp_Proyectos'
tareas         → DDB_TAREAS         || 'Igp_Tareas'
reuniones      → DDB_REUNIONES      || 'Igp_Reuniones'
actividad      → DDB_ACTIVIDAD      || 'Igp_Actividad'
notificaciones → DDB_NOTIFICACIONES || 'Igp_Notificaciones'
```

Variables de entorno adicionales, todas con valor por defecto y por tanto en
`RECOMMENDED` como mucho, nunca en `REQUIRED` de `api/lib/validateEnv.js`:
`TASKS_S3_PREFIX`, `TASKS_ENLACE_TIMEOUT_MS`, `TASKS_ENLACE_MAX_BYTES`,
`REUNIONES_MAX_AUDIO_MB`, `REUNIONES_RETENCION_AUDIO_DIAS`,
`TRANSCRIPCION_PROVEEDOR`, `TRANSCRIPCION_IDIOMA`.

## Orden de creación de tablas

Las crea a mano el responsable del proyecto, **una a una**, y el agente espera
confirmación antes de escribir código que las use.

| Orden | Tabla | Fase que la necesita |
|---|---|---|
| 1 | `Igp_Proyectos` | 1A |
| 2 | `Igp_Tareas` | 1A |
| 3 | `Igp_Actividad` | 1A |
| 4 | `Igp_Reuniones` | 1B |
| 5 | `Igp_Notificaciones` | 3 |
