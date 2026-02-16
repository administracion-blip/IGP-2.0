# ERP Hostelería

App multiplataforma (Android, iOS y web) con TypeScript y Expo. Login contra DynamoDB (AWS) y panel con sidebar, barra superior y footer.

## Requisitos

- Node.js 18+
- Cuenta AWS con tabla DynamoDB con atributos: `id_usuario`, `email`, `password`, `Nombre`

## Instalación

```bash
npm install
cd api && npm install && cd ..
```

## Configuración

1. **API y DynamoDB**  
   En la carpeta `api/` configura AWS (variables de entorno o `~/.aws/credentials`). Opcionalmente crea `api/.env`:

   - `AWS_REGION` – Región de tu tabla (ej. `eu-west-1`)
   - `DDB_USUARIOS` – Nombre de la tabla de usuarios

2. **URL del API en la app**  
   En la raíz del proyecto crea `.env` (opcional, por defecto usa `http://localhost:3001`):

   - `EXPO_PUBLIC_API_URL=http://localhost:3001` (o la URL de tu API en producción)

3. **Opcional – Código postal**  
   En `api/.env` o `api/.env.local` puedes añadir `GEOAPI_KEY` (clave en [geoapi.es](https://geoapi.es)) para que, al introducir un código postal de 5 dígitos en los formularios de Empresas y Locales, se rellenen automáticamente los campos Municipio y Provincia. Sin esta variable el endpoint sigue respondiendo y el usuario puede rellenarlos a mano.

## Ejecución

### Opción recomendada: API + App en una sola terminal

```bash
npm run dev
```

Arranca el API (puerto 3001) y la app web a la vez. Evita el error `ERR_CONNECTION_REFUSED` que aparece cuando el API no está en marcha.

### Opción manual: dos terminales

**Terminal 1 – API (login con DynamoDB):**

```bash
npm run api
# o: cd api && npm run dev
```

**Terminal 2 – App:**

```bash
npm run web      # Navegador
npm run android  # Android
npm run ios      # iOS (macOS)
```

### Si ves "Connection Failed / ERR_CONNECTION_REFUSED"

1. Asegúrate de que el API esté corriendo (puerto 3001).
2. Usa `npm run dev` para levantar API y app juntos.
3. Si el error persiste, pulsa "Restart Browser" o abre de nuevo la URL que muestra Expo.

Tras el login correcto se muestra el panel con barra superior (Nombre a la izquierda), sidebar (menú "Base de Datos" con icono) y footer.

## Componente TablaBasica

Las pantallas de listado CRUD (Empresas, Productos, Usuarios, etc.) reutilizan el componente **TablaBasica** (`app/components/TablaBasica.tsx`), que unifica:

- Cabecera (atrás + título), toolbar (Crear, Editar, Borrar, búsqueda, opcional Importar)
- Tabla con columnas redimensionables, selección de fila y paginación opcional

Los modales de Crear/Editar e Importar se mantienen en cada pantalla para personalizar formularios y lógica. Ver `app/(app)/productos.tsx` como ejemplo y `.cursor/rules/tabla-basica.mdc` para uso detallado.
