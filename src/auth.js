import { json, error, hashPassword, verifyPassword, firmarToken } from './utils.js';

export async function registrar(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const { username, password, password2, nombre, familia, fechaNacimiento } = body;

  if (!username || !password || !nombre) {
    return error('Rellena al menos usuario, contraseña y nombre.', 400, origin);
  }
  if (password !== password2) {
    return error('Las contraseñas no coinciden.', 400, origin);
  }
  if (fechaNacimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fechaNacimiento)) {
    return error('La fecha de nacimiento no es válida.', 400, origin);
  }

  const existente = await env.DB
    .prepare('SELECT id FROM users WHERE username = ?')
    .bind(username.toLowerCase())
    .first();

  if (existente) {
    return error('Ese usuario ya existe en el faro.', 409, origin);
  }

  const { hash, salt } = await hashPassword(password);

  await env.DB.prepare(
    `INSERT INTO users (username, password_hash, password_salt, nombre_completo, rol_familiar, fecha_nacimiento)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(username.toLowerCase(), hash, salt, nombre, familia || null, fechaNacimiento || null).run();

  return json({ ok: true }, { status: 201 }, origin);
}

export async function login(request, env, origin) {
  const { username, password } = await request.json().catch(() => ({}));
  if (!username || !password) {
    return error('Escribe tu usuario y tu contraseña.', 400, origin);
  }

  const user = await env.DB
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(username.toLowerCase())
    .first();

  if (!user) return error('Acceso incorrecto.', 401, origin);

  const valido = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!valido) return error('Acceso incorrecto.', 401, origin);

  const token = await firmarToken(
    { id: user.id, username: user.username, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );

  return json({
    token,
    user: { id: user.id, nombre: user.nombre_completo, familia: user.rol_familiar }
  }, {}, origin);
}
