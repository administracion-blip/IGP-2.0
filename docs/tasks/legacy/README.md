# Diseños archivados — Proyectos, Reuniones y Agenda

Estos documentos son **borradores de diseño previos** al módulo de dirección
(proyectos, tareas y reuniones). Se archivan aquí el 25/08/2026 por dos motivos:

1. **Nunca se implementaron.** No existe `api/routes/proyectos.js`,
   `api/routes/reuniones.js` ni `api/routes/agenda.js`, ni las tablas que
   describen (`Igp_Proyectos`, `Igp_ProyectoMensajes`, `Igp_Notificaciones`,
   `Igp_AgendaRefs`, `Igp_Reuniones`), ni `app/lib/agendaRefRutas.ts`. Ninguna
   parte de la app depende de ellos.
2. **Se solapaban entre sí y con el módulo nuevo.** Cuatro documentos proponían
   esquemas de datos distintos para las mismas entidades, y
   `cursor-agenda-proyectos-completo-prompt.md` ya declaraba sustituir a otros
   dos. Tenerlos en la raíz hacía que cualquier agente encontrase varios
   contratos contradictorios.

**No usar como referencia de implementación.** El contrato vigente del módulo
vive en `docs/tasks/` (pendiente de redactar).

## Qué merece la pena rescatar de aquí

| Documento | Ideas aprovechables |
|---|---|
| `PROMPT-MODULO-REUNIONES.md` | Modelo de visibilidad de reunión (`direccion`/`empresa`/`local`/`restringida` + `usuarios_autorizados`), aviso de grabación con registro de asistentes informados, política de borrado de audio y el problema de los audios en estado de error, validación previa de la transcripción con audio real. |
| `cursor-proyectos-prompt.md` | Hilo de conversación del proyecto y menciones `@usuario`. |
| `cursor-agenda-proyectos-completo-prompt.md` | Fases de integración con Google Calendar y tabla de notificaciones genérica (no acoplada a proyectos). |
| `cursor-agenda-prompt.md` | Decisiones de autenticación contra Google Calendar. |
