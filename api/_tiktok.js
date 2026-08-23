/* Lo que hace falta para hablar con la API oficial de TikTok Shop.
 *
 * Aquí está lo aburrido y lo delicado: la firma de cada llamada, el cambio de
 * auth_code por access_token, el refresco antes de que caduque, y dónde se
 * guarda todo eso. Las puertas (/api/tiktok-auth, /api/tiktok-webhook y las
 * que vengan) solo usan lo de abajo y no vuelven a escribir nada de esto.
 *
 * LAS TRES DIRECCIONES, QUE NO SON LA MISMA Y CONFUNDEN:
 *
 *   auth.tiktok-shops.com          cambiar codigos por tokens
 *   open-api.tiktokglobalshop.com  todas las llamadas de verdad (no US)
 *   services.tiktokshop.com        la pagina donde el vendedor autoriza
 *
 * LA FIRMA (lo que rompe a todo el mundo la primera vez):
 *   1. coger los parametros de la direccion menos "sign" y "access_token"
 *   2. ordenarlos por nombre y pegarlos clave+valor, sin nada en medio
 *   3. poner delante el camino ("/order/202309/orders/search")
 *   4. pegar detras el cuerpo tal cual se manda, si lo hay
 *   5. envolver el resultado con el secreto por delante y por detras
 *   6. HMAC-SHA256 de eso con el secreto, en hexadecimal
 *
 * El paso 5 es el que nadie se espera: el secreto va DOS veces, una a cada
 * lado, ademas de ser la llave del HMAC.
 */
const crypto = require('crypto');
const { db } = require('./_lib');

const AUTH = 'https://auth.tiktok-shops.com';
const API = process.env.TIKTOK_API || 'https://open-api.tiktokglobalshop.com';

const appKey = () => process.env.TIKTOK_APP_KEY || '6l24ge9207cvd';
const appSecret = () => process.env.TIKTOK_APP_SECRET || '';

/* ------------------------------------------------------------------ tablas */

/* Una fila por tienda autorizada: billysvlc y billystourvlc son dos apps
 * distintas (una app de vendedor solo se puede atar a UNA tienda), asi que
 * cada una trae su propio app_key y sus propios tokens.
 *
 * El refresh_token dura mucho mas que el access_token, pero no para siempre:
 * si caduca hay que volver a pasar por la pagina de autorizacion a mano. Por
 * eso se guarda cuando caduca cada uno y /api/tiktok-auth?estado lo enseña. */
const ESQUEMA = [
  `create table if not exists tiktok_cuentas (
     cuenta        text primary key,
     app_key       text not null default '',
     tienda_id     text not null default '',
     tienda_cifra  text not null default '',
     tienda_nombre text not null default '',
     region        text not null default '',
     acceso        text not null default '',
     acceso_hasta  timestamptz,
     refresco      text not null default '',
     refresco_hasta timestamptz,
     abierto_id    text not null default '',
     actualizado   timestamptz not null default now()
   )`,
  /* Todo lo que TikTok nos empuja, tal cual llega. Sin interpretar nada: si
   * mañana cambian el formato de un aviso, el dato crudo sigue aqui y se
   * puede releer. La firma se comprueba al recibir y se apunta si cuadra. */
  `create table if not exists tiktok_eventos (
     id       bigserial primary key,
     tipo     text not null default '',
     tienda   text not null default '',
     datos    jsonb not null,
     firma_ok boolean not null default false,
     en       timestamptz not null default now()
   )`,
  `create index if not exists tiktok_eventos_en on tiktok_eventos (en desc)`
];

let creando = null;
function asegurarTablas() {
  if (creando) return creando;
  creando = (async () => {
    const s = db();
    for (const sentencia of ESQUEMA) await s.unsafe(sentencia);
  })().catch((e) => { creando = null; throw e; });
  return creando;
}

/* ------------------------------------------------------------------ firma */

function firmar(camino, params, cuerpo, secreto) {
  const claves = Object.keys(params || {})
    .filter((k) => k !== 'sign' && k !== 'access_token' && params[k] !== undefined && params[k] !== null)
    .sort();
  let base = camino;
  for (const k of claves) base += k + String(params[k]);
  if (cuerpo) base += cuerpo;
  base = secreto + base + secreto;
  return crypto.createHmac('sha256', secreto).update(base, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ llamar */

/* Una llamada firmada a la API. Devuelve el objeto entero de TikTok, no solo
 * data: el "code" y el "message" hacen falta para saber por que ha fallado,
 * y el request_id es lo primero que te pide su soporte. */
async function llamar({ camino, metodo = 'GET', params = {}, cuerpo = null, acceso = '', cifra = '' }) {
  const secreto = appSecret();
  if (!secreto) { const e = new Error('Falta TIKTOK_APP_SECRET en el proyecto'); e.falta = true; throw e; }

  const texto = cuerpo ? JSON.stringify(cuerpo) : '';
  const q = { ...params, app_key: appKey(), timestamp: Math.floor(Date.now() / 1000) };
  if (cifra) q.shop_cipher = cifra;
  q.sign = firmar(camino, q, texto, secreto);

  const direccion = API + camino + '?' + new URLSearchParams(q).toString();
  const cabeceras = { 'content-type': 'application/json' };
  if (acceso) cabeceras['x-tts-access-token'] = acceso;

  const r = await fetch(direccion, { method: metodo, headers: cabeceras, body: texto || undefined });
  const crudo = await r.text();
  let json = null;
  try { json = JSON.parse(crudo); } catch (e) { /* TikTok tambien devuelve HTML cuando algo va muy mal */ }
  if (!json) {
    const e = new Error('TikTok no ha devuelto JSON (' + r.status + '): ' + crudo.slice(0, 300));
    e.http = r.status;
    throw e;
  }
  return json;
}

/* ------------------------------------------------------------------ tokens */

const enSegundos = (s) => (s ? new Date(Date.now() + Number(s) * 1000) : null);

async function pedirToken(codigo) {
  const q = new URLSearchParams({
    app_key: appKey(),
    app_secret: appSecret(),
    auth_code: String(codigo),
    grant_type: 'authorized_code'
  });
  const r = await fetch(AUTH + '/api/v2/token/get?' + q.toString());
  return r.json();
}

async function refrescarToken(refresco) {
  const q = new URLSearchParams({
    app_key: appKey(),
    app_secret: appSecret(),
    refresh_token: String(refresco),
    grant_type: 'refresh_token'
  });
  const r = await fetch(AUTH + '/api/v2/token/refresh?' + q.toString());
  return r.json();
}

/* Las tiendas que ese token puede tocar. De aqui sale el shop_cipher, que es
 * obligatorio en casi todas las demas llamadas y que no se puede inventar. */
async function tiendasDe(acceso) {
  return llamar({ camino: '/authorization/202309/shops', acceso });
}

async function guardar(cuenta, datos) {
  await asegurarTablas();
  const s = db();
  const x = {
    app_key: appKey(),
    tienda_id: '', tienda_cifra: '', tienda_nombre: '', region: '',
    abierto_id: '', acceso: '', refresco: '',
    acceso_hasta: null, refresco_hasta: null,
    ...datos
  };
  await s`
    insert into tiktok_cuentas (cuenta, app_key, tienda_id, tienda_cifra, tienda_nombre,
                                region, acceso, acceso_hasta, refresco, refresco_hasta,
                                abierto_id, actualizado)
    values (${cuenta}, ${x.app_key}, ${x.tienda_id}, ${x.tienda_cifra}, ${x.tienda_nombre},
            ${x.region}, ${x.acceso}, ${x.acceso_hasta}, ${x.refresco}, ${x.refresco_hasta},
            ${x.abierto_id}, now())
    on conflict (cuenta) do update set
      app_key = excluded.app_key,
      tienda_id = excluded.tienda_id,
      tienda_cifra = excluded.tienda_cifra,
      tienda_nombre = excluded.tienda_nombre,
      region = excluded.region,
      acceso = excluded.acceso,
      acceso_hasta = excluded.acceso_hasta,
      refresco = excluded.refresco,
      refresco_hasta = excluded.refresco_hasta,
      abierto_id = excluded.abierto_id,
      actualizado = now()`;
}

async function cuentas() {
  await asegurarTablas();
  const s = db();
  return s`select * from tiktok_cuentas order by cuenta`;
}

/* El token bueno de una cuenta, refrescandolo si le quedan menos de diez
 * minutos. Se refresca ANTES de que caduque y no despues de un 401: si se
 * espera al fallo, el fallo llega justo en mitad del paso 3, con el almacen
 * esperando etiquetas. */
const MARGEN_MS = 10 * 60000;

async function accesoDe(cuenta) {
  await asegurarTablas();
  const s = db();
  const filas = await s`select * from tiktok_cuentas where cuenta = ${cuenta}`;
  if (!filas.length) { const e = new Error('La cuenta ' + cuenta + ' no esta autorizada todavia'); e.sinAutorizar = true; throw e; }
  const f = filas[0];

  const queda = f.acceso_hasta ? new Date(f.acceso_hasta).getTime() - Date.now() : -1;
  if (f.acceso && queda > MARGEN_MS) return { acceso: f.acceso, cifra: f.tienda_cifra, fila: f };

  if (!f.refresco) { const e = new Error('Sin refresh_token para ' + cuenta + ': hay que volver a autorizar'); e.sinAutorizar = true; throw e; }
  const nuevo = await refrescarToken(f.refresco);
  const d = (nuevo && nuevo.data) || {};
  if (!d.access_token) {
    const e = new Error('No se ha podido refrescar el token de ' + cuenta + ': ' + JSON.stringify(nuevo).slice(0, 300));
    e.sinAutorizar = true;
    throw e;
  }
  await guardar(cuenta, {
    tienda_id: f.tienda_id, tienda_cifra: f.tienda_cifra, tienda_nombre: f.tienda_nombre,
    region: f.region, abierto_id: f.abierto_id,
    acceso: d.access_token,
    acceso_hasta: enSegundos(d.access_token_expire_in),
    refresco: d.refresh_token || f.refresco,
    refresco_hasta: enSegundos(d.refresh_token_expire_in)
  });
  return { acceso: d.access_token, cifra: f.tienda_cifra, fila: f };
}

/* Lo que usaran los pasos 2, 3 y 4: pide por cuenta y ya va firmado, con
 * token fresco y con el shop_cipher puesto. */
async function comoCuenta(cuenta, opciones) {
  const { acceso, cifra } = await accesoDe(cuenta);
  return llamar({ ...opciones, acceso, cifra: opciones.cifra === false ? '' : cifra });
}

/* --------------------------------------------------------- firma del aviso */

/* TikTok firma cada aviso del webhook con HMAC-SHA256 de (app_key + cuerpo),
 * usando el secreto como llave, y lo manda en la cabecera Authorization. */
function firmaAvisoVale(cuerpoCrudo, cabecera) {
  const secreto = appSecret();
  if (!secreto || !cabecera) return false;
  const mia = crypto.createHmac('sha256', secreto)
    .update(appKey() + String(cuerpoCrudo), 'utf8').digest('hex');
  const dada = String(cabecera).replace(/^Bearer\s+/i, '').trim();
  if (dada.length !== mia.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mia), Buffer.from(dada));
}

module.exports = {
  AUTH, API, appKey, appSecret, asegurarTablas,
  firmar, llamar, pedirToken, refrescarToken, tiendasDe,
  guardar, cuentas, accesoDe, comoCuenta, firmaAvisoVale
};
