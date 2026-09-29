/* /api/tiktok-finanzas — prueba del permiso de finanzas (29 sep 2026).
 *
 * Sirvio para comprobar que TikTok nos deja leer el dinero de cada tienda.
 * La herramienta de verdad es /api/finanzas. Esta se queda para diagnostico,
 * pero ya NO se abre con el codigo del almacen: pide el codigo de finanzas.
 *
 *   GET ?f=CODIGO&cuenta=billys_de            ultimas liquidaciones (60 dias)
 *   GET ?f=CODIGO&cuenta=billys_de&pedido=... el dinero de un pedido
 */
const crypto = require('crypto');
const { puerta, aTexto } = require('./_lib');
const T = require('./_tiktok');

const HUELLA = '5e6b779d054291a12ba58ace81ca620a1223c0f595f5209af6df1855c7a77830';
function esAaron(req) {
  const q = req.query || {};
  const dado = String(q.f || req.headers['x-billys-finanzas'] || '');
  if (!dado) return false;
  const h = crypto.createHash('sha256').update(dado).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(HUELLA));
}

const CUENTAS = ['billysvlc', 'billystourvlc', 'billys_de', 'billys_nl'];

module.exports = puerta(async (req, res) => {
  if (!esAaron(req)) return res.status(401).json({ ok: false, error: 'sin-permiso' });
  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billys_de').toLowerCase();
  if (!CUENTAS.includes(cuenta)) return res.status(400).json({ ok: false, error: 'cuenta-desconocida', cuentas: CUENTAS });
  const pedido = aTexto(q.pedido).replace(/[^0-9]/g, '');
  const t0 = Date.now();
  let r;
  if (pedido) {
    r = await T.comoCuenta(cuenta, { camino: '/finance/202501/orders/' + pedido + '/statement_transactions', metodo: 'GET' });
  } else {
    const ahora = Math.floor(Date.now() / 1000);
    r = await T.comoCuenta(cuenta, { camino: '/finance/202309/statements', metodo: 'GET',
      params: { sort_field: 'statement_time', sort_order: 'DESC', page_size: 10,
        statement_time_ge: ahora - 60 * 24 * 3600, statement_time_lt: ahora } });
  }
  const code = r && r.code;
  return res.status(200).json({ ok: code === 0, permiso: code === 0 ? 'si' : 'no-o-otro-fallo', cuenta,
    consulta: pedido ? 'pedido' : 'liquidaciones',
    tiktok: { code, message: r && r.message, request_id: r && r.request_id, data: r && r.data }, ms: Date.now() - t0 });
});
