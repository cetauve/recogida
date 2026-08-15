/* Lo que comparten las cuatro puertas de la API.
 *
 * Aquí está la conexión con Postgres (Supabase), el esquema, quién puede
 * escribir y quién puede leer, y las cuatro o cinco ayudas que si no habría
 * que copiar en cada archivo.
 *
 * DOS LLAVES, Y HACEN COSAS DISTINTAS:
 *
 *   BILLYS_TOKEN    escribir.  Solo la extensión lo tiene. Va en una cabecera,
 *                   nunca en la dirección, para que no acabe en un historial
 *                   ni en un WhatsApp.
 *   BILLYS_CODIGO   leer.      Va en la dirección que se guarda el equipo:
 *                   /recogida?d=xxxx. Sin él, la API no devuelve nada.
 *
 * Si falta cualquiera de las dos en Vercel, la puerta se cierra: preferimos
 * que no funcione a que quede abierta. /api/salud lo dice claramente.
 */
const postgres = require('postgres');
const crypto = require('crypto');

/* ------------------------------------------------------------------ base */

let sql = null;
function db() {
  if (sql) return sql;
  const url = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL ||
              process.env.POSTGRES_URL_NON_POOLING;
  if (!url) { const e = new Error('No hay POSTGRES_URL en el proyecto'); e.falta = true; throw e; }
  /* prepare:false es obligatorio: la conexión de Supabase pasa por pgbouncer
   * en modo transacción y ahí las sentencias preparadas no sobreviven.
   * max:1 porque cada lambda es un proceso suyo y no queremos abrir de más. */
  sql = postgres(url, {
    /* Supabase exige SSL; el Postgres de las pruebas, en esta misma máquina,
     * no lo tiene. Se decide por la dirección para no tener dos ramas de
     * configuración que se puedan desincronizar. */
    ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : 'require',
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15
  });
  return sql;
}

/* El esquema, una sentencia por elemento. Todas son "si no existe", así que
 * esto se puede correr en cada arranque sin miedo y sin migraciones. */
const ESQUEMA = [
  `create table if not exists directos (
     id           text primary key,
     dia          date not null,
     cuenta       text not null default '',
     empezo       timestamptz,
     acabo        timestamptz,
     lote_actual  integer,
     lote_en      timestamptz,
     actualizado  timestamptz not null default now()
   )`,
  `create index if not exists directos_dia on directos (dia)`,

  /* Una fila por prenda vendida. La clave lleva la cuenta porque billysvlc y
   * billystourvlc repiten los números: el 47 existe en las dos. */
  `create table if not exists lotes (
     directo    text not null,
     cuenta     text not null default '',
     num        integer not null,
     dia        date not null,
     vendida_en timestamptz,
     precio     numeric,
     sku        text,
     titulo     text,
     parado     boolean not null default false,
     comprador  text,
     primary key (directo, cuenta, num)
   )`,
  `create index if not exists lotes_dia on lotes (dia)`,
  /* Una prenda leída EN VIVO del panel del directo. Ahí solo se conoce el
   * productId, no el nombre de la cuenta, así que la fila es provisional:
   * sirve para ver el cruce mientras el directo está en marcha y la sustituye
   * la definitiva cuando se hace la lectura del paso 2. */
  `alter table lotes add column if not exists provisional boolean not null default false`,
  `create index if not exists lotes_vendida on lotes (vendida_en)`,

  /* Lo que marcan las vendedoras. El lote va sellado en el toque: el servidor
   * le dijo a la tablet por qué prenda iba el directo en ese momento, así que
   * el cruce deja de ser una estimación. */
  `create table if not exists toques (
     id        bigserial primary key,
     dia       date not null,
     directo   text not null default '',
     vendedora text not null,
     en        timestamptz not null,
     lote      integer,
     cuenta    text not null default '',
     sesion    text not null default '',
     categoria text not null default '',
     unique (dia, vendedora, en)
   )`,
  `create index if not exists toques_dia on toques (dia, vendedora)`,
  /* La app de la vendedora manda qué categoría pulsó desde el primer día y
   * hasta hoy se tiraba. Sin ella no se puede saber qué vende cada una. */
  `alter table toques add column if not exists categoria text not null default ''`,

  /* EL TURNO DE CADA VENDEDORA · de qué hora a qué hora estuvo.
   *
   * Empieza a contar cuando pone su nombre y entra a la rejilla, NO en su
   * primer toque. Si se midiera por los toques, las horas de quien menos vende
   * saldrían más cortas y su €/hora inflado.
   *
   * La clave lleva la hora de entrada para que una misma persona pueda hacer
   * dos turnos el mismo día (mañana y tarde) sin pisarse, y para que reenviar
   * el mismo turno no cree uno nuevo. */
  `create table if not exists turnos (
     dia         date not null,
     vendedora   text not null,
     empezo      timestamptz not null,
     acabo       timestamptz,
     lote_inicio integer,
     lote_fin    integer,
     directo     text not null default '',
     actualizado timestamptz not null default now(),
     primary key (dia, vendedora, empezo)
   )`,
  /* DESDE QUE CUENTA EMITE ESE TURNO. billysvlc o billystourvlc.
   * La tablet lo pregunta una vez al empezar el directo. Sin esto, un toque
   * dado durante un directo de la cuenta tour se cruzaba por hora con una
   * prenda de la otra cuenta, que es justo lo que no puede pasar. */
  `alter table turnos add column if not exists cuenta text not null default ''`,
  `create index if not exists turnos_dia on turnos (dia)`,

  /* LA COLA DE EMPAQUETADO.
   *
   * Un solo recogedor va dejando paquetes aquí según los desliza, y varios
   * empaquetadores piden "el siguiente" desde sus móviles. El reparto se hace
   * con FOR UPDATE SKIP LOCKED, que es lo único que garantiza que a dos
   * móviles no les toque el mismo paquete aunque pulsen en el mismo instante.
   *
   * La ficha entera se guarda aquí dentro (jsonb) porque el empaquetador entra
   * por un enlace que no sabe nada de tandas: pide un paquete y tiene que
   * recibir TODO lo que necesita para hacerlo, sin buscarlo en ningún sitio. */
  `create table if not exists cola (
     dia          date not null,
     pedido       text not null,
     numero       integer,
     apodo        text not null default '',
     tanda        text not null default '',
     prendas      integer,
     ficha        jsonb not null,
     estado       text not null default 'espera',
     quien_abrio  text not null default '',
     abierto_en   timestamptz not null,
     quien_cierra text not null default '',
     tomado_en    timestamptz,
     cerrado_en   timestamptz,
     primary key (dia, pedido)
   )`,
  `create index if not exists cola_espera on cola (dia, estado, numero)`,

  /* QUIÉN ESTÁ HACIENDO CADA TANDA.
   *
   * Con dos personas recogiendo, nada impedía que las dos abrieran la misma
   * tanda y recogieran las mismas prendas. Repartir de una en una lo
   * arreglaría pero las haría lentas: quien recoge necesita ver la tanda
   * entera para hacer UNA barrida del perchero en orden de número.
   *
   * Así que se reparte por tandas, no por paquetes: la primera que entra se
   * la queda, y a la otra le sale marcada con quién la está haciendo y por
   * dónde va. Se puede entrar igual si hace falta —a veces alguien se va—,
   * pero preguntando primero. */
  `create table if not exists tandas_toma (
     dia         date not null,
     tanda       text not null,
     quien       text not null default '',
     hechos      integer not null default 0,
     total       integer,
     actualizado timestamptz not null default now(),
     primary key (dia, tanda)
   )`,

  /* Lo calculado para el almacén: el mismo objeto que hasta hoy viajaba
   * detrás de la almohadilla del enlace. Una fila por día; la extensión
   * recalcula todo y lo vuelve a mandar entero. */
  `create table if not exists tandas (
     dia      date primary key,
     directo  text not null default '',
     titulo   text,
     datos    jsonb not null,
     generado timestamptz not null default now()
   )`,

  /* Cada "Listo" de quien recoge y de quien empaqueta. */
  `create table if not exists tiempos (
     id     bigserial primary key,
     dia    date not null,
     quien  text not null,
     modo   text not null default '',
     equipo text not null default '',
     pedido text not null default '',
     apodo  text,
     prendas integer,
     en     timestamptz not null,
     estado text not null default 'listo',
     unique (dia, quien, pedido, estado)
   )`,
  `create index if not exists tiempos_dia on tiempos (dia, quien)`,
  /* La base de producción se creó sin esta columna y el "create" de arriba ya
   * no se vuelve a ejecutar sobre una base que existe. Sin el alter, /tiempos
   * seguiría enseñando la columna de prendas vacía para siempre. */
  `alter table tiempos add column if not exists prendas integer`,

  /* Quién ganó qué. Viaja a las tarjetas de recogida para que quien empaqueta
   * meta el detalle en ese paquete. */
  `create table if not exists regalos (
     id      bigserial primary key,
     dia     date not null,
     directo text not null default '',
     tier    text not null,
     usuario text,
     num     integer,
     en      timestamptz not null,
     unique (dia, tier, en)
   )`,
  `create index if not exists regalos_dia on regalos (dia)`
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

/* ------------------------------------------------------------------ llaves */

function iguales(a, b) {
  /* Comparar hashes y no los textos: así tardar más o menos no dice nada
   * sobre cuántas letras se acertaron. */
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function puedeEscribir(req) {
  const esperado = process.env.BILLYS_TOKEN;
  if (!esperado) return false;
  const cab = req.headers['x-billys-token'];
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const dado = String(cab || auth || '');
  return dado.length > 0 && iguales(dado, esperado);
}

function puedeLeer(req) {
  if (puedeEscribir(req)) return true;          // la extensión también lee
  const esperado = process.env.BILLYS_CODIGO;
  if (!esperado) return false;
  const q = req.query || {};
  const dado = String(q.d || q.codigo || req.headers['x-billys-codigo'] || '');
  return dado.length > 0 && iguales(dado, esperado);
}

/* ------------------------------------------------------------------ ayudas */

/* El día del negocio, en hora de Valencia. Un directo que acaba a la una de la
 * mañana sigue siendo del día anterior para quien empaqueta, pero eso lo
 * decide quien manda los datos: aquí solo damos el de hoy por defecto. */
function diaDeHoy(cuando) {
  const d = cuando ? new Date(cuando) : new Date();
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(d);
}
function diaDe(v) {
  if (!v) return diaDeHoy();
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? diaDeHoy() : diaDeHoy(d);
}

const aFecha = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
const aEntero = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
const aNumero = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
const aTexto = (v) => (v === undefined || v === null ? '' : String(v));

function cuerpo(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

/* Envuelve una puerta: cabeceras, OPTIONS, tablas y errores en un solo sitio.
 * Que un fallo de la base no devuelva una página de Vercel sino un JSON que
 * la app pueda enseñar. */
function puerta(manejar) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Billys-Token,X-Billys-Codigo,Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    try {
      await asegurarTablas();
      await manejar(req, res);
    } catch (e) {
      const falta = e && e.falta;
      res.status(falta ? 503 : 500).json({
        ok: false,
        error: falta ? 'sin-base-de-datos' : 'fallo',
        detalle: String((e && e.message) || e)
      });
    }
  };
}

const noAutorizado = (res, quiere) => res.status(401).json({
  ok: false,
  error: 'sin-permiso',
  detalle: quiere === 'escribir'
    ? 'Falta la cabecera X-Billys-Token, o no coincide con BILLYS_TOKEN.'
    : 'Falta el codigo de lectura (?d=...), o no coincide con BILLYS_CODIGO.'
});

module.exports = {
  db, asegurarTablas, puerta, puedeEscribir, puedeLeer, noAutorizado,
  diaDeHoy, diaDe, aFecha, aEntero, aNumero, aTexto, cuerpo
};
