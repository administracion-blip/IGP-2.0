# Prompt para Cursor: Agenda diaria conectada a Google Calendar

## Nombre en producto

- **Nombre visible:** «Agenda»
- **Ruta frontend:** `app/(app)/agenda/index.tsx` (vista día con selector de fecha y tira semanal)
- **Permiso:** `agenda.ver` (registrado en roles/permisos existente)

## Objetivo

Cada usuario ve su agenda de Google Calendar (la del email asociado en `igp_usuarios`) dentro de la app, en vista diaria, y puede **anclar referencias** a cada evento: secciones de la app (deep links), entidades concretas (factura, pedido, campaña, mantenimiento, remesa…), documentos y URLs. **v1 de solo lectura contra Google**: los eventos se crean/editan en Google Calendar; las referencias viven en IGP.

## Arquitectura de autenticación (decisión cerrada — no cambiar)

**Service account de Google con delegación de dominio (domain-wide delegation), solo backend.**

- La app móvil NUNCA habla con Google; solo con el API de IGP.
- El backend usa la service account impersonando el `Email` del usuario del token (resuelto vía `findUsuarioByEmail` / GSI `Email-index` de `igp_usuarios`).
- Scope único: `https://www.googleapis.com/auth/calendar.readonly`. No pedir más en v1.
- Credenciales de la service account (JSON) en AWS Secrets Manager o variable de entorno, patrón ya usado en el proyecto para secretos. Nunca en el repo.
- Restricción de seguridad: solo impersonar emails cuyo dominio esté en `AGENDA_DOMINIOS_PERMITIDOS` (env, lista separada por comas). Un email fuera del dominio → respuesta «calendario no disponible», jamás error 500.
- Dependencia backend: `googleapis` (cliente oficial Node). Módulo nuevo `api/lib/google/calendarClient.js` con una única función pública `listarEventos(email, fechaInicioIso, fechaFinIso)` que devuelve eventos normalizados (id, título, inicio, fin, allDay, ubicación, asistentes count, link a Google Calendar, estado).

### Configuración manual previa (documentar en `api/AGENDA-GOOGLE.md`, no automatizable)

1. En Google Cloud Console: crear proyecto (o usar el existente), habilitar **Google Calendar API**, crear service account y generar clave JSON.
2. En la service account: habilitar domain-wide delegation y copiar el Client ID.
3. En Google Admin (admin.google.com → Seguridad → Controles de API → Delegación de dominio): autorizar ese Client ID con el scope `calendar.readonly`.
4. Guardar el JSON en Secrets Manager y configurar `AGENDA_GOOGLE_SA_SECRET` + `AGENDA_DOMINIOS_PERMITIDOS`.

## Modelo de datos

### Tabla `Igp_AgendaRefs` — referencias ancladas a eventos

```
PK          string — "USER#<id_usuario>"
SK          string — "EVENT#<googleEventId>#REF#<refId(uuid)>"
GoogleEventId string
Tipo        string — "seccion_app" | "entidad" | "documento" | "url"
— seccion_app: { route, label, icon }        (mismo shape que favoritos/HubTile;
                                              catálogo desde app/constants/modulos.ts)
— entidad:     { modulo, entidadId, etiqueta } — modulo: "factura" | "pedido" |
               "campana" | "mantenimiento" | "remesa" | "actuacion" | "activacion".
               La ruta de detalle se resuelve en el cliente con un mapa central
               modulo→route (nuevo util app/lib/agendaRefRutas.ts).
— documento:   { s3Key, nombre }              (subida con el patrón de adjuntos de
                                              facturación; URL firmada al leer)
— url:         { url, etiqueta }
CreadoPor / CreadoEn
```

Las refs son del usuario (PK por usuario): anclar una referencia no la ve otro asistente del mismo evento. Compartirlas es mejora futura, no v1.

## Tarea 1 — Backend `api/routes/agenda.js`

Patrón de auth/errores/permisos del resto de rutas. Todo requiere `agenda.ver`.

- **`GET /api/agenda?fecha=YYYY-MM-DD&vista=dia|semana`** — eventos del usuario del token para ese día (o semana), normalizados, con sus refs mergeadas (query a `Igp_AgendaRefs` por los eventIds). Cache en memoria por usuario+rango 60 s (la pantalla se abre y refresca mucho; no castigar el API de Google).
  - Usuario sin calendario accesible (fuera de dominio, delegación no autorizada, 404 de Google): `{ eventos: [], calendarioDisponible: false, motivo }` con 200 — la UI muestra estado vacío explicado, nunca rompe.
- **`POST /api/agenda/eventos/:googleEventId/referencias`** — crea ref (valida shape por Tipo).
- **`DELETE /api/agenda/eventos/:googleEventId/referencias/:refId`** — solo el creador.
- **`POST /api/agenda/referencias/documento`** — subida de documento (multer + S3, patrón de adjuntos de facturación) que devuelve `s3Key` para crear la ref.
- Registrar `DDB_AGENDA_REFS_TABLE` en `api/lib/db.js` + `api/scripts/create-agenda-refs-table.js`.

## Tarea 2 — Pantalla Agenda

`app/(app)/agenda/index.tsx`, entrada en el menú con permiso `agenda.ver`:

- **Tira semanal** arriba (7 días, hoy marcado, tap cambia el día) + **lista del día**: eventos ordenados por hora, all-day arriba. Card de evento: franja horaria, título, ubicación, y **chips de referencias** debajo.
- Tap en chip → navega: `seccion_app`/`entidad` con `router.push` (mapa `agendaRefRutas.ts`); `documento` abre URL firmada; `url` abre navegador.
- Botón «+» en cada evento → modal «Añadir referencia» con 4 pestañas: Sección (lista desde `modulos.ts` filtrada por permisos del usuario), Entidad (selector de módulo + buscador que reutilice los endpoints de listado existentes de cada módulo), Documento (picker + subida), URL.
- Pull-to-refresh. Estado «Calendario no disponible» con el motivo y las instrucciones de contacto con el administrador.
- Botón discreto «Abrir en Google Calendar» por evento (link `htmlLink` que ya da el API).

## Tarea 3 — Card «Hoy» en Planning del Día (opcional, si el esfuerzo es bajo)

Mini-card con los 3 próximos eventos del día del usuario (hora + título, sin detalles), visible con `agenda.ver`, enlazando a la pantalla Agenda. Mismo endpoint con `vista=dia`.

## Reglas no opcionales

1. Solo lectura contra Google en v1. Ni crear, ni editar, ni borrar eventos. El scope readonly lo garantiza estructuralmente.
2. La service account no se usa jamás para un email fuera de los dominios permitidos.
3. Errores de Google (cuota, red, delegación) degradan a «calendario no disponible», nunca tumban la pantalla ni el planning.
4. Las refs referencian entidades por id — no duplican datos de la entidad (la etiqueta es solo cosmética).

## Criterios de aceptación

- Un usuario con email del dominio ve sus eventos de hoy y de cualquier día de la semana.
- Anclar una factura a un evento y tocar el chip abre el detalle de esa factura.
- Un usuario sin `agenda.ver` no ve la pantalla y el endpoint devuelve 403.
- Un usuario con email fuera del dominio ve el estado «Calendario no disponible», no un error.
- Las refs de un usuario no aparecen en la agenda de otro usuario invitado al mismo evento.
- Tumbar la conectividad con Google no afecta al resto de la app (el planning carga igual).

---

## Mejoras futuras (NO implementar ahora — backlog priorizado)

1. **Eventos del negocio mezclados**: inyectar en la agenda (con estilo diferenciado) las actuaciones, activaciones, mantenimientos y vencimientos de facturas/remesas del día que ya viven en IGP. La agenda pasa de personal a operativa.
2. **«Añadir a agenda» contextual**: botón en la ficha de factura/pedido/campaña que ancle esa entidad a un evento existente (v1.5) o cree el evento en Google (v2, requiere scope de escritura y decisión consciente).
3. **Escritura v2**: crear/editar eventos desde la app con scope `calendar.events`, incluyendo Meet link e invitados.
4. **Vista de equipo**: para administradores, ver la agenda de otros usuarios (la delegación ya lo permite técnicamente) con permiso propio `agenda.equipo`.
5. **Digest matinal**: notificación push (Expo) a las 8:30 con los eventos del día y sus referencias.
