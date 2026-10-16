/* =========================================================================
   app.js — Lógica de la aplicación
   -------------------------------------------------------------------------
   Se ocupa de:
     1. Manipulación del DOM (querySelector, createElement)
     2. Eventos (DOMContentLoaded, submit, input, online, offline, click)
     3. Fetch API (GET a jsonplaceholder / POST para crear usuarios)
     4. IndexedDB (a través de db.js)
     5. Sincronización de la cola cuando vuelve Internet
     6. Validaciones del formulario con ARIA
   ========================================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     CONFIGURACIÓN
     ------------------------------------------------------------------ */
  const API_URL = 'https://jsonplaceholder.typicode.com/users';
  const REGEX_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const LARGO_TELEFONO = 10;

  // Referencias a los elementos del DOM (se llenan en cachearElementos)
  const ui = {};

  // Estado de la aplicación en memoria
  const estado = {
    online: navigator.onLine,
    usuarios: [],
    pendientes: 0,
    ultimaSincronizacion: null,
    sincronizando: false   // candado para no lanzar dos sincronizaciones a la vez
  };

  /* =====================================================================
     1. ARRANQUE
     ================================================================== */
  document.addEventListener('DOMContentLoaded', iniciar);

  async function iniciar() {
    cachearElementos();
    registrarEventos();
    pintarEstadoConexion();

    await registrarServiceWorker();

    try {
      await DB.abrir();
    } catch (error) {
      mostrarMensaje('No se pudo abrir la base de datos local: ' + error.message, 'error');
      return;
    }

    // Siempre se leen primero los datos locales (funciona con y sin Internet)
    await refrescar();

    if (estado.online) {
      await actualizarDesdeAPI();
    } else {
      mostrarMensaje('Sin conexión - Datos locales', 'aviso');
    }
  }

  // querySelector: se guardan los nodos una sola vez
  function cachearElementos() {
    ui.indicador = document.querySelector('#indicador-conexion');
    ui.textoEstado = document.querySelector('#texto-estado');
    ui.mensaje = document.querySelector('#mensaje');

    ui.formulario = document.querySelector('#form-usuario');
    ui.btnGuardar = document.querySelector('#btn-guardar');
    ui.btnSincronizar = document.querySelector('#btn-sincronizar');

    ui.infoConexion = document.querySelector('#info-conexion');
    ui.infoTotal = document.querySelector('#info-total');
    ui.infoPendientes = document.querySelector('#info-pendientes');
    ui.infoUltima = document.querySelector('#info-ultima');

    ui.lista = document.querySelector('#lista-usuarios');
    ui.contador = document.querySelector('#contador-usuarios');
    ui.listaVacia = document.querySelector('#lista-vacia');

    ui.campos = {
      nombre: document.querySelector('#nombre'),
      usuario: document.querySelector('#usuario'),
      correo: document.querySelector('#correo'),
      telefono: document.querySelector('#telefono')
    };

    ui.errores = {
      nombre: document.querySelector('#error-nombre'),
      usuario: document.querySelector('#error-usuario'),
      correo: document.querySelector('#error-correo'),
      telefono: document.querySelector('#error-telefono')
    };
  }

  // addEventListener: todos los eventos, ninguno con atributos en el HTML
  function registrarEventos() {
    ui.formulario.addEventListener('submit', enviarFormulario);
    ui.formulario.addEventListener('input', validarEnVivo);
    ui.btnSincronizar.addEventListener('click', sincronizarAhora);

    window.addEventListener('online', alConectar);
    window.addEventListener('offline', alDesconectar);
  }

  /* =====================================================================
     2. SERVICE WORKER
     ================================================================== */
  async function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[SW] Este navegador no soporta Service Workers');
      return;
    }

    try {
      const registro = await navigator.serviceWorker.register('sw.js');
      console.log('[SW] Service Worker registrado. Ábrelo una segunda vez para que controle la página.');
      if (registro.active) {
        console.log('[SW] Service Worker activo:', registro.active.scriptURL);
      }
    } catch (error) {
      console.error('[SW] Error al registrar el Service Worker:', error);
    }
  }

  /* =====================================================================
     3. RENDERIZADO (manipulación del DOM)
     ================================================================== */
  function mostrarMensaje(texto, tipo) {
    ui.mensaje.textContent = texto;
    ui.mensaje.className = 'mensaje ' + (tipo || 'info');
  }

  function pintarEstadoConexion() {
    const texto = estado.online ? 'Conectado' : 'Sin conexión';

    ui.textoEstado.textContent = texto;
    ui.indicador.classList.toggle('conectado', estado.online);
    ui.indicador.classList.toggle('sin-conexion', !estado.online);
    ui.infoConexion.textContent = texto;
  }

  // Vuelve a leer todo desde IndexedDB y actualiza la interfaz
  async function refrescar() {
    try {
      estado.usuarios = await DB.listarUsuarios();
      estado.pendientes = await DB.contarPendientes();
      estado.ultimaSincronizacion = await DB.obtenerUltimaSincronizacion();
    } catch (error) {
      console.error('Error al leer IndexedDB:', error);
      mostrarMensaje('Error al leer los datos locales: ' + error.message, 'error');
      return;
    }

    pintarEstadoConexion();
    pintarInformacion();
    pintarUsuarios();
  }

  function pintarInformacion() {
    ui.infoTotal.textContent = String(estado.usuarios.length);
    ui.infoPendientes.textContent = String(estado.pendientes);
    ui.infoUltima.textContent = estado.ultimaSincronizacion
      ? formatearFecha(estado.ultimaSincronizacion)
      : 'Nunca';
  }

  // Construye cada tarjeta de usuario con createElement (nada de innerHTML con datos)
  function pintarUsuarios() {
    ui.lista.textContent = ''; // limpia la lista
    const fragmento = document.createDocumentFragment();

    for (const usuario of estado.usuarios) {
      const pendiente = usuario.estado !== 'synced';

      const li = document.createElement('li');
      li.className = 'tarjeta-usuario' + (pendiente ? ' pendiente' : '');
      li.setAttribute('data-id', usuario.id);
      li.setAttribute('data-estado', usuario.estado);

      const titulo = document.createElement('h3');
      titulo.textContent = usuario.nombre;
      li.appendChild(titulo);

      li.appendChild(crearDato('Usuario', usuario.usuario));
      li.appendChild(crearDato('Correo', usuario.correo));
      li.appendChild(crearDato('Teléfono', usuario.telefono));

      const insignia = document.createElement('span');
      insignia.className = 'estado ' + (pendiente ? 'estado-pendiente' : 'estado-sincronizado');
      insignia.textContent = pendiente ? 'Pendiente de sincronización' : 'Sincronizado';
      li.appendChild(insignia);

      fragmento.appendChild(li);
    }

    ui.lista.appendChild(fragmento);

    ui.contador.textContent = estado.usuarios.length === 1
      ? '1 usuario'
      : estado.usuarios.length + ' usuarios';

    ui.listaVacia.hidden = estado.usuarios.length !== 0;
  }

  function crearDato(etiqueta, valor) {
    const p = document.createElement('p');
    p.className = 'dato';

    const spanEtiqueta = document.createElement('span');
    spanEtiqueta.className = 'etiqueta';
    spanEtiqueta.textContent = etiqueta + ': ';

    const spanValor = document.createElement('span');
    spanValor.textContent = valor;

    p.appendChild(spanEtiqueta);
    p.appendChild(spanValor);
    return p;
  }

  function formatearFecha(fechaISO) {
    const fecha = new Date(fechaISO);
    if (isNaN(fecha.getTime())) return 'Nunca';
    return fecha.toLocaleString('es', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  /* =====================================================================
     4. FETCH API — descargar usuarios (GET)
     ================================================================== */
  async function actualizarDesdeAPI() {
    if (!estado.online) return;

    console.log('[Fetch] GET ' + API_URL);
    mostrarMensaje('Conectado - Consultando la API…', 'info');

    try {
      const respuesta = await fetch(API_URL, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (!respuesta.ok) {
        throw new Error('La API respondió con HTTP ' + respuesta.status);
      }

      const datos = await respuesta.json();
      console.log('[Fetch] Se recibieron ' + datos.length + ' usuarios');

      await DB.guardarUsuariosDesdeAPI(datos);

      const fecha = new Date().toISOString();
      await DB.guardarUltimaSincronizacion(fecha);

      await refrescar();
      mostrarMensaje('Conectado - Datos actualizados', 'exito');

      // Si quedó algo en la cola de una sesión offline, se envía ahora
      await sincronizarCola({ silencioso: true });

    } catch (error) {
      console.warn('[Fetch] No se pudo actualizar desde la API:', error.message);
      await refrescar();
      mostrarMensaje(
        'No se pudo actualizar desde la API (' + error.message + '). Se muestran los datos locales.',
        'aviso'
      );
    }
  }

  /* =====================================================================
     5. COLA DE SINCRONIZACIÓN (POST)
     ================================================================== */
  async function sincronizarAhora() {
    if (!estado.online) {
      mostrarMensaje('Sin conexión: no se puede sincronizar. Los registros quedan en la cola.', 'aviso');
      return;
    }
    await sincronizarCola();
  }

  async function sincronizarCola(opciones) {
    const silencioso = Boolean(opciones && opciones.silencioso);
    if (estado.sincronizando) return;
    if (!estado.online) return;

    estado.sincronizando = true;
    ui.btnGuardar.disabled = true;
    ui.btnSincronizar.disabled = true;

    try {
      const pendientes = await DB.listarPendientes();

      if (pendientes.length === 0) {
        if (!silencioso) {
          mostrarMensaje('No hay registros pendientes de sincronizar.', 'info');
        }
        return;
      }

      console.log(`[Sync] Iniciando sincronización de ${pendientes.length} registro(s)`);
      if (!silencioso) {
        mostrarMensaje('Sincronizando ' + pendientes.length + ' registro(s)…', 'info');
      }

      let enviados = 0;
      let fallo = null;

      for (const registro of pendientes) {
        try {
          // ---- Fetch API: POST ----
          const respuesta = await fetch(API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify(registro.datos)
          });

          if (!respuesta.ok) {
            throw new Error('HTTP ' + respuesta.status);
          }

          const creado = await respuesta.json();
          await DB.marcarSincronizado(registro.id, creado && creado.id ? creado.id : null);
          enviados++;
          console.log(`[Sync] Registro #${registro.id} sincronizado (serverId=${creado && creado.id})`);

        } catch (error) {
          // Falla => NO se borra nada, sigue "pending" para reintentar luego
          fallo = error;
          await DB.registrarIntentoFallido(registro.id, error.message);
          break; // no se insist con el resto
        }
      }

      await refrescar();

      if (fallo) {
        mostrarMensaje(
          'Sincronización incompleta: no se pudo enviar un registro (' + fallo.message +
          '). Se mantiene en "Pendiente de sincronización" para reintentarlo.',
          'aviso'
        );
      } else {
        console.log('[Sync] Sincronización completada: ' + enviados + ' registro(s)');
        mostrarMensaje(
          'Sincronización completada: ' + enviados + ' usuario(s) enviados a la API.',
          'exito'
        );
      }

    } catch (error) {
      console.error('[Sync] Error inesperado:', error);
      mostrarMensaje('Error durante la sincronización: ' + error.message, 'error');
    } finally {
      estado.sincronizando = false;
      ui.btnGuardar.disabled = false;
      ui.btnSincronizar.disabled = false;
    }
  }

  /* =====================================================================
     6. EVENTOS DE CONEXIÓN
     ================================================================== */
  async function alConectar() {
    console.log('[Red] Evento "online": vuelve la conexión');
    estado.online = true;
    pintarEstadoConexion();
    mostrarMensaje('Conexión recuperada - Sincronizando cola pendiente…', 'info');
    await sincronizarCola();
  }

  function alDesconectar() {
    console.log('[Red] Evento "offline": se perdió la conexión');
    estado.online = false;
    pintarEstadoConexion();
    mostrarMensaje('Sin conexión - Datos locales', 'aviso');
  }

  /* =====================================================================
     7. VALIDACIONES DEL FORMULARIO
     ================================================================== */
  const REGLAS = {
    nombre(valor) {
      if (!valor) return 'El nombre es obligatorio.';
      if (valor.length < 3) return 'El nombre debe tener al menos 3 caracteres.';
      return '';
    },
    usuario(valor) {
      if (!valor) return 'El usuario es obligatorio.';
      if (valor.length < 3) return 'El usuario debe tener al menos 3 caracteres.';
      return '';
    },
    correo(valor) {
      if (!valor) return 'El correo es obligatorio.';
      if (!REGEX_CORREO.test(valor)) return 'El correo no tiene un formato válido (ejemplo: ana@correo.com).';
      return '';
    },
    telefono(valor) {
      if (!valor) return 'El teléfono es obligatorio.';
      if (!/^\d+$/.test(valor)) return 'El teléfono solo puede contener dígitos.';
      if (valor.length !== LARGO_TELEFONO) {
        return 'El teléfono debe tener exactamente ' + LARGO_TELEFONO + ' dígitos.';
      }
      return '';
    }
  };

  // Marca visual + semántica (aria-invalid) y escribe el mensaje en su <p>
  function pintarError(nombreCampo, mensajeError) {
    const campo = ui.campos[nombreCampo];
    const parrafo = ui.errores[nombreCampo];

    if (mensajeError) {
      parrafo.textContent = mensajeError;
      campo.setAttribute('aria-invalid', 'true');
    } else {
      parrafo.textContent = '';
      campo.setAttribute('aria-invalid', 'false');
    }
  }

  function validarCampo(nombreCampo) {
    const mensaje = REGLAS[nombreCampo](ui.campos[nombreCampo].value);
    pintarError(nombreCampo, mensaje);
    return mensaje === '';
  }

  // Evento "input": se valida mientras el usuario escribe
  function validarEnVivo(evento) {
    const campo = evento.target;
    const nombre = campo.name;
    if (!nombre || !REGLAS[nombre]) return;

    // Solo se muestra el error si el campo ya fue marcado como inválido
    if (campo.getAttribute('aria-invalid') === 'true' || evento.target.value !== '') {
      validarCampo(nombre);
    }
  }

  function validarTodo() {
    const resultados = Object.keys(REGLAS).map(validarCampo);
    return resultados.every((ok) => ok);
  }

  function limpiarErrores() {
    Object.keys(REGLAS).forEach((nombre) => pintarError(nombre, ''));
  }

  function enfocarPrimerError() {
    const primero = Object.keys(REGLAS).find(
      (nombre) => ui.campos[nombre].getAttribute('aria-invalid') === 'true'
    );
    if (primero) ui.campos[primero].focus();
  }

  /* =====================================================================
     8. ENVÍO DEL FORMULARIO
     ================================================================== */
  async function enviarFormulario(evento) {
    evento.preventDefault(); // evita la recarga de la página

    if (!validarTodo()) {
      console.warn('[Formulario] Validación fallida');
      mostrarMensaje('Revisa los campos marcados en rojo.', 'error');
      enfocarPrimerError();
      return;
    }

    const datos = {
      nombre: ui.campos.nombre.value,
      usuario: ui.campos.usuario.value,
      correo: ui.campos.correo.value,
      telefono: ui.campos.telefono.value
    };

    ui.btnGuardar.disabled = true;

    try {
      // Se guarda en IndexedDB y se agrega a la cola "pending"
      await DB.crearUsuarioLocal(datos);
      console.log('[IndexedDB] Usuario guardado en modo local (pending)');

      ui.formulario.reset();
      limpiarErrores();
      await refrescar();

      if (estado.online) {
        await sincronizarCola({ silencioso: true });
      } else {
        mostrarMensaje(
          'Usuario guardado sin conexión. Quedó en la cola: "Pendiente de sincronización".',
          'aviso'
        );
      }

    } catch (error) {
      console.error('[IndexedDB] Error al guardar:', error);
      mostrarMensaje('No se pudo guardar el usuario: ' + error.message, 'error');
    } finally {
      ui.btnGuardar.disabled = false;
    }
  }

})();
