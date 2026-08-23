/* /api/tiktok-prueba — la primera llamada de verdad.
 *
 * Toca los cuatro sitios que van a hacer falta para los pasos 2, 3 y 4, y
 * dice de cada uno si contesta o con que se queja. Sirve para saber, ANTES de
 * mover ningun paso, que los permisos estan bien dados y la firma cuadra.
 *
 *   GET ?d=CODIGO&cuenta=billysvlc
 *
 * Se puede borrar el dia que todo funcione, pero conviene dejarlo: cuando algo
 * falle en directo, lo primero es saber si falla la API o fallamos nosotros.
 */
const { puerta, puedeLeer, noAutorizado, aTexto } = require('./_lib');
const T = require('./_tiktok');

/* Un intento suelto. Nunca revienta: lo que interesa es el parte de los
 * cuatro, no que el primero corte la pagina. */
async function probar(cuenta, nombre, opciones) {
  const t0 = Date.now();
  try {
    const r = await T.comoCuenta(cuenta, opciones);
    const d = r && r.data;
    return {
      que: nombre,
      ok: r && r.code === 0,
      code: r && r.code,
      mensaje: aTexto(r && r.message).slice(0, 200),
      ms: Date.now() - t0,
      /* Un resumen, no el volcado entero: aqui solo queremos saber si hay
       * datos al otro lado. */
      cuantos: d ? (Array.isArray(d.orders) ? d.orders.length
                  : Array.isArray(d.packages) ? d.packages.length
                  : Array.isArray(d.products) ? d.products.length
                  : Array.isArray(d.shops) ? d.shops.length
                  : Object.keys(d).length) : 0,
      claves: d ? Object.keys(d).slice(0, 8) : []
    };
  } catch (e) {
    return { que: nombre, ok: false, error: String((e && e.message) || e).slice(0, 300), ms: Date.now() - t0 };
  }
}

module.exports = puerta(async (req, res) => {
  if (!puedeLeer(req)) return noAutorizado(res, 'leer');
  const q = req.query || {};
  const cuenta = (aTexto(q.cuenta).trim() || 'billysvlc').toLowerCase();

  /* Las 24 horas de ayer y hoy: suficiente para que un dia de directo
   * devuelva algo, y poco para no pedirle a TikTok un historico entero. */
  const hasta = Math.floor(Date.now() / 1000);
  const desde = hasta - 36 * 3600;

  const partes = [];

  partes.push(await probar(cuenta, 'las tiendas autorizadas',
    { camino: '/authorization/202309/shops', cifra: false }));

  partes.push(await probar(cuenta, 'buscar pedidos (paso 2)',
    { camino: '/order/202309/orders/search', metodo: 'POST',
      params: { page_size: 10 },
      cuerpo: { create_time_ge: desde, create_time_lt: hasta } }));

  partes.push(await probar(cuenta, 'buscar paquetes (paso 3)',
    { camino: '/fulfillment/202309/packages/search', metodo: 'POST',
      params: { page_size: 10 }, cuerpo: {} }));

  partes.push(await probar(cuenta, 'buscar productos',
    { camino: '/product/202309/products/search', metodo: 'POST',
      params: { page_size: 5 }, cuerpo: {} }));

  const bien = partes.filter((p) => p.ok).length;
  return res.status(200).json({
    ok: bien === partes.length,
    cuenta,
    resumen: bien + ' de ' + partes.length + ' llamadas han contestado bien',
    partes
  });
});
