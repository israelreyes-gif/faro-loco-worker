import { json, error, madridNow, cicloActual, usuarioDesdePeticion } from './utils.js';
import { enviarAUsuario, enviarATodos } from './push.js';

const T_CUMPLE = 9 * 60;        // 09:00 -> avisos de cumpleaños
const T_RESET = 10 * 60;        // 10:00 -> vuelve a "apagado"
const T_GIRANDO = 21 * 60 + 50; // 21:50 -> empieza a girar el dado (visual)
const T_ELEGIDO = 21 * 60 + 55; // 21:55 -> se revela el elegido
const T_ESCRIBIENDO = 22 * 60;  // 22:00 -> se abre la hora para escribir
const T_CIERRE = 23 * 60;       // 23:00 -> se cierra la ventana

// ---------------------------------------------------------------
// GET /api/estado — llamado por el frontend cada pocos segundos
// Nota: nunca se envía el nombre del agraciado ni del autor del
// mensaje — el faro es anónimo. Solo se envía el número del dado.
// ---------------------------------------------------------------
export async function getEstado(request, env, origin) {
  const usuario = await usuarioDesdePeticion(request, env);
  if (!usuario) return error('No autenticado.', 401, origin);

  const ciclo = cicloActual();
  const hm = madridNow().minutesOfDay;

  const totalUsuarios = (await env.DB
    .prepare('SELECT COUNT(*) AS n FROM users').first())?.n ?? 0;

  const sorteo = await env.DB
    .prepare('SELECT * FROM sorteos WHERE fecha_ciclo = ?')
    .bind(ciclo).first();

  const mensajeRow = sorteo ? await env.DB
    .prepare('SELECT * FROM mensajes WHERE sorteo_id = ?')
    .bind(sorteo.id).first() : null;

  const fase = calcularFase(hm, sorteo, mensajeRow);

  const respuesta = { fase, totalUsuarios };

  if (sorteo) {
    respuesta.ganador = { id: sorteo.ganador_user_id };
    respuesta.numeroElegido = sorteo.numero_elegido;
  }
  if (mensajeRow) {
    respuesta.mensaje = {
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

  // 23:00 -> 10:00 del día siguiente (overnight)
  if (mensaje) return 'mensaje';
  if (sorteo) return 'sin_mensaje';
  return 'apagado';
}

// ---------------------------------------------------------------
// Tarea programada (cron cada 5 min) — ver src/index.js `scheduled`
// ---------------------------------------------------------------
export async function ejecutarTareaProgramada(env) {
  const hm = madridNow().minutesOfDay;
  const ciclo = cicloActual();

  if (hm === T_CUMPLE) await avisarCumpleanos(env);
  if (hm === T_GIRANDO) await avisarDadoGirando(env);
  if (hm === T_ELEGIDO) await elegirGanador(env, ciclo);
  if (hm === T_ESCRIBIENDO) await avisarInicioEscritura(env, ciclo);
  if (hm === T_CIERRE) await avisarSiSinMensaje(env, ciclo);
}

async function avisarCumpleanos(env) {
  const { month, day } = madridNow();
  const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const cumples = await env.DB
    .prepare(`SELECT nombre_completo FROM users WHERE substr(fecha_nacimiento, 6, 5) = ?`)
    .bind(mmdd).all();

  for (const persona of cumples.results) {
    await enviarATodos(env, {
      title: 'FARO',
      body: `Hoy es el cumpleaños de ${persona.nombre_completo}. 🎉`
    });
  }
}

async function avisarDadoGirando(env) {
  await enviarATodos(env, {
    title: 'FARO',
    body: 'El faro está eligiendo a alguien esta noche.'
  });
}

async function elegirGanador(env, ciclo) {
  const yaExiste = await env.DB
    .prepare('SELECT id FROM sorteos WHERE fecha_ciclo = ?').bind(ciclo).first();
  if (yaExiste) return;

  const usuarios = await env.DB.prepare('SELECT id FROM users ORDER BY id ASC').all();
  const ids = usuarios.results.map(u => u.id);
  if (ids.length === 0) return;

  const indice = randomIndex(ids.length); // aleatoriedad estricta, misma probabilidad para todos
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
  if (mensaje) return; // ya se difundió al enviarlo, ver src/mensajes.js

  await enviarATodos(env, {
    title: 'FARO',
    body: 'El faro se apagó esta noche sin dejar ningún mensaje.'
  });
}

// Rechaza valores que introducirían sesgo de módulo, para que cada
// usuario tenga exactamente la misma probabilidad de ser elegido.
function randomIndex(n) {
  const max = Math.floor(0xFFFFFFFF / n) * n;
  let x;
  do {
    x = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (x >= max);
  return x % n;
}
