# Integración actuaciones — contrato (solo lectura)

API para que una app externa de marketing lea actuaciones y rellene carteles.

**Solo lectura.** No hay endpoints de escritura en este namespace. Cualquier método distinto de `GET` se rechaza.

## Autenticación

Cabecera obligatoria:

```http
X-Api-Key: <pegar-clave-aqui>
```

La clave **no** autentica el resto de `/api` (esas rutas siguen exigiendo JWT Bearer). No uses esta cabecera como sustituto del login de usuarios.

## Endpoint

```http
GET /api/integraciones/v1/actuaciones
```

### Query params

| Param | Obligatorio | Descripción |
|-------|-------------|-------------|
| `fechaDesde` | Sí | Inicio del rango, `YYYY-MM-DD` (inclusivo) |
| `fechaHasta` | Sí | Fin del rango, `YYYY-MM-DD` (inclusivo) |
| `local` | No | Filtra por nombre de local (`local_nombre_snapshot`, sin distinguir mayúsculas) o por `id_local` si el valor parece un id |
| `limit` | No | Tamaño de página (default `100`, máximo `200`) |
| `cursor` | No | Cursor opaco de la página anterior (`nextCursor`) |

### Filtros de negocio (fijos en servidor)

- Rango inclusivo por campo `fecha`.
- **No** se filtra por estado.
- Se excluyen **huecos** (sin artista): `id_artista` y `artista_nombre_snapshot` vacíos.
- Solo ítems con `fecha` válida `YYYY-MM-DD`.
- Orden: `fecha` asc, luego `hora_inicio`, luego `id_actuacion`.

## Respuesta

```json
{
  "data": [
    {
      "id_actuacion": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "artista_nombre_snapshot": "Grupo Ejemplo",
      "local_nombre_snapshot": "Local Centro",
      "fecha": "2026-08-17",
      "hora_inicio": "22:30",
      "fecha_dia_semana": "LUNES",
      "fecha_dia_numero": "17",
      "fecha_mes": "AGOSTO"
    }
  ],
  "nextCursor": null
}
```

- `data`: lista de DTOs estables (no es el ítem Dynamo crudo).
- `nextCursor`: string opaco en base64url, o `null` si no hay más páginas. Pasarlo como `cursor` en la siguiente petición.
- Días/meses en mayúsculas ASCII sin tildes (`MIERCOLES`, `SABADO`, etc.).

## Códigos de error

| Código | Cuándo |
|--------|--------|
| `400` | Params inválidos (`fechaDesde`/`fechaHasta` ausentes o mal formados, `cursor` inválido, rango invertido) |
| `401` | Sin `X-Api-Key`, clave desconocida, inactiva o sin scope `actuaciones:read` |
| `405` | Método distinto de GET bajo `/api/integraciones` |
| `500` | Error interno al leer datos |

## Notas

- Paginación cursor-based: el cursor no contiene secretos; solo posición de ordenación (`fecha`, `hora_inicio`, `id_actuacion`).
- No inventar ni persistir campos fuera del DTO documentado.
