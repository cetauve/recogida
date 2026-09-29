/* /api/tiktok-finanzas — el dinero de TikTok, SOLO LECTURA.
 *
 * Primera pieza de la herramienta financiera (29 sep 2026). No escribe nada en
 * la base ni en TikTok: solo pregunta y devuelve lo que TikTok contesta, con el
 * code, el message y el request_id para saber por que falla si falla.
 *
 *   GET ?d=CODIGO&cuenta=billys_de
 *       -> las ultimas liquidaciones de esa tienda (60 dias). Sirve de prueba:
 *          si contesta con datos, la app TIENE el permiso de finanzas.
 *   GET ?d=CODIGO&cuenta=billys_de&pedido=5770...
 *       -> todo el dinero de UN pedido: venta, comisiones, envio, liquidado.
 *
 * No devuelve nombres, direcciones ni nada del comprador: solo importes.
 * No toca tandas.js ni _lib.js (aviso del 26 sep).
 */
const { puerta, puedeLeer, noAutorizado, aTexto } = require('./_lib');
const T = require('./_tiktok');

const CUENTAS = ['billysvlc', 'billystourvlc', 'billys_de', 'billys_nl'];

function resumen(r) {
  return {
    code: r && r.code,
    message: r && r.message,
    request_id: r && r.request_id,
    data: r && r.data
  };
}

module.exports = puerta(async (req, res) => {
  if (!puedeLeer(req)) return noAutorizado(res, 'leer');
  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billys_de').toLowerCase();
  if (!CUENTAS.includes(cuenta)) {
    return res.status(400).json({ ok: false, error: 'cuenta-desconocida', cuentas: CUENTAS });
  }
  const pedido = aTexto(q.pedido).replace(/[^0-9]/g, '');
  const t0 = Date.now();

  let r;
  if (pedido) {
    r = await T.comoCuenta(cuenta, {
      camino: '/finance/202501/orders/' + pedido + '/statement_transactions',
      metodo: 'GET'
    });
  } else {
    const ahora = Math.floor(Date.now() / 1000);
    r = await T.comoCuenta(cuenta, {
      camino: '/finance/202309/statements',
      metodo: 'GET',
      params: {
        sort_field: 'statement_time',
        sort_order: 'DESC',
        page_size: 10,
        statement_time_ge: ahora - 60 * 24 * 3600,
        statement_time_lt: ahora
      }
    });
  }

  const code = r && r.code;
  return res.status(200).json({
    ok: code === 0,
    permiso: code === 0 ? 'si' : 'no-o-otro-fallo',
    cuenta,
    consulta: pedido ? 'pedido' : 'liquidaciones',
    tiktok: resumen(r),
    ms: Date.now() - t0
  });
});
