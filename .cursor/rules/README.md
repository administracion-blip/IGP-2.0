# Reglas del proyecto IGP-2.0

Índice de las reglas para el agente de Cursor. Todas las reglas del proyecto se
definen **aquí**, en `.cursor/rules/`, de forma estructurada. No dispersar
convenciones en `Notas.md`, comentarios sueltos u otros documentos.

## Capas

### Siempre activas (`alwaysApply: true`)

| Regla | Qué cubre |
|-------|-----------|
| `arquitectura-igp.mdc` | "Constitución" del proyecto: stack, auth, permisos, locales, jornada de negocio (09:30), APIs, módulos y convenciones generales. |
| `critical-bug-finder.mdc` | Comportamiento del agente al revisar commits: detectar bugs críticos de corrección. |

### Por contexto (se aplican según `globs`)

| Regla | `globs` | Qué cubre |
|-------|---------|-----------|
| `ui-responsive.mdc` | `app/**/*.tsx` | Breakpoints, `useBreakpoint`, orientación, `MIN_TOUCH`, densidad y tipografía. |
| `campo-fecha.mdc` | `app/**/*.tsx` | Campo de fecha (`InputFecha`): formato ISO vs dd/mm/aaaa, calendario, jornada. |
| `desplegables-zindex.mdc` | `app/**/*.tsx` | Desplegables / menús flotantes por encima de tablas (z-index / stacking). |
| `tabla-basica.mdc` | `app/(app)/**/*.tsx` | Uso de `TablaBasica` en pantallas CRUD. |
| `dialogos-app.mdc` | `app/**/*.tsx` | Confirmaciones y avisos in-app (`useConfirmar`); no `window.confirm` ni `Alert.alert` directos. |
| `modulo-tasks.mdc` | ficheros del módulo de dirección | Proyectos, tareas y reuniones: reglas de trabajo y punteros al contrato de `docs/tasks/`. |

## Cómo elegir dónde va una regla nueva

- **Afecta a todo el proyecto y es comportamiento base** → ampliar `arquitectura-igp.mdc`.
- **Convención de UI / componente concreto** → regla propia con `globs` acotado (como `campo-fecha.mdc` o `tabla-basica.mdc`).
- **Tarea/rol del agente** (revisión, auditoría…) → regla `alwaysApply` separada (como `critical-bug-finder.mdc`).
- Evitar duplicar materia entre `arquitectura-igp.mdc` y las reglas por contexto: en la regla global, **remitir** a la específica en lugar de repetir el detalle.

## No son reglas (documentación)

- `docs/BACKLOG-UX.md` — roadmap de mejoras UX (qué falta), no convenciones.
- `docs/reviews/` — informes automáticos de revisión de bugs (histórico del agente); ver `docs/reviews/README.md`.
- `docs/prompts/legacy/` — prompts archivados de Cursor (specs de sesiones); no referencia de implementación.
- `docs/tasks/` — contrato del módulo de dirección (proyectos, tareas y reuniones):
  esquema de datos, API, fases y coste. La regla `modulo-tasks.mdc` remite aquí.
- `README.md` (raíz) — instalación y ejecución del proyecto.
- `Notas.md` — chuleta de comandos personales.
