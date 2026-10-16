/* =========================================================================
   sw.js — Service Worker
   -------------------------------------------------------------------------
   Su trabajo NO es guardar datos de usuarios (eso es IndexedDB).
   Su trabajo es_guardar los ARCHIVOS de la aplicación en la Cache API
   para que la página pueda abrirse sin Internet.
   ========================================================================= */

const CACHE_NAME = 'usuarios-pwa-v1';

// Archivos imprescindibles para que la app funcione sin conexión
const RECURSOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.json'
];

/* -------------------------------------------------------------------------
   install: se ejecuta la primera vez que se registra el Service Worker.
   Guarda todos los archivos en la Cache API.
   ---------------------------------------------------------------------- */
self.addEventListener('install', (evento) => {
  console.log('[SW] Instalando y guardando archivos en la Cache API…');

  evento.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(RECURSOS))
      .then(() => self.skipWaiting())
      .catch((error) => console.error('[SW] Error al guardar en la caché:', error))
  );
});

/* -------------------------------------------------------------------------
   activate: limpia las cachés de versiones anteriores.
   ---------------------------------------------------------------------- */
self.addEventListener('activate', (evento) => {
  console.log('[SW] Activado. Limpiando cachés antiguas…');

  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      ))
      .then(() => self.clients.claim())
  );
});

/* -------------------------------------------------------------------------
   fetch: decide de dónde sale cada recurso.
     - Navegaciones (abrir la página)  -> Red primero, caché si falla
     - Archivos propios (css, js...) -> Caché primero, actualiza después
     - API externa y POST             -> no se toca (la app usa IndexedDB)
   ---------------------------------------------------------------------- */
self.addEventListener('fetch', (evento) => {
  const solicitud = evento.request;

  // 1. Las peticiones que no son GET (POST del formulario) nunca pasan por el SW
  if (solicitud.method !== 'GET') {
    return;
  }

  const url = new URL(solicitud.url);

  // 2. La API externa (jsonplaceholder) se deja pasar sin interceptar
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3. Abrir la página: primero la red (para tener la versión nueva),
  //    si no hay Internet se sirve el index.html desde la caché.
  if (solicitud.mode === 'navigate') {
    evento.respondWith(redPrimeroConCache(solicitud));
    return;
  }

  // 4. Los demás archivos: caché primero + actualización silenciosa
  evento.respondWith(cachePrimeroActualizando(solicitud));
});

// ---------------------------------------------------------------- Red -> Caché
async function redPrimeroConCache(solicitud) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const respuesta = await fetch(solicitud);
    if (respuesta && respuesta.ok) {
      cache.put(solicitud, respuesta.clone());
    }
    return respuesta;
  } catch (error) {
    console.log('[SW] Sin red: se sirve index.html desde la Cache API');
    const desdeCache = await cache.match('./index.html');
    if (desdeCache) return desdeCache;
    throw error;
  }
}

// ---------------------------------------------------------------- Caché -> Red
async function cachePrimeroActualizando(solicitud) {
  const cache = await caches.open(CACHE_NAME);
  const guardado = await cache.match(solicitud);

  if (guardado) {
    // Se devuelve la copia guardada y, en segundo plano, se trae la nueva
    fetch(solicitud)
      .then((respuesta) => {
        if (respuesta && respuesta.ok) cache.put(solicitud, respuesta.clone());
      })
      .catch(() => { /* sin red: no pasa nada, ya se sirvió la copia guardada */ });

    return guardado;
  }

  const respuesta = await fetch(solicitud);
  if (respuesta && respuesta.ok) {
    cache.put(solicitud, respuesta.clone());
  }
  return respuesta;
}
