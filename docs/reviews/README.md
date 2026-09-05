# Revisiones automáticas de código

Informes generados por el agente al revisar commits recientes (bugs críticos,
regresiones y márgenes de mejora). **No son documentación funcional** del producto;
son histórico de auditorías.

## Convención

- Nombre: `reporte-bugs-YYYY-MM-DD.md`
- Ubicación: **solo aquí** (`docs/reviews/`), nunca en la raíz del repo.
- Los informes nuevos deben crearse aquí; la raíz del repo está en `.gitignore` para evitar basura accidental.
- Opcional commitear el último informe; el histórico completo puede quedarse solo en local.

## Documentación del producto

Para contratos, APIs y decisiones de módulo, usar `docs/tasks/` y las reglas en
`.cursor/rules/`.
