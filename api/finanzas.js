/* /api/finanzas — el dinero de cada prenda vendida con tablet. SOLO AARON.
 *
 * 29 sep 2026. Cruza dos cosas que hasta hoy vivian separadas:
 *   - lo que apunta el ordenador del directo (tabla directo_vivo): cada venta
 *     con su pedido, anuncio (prenda y marca), precio de remate, hora y ficha;
 *   - lo que TikTok dice que paga por cada pedido (API de finanzas): venta,
 *     comision, envio, ajustes y lo que se liquida de verdad. Si el pedido aun
 *     no se ha liquidado, la estimacion que da TikTok.
 *
 * No toca tandas.js ni _lib.js (aviso del 26 sep). Solo LEE directo_vivo. Lo
 * que escribe va a sus dos tablas propias (fin_mov y fin_estado), que no usa
 * nadie mas.
 *
 * LA LLAVE. No vale el codigo del almacen: esto son las cuentas del negocio.
 * Va con ?f=CODIGO, y aqui solo se guarda la huella del codigo, no el codigo,
 * porque el repositorio es publico.
 *
 * COMO SE LLENA. TikTok contesta despacio y en paginas, asi que la pantalla
 * pide el trabajo a trozos, cada trozo de menos de 8 segundos:
 *   ?accion=liquidaciones&pais=es     lista de liquidaciones desde el 28 sep
 *   ?accion=liquidacion&pais=es&id=X  los movimientos de una liquidacion
 *   ?accion=pendientes&pais=es        lo que aun no se ha liquidado (estimado)
 *   ?accion=datos&desde=AAAA-MM-DD&hasta=AAAA-MM-DD   el cruce, ya hecho
 *   ?accion=muestra&pais=es           un movimiento de cada tipo, crudo, para
 *                                     comprobar los nombres de los campos
 *
 * NO SE DEVUELVEN NUMEROS DE PEDIDO ni nada del comprador. Solo importes.
 */
const crypto = require('crypto');
const { db, puerta, aTexto } = require('./_lib');
const T = require('./_tiktok');

const HUELLA = '5e6b779d054291a12ba58ace81ca620a1223c0f595f5209af6df1855c7a77830';
function esAaron(req) {
  const q = req.query || {};
  const dado = String(q.f || req.headers['x-billys-finanzas'] || '');
  if (!dado) return false;
  const h = crypto.createHash('sha256').update(dado).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(HUELLA));
}

const TIENDAS = { es: 'billysvlc', de: 'billys_de', nl: 'billys_nl' };
const PAIS_DE_CANAL = { bv: 'es', bto: 'es', bta: 'es', de: 'de', nl: 'nl' };
const DESDE_MIN = '2026-09-28';                  /* primer dia con tablets */
const LIMITE_MS = 5000;   /* cada llamada termina bien antes de los 10 s */

/* ------------------------------------------------------------------ tablas */

let hechas = false;
async function tablas(s) {
  if (hechas) return;
  await s.unsafe(`create table if not exists fin_mov (
    id text primary key,
    pais text not null,
    pedido text not null default '',
    tipo text not null default '',
    liquidado boolean not null default false,
    liquidacion text not null default '',
    liquidacion_en timestamptz,
    pedido_en timestamptz,
    ingreso numeric not null default 0,
    comision numeric not null default 0,
    envio numeric not null default 0,
    ajuste numeric not null default 0,
    neto numeric not null default 0,
    detalle jsonb not null default '{}'::jsonb,
    visto timestamptz not null default now()
  )`);
  await s.unsafe(`create index if not exists fin_mov_pedido on fin_mov (pedido)`);
  await s.unsafe(`create table if not exists fin_estado (
    clave text primary key,
    valor jsonb not null default '{}'::jsonb,
    en timestamptz not null default now()
  )`);
  hechas = true;
}

async function leerEstado(s, clave) {
  const f = await s`select valor from fin_estado where clave = ${clave}`;
  return (f[0] && f[0].valor) || {};
}
async function ponerEstado(s, clave, valor) {
  await s`insert into fin_estado (clave, valor, en) values (${clave}, ${s.json(valor)}, now())
          on conflict (clave) do update set valor = excluded.valor, en = now()`;
}

/* ------------------------------------------------------------------ ayudas */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const primero = (o, claves) => { for (const k of claves) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
const aFecha = (seg) => { const n = Number(seg); return n > 0 ? new Date(n * 1000) : null; };
const epoch = (dia) => Math.floor(new Date(dia + 'T00:00:00+02:00').getTime() / 1000);

/* La lista viene con un nombre distinto en cada consulta. Se coge la primera
 * lista que haya en data en vez de adivinar el nombre. */
function laLista(data) {
  if (!data || typeof data !== 'object') return [];
  for (const k of ['statement_transactions', 'transactions', 'statements', 'order_transactions']) {
    if (Array.isArray(data[k])) return data[k];
  }
  for (const k of Object.keys(data)) if (Array.isArray(data[k])) return data[k];
  return [];
}

/* Solo lo que no es cero de los desgloses: con eso se explica cada euro sin
 * guardar cien campos vacios por pedido. */
function desglose(tx) {
  const d = {};
  const mirar = (o, pre) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) { mirar(v, pre); continue; }
      if (!/_amount$/.test(k)) continue;
      const n = num(v);
      if (n) d[k.replace(/_amount$/, '')] = n;
    }
  };
  for (const k of Object.keys(tx || {})) if (/_breakdown$/.test(k)) mirar(tx[k]);
  return d;
}

function aFila(tx, pais, liquidado, liq) {
  const pedido = aTexto(primero(tx, ['order_id', 'adjustment_order_id']));
  const idTx = aTexto(primero(tx, ['id', 'adjustment_id', 'order_id']));
  const id = liquidado ? 'l:' + liq.id + ':' + idTx : 'p:' + pais + ':' + idTx;
  return {
    id,
    pais,
    pedido,
    tipo: aTexto(primero(tx, ['type', 'transaction_type']) || (tx.adjustment_id ? 'ADJUSTMENT' : 'ORDER')),
    liquidado,
    liquidacion: liquidado ? aTexto(liq.id) : '',
    liquidacion_en: liquidado ? liq.en : null,
    pedido_en: aFecha(tx.order_create_time),
    ingreso: num(primero(tx, ['revenue_amount', 'est_revenue_amount'])),
    comision: num(primero(tx, ['fee_tax_amount', 'est_fee_tax_amount', 'est_fee_amount', 'fee_amount'])),
    envio: num(primero(tx, ['shipping_cost_amount', 'est_shipping_cost_amount'])),
    ajuste: num(primero(tx, ['adjustment_amount', 'est_adjustment_amount'])),
    neto: num(primero(tx, ['settlement_amount', 'est_settlement_amount'])),
    detalle: desglose(tx)
  };
}

const COLS = ['id', 'pais', 'pedido', 'tipo', 'liquidado', 'liquidacion', 'liquidacion_en', 'pedido_en',
  'ingreso', 'comision', 'envio', 'ajuste', 'neto', 'detalle', 'visto'];

async function guardar(s, filas) {
  if (!filas.length) return 0;
  const unicas = Object.values(Object.fromEntries(filas.map((f) => [f.id, f])));
  const ahora = new Date();
  const listas = unicas.map((f) => ({ ...f, detalle: s.json(f.detalle), visto: ahora }));
  for (let i = 0; i < listas.length; i += 200) {
    await s`insert into fin_mov ${s(listas.slice(i, i + 200), ...COLS)}
      on conflict (id) do update set
        pedido = excluded.pedido, tipo = excluded.tipo, liquidado = excluded.liquidado,
        liquidacion = excluded.liquidacion, liquidacion_en = excluded.liquidacion_en,
        pedido_en = excluded.pedido_en, ingreso = excluded.ingreso, comision = excluded.comision,
        envio = excluded.envio, ajuste = excluded.ajuste, neto = excluded.neto,
        detalle = excluded.detalle, visto = excluded.visto`;
  }
  return unicas.length;
}

function falloTikTok(res, r) {
  return res.status(200).json({ ok: false, error: 'tiktok',
    code: r && r.code, message: r && r.message, request_id: r && r.request_id });
}

/* ------------------------------------------------------------ liquidaciones */

async function liquidaciones(s, res, pais) {
  const cuenta = TIENDAS[pais];
  const lista = [];
  let token = '';
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const params = { sort_field: 'statement_time', sort_order: 'DESC', page_size: 100,
      statement_time_ge: epoch(DESDE_MIN) };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, { camino: '/finance/202309/statements', params });
    if (!r || r.code !== 0) return falloTikTok(res, r);
    for (const x of laLista(r.data)) lista.push(x);
    token = aTexto(r.data && r.data.next_page_token);
    if (!token) break;
  }
  const est = await leerEstado(s, 'liq:' + pais);
  const hechasYa = new Set(est.hechas || []);
  return res.status(200).json({ ok: true, pais, liquidaciones: lista.map((x) => ({
    id: aTexto(x.id),
    en: aFecha(x.statement_time),
    neto: num(x.settlement_amount),
    ingreso: num(x.revenue_amount),
    estado: aTexto(x.payment_status),
    hecha: hechasYa.has(aTexto(x.id))
  })) });
}

async function liquidacion(s, res, pais, id, tokenDado, t0, q = {}) {
  if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: 'id-raro' });
  const cuenta = TIENDAS[pais];
  const liq = { id, en: null };
  /* La fecha de la liquidacion no viene en cada movimiento: la pantalla la
   * manda (la saco de la lista) y si no, se deja vacia. */
  if (q.en) { const d = new Date(q.en); if (!isNaN(d)) liq.en = d; }
  let token = tokenDado, guardadas = 0;
  while (Date.now() - t0 < LIMITE_MS) {
    const params = { sort_field: 'order_create_time', sort_order: 'ASC', page_size: 100 };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, { camino: '/finance/202501/statements/' + id + '/statement_transactions', params });
    if (!r || r.code !== 0) return falloTikTok(res, r);
    const filas = laLista(r.data).map((tx) => aFila(tx, pais, true, liq));
    guardadas += await guardar(s, filas);
    token = aTexto(r.data && r.data.next_page_token);
    if (!token) break;
  }
  if (!token) {
    const est = await leerEstado(s, 'liq:' + pais);
    const lista = new Set(est.hechas || []);
    lista.add(id);
    await ponerEstado(s, 'liq:' + pais, { ...est, hechas: [...lista] });
  }
  return res.status(200).json({ ok: true, pais, id, guardadas, sigue: !!token, token });
}

/* -------------------------------------------------------------- pendientes */

/* Lo no liquidado se recorre entero de mas nuevo a mas viejo, y se para al
 * llegar a pedidos de antes del 28 sep. Al terminar una pasada completa se
 * apunta cuando empezo: todo lo pendiente que no se haya vuelto a ver desde
 * entonces ya no esta pendiente (se liquido, se cancelo o se devolvio). */
async function pendientes(s, res, pais, tokenDado, inicioDado, t0) {
  const cuenta = TIENDAS[pais];
  const inicio = inicioDado || new Date().toISOString();
  const tope = epoch(DESDE_MIN) - 2 * 86400;
  let token = tokenDado, guardadas = 0, fin = false;
  while (Date.now() - t0 < LIMITE_MS) {
    const params = { sort_field: 'order_create_time', sort_order: 'DESC', page_size: 100 };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, { camino: '/finance/202507/orders/unsettled', params });
    if (!r || r.code !== 0) return falloTikTok(res, r);
    const txs = laLista(r.data);
    const nuevas = txs.filter((tx) => !(Number(tx.order_create_time) > 0) || Number(tx.order_create_time) >= tope);
    guardadas += await guardar(s, nuevas.map((tx) => aFila(tx, pais, false)));
    token = aTexto(r.data && r.data.next_page_token);
    const masViejo = Math.min(...txs.map((tx) => Number(tx.order_create_time) || Infinity));
    if (!token || !txs.length || masViejo < tope) { fin = true; break; }
  }
  if (fin) await ponerEstado(s, 'pend:' + pais, { completo: inicio });
  return res.status(200).json({ ok: true, pais, guardadas, sigue: !fin, token: fin ? '' : token, inicio });
}

/* ------------------------------------------------------------------ cruce */

const aEuros = (x) => {
  const t = String(x == null ? '' : x).replace(/[^0-9,.\-]/g, '');
  if (!t) return 0;
  const n = /,\d{1,2}$/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const diaMadrid = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const r2 = (n) => Math.round(n * 100) / 100;

async function datos(s, res, desde, hasta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return res.status(400).json({ ok: false, error: 'fechas-raras' });
  }
  if (desde < DESDE_MIN) desde = DESDE_MIN;

  const ventasCrudas = await s`
    select d.sesion as sesion, d.estado->>'canal' as canal,
           v->>'pedido' as pedido, v->>'nombre' as nombre, v->>'precio' as precio,
           v->>'hora' as hora, v->>'ficha' as ficha
      from directo_vivo d,
           lateral jsonb_array_elements(
             case when jsonb_typeof(d.estado->'ventas') = 'array'
                  then d.estado->'ventas' else '[]'::jsonb end) v
     where d.cuando >= ${desde}::date - interval '1 day'`;

  const ventas = [];
  for (const v of ventasCrudas) {
    const ms = Number(v.hora);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const dia = diaMadrid(ms);
    if (dia < desde || dia > hasta) continue;
    const pais = PAIS_DE_CANAL[aTexto(v.canal)] || '';
    ventas.push({ ms, dia, pais, canal: aTexto(v.canal), sesion: aTexto(v.sesion), ficha: parseInt(v.ficha, 10) || null,
      nombre: aTexto(v.nombre), remate: aEuros(v.precio), pedido: aTexto(v.pedido) });
  }

  const pedidos = [...new Set(ventas.map((v) => v.pedido).filter(Boolean))];
  const movs = pedidos.length
    ? await s`select pedido, pais, tipo, liquidado, visto, ingreso, comision, envio, ajuste, neto, detalle
                from fin_mov where pedido = any(${pedidos})`
    : [];

  /* Cuando se completo la ultima pasada de pendientes de cada pais. */
  const completo = {};
  for (const p of Object.keys(TIENDAS)) {
    const e = await leerEstado(s, 'pend:' + p);
    completo[p] = e.completo ? new Date(e.completo).getTime() : 0;
  }

  /* Por pais Y pedido: un numero de pedido es de una sola tienda, pero asi
   * un movimiento de otra tienda no puede colarse nunca en una prenda. */
  const porPedido = {};
  for (const m of movs) { const k = m.pais + '|' + m.pedido; (porPedido[k] = porPedido[k] || []).push(m); }

  const dinero = {};
  for (const [pedido, ms] of Object.entries(porPedido)) {
    const liq = ms.filter((m) => m.liquidado);
    const pend = ms.filter((m) => !m.liquidado && new Date(m.visto).getTime() >= (completo[m.pais] || 0));
    const usa = liq.length ? liq : pend;
    if (!usa.length) continue;
    const sum = (k) => usa.reduce((a, m) => a + num(m[k]), 0);
    const det = {};
    for (const m of usa) for (const [k, v] of Object.entries(m.detalle || {})) det[k] = (det[k] || 0) + num(v);
    dinero[pedido] = { estado: liq.length ? 'L' : 'P', ingreso: sum('ingreso'), comision: sum('comision'),
      envio: sum('envio'), ajuste: sum('ajuste'), neto: sum('neto'), det };
  }

  /* Un pedido puede llevar varias prendas: el dinero se reparte entre ellas
   * por su precio de remate (a partes iguales si no hay precio). */
  const prendasDe = {};
  for (const v of ventas) if (v.pedido) (prendasDe[v.pedido] = prendasDe[v.pedido] || []).push(v);

  const filas = ventas.map((v) => {
    const d = v.pedido && dinero[v.pais + '|' + v.pedido];
    const grupo = v.pedido ? prendasDe[v.pedido] : [v];
    const total = grupo.reduce((a, x) => a + x.remate, 0);
    const parte = total > 0 ? v.remate / total : 1 / grupo.length;
    const fila = { h: v.ms, dia: v.dia, pais: v.pais, canal: v.canal, sesion: v.sesion, ficha: v.ficha,
      anuncio: v.nombre, remate: v.remate, estado: d ? d.estado : '-', prendasPedido: grupo.length };
    if (d) {
      fila.ingreso = r2(d.ingreso * parte); fila.comision = r2(d.comision * parte);
      fila.envio = r2(d.envio * parte); fila.ajuste = r2(d.ajuste * parte); fila.neto = r2(d.neto * parte);
      const det = {};
      for (const [k, x] of Object.entries(d.det)) det[k] = r2(x * parte);
      fila.det = det;
    }
    return fila;
  });

  /* Lo que TikTok liquida y no es de ninguna prenda de tablet: ajustes sueltos,
   * cargos de envio, pedidos de fuera del directo. Por pais y dia de
   * liquidacion, para que el total cuadre con lo que llega al banco. */
  const pedidosTablet = new Set(pedidos);
  const sueltos = await s`
    select pais, to_char(liquidacion_en at time zone 'Europe/Madrid', 'YYYY-MM-DD') as dia,
           tipo, pedido <> '' as con_pedido, pedido,
           ingreso, comision, envio, ajuste, neto
      from fin_mov
     where liquidado and liquidacion_en >= ${desde}::date and liquidacion_en < ${hasta}::date + interval '1 day'`;
  const otros = {};
  for (const x of sueltos) {
    if (x.pedido && pedidosTablet.has(x.pedido)) continue;
    const k = x.pais + '|' + x.dia + '|' + (x.con_pedido ? 'pedido-fuera-de-tablet' : aTexto(x.tipo || 'otro'));
    const o = otros[k] = otros[k] || { pais: x.pais, dia: x.dia, que: k.split('|')[2], n: 0, ingreso: 0, comision: 0, envio: 0, ajuste: 0, neto: 0 };
    o.n++; for (const c of ['ingreso', 'comision', 'envio', 'ajuste', 'neto']) o[c] = r2(o[c] + num(x[c]));
  }

  const actualizado = {};
  for (const p of Object.keys(TIENDAS)) actualizado[p] = completo[p] ? new Date(completo[p]).toISOString() : null;

  return res.status(200).json({ ok: true, desde, hasta, actualizado, ventas: filas, otros: Object.values(otros) });
}

/* ----------------------------------------------------------------- muestra */

async function muestra(s, res, pais) {
  const cuenta = TIENDAS[pais];
  const st = await T.comoCuenta(cuenta, { camino: '/finance/202309/statements',
    params: { sort_field: 'statement_time', sort_order: 'DESC', page_size: 20 } });
  const conDinero = laLista(st.data).find((x) => num(x.revenue_amount) !== 0) || laLista(st.data)[0];
  let tx = null;
  if (conDinero) {
    const r = await T.comoCuenta(cuenta, { camino: '/finance/202501/statements/' + conDinero.id + '/statement_transactions',
      params: { sort_field: 'order_create_time', page_size: 3 } });
    tx = { code: r.code, message: r.message, claves: Object.keys(r.data || {}), primero: laLista(r.data)[0] || null };
  }
  const p = await T.comoCuenta(cuenta, { camino: '/finance/202507/orders/unsettled',
    params: { sort_field: 'order_create_time', sort_order: 'DESC', page_size: 3 } });
  const pend = { code: p.code, message: p.message, claves: Object.keys(p.data || {}), primero: laLista(p.data)[0] || null };
  const tapar = (o) => { if (o && o.primero) { for (const k of Object.keys(o.primero)) if (/order_id|adjustment_order_id/.test(k)) o.primero[k] = '(oculto)'; } return o; };
  return res.status(200).json({ ok: true, pais, liquidacion: tapar(tx), pendientes: tapar(pend) });
}

/* ------------------------------------------------------------------ puerta */

module.exports = puerta(async (req, res) => {
  if (!esAaron(req)) return res.status(401).json({ ok: false, error: 'sin-permiso' });
  const t0 = Date.now();
  const q = req.query || {};
  const s = db();
  await tablas(s);
  const accion = aTexto(q.accion);
  const pais = aTexto(q.pais).toLowerCase();
  if (accion !== 'datos' && !TIENDAS[pais]) return res.status(400).json({ ok: false, error: 'pais-raro', paises: Object.keys(TIENDAS) });

  if (accion === 'liquidaciones') return liquidaciones(s, res, pais);
  if (accion === 'liquidacion') return liquidacion(s, res, pais, aTexto(q.id), aTexto(q.t), t0, q);
  if (accion === 'pendientes') return pendientes(s, res, pais, aTexto(q.t), aTexto(q.inicio), t0);
  if (accion === 'muestra') return muestra(s, res, pais);
  if (accion === 'datos') {
    const hoy = diaMadrid(Date.now());
    return datos(s, res, aTexto(q.desde) || DESDE_MIN, aTexto(q.hasta) || hoy);
  }
  return res.status(400).json({ ok: false, error: 'accion-rara' });
});
