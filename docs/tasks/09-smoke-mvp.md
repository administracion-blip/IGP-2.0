# 09 · Smoke MVP — cierre operativo del módulo

Checklist para dar el módulo por **usable en el grupo** (Fases 1A–1B + 2 usable +
3 usable). **No incluye Fase 4** (plantillas, orden automático, cuadro de mando,
actas PDF, compras).

---

## Estado

**MVP cerrado el 31/08/2026** — smoke manual confirmado en producto («funciona
bastante bien»: proyectos, reuniones/Meet, importar transcripción → acta /
propuestas). Tests API verdes el mismo día (ver abajo).

Siguiente horizonte: [Fase 4](06-fases-y-dependencias.md) según prioridad de uso.

---

## Verificación automática (pasada en repo)

Ejecutado el **31/08/2026** en `api/`:

```bash
cd api && npm test
# → 771 pass / 0 fail

cd api && node --test "tests/tasksReuniones*.test.mjs" "tests/tasksTareas.test.mjs" "tests/googleCalendar.test.mjs"
# → 112 pass / 0 fail (reuniones + tareas + Calendar client)
```

Cubre en código: visibilidad, orden congelado, acuerdos→tareas, audio/presign,
pipeline tick, Transcribe stub, resumen, propuestas, **importar transcripción**,
idempotencia, Google Calendar client unitario.

---

## Precondiciones

- [x] `npm run dev` (API + Expo) estable.
- [x] `api/.env.local`: Google Calendar OK; `OPENAI_API_KEY`;
      `REUNIONES_PIPELINE_ENABLED=true`; (AWS Transcribe opcional si se prueba audio).
- [x] Usuario con `proyectos.*` / `reuniones.gestionar` / `reuniones.ver`.

---

## A · Proyectos y tareas (1A)

- [x] Crear proyecto desde listado → navega a la ficha.
- [x] En la ficha: **Nueva tarea** queda con el proyecto asignado.
- [x] **Mis tareas** muestra la tarea abierta.

## B · Reuniones y Calendar (1B)

- [x] Desde el proyecto: **Nueva reunión** (sin teclear `proyecto_id`).
- [x] La reunión aparece en «Reuniones del proyecto» y en `/reuniones`.
- [x] Hay `meet_code` / chip **Abrir Meet** → **una sola** pestaña nueva.
- [x] Evento / Meet usable (Calendar o enlace Meet en ficha).

## C · Pipeline / acta (2) — camino: importar texto Meet

- [x] **Importar transcripción** (pegar / `.txt`) sin aviso de grabación.
- [x] Origen «Transcripción importada»; tick genera acta.
- [x] Resumen / acta en borrador y propuestas de la IA.
- [x] Validar propuestas (aceptar → tarea) operativa en uso real.
- [x] Idempotencia de re-import / no romper flujo (cubierto también por tests).

### C-bis · Camino audio (opcional)

- [ ] Aviso de grabación → subir audio → Transcribe → misma acta/propuestas
      (no bloquea el MVP; camino preferido = importar texto).

## D · Avisos y calendario personal (3)

- [x] Piezas en código (campana + ICS + tabla AWS) + uso aceptable en smoke de
      producto. Directory real sigue **fuera** (stub).

## E · Fuera de alcance MVP (no bloquean el cierre)

- Directory real (stub OK).
- Cuadro de mando / PDF / compras / plantillas / orden del día automático (Fase 4).
- Descarga automática del Doc de Meet desde Drive.
- Grabación dentro de la app (A-09: no).

---

## Criterio de «MVP cerrado»

Pasaron **A + B + C** (+ D en código/uso). **Cumplido 31/08/2026.**
