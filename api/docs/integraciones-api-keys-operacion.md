# Operación de API keys de integración

Procedimiento para dar de alta, rotar y revocar claves de la tabla `Igp_IntegracionesApi` (o el nombre en `DDB_INTEGRACIONES_API`).

**Nunca** guardes la clave en claro en el repositorio, en tickets ni en logs. En Dynamo solo se almacena el **hash SHA-256** (hex) de la clave.

## Esquema Dynamo

- **Tabla:** `Igp_IntegracionesApi`
- **PK:** `id_clave` (S)
- **GSI:** `GsiKeyHash` — HASH `key_hash` (S)

Atributos:

| Atributo | Tipo | Notas |
|----------|------|--------|
| `id_clave` | S | PK (UUID u otro id estable) |
| `id_integracion` | S | Identificador de negocio de la integración |
| `nombre` | S | Nombre legible |
| `key_hash` | S | SHA-256 hex de la clave en claro |
| `key_prefix` | S | Prefijo corto para logs (p. ej. primeros caracteres no secretos) |
| `activa` | BOOL | Debe ser `true` para autenticar |
| `scopes` | L (strings) | Incluir `actuaciones:read` para el endpoint de actuaciones |
| `created_at` | S | ISO |
| `last_used_at` | S | Lo actualiza la API en cada uso autenticado |
| `nota` | S | Opcional |

## Generar una clave (fuera del código)

1. Genera una clave larga y aleatoria con un gestor de contraseñas o, por ejemplo:

   ```bash
   openssl rand -hex 32
   ```

2. Anota la clave en un canal seguro; **solo se entregará una vez** al consumidor.

3. Calcula el hash (ejemplo; sustituye el placeholder):

   ```bash
   # Linux / macOS / Git Bash
   printf '%s' '<pegar-clave-aqui>' | openssl dgst -sha256
   ```

   En PowerShell (sin volcar la clave a un fichero del repo):

   ```powershell
   $k = Read-Host 'Clave'
   $bytes = [System.Text.Encoding]::UTF8.GetBytes($k)
   $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
   ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
   ```

4. Elige un `key_prefix` corto para identificación en logs (no la clave completa). Ejemplo de valor: `REDACTED` o un prefijo acordado de pocos caracteres.

## Insertar el ítem

Inserta un ítem con:

- `id_clave`: UUID nuevo
- `key_hash`: resultado del SHA-256 (hex en minúsculas)
- `key_prefix`: el prefijo acordado
- `activa`: `true`
- `scopes`: lista con al menos `actuaciones:read`
- `created_at`: timestamp ISO actual
- `nombre` / `id_integracion` / `nota` según corresponda

No pongas la clave en claro en ningún atributo.

## Entrega

Entrega la clave en claro **una sola vez** al responsable de la app externa (gestor de secretos / canal cifrado). Después solo existirá el hash en Dynamo.

## Rotación (recomendado: 2 activas)

1. Genera una clave nueva, calcula hash e inserta un **segundo** ítem `activa=true` con el mismo `id_integracion` (u otro, según política).
2. Comunica la clave nueva al consumidor.
3. Cuando confirme el cambio, pon `activa=false` en el ítem antiguo (revocación).

Así puedes tener temporalmente dos claves válidas.

## Revocación

Pon `activa` a `false` en el ítem correspondiente. No es necesario borrar el registro (útil para auditoría).

## Qué loguear

Permitido:

- `key_prefix`
- opcionalmente los **últimos 4** caracteres de la clave entrante (nunca la clave completa ni el hash completo en logs de aplicación si se puede evitar)

Prohibido:

- API key completa
- hashes de ejemplo realistas en documentación o código
- semillas / fixtures con secretos en el repo

## Recordatorio de seguridad

- El middleware de integración es independiente de JWT y de `X-Internal-Secret`.
- La API key **no** abre el resto de rutas `/api`.
- El namespace `/api/integraciones` es **solo GET**; no crear rutas de escritura de actuaciones para esta auth.
