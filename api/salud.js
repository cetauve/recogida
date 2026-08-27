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
          sku: aTexto(l.sku_id),
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
    const e = porCuenta[c] = porCuenta[c] || { prendas: 0, numeros: [], ejemplos: [] };
    e.prendas++;
    if (p.num != null) e.numeros.push(p.num);
    /* Tres pedidos de muestra por cuenta. Sirven para abrir uno en el Centro de
     * vendedores y comprobar a mano que el rotulo que dice esto es el que pone
     * TikTok en pantalla ("LIVE: billysvlc"), que por API no llega. */
    if (e.ejemplos.length < 3) e.ejemplos.push({ pedido: p.pedido, num: p.num, sku: p.sku });
  }
  for (const c of Object.keys(porCuenta)) porCuenta[c].numeros.sort((a, b) => a - b);

  /* Y LO MISMO POR PEDIDO, que es lo unico que desambigua.
   * El numero 47 existe en los tres racks y son prendas distintas, asi que
   * repartir los numeros de una tarjeta mirando solo el numero no vale. La
   * tarjeta si guarda los ids de pedido de su comprador: con esto se cruza por
   * ahi y cada numero cae en su cuenta sin lugar a dudas. */
  const porPedido = {};
  for (const p of prendas) {
    if (!p.pedido) continue;
    const c = rotulo.get(p.producto) || '';
    (porPedido[p.pedido] = porPedido[p.pedido] || []).push({ n: p.num, c });
  }

  return {
    estado, desde, vueltas, corto, ms: Date.now() - t0,
    total: prendas.length,
    productos: ids.map((id) => ({ producto: id, cuenta: rotulo.get(id) || '(sin rotulo)' })),
    porCuenta,
    porPedido
  };
}

/* ===========================================================================
 * ?cuentas=1 — DE QUIEN ES CADA PRODUCTO DE HOY, ANTES DE LEER LOS PEDIDOS.
 * ===========================================================================
 * EL FALLO DEL 25 Y DEL 26 AGO 2026, dos noches seguidas. El rotulo de la
 * cuenta se aprendia solo de las analiticas de directos, y cuando esas fallan
 * —o cuando el mismo producto aparece listado en el directo de otra cuenta con
 * cero ventas— salen cientos de prendas con el cartel cambiado. El 26 las 866
 * prendas del dia acabaron bajo un solo nombre.
 *
 * La salida no es adivinar mejor: es PREGUNTAR, una vez, antes de nada. Pero
 * preguntar en frio ("de quien es el producto 1729905234485614761") no lo
 * contesta nadie. Asi que esto propone, y la persona solo confirma:
 *
 *   1. POR EL NOMBRE. Si el titulo del producto lleva dentro el nombre de una
 *      cuenta, no hay nada que adivinar. Es lo mas fiable que hay y no depende
 *      de que TikTok conteste nada.
 *   2. POR LA HORA DE ARRANQUE. Las analiticas dan las sesiones de HOY con su
 *      username y su hora de inicio —eso llega al momento, no con el retraso de
 *      un dia que tienen los productos—. El producto cuya primera venta es mas
 *      temprana es del directo que empezo antes.
 *   3. LO QUE YA ESTA FIJADO A MANO no se toca ni se vuelve a preguntar.
 *
 * Se devuelven ademas los tres datos que una persona reconoce de un vistazo sin
 * ir a mirar a ningun sitio: la hora de la primera venta, cuantas prendas lleva
 * y el numero mas alto. "El que llega al 350 es el mio."
 *
 * Solo LEE. Fijar es otra llamada y la dispara la persona. */
async function cuentasDeHoy(req) {
  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();
  const t0 = Date.now();
  const D = require('./_directos');

  /* 1. Los pedidos que hay ahora mismo pendientes de envio: de ahi salen los
   *    productos del dia, con su nombre, su hora y sus numeros. */
  const productos = new Map();
  let token = '', vueltas = 0;
  do {
    const params = { page_size: 50 };
    if (token) params.page_token = token;
    const r = await T.comoCuenta(cuenta, {
      camino: '/order/202309/orders/search', metodo: 'POST', params,
      cuerpo: { order_status: 'AWAITING_SHIPMENT' }
    });
    if (!r || r.code !== 0) return { error: aTexto(r && r.message).slice(0, 200) };
    const d = r.data || {};
    for (const o of (d.orders || [])) {
      const creado = o.create_time ? Number(o.create_time) * 1000 : null;
      for (const l of (o.line_items || [])) {
        const id = aTexto(l.product_id);
        if (!id) continue;
        const e = productos.get(id) || { producto: id, titulo: aTexto(l.product_name), prendas: 0, alto: 0, primera: null };
        e.prendas++;
        const n = Number(aTexto(l.seller_sku).replace(/\D+/g, ''));
        if (Number.isFinite(n) && n > e.alto) e.alto = n;
        if (creado && (!e.primera || creado < e.primera)) e.primera = creado;
        if (!e.titulo) e.titulo = aTexto(l.product_name);
        productos.set(id, e);
      }
    }
    token = aTexto(d.next_page_token);
    vueltas++;
    if (Date.now() - t0 > 25000) break;
  } while (token && vueltas < 30);

  /* 2. Lo que ya se sabe, para no preguntar dos veces por lo mismo. */
  await D.asegurarTablas();
  const s = db();
  const ids = [...productos.keys()];
  const filas = ids.length
    ? await s`select producto, cuenta, directo from tiktok_productos where producto = any(${ids})`
    : [];
  const yaEsta = new Map(filas.map((f) => [f.producto, f]));

  /* 3. Los directos de hoy, con su nombre y su hora de arranque. */
  let sesiones = [];
  try { sesiones = await D.directos(cuenta, 2); } catch (_) { sesiones = []; }
  /* EN HORA DE ESPANA, NO EN UTC. Con toISOString salian dos horas menos y
   * ninguna hora cuadraba con la realidad, asi que la propuesta no habia forma
   * de comprobarla de un vistazo. diaDeHoy ya va en Europe/Madrid. */
  const hora = (ms) => new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const hoy = diaDeHoy();
  const deHoy = sesiones.filter((x) => x.empezo && diaDeHoy(x.empezo) === hoy && x.cuenta);
  const nombres = [...new Set(deHoy.map((x) => x.cuenta))];
  /* Y las cuentas que conocemos aunque hoy no hayan emitido todavia: sirven
   * para el emparejamiento por nombre y para pintar los botones. */
  const conocidas = await s`select distinct cuenta from tiktok_productos where cuenta <> '' order by cuenta`;
  const todas = [...new Set([...nombres, ...conocidas.map((c) => c.cuenta)])];

  /* 4. La propuesta. Por nombre primero, que es lo unico que no depende de que
   *    TikTok conteste; por hora de arranque despues. */
  const porHora = deHoy.slice().sort((a, b) => (a.empezo || 0) - (b.empezo || 0));
  const lista = [...productos.values()].sort((a, b) => (a.primera || 0) - (b.primera || 0));
  const usadas = new Set();
  const fuera = [];

  for (const p of lista) {
    const guardado = yaEsta.get(p.producto);
    if (guardado && guardado.directo === 'a mano') {
      fuera.push({ ...p, cuenta: guardado.cuenta, porque: 'fijado a mano', firme: true });
      usadas.add(guardado.cuenta);
      continue;
    }
    const t = p.titulo.toLowerCase().replace(/[^a-z0-9]/g, '');
    const porNombre = todas.find((c) => c && t.includes(c.toLowerCase().replace(/[^a-z0-9]/g, '')));
    if (porNombre) {
      fuera.push({ ...p, cuenta: porNombre, porque: 'el nombre del producto lo dice', firme: true });
      usadas.add(porNombre);
      continue;
    }
    const libre = porHora.find((x) => !usadas.has(x.cuenta));
    if (libre) {
      usadas.add(libre.cuenta);
      fuera.push({ ...p, cuenta: libre.cuenta, porque: 'empezo a las ' + hora(libre.empezo), firme: false });
    } else {
      fuera.push({ ...p, cuenta: (guardado && guardado.cuenta) || '', porque: guardado ? 'lo aprendido' : 'no lo se', firme: false });
    }
  }

  return {
    cuentas: todas,
    directosDeHoy: deHoy.map((x) => ({ cuenta: x.cuenta, empezo: x.empezo, hora: hora(x.empezo) })),
    hayAnaliticas: deHoy.length > 0,
    productos: fuera.map((p) => ({
      producto: p.producto, titulo: p.titulo, prendas: p.prendas, alto: p.alto,
      primera: p.primera ? new Date(p.primera).toISOString() : null,
      horaPrimera: p.primera ? hora(p.primera) : null,
      cuenta: p.cuenta, porque: p.porque, firme: !!p.firme
    })),
    ms: Date.now() - t0
  };
}

const PAGINA_CUENTAS = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\"><title>De quien es cada rack</title>\n<style>\n:root{--bg:#F2F5F4;--c:#FFF;--t:#111817;--m:#5E6E6C;--l:#D7E0DE;--a:#0E5F63;--ab:#D9EBEB;--ok:#2C6B45;--x:#A03227;--w:#9A5B0C;--wb:#F6E9D6}\n@media(prefers-color-scheme:dark){:root{--bg:#0C1212;--c:#141C1C;--t:#E5EDEB;--m:#8DA09D;--l:#26302F;--a:#5CC7CC;--ab:#0F2C2D;--ok:#7DC79C;--x:#E88175;--w:#E0A85C;--wb:#2C2416}}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--t);font:16px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}\n.w{max-width:820px;margin:0 auto;padding:20px 14px 60px}\nh1{font-size:1.35rem;margin:0 0 3px}p.s{color:var(--m);font-size:.9rem;margin:0 0 20px}\n.p{background:var(--c);border:1px solid var(--l);border-radius:12px;margin-bottom:14px;overflow:hidden}\n.p .cab{padding:14px 16px 10px}\n.p h2{font-size:1.02rem;margin:0 0 6px;word-break:break-word}\n.datos{display:flex;flex-wrap:wrap;gap:6px 16px;font:.8rem ui-monospace,Menlo,monospace;color:var(--m)}\n.datos b{color:var(--t);font-weight:600}\n.bt{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 14px}\n.bt button{flex:1 1 30%;min-width:132px;padding:13px 8px;border-radius:10px;border:2px solid var(--l);\n  background:var(--bg);color:var(--t);font:700 .95rem inherit;cursor:pointer}\n.bt button.on{border-color:var(--a);background:var(--ab);color:var(--a)}\n.pq{padding:0 16px 12px;font-size:.8rem;color:var(--m)}\n.pq b{color:var(--ok)}\n.firme{border-left:5px solid var(--ok)}\n.duda{border-left:5px solid var(--w)}\n.avisa{background:var(--wb);border:1px solid var(--w);color:var(--w);border-radius:10px;padding:12px 14px;margin-bottom:18px;font-size:.88rem;font-weight:600}\n.ir{position:sticky;bottom:10px;margin-top:20px}\n.ir button{width:100%;padding:17px;border-radius:12px;border:0;background:var(--a);color:var(--bg);\n  font:800 1.05rem inherit;cursor:pointer}\n.ir button:disabled{opacity:.45;cursor:default}\n#fin{margin-top:14px;font-size:.9rem;font-weight:600}\n.malo{color:var(--x)}.bueno{color:var(--ok)}\n.cargando{color:var(--m);padding:30px 0;text-align:center}\n</style></head><body><div class=\"w\">\n<h1>\u00bfDe qui\u00e9n es cada rack?</h1>\n<p class=\"s\">M\u00edralo un segundo y confirma. Con esto las tarjetas salen con el nombre puesto.</p>\n<div id=\"todo\" class=\"cargando\">Leyendo lo de hoy\u2026</div>\n<div class=\"ir\"><button id=\"ok\" disabled>Confirmar</button><div id=\"fin\"></div></div>\n</div><script>\nvar D = new URLSearchParams(location.search).get('d') || '';\nvar CUENTA = new URLSearchParams(location.search).get('cuenta') || 'billysvlc';\nvar TOK = new URLSearchParams(location.search).get('t') || '';\nvar P = [], CUENTAS = [];\n\nfunction pinta(){\n  var h = '';\n  if (!window.__HAY) h += '<div class=\"avisa\">Las anal\u00edticas de directos no contestan ahora mismo, as\u00ed que no puedo proponer nada por la hora. Marca a mano de qui\u00e9n es cada uno.</div>';\n  h += P.map(function(p,i){\n    return '<div class=\"p ' + (p.firme?'firme':'duda') + '\">' +\n      '<div class=\"cab\"><h2>' + (p.titulo||'(sin nombre)') + '</h2>' +\n      '<div class=\"datos\">' +\n        '<span>primera venta <b>' + (p.horaPrimera ? p.horaPrimera : '\u2014') + '</b></span>' +\n        '<span><b>' + p.prendas + '</b> prendas</span>' +\n        '<span>llega al n\u00ba <b>' + p.alto + '</b></span>' +\n      '</div></div>' +\n      '<div class=\"bt\">' + CUENTAS.map(function(c){\n        return '<button data-i=\"' + i + '\" data-c=\"' + c + '\"' + (p.cuenta===c?' class=\"on\"':'') + '>' + c + '</button>';\n      }).join('') + '</div>' +\n      '<div class=\"pq\">' + (p.cuenta ? ('propuesto porque <b>' + p.porque + '</b>') : 'sin propuesta, elige t\u00fa') + '</div>' +\n    '</div>';\n  }).join('');\n  document.getElementById('todo').className = '';\n  document.getElementById('todo').innerHTML = h;\n  document.getElementById('ok').disabled = !P.length || P.some(function(p){ return !p.cuenta; });\n  document.querySelectorAll('.bt button').forEach(function(b){\n    b.onclick = function(){\n      var i = +b.dataset.i, c = b.dataset.c;\n      P[i].cuenta = c; P[i].porque = 'lo has dicho t\u00fa'; P[i].firme = true;\n      /* Si solo queda uno sin marcar y solo queda una cuenta libre, se rellena\n         solo: identificadas dos, la tercera no tiene alternativa. */\n      var usadas = P.filter(function(x){return x.cuenta}).map(function(x){return x.cuenta});\n      var libres = CUENTAS.filter(function(c2){ return usadas.indexOf(c2) < 0; });\n      var sin = P.filter(function(x){ return !x.cuenta; });\n      if (sin.length === 1 && libres.length === 1) { sin[0].cuenta = libres[0]; sin[0].porque = 'por descarte'; sin[0].firme = true; }\n      pinta();\n    };\n  });\n}\n\nfetch('/api/salud?d=' + encodeURIComponent(D) + '&cuentas=1&cuenta=' + encodeURIComponent(CUENTA), {cache:'no-store'})\n  .then(function(r){ return r.json(); })\n  .then(function(j){\n    if (!j.ok) throw new Error(j.error || 'no ha ido');\n    P = j.productos || []; CUENTAS = j.cuentas || []; window.__HAY = j.hayAnaliticas;\n    if (!P.length) { document.getElementById('todo').innerHTML = '<div class=\"avisa\">No hay pedidos pendientes ahora mismo. Esto se usa cuando ha acabado el directo y antes de darle al paso 2.</div>'; return; }\n    pinta();\n  })\n  .catch(function(e){ document.getElementById('todo').innerHTML = '<div class=\"avisa\">No he podido leer: ' + e.message + '</div>'; });\n\ndocument.getElementById('ok').onclick = function(){\n  var b = document.getElementById('ok'), f = document.getElementById('fin');\n  b.disabled = true; b.textContent = 'Guardando\u2026'; f.textContent = '';\n  var hechas = 0, fallos = [];\n  var siguiente = function(i){\n    if (i >= P.length) {\n      b.textContent = 'Confirmar';\n      f.className = fallos.length ? 'malo' : 'bueno';\n      f.textContent = fallos.length\n        ? (hechas + ' guardados, ' + fallos.length + ' han fallado: ' + fallos.join(', '))\n        : ('Listo: ' + hechas + ' racks con su nombre. Ya puedes darle al paso 2.');\n      return;\n    }\n    var p = P[i];\n    fetch('/api/tiktok-etiquetas?cuenta=' + encodeURIComponent(CUENTA) +\n          '&fijar=' + encodeURIComponent(p.producto) + '&cuenta_es=' + encodeURIComponent(p.cuenta),\n          { headers: { 'X-Billys-Token': TOK } })\n      .then(function(r){ return r.json(); })\n      .then(function(j){ if (j && j.ok) hechas++; else fallos.push(p.titulo || p.producto.slice(-6)); })\n      .catch(function(){ fallos.push(p.titulo || p.producto.slice(-6)); })\n      .then(function(){ siguiente(i+1); });\n  };\n  siguiente(0);\n};\n</script></body></html>\n";

module.exports = puerta(async (req, res) => {
  const s = db();
  const hoy = diaDeHoy();

  /* La pantalla de confirmar. Se abre en el movil o en el propio ordenador
   * justo antes del paso 2. */
  if (aTexto((req.query || {}).racks)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).end(PAGINA_CUENTAS);
  }

  if (aTexto((req.query || {}).cuentas)) {
    if (!puedeLeer(req)) return res.status(401).json({ ok: false, error: 'sin-permiso' });
    const r = await cuentasDeHoy(req);
    return res.status(200).json({ ok: !r.error, ...r });
  }

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
