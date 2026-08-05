import { buildPushHTTPRequest } from '@pushforge/builder';
import { json, error, usuarioDesdePeticion } from './utils.js';

export async function subscribirPush(request, env, origin) {
  const usuario = await usuarioDesdePeticion(request, env);
  if (!usuario) return error('No autenticado.', 401, origin);

  const sub = await request.json().catch(() => ({}));
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return error('Suscripción push incompleta.', 400, origin);
  }

  await env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`
  ).bind(usuario.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth).run();

  return json({ ok: true }, { status: 201 }, origin);
}

export async function enviarAUsuario(env, userId, payload) {
  const subs = await env.DB
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').bind(userId).all();
  await Promise.all(subs.results.map(sub => enviarPush(env, sub, payload)));
}

export async function enviarATodos(env, payload) {
  const subs = await env.DB.prepare('SELECT * FROM push_subscriptions').all();
  await Promise.all(subs.results.map(sub => enviarPush(env, sub, payload)));
}

async function enviarPush(env, sub, payload) {
  try {
    const { endpoint, headers, body } = await buildPushHTTPRequest({
      privateJWK: JSON.parse(env.VAPID_PRIVATE_KEY),
      subscription: {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      },
      message: {
        payload,
        adminContact: env.VAPID_SUBJECT
      }
    });

    const res = await fetch(endpoint, { method: 'POST', headers, body });

    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
        .bind(sub.endpoint).run();
    }
  } catch (err) {
    console.error('Error enviando push:', err);
  }
}
