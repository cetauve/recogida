/* /api/salud — para saber qué falta sin adivinar.
 *
 * Abierta a propósito, pero no enseña nada que valga: dice si cada pieza está
 * puesta (sí/no), nunca su valor. Los conteos solo con el código de lectura.
 *
 * Cuando algo no funcione, esta es la primera dirección que hay que abrir.
 */
const { db, puerta, puedeLeer, aTexto, aEntero, diaDeHoy } = require('./_lib');
const T = require('./_tiktok');

/* ===========================================================================
 * ?prendas=<ESTADO>&desde=<fecha> — QUE NUMERO ES DE QUE CUENTA.
 * ===========================================================================
 * EL FALLO DEL 26 AGO 2026. Las tarjetas de ese dia salieron con las 866
 * prendas bajo el mismo cartel: los tres productos del dia se aprendieron mal,
 * y como el panel vio "una sola cuenta" decidio que no hacia falta pintar el
 * rotulo. En el almacen tenian tres racks y ninguna forma de saber cual era
 * cual.
 *
 * El paso 2 solo lee lo PENDIENTE DE ENVIO, asi que en cuanto se imprime no
 * hay forma de volver a preguntar por esas prendas. Esto lee cualquier estado
 * —A LA ESPERA DE RECOGIDA, que es donde acaban— y devuelve, por prenda, su
 * numero y de que producto es. Con los productos ya fijados a mano, eso es el
 * rotulo bueno.
 *
 * Es una herramienta de rescate, no parte del flujo. Solo lee. */
const BUSCAR = '/order/202309/orders/search';

async function prendasPorCuenta(req) {
  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();
  const estado = (aTexto(q.prendas).trim() || 'AWAITING_COLLECTION').toUpperCase();
  const desde = (() => {
    const v = aTexto(q.desde).trim();
    if (!v) return 0;
    if (/^\d+$/.test(v)) return Number(v);
    const t = Date.parse(v.length <= 10 ? v + 'T00:00:00Z' : v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  })();

  const t0 = Date.now();
  const cuerpo = { order_status: estado };
  if (desde) cuerpo.create_time_ge = desde;

  const prendas = [];
  let token = '', vueltas = 0, corto = false;
  do {
    const params = { page_size: 50 };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, { camino: BUSCAR, metodo: 'POST', params, cuerpo });
    if (!r || r.code !== 0) return { error: aTexto(r && r.message).slice(0, 200), code: r && r.code };
    const d = r.data || {};
    for (const o of (d.orders || [])) {
      for (const l of (o.line_items || [])) {
        const num = Number(aTexto(l.seller_sku).replace(/\D+/g, ''));
        prendas.push({
          num: Number.isFinite(num) ? num : null,
          producto: aTexto(l.product_id),
          pedido: aTexto(o.id),
          creado: o.create_time ? Number(o.create_time) * 1000 : null
        });
      }
    }
    token = aTexto(d.next_page_token);
    vueltas++;
    if (Date.now() - t0 > 40000) { corto = true; break; }
  } while (token && vueltas < 40);

  /* El rotulo de cada producto, de lo ya guardado (incluido lo fijado a mano). */
  const D = require('./_directos');
  await D.asegurarTablas();
  const s = db();
  const ids = [...new Set(prendas.map((p) => p.producto).filter(Boolean))];
  const filas = ids.length
    ? await s`select producto, cuenta, directo from tiktok_productos where producto = any(${ids})`
    : [];
  const rotulo = new Map(filas.map((f) => [f.producto, f.cuenta]));

  /* Agrupado por cuenta, con los numeros ordenados: es lo que hace falta para
   * rehacer las tarjetas o para cantarlo en el almacen. */
  const porCuenta = {};
  for (const p of prendas) {
    const c = rotulo.get(p.producto) || ('(sin rotulo) ' + p.producto);
    const e = porCuenta[c] = porCuenta[c] || { prendas: 0, numeros: [] };
    e.prendas++;
    if (p.num != null) e.numeros.push(p.num);
  }
  for (const c of Object.keys(porCuenta)) porCuenta[c].numeros.sort((a, b) => a - b);

  return {
    estado, desde, vueltas, corto, ms: Date.now() - t0,
    total: prendas.length,
    productos: ids.map((id) => ({ producto: id, cuenta: rotulo.get(id) || '(sin rotulo)' })),
    porCuenta
  };
}

module.exports = puerta(async (req, res) => {
  const s = db();
  const hoy = diaDeHoy();

  if (aTexto((req.query || {}).prendas)) {
    if (!puedeLeer(req)) return res.status(401).json({ ok: false, error: 'sin-permiso' });
    const r = await prendasPorCuenta(req);
    return res.status(200).json({ ok: !r.error, ...r });
  }

  const estado = {
    ok: true,
    hoy,
    postgres: !!(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL),
    tokenDeEscritura: !!process.env.BILLYS_TOKEN,
    codigoDeLectura: !!process.env.BILLYS_CODIGO,
    tablas: []
  };

  const t = await s`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`;
  estado.tablas = t.map((x) => x.table_name);

  const faltan = ['directos', 'lotes', 'toques', 'tandas', 'tiempos', 'regalos']
    .filter((n) => !estado.tablas.includes(n));
  if (faltan.length) { estado.ok = false; estado.faltanTablas = faltan; }
  if (!estado.tokenDeEscritura) { estado.ok = false; estado.aviso = 'Sin BILLYS_TOKEN no se puede escribir nada.'; }
  if (!estado.codigoDeLectura) { estado.ok = false; estado.aviso2 = 'Sin BILLYS_CODIGO no se puede leer nada.'; }

  if (puedeLeer(req)) {
    const [d] = await s`select count(*)::int as n from directos`;
    const [l] = await s`select count(*)::int as n from lotes`;
    const [q] = await s`select count(*)::int as n from toques`;
    const [n] = await s`select count(*)::int as n from tandas`;
    const [m] = await s`select count(*)::int as n from tiempos`;
    const [g] = await s`select count(*)::int as n from regalos`;
    estado.filas = { directos: d.n, lotes: l.n, toques: q.n, tandas: n.n, tiempos: m.n, regalos: g.n };
  }

  return res.status(200).json(estado);
});
