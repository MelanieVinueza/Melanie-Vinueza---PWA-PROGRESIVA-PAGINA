/* =========================================================================
   db.js — Capa de persistencia (IndexedDB)
   -------------------------------------------------------------------------
   Base de datos: "UsuariosDB"
   Object stores:
     - usuarios  : todos los usuarios (vienen de la API o se crean localmente)
     - syncQueue : cola de sincronización (usuarios creados sin conexión)
     - meta      : datos pequeños de la app (fecha de última sincronización)

   ESTE archivo es el único que habla con IndexedDB.
   app.js consume el objeto global "DB" con promesas.
   ========================================================================= */

const DB_NAME = 'UsuariosDB';
const DB_VERSION = 1;

const STORE_USUARIOS = 'usuarios';
const STORE_COLA = 'syncQueue';
const STORE_META = 'meta';

// Se abre una sola vez y se reutiliza la conexión
let promesaDB = null;

/* -------------------------------------------------------------------------
   1. Apertura / creación de la base de datos
   ---------------------------------------------------------------------- */
function abrirBaseDatos() {
  if (promesaDB) {
    return promesaDB;
  }

  promesaDB = new Promise((resolve, reject) => {
    const solicitud = indexedDB.open(DB_NAME, DB_VERSION);

    // Se ejecuta SOLO la primera vez (o si cambia la versión).
    // Aquí se crean los object stores.
    solicitud.onupgradeneeded = (evento) => {
      const db = evento.target.result;
      console.log('[IndexedDB] Creando/actualizando la base de datos', DB_NAME);

      // --- Store: usuarios -------------------------------------------------
      if (!db.objectStoreNames.contains(STORE_USUARIOS)) {
        const storeUsuarios = db.createObjectStore(STORE_USUARIOS, {
          keyPath: 'id',
          autoIncrement: true
        });
        storeUsuarios.createIndex('estado', 'estado', { unique: false });
        storeUsuarios.createIndex('origen', 'origen', { unique: false });
      }

      // --- Store: syncQueue (cola de sincronización) ----------------------
      if (!db.objectStoreNames.contains(STORE_COLA)) {
        const storeCola = db.createObjectStore(STORE_COLA, {
          keyPath: 'id',
          autoIncrement: true
        });
        // Índice para buscar rápido los registros "pending"
        storeCola.createIndex('estado', 'estado', { unique: false });
      }

      // --- Store: meta -----------------------------------------------------
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'clave' });
      }
    };

    solicitud.onsuccess = () => {
      const db = solicitud.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };

    solicitud.onerror = () => reject(solicitud.error);
    solicitud.onblocked = () => console.warn('[IndexedDB] Apertura bloqueada por otra pestaña');
  });

  return promesaDB;
}

/* -------------------------------------------------------------------------
   2. Utilidades
   ---------------------------------------------------------------------- */

// Envuelve cualquier IDBRequest en una promesa
function pedir(solicitud) {
  return new Promise((resolve, reject) => {
    solicitud.onsuccess = () => resolve(solicitud.result);
    solicitud.onerror = () => reject(solicitud.error);
  });
}

// Ejecuta una transacción y espera a que termine correctamente
async function transaccion(stores, modo, accion) {
  const db = await abrirBaseDatos();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, modo);
    let resultado;

    tx.oncomplete = () => resolve(resultado);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    Promise.resolve()
      .then(() => accion(tx))
      .then((r) => { resultado = r; })
      .catch((error) => {
        try { tx.abort(); } catch (e) { /* la transacción ya terminó */ }
        reject(error);
      });
  });
}

/* -------------------------------------------------------------------------
   3. API de usuarios (store: usuarios)
   ---------------------------------------------------------------------- */

// Traduce el formato de la API (name, username, email, phone) al formato interno
function normalizarUsuarioApi(usuario) {
  return {
    id: usuario.id,
    nombre: usuario.name,
    usuario: usuario.username,
    correo: usuario.email,
    telefono: usuario.phone,
    estado: 'synced',   // ya vino del servidor
    origen: 'api',
    serverId: usuario.id,
    fechaCreacion: new Date().toISOString()
  };
}

// Guarda (o actualiza) los usuarios obtenidos de la API
async function guardarUsuariosDesdeAPI(listaApi) {
  const usuarios = listaApi.map(normalizarUsuarioApi);

  await transaccion([STORE_USUARIOS], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_USUARIOS);
    for (const usuario of usuarios) {
      store.put(usuario); // put = inserta si no existe, actualiza si ya existe
    }
  });

  console.log(`[IndexedDB] ${usuarios.length} usuarios guardados desde la API`);
  return usuarios.length;
}

// Devuelve TODOS los usuarios ordenados por id
async function listarUsuarios() {
  const usuarios = await transaccion([STORE_USUARIOS], 'readonly', (tx) =>
    pedir(tx.objectStore(STORE_USUARIOS).getAll())
  );
  return usuarios.sort((a, b) => a.id - b.id);
}

// Cuenta usuarios almacenados
async function contarUsuarios() {
  return transaccion([STORE_USUARIOS], 'readonly', (tx) =>
    pedir(tx.objectStore(STORE_USUARIOS).count())
  );
}

/* -------------------------------------------------------------------------
   4. Crear usuario + enlistarlo en la cola (store: usuarios + syncQueue)
   ---------------------------------------------------------------------- */

// Guarda un usuario nuevo en IndexedDB y lo mete en la cola con estado "pending".
// Ambas escrituras van en la MISMA transacción: o se guardan las dos, o ninguna.
async function crearUsuarioLocal(datos) {
  const nuevoUsuario = {
    nombre: datos.nombre.trim(),
    usuario: datos.usuario.trim(),
    correo: datos.correo.trim(),
    telefono: datos.telefono.trim(),
    estado: 'pending',                 // pendiente de sincronización
    origen: 'local',                   // creado en este dispositivo
    serverId: null,                    // aún no tiene id del servidor
    fechaCreacion: new Date().toISOString()
  };

  const resultado = await transaccion(
    [STORE_USUARIOS, STORE_COLA],
    'readwrite',
    async (tx) => {
      const storeUsuarios = tx.objectStore(STORE_USUARIOS);
      const storeCola = tx.objectStore(STORE_COLA);

      const idUsuario = await pedir(storeUsuarios.add(nuevoUsuario));

      const idCola = await pedir(storeCola.add({
        usuarioId: idUsuario,                       // id local del usuario
        datos: {                                     // datos a enviar por Fetch
          nombre: nuevoUsuario.nombre,
          usuario: nuevoUsuario.usuario,
          correo: nuevoUsuario.correo,
          telefono: nuevoUsuario.telefono
        },
        operacion: 'create',                        // operación pendiente
        estado: 'pending',                          // estado inicial
        intentos: 0,
        ultimoError: null,
        fechaCreacion: new Date().toISOString(),
        fechaSincronizacion: null
      }));

      return { idUsuario, idCola };
    }
  );

  console.log(`[IndexedDB] Usuario local #${resultado.idUsuario} creado y agregado a la cola (pending)`);
  return resultado;
}

/* -------------------------------------------------------------------------
   5. Cola de sincronización (store: syncQueue)
   ---------------------------------------------------------------------- */

// Devuelve SOLO los registros con estado "pending"
async function listarPendientes() {
  const pendientes = await transaccion([STORE_COLA], 'readonly', (tx) =>
    pedir(tx.objectStore(STORE_COLA).index('estado').getAll('pending'))
  );
  return pendientes.sort((a, b) => a.id - b.id);
}

// Cuenta los registros pendientes
async function contarPendientes() {
  return transaccion([STORE_COLA], 'readonly', (tx) =>
    pedir(tx.objectStore(STORE_COLA).index('estado').count('pending'))
  );
}

// Marca un registro de la cola como "synced" y actualiza su usuario
async function marcarSincronizado(idCola, serverId) {
  await transaccion([STORE_COLA, STORE_USUARIOS], 'readwrite', async (tx) => {
    const storeCola = tx.objectStore(STORE_COLA);
    const storeUsuarios = tx.objectStore(STORE_USUARIOS);

    const registro = await pedir(storeCola.get(idCola));
    if (!registro) return;

    registro.estado = 'synced';
    registro.fechaSincronizacion = new Date().toISOString();
    registro.ultimoError = null;
    storeCola.put(registro);

    if (serverId) {
      const usuario = await pedir(storeUsuarios.get(registro.usuarioId));
      if (usuario) {
        usuario.estado = 'synced';
        usuario.serverId = serverId;
        storeUsuarios.put(usuario);
      }
    }
  });

  console.log(`[IndexedDB] Registro de cola #${idCola} marcado como "synced"`);
}

// Si el envío falla: NO se borra nada, solo se registra el intento fallido
async function registrarIntentoFallido(idCola, mensajeError) {
  await transaccion([STORE_COLA], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE_COLA);
    const registro = await pedir(store.get(idCola));
    if (!registro) return;

    registro.intentos = (registro.intentos || 0) + 1;
    registro.ultimoError = mensajeError;
    registro.fechaUltimoIntento = new Date().toISOString();
    // El estado sigue siendo "pending": se reintentará más tarde
    store.put(registro);
  });

  console.warn(`[IndexedDB] Falló el envío del registro #${idCola}. Sigue en "pending".`, mensajeError);
}

/* -------------------------------------------------------------------------
   6. Metadatos (store: meta) — fecha de última sincronización
   ---------------------------------------------------------------------- */
async function guardarUltimaSincronizacion(fechaISO) {
  return transaccion([STORE_META], 'readwrite', (tx) =>
    pedir(tx.objectStore(STORE_META).put({ clave: 'ultimaSincronizacion', valor: fechaISO }))
  );
}

async function obtenerUltimaSincronizacion() {
  const registro = await transaccion([STORE_META], 'readonly', (tx) =>
    pedir(tx.objectStore(STORE_META).get('ultimaSincronizacion'))
  );
  return registro ? registro.valor : null;
}

/* -------------------------------------------------------------------------
   7. Objeto público (lo usa app.js)
   ---------------------------------------------------------------------- */
const DB = {
  abrir: abrirBaseDatos,
  guardarUsuariosDesdeAPI,
  listarUsuarios,
  contarUsuarios,
  crearUsuarioLocal,
  listarPendientes,
  contarPendientes,
  marcarSincronizado,
  registrarIntentoFallido,
  guardarUltimaSincronizacion,
  obtenerUltimaSincronizacion,
  nombres: {
    base: DB_NAME,
    usuarios: STORE_USUARIOS,
    cola: STORE_COLA,
    meta: STORE_META
  }
};
