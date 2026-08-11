# S-14 — npm audit (2026-08-11)

## Antes

| Ámbito | Comando | Resultado |
|--------|---------|-----------|
| `api/` | `npm audit --omit=dev` | **15** (9 moderate, 6 high) |
| raíz | `npm audit --omit=dev` | **42** (1 low, 12 moderate, 26 high, 3 critical) |
| raíz | `npm audit` | **44** (1 low, 12 moderate, 27 high, 4 critical) |

## Aplicado

- **`api/`**: `npm audit fix` (sin `--force`). Actualizó transitive deps (`body-parser`, `brace-expansion`, `dompurify`, `fast-xml-*`, `ip-address`/`express-rate-limit`, `multer`, `path-to-regexp`, `qs`/`express`, etc.). Cambió `api/package-lock.json`.
- **`npm test` en `api/`**: **165 pass / 0 fail** (incluye tests S-08).
- **Raíz**: `npm audit fix` **no se aplicó** — falló con `ERESOLVE` (peer `@types/react` ~19.1 vs `@types/react-dom` pidiendo ^19.2). No se usó `--force` ni `--legacy-peer-deps`. Lock de raíz sin cambios por este paso.

## Después

| Ámbito | Resultado |
|--------|-----------|
| `api/` | **3** (2 moderate, 1 high) |
| raíz | Sin cambio (42 / 44 como arriba) |

## Restantes high/critical que requieren major (o no hay fix)

### `api/` (requieren `--force` / breaking)

- **sharp** (high): fix → `sharp@0.35.x` (breaking). No aplicado.
- **uuid** vía **exceljs** (moderate, pero solo con `--force`): npm propone `exceljs@3.4.0` (downgrade breaking). No aplicado.

### Raíz (Expo / sin fix / bloqueados por ERESOLVE)

- **image-size**, **postcss**, **uuid/xcode** (high/moderate): `npm audit fix --force` propondría **expo@57** — major; no tocar a ciegas.
- **xlsx** (high): *No fix available* (SheetJS).
- Criticals reportados en audit completo (`jspdf`, `shell-quote`, `tar`, etc.): muchos tendrían fix no-force, pero el `audit fix` de raíz no pudo resolverse por el conflicto de peers. Revisar tras alinear `@types/react` / `@types/react-dom` o con resolución controlada (sin Expo major).
