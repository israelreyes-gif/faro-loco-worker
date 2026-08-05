import { json, error, madridNow, cicloActual, usuarioDesdePeticion } from './utils.js';
import { enviarAUsuario, enviarATodos } from './push.js';

const T_RESET = 10 * 60;
const T_GIRANDO = 21 * 60 + 50;
const T_ELEGIDO = 21 * 60 + 55;
const T_ESCRIBIENDO = 22 * 60;
const T_CIERRE = 23 * 60;

export async function getEstado(request, env, origin) {
  const usuario = await usuarioDesdePeticion(request, env);
  if (!usuario) return error('No autenticado.', 401, origin);

  const ciclo = cicloActual();
  const hm = madridNow().minutesOfDay;

  const totalUsuarios = (await env.DB
    .prepare('SELECT COUNT(*) AS n FROM users').first())?.n ?? 0;

  const sorteo = await env.DB
    .prepare(`SELECT s.*, u.nombre_completo, u.rol_familiar
              FROM sorteos s JOIN users u ON u.id = s.ganador_user_id
              WHERE s.fecha_ciclo = ?`)
    .bind(ciclo).first();

  const mensajeRow = sorteo ? await env.DB
    .prepare(`SELECT m.*, u.nombre_completo, u.rol_familiar
              FROM mensajes m JOIN users u ON u.id = m.user_id
              WHERE m.sorteo_id = ?`)
    .bind(sorteo.id).first() : null;

  const fase = calcularFase(hm, sorteo, mensajeRow);

  const respuesta = { fase, totalUsuarios };

  if (sorteo) {
    respuesta.ganador = { id: sorteo.ganador_user_id, nombre: sorteo.nombre_completo, familia: sorteo.rol_familiar };
    respuesta.numeroElegido = sorteo.numero_elegido;
  }
  if (mensajeRow) {
    respuesta.mensaje = {
      nombre: mensajeRow.nombre_completo,
      familia: mensajeRow.rol_familiar,
      categoria: mensajeRow.categoria,
      texto: mensajeRow.texto
    };
  }
  if (fase === 'escribiendo') {
    respuesta.segundosRestantes = Math.max(0, (T_CIERRE - hm) * 60 - madridNow().second);
  }

  return json(respuesta, {}, origin);
}

function calcularFase(hm, sorteo, mensaje) {
  if (hm >= T_RESET && hm < T_GIRANDO) return 'apagado';
  if (hm >= T_GIRANDO && hm < T_ELEGIDO) return 'girando';
  if (hm >= T_ELEGIDO && hm < T_ESCRIBIENDO) return sorteo ? 'elegido' : 'girando';

  if (hm >= T_ESCRIBIENDO && hm < T_CIERRE) {
    if (mensaje) return 'mensaje';
    return sorteo ? 'escribiendo' : 'elegido';
  }

  if (mensaje) return 'mensaje';
  if (sorteo) return 'sin_mensaje';
  return 'apagado';
}

export async function ejecutarTareaProgramada(env) {
  const hm = madridNow().minutesOfDay;
  const ciclo = cicloActual();

  if (hm === T_ELEGIDO) await elegirGanador(env, ciclo);
  if (hm === T_ESCRIBIENDO) await avisarInicioEscritura(env, ciclo);
  if (hm === T_CIERRE) await avisarSiSinMensaje(env, ciclo);
}

async function elegirGanador(env, ciclo) {
  const yaExiste = await env.DB
    .prepare('SELECT id FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();
  if (yaExiste) return;

  const usuarios = await env.DB.prepare('SELECT id FROM users ORDER BY id ASC').all();
  const ids = usuarios.results.map(u => u.id);
  if (ids.length === 0) return;

  const indice = randomIndex(ids.length);
  const ganadorId = ids[indice];

  await env.DB.prepare(
    `INSERT OR IGNORE INTO sorteos (fecha_ciclo, ganador_user_id, numero_elegido, total_usuarios)
     VALUES (?, ?, ?, ?)`
  ).bind(ciclo, ganadorId, indice + 1, ids.length).run();

  await enviarAUsuario(env, ganadorId, {
    title: 'FARO',
    body: 'Esta noche, el faro te ha iluminado.'
  });
}

async function avisarInicioEscritura(env, ciclo) {
  const sorteo = await env.DB
    .prepare('SELECT ganador_user_id FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();
  if (!sorteo) return;

  await enviarAUsuario(env, sorteo.ganador_user_id, {
    title: 'FARO',
    body: 'Tienes 1 hora para escribir lo que quieras dejar esta noche.'
  });
}

async function avisarSiSinMensaje(env, ciclo) {
  const sorteo = await env.DB
    .prepare('SELECT id FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();
  if (!sorteo) return;

  const mensaje = await env.DB
    .prepare('SELECT id FROM mensajes WHERE sorteo_id = ?').bind(sorteo.id).first();
  if (mensaje) return;

  await enviarATodos(env, {
    title: 'FARO',
    body: 'El faro se apagó esta noche sin dejar ningún mensaje.'
  });
}

function randomIndex(n) {
  const max = Math.floor(0xFFFFFFFF / n) * n;
  let x;
  do {
    x = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (x >= max);
  return x % n;
}
