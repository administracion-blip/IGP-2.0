# Prompt para Cursor: Agenda (Google Calendar) + Notificaciones + Proyectos — implementación completa

> Este prompt SUSTITUYE a `cursor-agenda-prompt.md` y `cursor-proyectos-prompt.md`. Es autocontenido.
> Implementar por fases EN ORDEN: cada fase compila, pasa sus criterios y se entrega antes de empezar la siguiente.

## Nombres en producto

- **«Agenda»** — ruta `app/(app)/agenda/index.tsx`
- **«Proyectos»** — rutas `app/(app)/proyectos/` (`index.tsx`, `[proyectoId].tsx`)
- Campana de **notificaciones** en la cabecera global (sin entrada de menú propia)

## Contexto del proyecto

- React Native / Expo (expo-router) + backend Node/Express en `/api` + DynamoDB.
- Usuarios en `igp_usuarios` (campos `Nombre`, `Email`, `Rol`; GSI `Email-index`, helper `findUsuarioByEmail` en `api/lib/dynamo/usuarios.js`).
- Adjuntos: patrón multer + S3 + URL firmada de `api/routes/facturacion.js` (adjuntos de facturas).
- Secretos: AWS Secrets Manager / env, patrón existente en el proyecto.
- Tablas: registrar en `api/lib/db.js` + script `api/scripts/create-*-table.js` por tabla (patrón de `create-agora-products-table.js`).

## Integración con el sistema de permisos (OBLIGATORIO seguir el mecanismo real)

El sistema es: tabla `Igp_RolesPermisos` (PK `ROL#<nombreRol>`, SK `PERMISO#<codigo>`), asignación desde la pantalla **Permisos** de la app. No hay seeds de permisos por módulo: el Administrador marca los códigos en la matriz.

**Códigos nuevos:**

| Código | Qué habilita |
|---|---|
| `agenda.ver` | Menú Agenda + todos los endpoints `/api/agenda/*` |
| `proyectos.ver` | Menú Proyectos + ver los proyectos donde participa |
| `proyectos.gestionar` | Crear/editar/cerrar proyectos |
| `proyectos.ver_todos` | Ver cualquier proyecto aunque no participe (administración) |

Las notificaciones propias NO llevan permiso: cualquier usuario autenticado lee y marca las suyas.

**Dónde registrarlos (exacto):**

1. `app/constants/modulos.ts` → añadir a `MODULOS` las dos entradas de menú:
   `{ route: '/agenda', label: 'Agenda', icon: <icono calendario del set en uso>, permiso: 'agenda.ver' }` y
   `{ route: '/proyectos', label: 'Proyectos', icon: <icono>, permiso: 'proyectos.ver' }` (con esto entran solos en `PERMISOS_MENU_LATERAL`).
2. `app/constants/modulos.ts` → nuevo grupo en `GRUPOS_PERMISOS`: `{ titulo: 'Agenda y Proyectos', codigos: ['agenda.ver', 'proyectos.ver', 'proyectos.gestionar', 'proyectos.ver_todos'] }` para que aparezcan en la matriz de la pantalla Permisos.
3. Backend → `requirePermission('<codigo>')` de `api/middleware/auth.js` como middleware en cada ruta; para lógica condicional dentro de un handler usar `hasPermission`/`hasAnyPermission`.
4. Documentar los códigos nuevos en la tabla de `api/ROLES-PERMISOS.md`.

---

# FASE A — Agenda conectada a Google Calendar (solo lectura)

## A.0 Configuración manual previa (documentar en `api/AGENDA-GOOGLE.md`)

1. Google Cloud Console: habilitar **Google Calendar API**, crear service account, generar clave JSON.
2. Habilitar domain-wide delegation en la service account y copiar su Client ID.
3. Google Admin (Seguridad → Controles de API → Delegación de dominio): autorizar ese Client ID con scope `https://www.googleapis.com/auth/calendar.readonly`.
4. JSON a Secrets Manager; env: `AGENDA_GOOGLE_SA_SECRET`, `AGENDA_DOMINIOS_PERMITIDOS` (dominios separados por comas).

## A.1 Cliente Google (solo backend)

- Dependencia `googleapis` en `api/package.json`.
- `api/lib/google/calendarClient.js` con una única función pública `listarEventos(email, inicioIso, finIso)` → eventos normalizados: `{ id, titulo, inicio, fin, allDay, ubicacion, numAsistentes, htmlLink, estado }`.
- Impersona el `Email` del usuario del token. **Regla dura:** si el dominio del email no está en `AGENDA_DOMINIOS_PERMITIDOS`, no se llama a Google.
- La app móvil jamás habla con Google directamente.

## A.2 Tabla `Igp_AgendaRefs`

```
PK "USER#<id_usuario>" · SK "EVENT#<googleEventId>#REF#<refId(uuid)>"
GoogleEventId · Tipo: "seccion_app" | "entidad" | "documento" | "url"
— seccion_app: { route, label, icon }   (catálogo = MODULOS de modulos.ts filtrado por permisos del usuario)
— entidad:     { modulo, entidadId, etiqueta } · modulo: "factura"|"pedido"|"campana"|"mantenimiento"|"remesa"|"actuacion"|"activacion"|"proyecto"
— documento:   { s3Key, nombre }
— url:         { url, etiqueta }
CreadoPor / CreadoEn
```

Ruta de detalle por módulo en un mapa central nuevo `app/lib/agendaRefRutas.ts` (lo reutiliza la Fase B). Las refs son privadas del usuario.

## A.3 Endpoints `api/routes/agenda.js` (todos con `requirePermission('agenda.ver')`)

- `GET /api/agenda?fecha=YYYY-MM-DD&vista=dia|semana` — eventos del usuario del token + refs mergeadas. Cache en memoria usuario+rango 60 s. Si el calendario no es accesible (dominio, delegación, 404): `{ eventos: [], calendarioDisponible: false, motivo }` con HTTP 200.
- `POST /api/agenda/eventos/:googleEventId/referencias` — valida shape por Tipo.
- `DELETE /api/agenda/eventos/:googleEventId/referencias/:refId` — solo el creador.
- `POST /api/agenda/referencias/documento` — subida S3 (patrón adjuntos facturación), devuelve `s3Key`.

## A.4 Pantalla Agenda

- Tira semanal (7 días, hoy marcado) + lista del día: all-day arriba, resto por hora. Card: franja horaria, título, ubicación, chips de referencias.
- Tap chip → `seccion_app`/`entidad` navegan con `router.push` (mapa `agendaRefRutas.ts`); `documento` abre URL firmada; `url` abre navegador.
- «+» por evento → modal Añadir referencia, 4 pestañas: Sección (MODULOS filtrado por `hasPermiso`), Entidad (selector de módulo + buscador reutilizando endpoints de listado existentes), Documento (picker + subida), URL.
- Pull-to-refresh; estado «Calendario no disponible» con motivo; link «Abrir en Google Calendar» (`htmlLink`).
- Entrada de menú vía `MODULOS` (ya registrada en la sección de permisos).

## Criterios de aceptación Fase A

- Usuario del dominio ve sus eventos de hoy y de cualquier día de la semana.
- Anclar una factura y tocar el chip abre su detalle.
- Sin `agenda.ver`: sin menú y endpoints 403. Email fuera de dominio: estado «no disponible», nunca error.
- Caída de Google no afecta al resto de la app.

---

# FASE B — Notificaciones + Proyectos con hilo y @menciones

**DECISIÓN INTENCIONAL: no hay chat general ni mensajes directos.** Cada proyecto tiene su hilo; toda conversación cuelga de un proyecto.

## B.1 Tabla `Igp_Notificaciones` (genérica, no acoplada a proyectos)

```
PK "USER#<id_usuario>" · SK "TS#<ISO>#<notifId>"
tipo: "mencion" | "asignacion_tarea" | "cambio_estado_proyecto" (extensible)
titulo · cuerpo · ruta (deep link) · leida:boolean · origen { modulo, proyectoId?, msgId? }
```

Endpoints en `api/routes/notificaciones.js` (solo autenticación, sin permiso):
`GET /api/notificaciones?soloNoLeidas=1` (paginado) · `GET /api/notificaciones/contador` · `POST /api/notificaciones/marcar-leidas` (ids o todas).
Helper backend `api/lib/notificaciones.js` → `crearNotificacion({ usuarioId, tipo, titulo, cuerpo, ruta, origen })` para uso de cualquier módulo.

## B.2 Tablas de proyectos

**`Igp_Proyectos`**: `proyectoId (PK, UUID)`, `nombre`, `descripcion?`, `estado: "Abierto"|"En curso"|"En pausa"|"Cerrado"|"Archivado"`, `responsableId`, `participantes: string[]` (incluye siempre al responsable), `localId?`, `fechaObjetivo?`, `etiquetas: string[]`, `tareas: [{ tareaId, titulo, hecho, asignadoId?, vencimiento? }]` (embebidas), `creadoPor/creadoEn/actualizadoEn`.

**`Igp_ProyectoMensajes`**: PK `"PROY#<proyectoId>"`, SK `"TS#<ISO>#<msgId>"`, `autorId/autorNombre`, `texto` (menciones en formato `@[Nombre](id_usuario)`), `menciones: string[]` (ids extraídos al guardar), `refs?` (mismo shape que Agenda), `adjuntos?: [{ s3Key, nombre }]`, `editadoEn?`. Borrar = marcador «mensaje eliminado», nunca delete físico.

## B.3 Endpoints `api/routes/proyectos.js`

Visibilidad base: participante del proyecto, o `hasPermission(user, 'proyectos.ver_todos')`.

- `GET /api/proyectos` (`requirePermission('proyectos.ver')`) — filtros `?estado=&participo=1`, orden actualizadoEn desc. Sin `ver_todos` solo devuelve donde participa.
- `GET /api/proyectos/:id` — ficha + tareas (sin mensajes).
- `POST /api/proyectos` / `PATCH /api/proyectos/:id` (`requirePermission('proyectos.gestionar')`) — cambio de estado notifica a participantes (helper B.1).
- `PATCH /api/proyectos/:id/tareas/:tareaId` — cualquier participante marca hecho/reasigna; asignación notifica al asignado.
- `GET /api/proyectos/:id/mensajes?antes=<SK>` — paginado hacia atrás, 50/página.
- `POST /api/proyectos/:id/mensajes` — texto + refs + adjuntos. Al guardar: parsear `@[Nombre](id)`, validar ids contra `igp_usuarios`; **mencionar a un no-participante lo añade como participante y lo notifica** (nunca queda un mencionado sin acceso al hilo).
- `PATCH`/`DELETE` de mensaje: solo autor; editar máx. 15 min después; borrar deja marcador.
- `GET /api/usuarios/buscar?q=` (solo autenticación) — máx. 10 `{ id_usuario, Nombre }`, sin emails ni datos sensibles. Para el autocompletado.

## B.4 Frontend Proyectos + campana

- **Lista**: tarjetas con estado (chips), responsable, tareas pendientes, fechaObjetivo (rojo si vencida), último mensaje relativo. Filtros estado / «solo los míos». Crear/editar solo con `proyectos.gestionar`.
- **Detalle**: cabecera colapsable (descripción, participantes con iniciales, checklist de tareas interactivo) + **hilo tipo mensajería**: burbujas, menciones resaltadas, refs/adjuntos como chips (mismo componente de chips que Agenda), input fijo abajo.
- **Menciones**: al teclear `@`, dropdown con `usuarios/buscar`; elegir inserta `@[Nombre](id)`. Regex de parseo/render compartida en `app/lib/menciones.ts` (input y burbujas).
- **Actualización**: polling 30 s con pantalla en foco + pull-to-refresh. Sin websockets en v1.
- **Campana global** en la cabecera de la app (visible para todo usuario autenticado): badge con `contador`, panel con lista, tocar → navega a `ruta` y marca leída.

## Criterios de aceptación Fase B

- Mensaje mencionando a un tercero no participante → pasa a participante, le llega notificación, y al tocarla aterriza en el hilo.
- No participante sin `ver_todos`: 403 en proyecto y mensajes. Sin `proyectos.gestionar`: puede comentar y marcar tareas, no crear/editar proyectos.
- Adjunto + ref a factura en un mensaje: ambos chips funcionan.
- Editar mensaje a los 16 minutos falla; borrar deja «mensaje eliminado».
- El badge refleja el contador y se limpia al marcar leídas.
- Los 4 códigos nuevos aparecen en la pantalla Permisos (grupo «Agenda y Proyectos») y funcionan al asignarlos a un rol.

---

# FASE C — Integración Agenda ↔ Proyectos

- Tipo de entidad `"proyecto"` ya contemplado en las refs (A.2): desde Agenda, anclar un proyecto a un evento (pestaña Entidad → módulo Proyectos → buscador de proyectos visibles); el chip navega al detalle del proyecto.
- En el detalle de proyecto, sección «Eventos vinculados»: query inversa sobre `Igp_AgendaRefs` del usuario (sus refs de tipo entidad/proyecto con ese proyectoId) mostrando fecha y título del evento; tocar abre la Agenda en ese día.

## Criterios de aceptación Fase C

- Anclar proyecto a evento desde la Agenda y navegar en ambos sentidos (evento→proyecto, proyecto→día de agenda).

---

## Reglas no opcionales (todas las fases)

1. Solo lectura contra Google; scope readonly; jamás impersonar fuera de los dominios permitidos.
2. Errores de Google degradan a «calendario no disponible»; nunca tumban pantalla ni planning.
3. Sin chat general ni DMs. Hilo = proyecto.
4. Mensajes sin borrado físico (auditoría).
5. Notificaciones genéricas desde el día 1 (tabla y helper reutilizables por otros módulos).
6. Permisos: SIEMPRE `requirePermission`/`hasPermission` en backend — el ocultado de menú en el cliente no es seguridad.
7. Las refs referencian entidades por id; la etiqueta es cosmética, nunca fuente de verdad.

## Mejoras futuras (NO implementar)

Push reales (Expo Notifications) para menciones y asignaciones · eventos operativos del negocio mezclados en la agenda (actuaciones, mantenimientos, vencimientos) · escritura v2 en Google Calendar (scope events, Meet, invitados) · vista de equipo de agenda para administradores (`agenda.equipo`) · resumen semanal por proyecto · plantillas de proyecto (apertura de local, feria) con tareas predefinidas.
