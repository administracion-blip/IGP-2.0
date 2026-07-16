# Prompt para Cursor: Módulo Proyectos (seguimiento + hilo de conversación + @menciones)

## Nombre en producto

- **Nombre visible:** «Proyectos»
- **Rutas frontend:** `app/(app)/proyectos/` (`index.tsx`, `[proyectoId].tsx`)
- **Permisos:** `proyectos.ver` (ver los proyectos donde participa), `proyectos.gestionar` (crear/editar/cerrar), `proyectos.ver_todos` (administración: ver todos aunque no participe)

## Objetivo y decisión de diseño

Crear proyectos con seguimiento (estado, responsable, participantes, tareas, fecha objetivo) donde **cada proyecto tiene su propio hilo de conversación**: mensajes con **@menciones** a usuarios de la app, adjuntos y referencias a entidades (factura, pedido, campaña, evento de agenda…).

**DECISIÓN INTENCIONAL: no hay chat general.** El hilo vive dentro de cada proyecto. Un chat libre duplicaría WhatsApp; un hilo por proyecto mantiene la conversación pegada a su contexto, que es el requisito real («no perder el hilo»). No implementar mensajería directa usuario-a-usuario.

## Contexto del proyecto (reutilizar)

- Patrones estándar del repo: rutas Express con auth/permisos, tablas en `api/lib/db.js`, scripts `create-*-table.js`, DynamoDB PK/SK.
- Usuarios: `igp_usuarios` (GSI `Email-index`; campos Nombre, Email). Para el autocompletado de menciones crear un endpoint ligero de búsqueda (ver Tarea 2).
- Adjuntos: patrón multer + S3 + URL firmada de `api/routes/facturacion.js` (adjuntos de facturas).
- Referencias a entidades y secciones: **reutilizar el mismo shape y el mapa `app/lib/agendaRefRutas.ts` del módulo Agenda** (`cursor-agenda-prompt.md`). Si Agenda aún no está implementada, crear ese util aquí y Agenda lo reutilizará. Añadir `"proyecto"` como tipo de entidad referenciable (así un evento de agenda puede anclar un proyecto y viceversa).
- Notificaciones: NO existe sistema previo — se crea aquí (Tarea 4) de forma genérica para que sirva a futuros módulos.

## Modelo de datos

### `Igp_Proyectos`

```
proyectoId      (PK, UUID)
nombre          string
descripcion     string?
estado          string   — "Abierto" | "En curso" | "En pausa" | "Cerrado" | "Archivado"
responsableId   string   — id_usuario
participantes   string[] — id_usuario (incluye siempre al responsable)
localId         string?  — opcional, si el proyecto es de un local concreto
fechaObjetivo   string?  — YYYY-MM-DD
etiquetas       string[]
tareas          array    — [{ tareaId, titulo, hecho: boolean, asignadoId?, vencimiento? }]
                           (lista embebida; si algún día superan ~50 por proyecto, migrar a tabla propia)
creadoPor / creadoEn / actualizadoEn
```

### `Igp_ProyectoMensajes` — hilo del proyecto

```
PK           string — "PROY#<proyectoId>"
SK           string — "TS#<ISO datetime>#<msgId>"
autorId / autorNombre
texto        string — con menciones en formato interno "@[Nombre](id_usuario)"
menciones    string[] — id_usuario extraídos al guardar (denormalizado para notificar)
refs         array?  — mismo shape que las referencias de Agenda (entidad/documento/url/seccion_app)
adjuntos     array?  — [{ s3Key, nombre }]
editadoEn    string? — editable solo por el autor, 15 min; borrar = marca "eliminado", no delete físico
```

### `Igp_Notificaciones` — genérica, no solo de proyectos

```
PK        string — "USER#<id_usuario>"
SK        string — "TS#<ISO datetime>#<notifId>"
tipo      string — "mencion" | "asignacion_tarea" | "cambio_estado_proyecto" (extensible)
titulo / cuerpo (breve)
ruta      string — deep link a la pantalla origen (ej. /proyectos/<id>)
leida     boolean
origen    { modulo: "proyectos", proyectoId, msgId? }
```

## Tarea 1 — Tablas y registro

Las tres tablas en `api/lib/db.js` + scripts de creación (patrón existente).

## Tarea 2 — Backend `api/routes/proyectos.js` y `api/routes/notificaciones.js`

**Proyectos** (visibilidad: participante, o `proyectos.ver_todos`):
- `GET /api/proyectos` — filtros `?estado=&participo=1`; ordenar por actualizadoEn desc.
- `GET /api/proyectos/:id` — ficha + tareas (sin mensajes).
- `POST /api/proyectos` / `PATCH /api/proyectos/:id` — requiere `proyectos.gestionar`; el responsable siempre queda en participantes. Cambio de estado genera notificación a participantes.
- `PATCH /api/proyectos/:id/tareas/:tareaId` — marcar hecho / reasignar; asignación genera notificación al asignado. Cualquier participante puede marcar tareas.

**Hilo**:
- `GET /api/proyectos/:id/mensajes?antes=<SK>` — paginado hacia atrás (50 por página), solo participantes o `ver_todos`.
- `POST /api/proyectos/:id/mensajes` — texto + refs + adjuntos. Al guardar: parsear menciones `@[Nombre](id)`, validar que los ids existen y son participantes (si mencionas a alguien que no participa, el backend lo **añade automáticamente como participante** y lo notifica — así el hilo nunca menciona a alguien que no puede leerlo).
- `PATCH /DELETE` de mensaje: solo autor, ventana de 15 minutos para editar; borrar deja marcador «mensaje eliminado».

**Usuarios para autocompletar**:
- `GET /api/usuarios/buscar?q=` — devuelve máx. 10 `{ id_usuario, Nombre }` (sin emails ni datos sensibles). Cualquier usuario autenticado.

**Notificaciones**:
- `GET /api/notificaciones?soloNoLeidas=1` (paginado), `POST /api/notificaciones/marcar-leidas` (ids o todas). Contador para el badge en `GET /api/notificaciones/contador`.

## Tarea 3 — Frontend

- **Lista** (`proyectos/index.tsx`): tarjetas con chips de estado, responsable, nº tareas pendientes, fecha objetivo (en rojo si vencida), último mensaje (hora relativa). Filtros: estado, «solo los míos».
- **Detalle** (`[proyectoId].tsx`) con dos zonas:
  - Cabecera colapsable: descripción, participantes (avatares/iniciales), tareas como checklist interactivo.
  - **Hilo estilo mensajería**: burbujas, autor e iniciales, menciones resaltadas como chips tocables (tocar → perfil no; simplemente resalta), refs y adjuntos como chips (mismo componente de chips de referencia que Agenda), input inferior fijo.
  - **Autocompletado de menciones**: al teclear `@` en el input, dropdown con `usuarios/buscar`; al elegir, insertar `@[Nombre](id)` y renderizar como chip. Regex de render compartida en un util (`app/lib/menciones.ts`) usada por input y burbujas.
- **Actualización del hilo**: polling cada 30 s mientras la pantalla está en foco + pull-to-refresh. **Nada de websockets en v1** — si algún día se necesita tiempo real, se decide entonces con la app ya desplegada en AWS.
- **Campana de notificaciones** en la cabecera global de la app (badge con contador). Panel simple: lista de notificaciones, tocar → navega a `ruta` y marca leída.

## Reglas no opcionales

1. Sin chat general ni mensajes directos: toda conversación cuelga de un proyecto.
2. Mencionar a un no-participante lo añade al proyecto (y se le notifica), nunca queda un mencionado sin acceso al hilo.
3. Los mensajes no se borran físicamente (auditoría del hilo).
4. La visibilidad es por participación; `proyectos.ver_todos` es para administración, no el default.
5. Notificaciones genéricas desde el día 1 (tabla y endpoints no acoplados a proyectos).

## Criterios de aceptación

- Crear proyecto con 2 participantes, escribir mensaje mencionando a un tercero → el tercero pasa a participante, recibe notificación, y al tocarla aterriza en el hilo.
- Un usuario no participante sin `ver_todos` recibe 403 al pedir el proyecto o sus mensajes.
- Marcar una tarea como hecha se refleja al otro participante tras el siguiente polling/refresh.
- Adjuntar un documento y una referencia a una factura en un mensaje: ambos chips funcionan.
- El badge de la campana refleja el contador y se limpia al marcar leídas.
- Editar un mensaje pasados 15 minutos devuelve error; borrar deja «mensaje eliminado».

## Mejoras futuras (backlog, NO implementar)

1. Push reales (Expo Notifications) para menciones y asignaciones.
2. Anclar proyectos a eventos de la Agenda (tipo `proyecto` en refs — el shape ya lo permite).
3. Resumen semanal automático por proyecto (mensajes + tareas cerradas).
4. Plantillas de proyecto (apertura de local, feria, obra) con tareas predefinidas.
