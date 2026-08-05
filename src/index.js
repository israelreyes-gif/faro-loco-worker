import { corsHeaders, error } from './utils.js';
import { registrar, login } from './auth.js';
import { getEstado, ejecutarTareaProgramada } from './sorteo.js';
import { postMensaje } from './mensajes.js';
import { subscribirPush } from './push.js';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/api/register' && request.method === 'POST') {
        return await registrar(request, env, origin);
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        return await login(request, env, origin);
      }
      if (url.pathname === '/api/estado' && request.method === 'GET') {
        return await getEstado(request, env, origin);
      }
      if (url.pathname === '/api/mensaje' && request.method === 'POST') {
        return await postMensaje(request, env, origin);
      }
      if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
        return await subscribirPush(request, env, origin);
      }

      return error('No encontrado.', 404, origin);
    } catch (err) {
      console.error(err);
      return error('Error interno del faro.', 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(ejecutarTareaProgramada(env));
  }
};
