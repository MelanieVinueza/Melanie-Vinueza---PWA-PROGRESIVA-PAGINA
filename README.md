# Gestión de Usuarios — PWA (Práctica de Desarrollo de Plataformas)

Aplicación web progresiva sencilla que consume una API REST real, guarda los datos
en **IndexedDB** y sigue funcionando **sin conexión** gracias al **Service Worker**
y la **Cache API**. Incluye una **cola de sincronización** que reintenta enviar
los registros creados sin internet.

Sin frameworks: solo HTML, CSS y JavaScript vanilla.

---

## 1. Estructura

```text
PWA-Usuarios/
│
├── index.html     Interfaz (estructura semántica + atributos ARIA)
├── styles.css     Estilos
├── app.js         DOM, eventos, Fetch API, validaciones y sincronización
├── db.js          IndexedDB (base "UsuariosDB", stores usuarios / syncQueue / meta)
├── sw.js          Service Worker + Cache API (archivos de la app)
├── manifest.json  Manifiesto de la PWA
├── .github/workflows/deploy-pages.yml  Publicación automática en GitHub Pages
└── README.md      Este archivo
```

## Publicar en GitHub Pages

El workflow `.github/workflows/deploy-pages.yml` publica esta PWA estática con
GitHub Actions cada vez que se suben cambios a la rama `main`. También se puede
iniciar manualmente desde **Actions → Deploy PWA to GitHub Pages → Run workflow**.

Para habilitar la publicación la primera vez:

1. En el repositorio, abrir **Settings → Pages**.
2. En **Build and deployment → Source**, seleccionar **GitHub Actions**.
3. Subir los archivos del proyecto y el workflow a la rama `main`.
4. En **Actions**, esperar a que termine correctamente el workflow.

Una vez publicado, el sitio estará disponible en
<https://melanievinueza.github.io/PWA-PAGINA-MELANIE-VINUEZA/>.
Los siguientes `push` a `main` volverán a desplegarlo automáticamente. Los
recursos y el Service Worker usan rutas relativas, por lo que también funcionan
bajo la ruta del repositorio en GitHub Pages.

## 2. Cómo ejecutarla

Un Service Worker **no funciona** abriendo el archivo con doble clic (`file:///`).
Hay que servir la carpeta por HTTP. Desde la carpeta `PWA-Usuarios`:

```bash
python -m http.server 8000
```

Luego abrir <http://localhost:8000> y **recargar una segunda vez** (la primera vez
se registra el Service Worker; la segunda ya queda controlando la página).

> Importante: `localhost` es un origen seguro, así que el Service Worker y la
> Cache API funcionan sin necesidad de HTTPS.

## 3. Qué hace cada archivo

| Archivo | Responsabilidad |
|---|---|
| `index.html` | Estructura de la página: encabezado con estado de conexión, formulario, panel de información y lista de usuarios. Incluye `aria-live`, `aria-invalid`, `aria-describedby` y `role="status"`. |
| `styles.css` | Presentación. Colores verdes/rojos para el estado de conexión y las insignias de sincronización. |
| `app.js` | Toda la lógica de la interfaz y de la red: `DOMContentLoaded`, `submit`, `input`, `online`, `offline`, `fetch` (GET y POST), validaciones y recorrido de la cola de sincronización. |
| `db.js` | Única capa que habla con IndexedDB. Crea la base `UsuariosDB` con los object stores `usuarios`, `syncQueue` y `meta`, y expone el objeto `DB` con métodos que devuelven promesas. |
| `sw.js` | Service Worker. En `install` guarda `index.html`, `styles.css`, `app.js`, `db.js` y `manifest.json` en la Cache API; en `fetch` sirve esos archivos desde la caché cuando no hay red. |
| `manifest.json` | Nombre, ícono, colores y modo de ejecución de la PWA. |

## 4. Dónde está cada cosa que pide la práctica

### Fetch API (`app.js`)

* **GET** — función `actualizarDesdeAPI()`:
  `fetch(API_URL, { method: 'GET', headers: { 'Accept': 'application/json' } })`
  contra `https://jsonplaceholder.typicode.com/users`.
* **POST** — función `sincronizarCola()`:
  `fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registro.datos) })`

### IndexedDB (`db.js`)

Base de datos **`UsuariosDB`**, versión 1.

| Object store | Contenido |
|---|---|
| `usuarios` | Todos los usuarios. Campos: `id`, `nombre`, `usuario`, `correo`, `telefono`, `estado` (`synced` / `pending`), `origen` (`api` / `local`), `serverId`, `fechaCreacion`. Índices: `estado`, `origen`. |
| `syncQueue` | Cola de sincronización. Campos: `id`, `usuarioId`, `datos` (nombre, usuario, correo, telefono), `operacion` (`create`), `estado` (`pending` → `synced`), `intentos`, `ultimoError`, `fechaCreacion`, `fechaUltimoIntento`, `fechaSincronizacion`. Índice: `estado`. |
| `meta` | Guarda la fecha de la última sincronización. |

### Service Worker + Cache API (`sw.js`)

* `install` → `caches.open('usuarios-pwa-v1')` + `cache.addAll(RECURSOS)`.
* `activate` → borra las cachés de versiones anteriores y hace `clients.claim()`.
* `fetch` → para la navegación usa *red primero* y si falla devuelve `index.html`
  desde la caché; para el resto de archivos usa *caché primero* y actualiza en
  segundo plano. Las peticiones que no son `GET` y las de la API externa
  **no se interceptan**.

### Eventos del DOM (`app.js`)

`DOMContentLoaded`, `submit`, `input`, `online`, `offline` y `click`.
No hay ningún atributo `onclick` en el HTML.

## 5. Cómo funciona la sincronización

1. El usuario envía el formulario.
2. `crearUsuarioLocal()` guarda el usuario en `usuarios` con `estado: 'pending'` **y**
   agrega un registro en `syncQueue` con `estado: 'pending'`, **en la misma
   transacción** (o se guardan ambos, o ninguno).
3. La interfaz lo muestra como **"Pendiente de sincronización"**.
4. Si hay internet, se intenta el envío en el momento. Si no hay, el registro espera.
5. Cuando vuelve la conexión se dispara el evento `online` → `alConectar()` →
   `sincronizarCola()`:
   * lee los registros `pending` usando el índice `estado` de `syncQueue`;
   * envía un `POST` por cada uno;
   * si la respuesta es correcta: `marcarSincronizado()` pone `estado: 'synced'`,
     guarda `fechaSincronizacion` y actualiza el usuario a `synced`;
   * si falla: **no borra nada**. Llama a `registrarIntentoFallido()`, que sube
     `intentos`, guarda `ultimoError` y **deja el registro en `pending`**.
6. El botón **"Sincronizar ahora"** ejecuta el mismo proceso manualmente.

El mensaje **"Sincronización completada"** aparece solo cuando todos los registros
pendientes se enviaron correctamente.

> Nota sobre la API: JSONPlaceholder es una API de prueba; recibe los `POST` y
> responde `201`, pero **no guarda nada en el servidor**. Por eso la persistencia
> real de los datos está en IndexedDB, que es lo que permite el funcionamiento offline.

## 6. Pruebas paso a paso frente al profesor

### Preparación

1. Abrir DevTools (`F12`) y dejar visible la pestaña **Network**.
2. En Network marcar **Offline** solo cuando se indique (para la prueba con el
   cable se desconecta físicamente).

### PRUEBA 1 — Con Internet

1. Cargar `http://localhost:8000`.
2. Ver los 10 usuarios en pantalla, todos con **"Sincronizado"**.
3. Mensaje **"Conectado - Datos actualizados"**, indicador 🟢.
4. En Network aparece la petición `GET https://jsonplaceholder.typicode.com/users`.

### PRUEBA 2 — Desconectar el cable

1. **Desconectar el cable de red.**
2. Recargar la página (o cerrarla y volver a abrirla).
3. La aplicación **abre igual** y muestra los 10 usuarios.
4. Mensaje **"Sin conexión - Datos locales"**, indicador 🔴.
5. Llenar el formulario y pulsar **"Guardar usuario"**.
6. El usuario aparece con **"Pendiente de sincronización"** y en
   *Información → Registros pendientes* sube a `1`.
7. **Recargar otra vez**: el usuario sigue ahí. No se perdió nada.

### PRUEBA 3 — Volver a conectar el cable

1. **Reconectar el cable de red.**
2. El evento `online` se dispara solo: el mensaje pasa a
   **"Sincronización completada: 1 usuario(s) enviados a la API."**
3. La insignia del usuario cambia a **"Sincronizado"** y
   *Registros pendientes* vuelve a `0`.
4. En Network se ve el `POST https://jsonplaceholder.typicode.com/users`.

### PRUEBA 4 — Validaciones (con internet)

1. Pulsar **"Guardar usuario"** con el formulario vacío: aparecen los 4 errores,
   los campos se marcan en rojo (`aria-invalid="true"`) y el foco va al primer error.
2. Escribir un correo inválido (`ana@correo`) y un teléfono de 3 dígitos: se
   rechazan al enviar.
3. El mensaje de error se va limpiando mientras se escribe (evento `input`).

### PRUEBA 5 — Sincronización que falla

1. Poner la red en Offline en DevTools **después** de crear el usuario.
2. Pulsar **"Sincronizar ahora"**: avisa que no se puede sincronizar y el registro
   sigue en la cola.
3. Quitar el modo Offline y pulsar **"Sincronizar ahora"** otra vez: ahora sí,
   aparece **"Sincronización completada"**.

## 7. Qué mostrar en DevTools

| Pestaña de DevTools | Qué demostrar |
|---|---|
| **Network** | La petición `GET /users` y luego el `POST /users` (Payload con los datos del usuario). Al activar *Offline* se ve que la navegación se sirve desde la caché. |
| **Application → IndexedDB** | Base `UsuariosDB` con los stores `usuarios`, `syncQueue` y `meta`. En `syncQueue` se ve el registro con `estado: "pending"`; tras sincronizar pasa a `"synced"`. |
| **Application → Cache Storage** | La caché `usuarios-pwa-v1` con `index.html`, `styles.css`, `app.js`, `db.js` y `manifest.json`. |
| **Application → Service Workers** | El Service Worker registrado y en estado *activated and running*. |
| **Console** | Los mensajes `[Fetch]`, `[IndexedDB]`, `[Sync]` y `[Red]` que narran cada paso. |

En `IndexedDB → UsuariosDB → syncQueue` se puede comprobar campo por campo que un
registro con `estado: "pending"` nunca se borra: si un envío falla, siguen ahí con
`intentos` incrementado y `ultimoError` guardado.

## 8. Accesibilidad

* `role="status"` + `aria-live="polite"` en el mensaje general y en el indicador de conexión.
* `aria-invalid="true"` en los campos con error.
* `aria-describedby` para asociar las pistas y los mensajes de error a cada campo.
* `aria-required="true"` en los campos obligatorios.
* Al enviar con errores, el foco se mueve automáticamente al primer campo inválido.
* HTML semántico: `header`, `main`, `section`, `footer`, `dl` para los datos de información.
