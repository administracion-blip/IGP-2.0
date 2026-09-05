# Prompts archivados de Cursor

Borradores de diseño e instrucciones de sesiones de Cursor usados para implementar
módulos de IGP-2.0. **No son documentación vigente** ni contrato de implementación.

## No usar como referencia de código

- La app **no importa** estos ficheros.
- Pueden estar **desactualizados** respecto al código actual.
- Contrato y convenciones vigentes: `.cursor/rules/`, `docs/tasks/` y el propio código.

## Ubicación

| Carpeta | Contenido |
|---------|-----------|
| `docs/prompts/legacy/` | Prompts generales (campanas, cashflow, remesas, IA, etc.) |
| `docs/tasks/legacy/` | Prompts del módulo dirección (proyectos, agenda, reuniones) — ver su `README.md` |

## Convención

- Nombre: `cursor-<modulo>-prompt.md` (u variantes descriptivas).
- **No crear prompts nuevos en la raíz del repo** (bloqueado en `.gitignore`).
- Si hace falta documentar una decisión que sigue vigente, trasladarla a `docs/tasks/`
  o a una regla en `.cursor/rules/`.
