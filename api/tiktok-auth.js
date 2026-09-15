/* /api/tiktok-auth — donde aterriza el vendedor despues de autorizar.
 *
 * TikTok manda aqui un auth_code de un solo uso. Esta puerta lo cambia por el
 * access_token y el refresh_token, pregunta que tienda ha autorizado (de ahi
 * sale el shop_cipher, que hace falta en casi todas las demas llamadas) y lo
 * guarda todo. Luego enseña una pagina que dice si ha ido bien.
 *
 *   GET  ?code=...&state=billysvlc     lo llama TikTok, no nosotros
 *   GET  ?estado=1&d=CODIGO            para mirar como estan las autorizaciones
 *
 * El "state" es el nombre que le damos a la cuenta (billysvlc o
 * billystourvlc). Va en el enlace de autorizacion que abrimos nosotros, asi
 * que sabemos cual vuelve. Si no viene, se guarda como "principal".
 *
 * ESTA DIRECCION ES PUBLICA y no puede llevar llave: la abre el navegador del
 * vendedor viniendo de TikTok. No pasa nada: sin un auth_code valido, aqui no
 * se consigue nada, y un auth_code solo lo emite TikTok despues de que una
 * persona pulse "autorizar" en su propia tienda.
 */
const { puerta, puedeLeer, noAutorizado, aTexto } = require('./_lib');
const T = require('./_tiktok');

const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pagina(res, titulo, cuerpo, color) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).end(`<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(titulo)}</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaed;
      font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
 .caja{max-width:520px;background:#171a21;border:1px solid #262b36;border-radius:14px;padding:28px}
 h1{margin:0 0 12px;font-size:20px;color:${color}}
 pre{white-space:pre-wrap;word-break:break-word;background:#0f1115;border:1px solid #262b36;
     border-radius:10px;padding:12px;font-size:13px;color:#9aa4b2;margin:16px 0 0}
 b{color:#fff}
</style>
<div class="caja"><h1>${escapar(titulo)}</h1>${cuerpo}</div>`);
}

module.exports = puerta(async (req, res) => {
  const q = req.query || {};

  /* ---- mirar como estan las autorizaciones (esto si lleva llave) ---- */
  if (q.estado !== undefined) {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const filas = await T.cuentas();
    const ahora = Date.now();
    return res.status(200).json({
      ok: true,
      hay: filas.length,
      cuentas: filas.map((f) => ({
        cuenta: f.cuenta,
        tienda: f.tienda_nombre,
        tiendaId: f.tienda_id,
        region: f.region,
        tieneCifra: !!f.tienda_cifra,
        accesoHasta: f.acceso_hasta,
        accesoCaducado: f.acceso_hasta ? new Date(f.acceso_hasta).getTime() < ahora : true,
        refrescoHasta: f.refresco_hasta,
        refrescoCaducado: f.refresco_hasta ? new Date(f.refresco_hasta).getTime() < ahora : true,
        actualizado: f.actualizado
      }))
    });
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'metodo' });

  /* ---- la vuelta de TikTok ---- */
  const codigo = aTexto(q.code || q.auth_code).trim();
  const cuenta = (aTexto(q.state).trim() || 'principal').toLowerCase();

  if (!codigo) {
    return pagina(res, 'Aqui no hay nada que hacer a mano',
      `<p>Esta direccion la usa TikTok para devolver el codigo de autorizacion.</p>
       <p>Para autorizar una tienda, abre el enlace de autorizacion de la app en el
       Partner Center, no esta pagina.</p>`, '#f0b429');
  }

  const respuesta = await T.pedirToken(codigo);
  const d = (respuesta && respuesta.data) || {};
  if (!d.access_token) {
    /* El auth_code caduca en minutos y es de un solo uso: recargar esta pagina
     * despues de que haya funcionado da este mismo error. Conviene decirlo. */
    return pagina(res, 'No ha colado',
      `<p>TikTok no ha aceptado el codigo. Los codigos caducan en unos minutos y
       solo valen una vez, asi que si acabas de autorizar y has recargado, es normal.</p>
       <pre>${escapar(JSON.stringify(respuesta, null, 2).slice(0, 900))}</pre>`, '#ff6b6b');
  }

  const enSegundos = (s) => (s ? new Date(Date.now() + Number(s) * 1000) : null);

  /* Con el token ya en la mano, preguntamos que tienda es. Si esto falla no
   * tiramos la autorizacion: el token vale y la cifra se puede pedir luego.
   *
   * EL 15 SEP 2026 ESTO GUARDO ALEMANIA COMO SI FUERA ESPAÑA.
   * TikTok devuelve TODAS las tiendas a las que llega ese permiso, y aqui se
   * cogia lista[0] sin mirar. Como la cuenta de vendedor tiene enlazadas
   * España, Holanda y Alemania, la primera era España: billys_de quedo con
   * el id y la cifra de Valencia, y la pantalla dijo que todo habia ido bien.
   * Pedir el almacen aleman habria devuelto los pedidos de Valencia.
   *
   * Ahora la region se saca del nombre que viaja en el enlace: billys_de es
   * DE, billys_nl es NL, y se busca ESA tienda en la lista. Los nombres sin
   * sufijo de dos letras (billysvlc) siguen como antes.
   *
   * Y SI NO CUADRA, NO SE GUARDA. Es la parte que importa: un fallo que se ve
   * cuesta cinco minutos y uno que se guarda en silencio cuesta un dia de
   * prendas enviadas al pais equivocado. */
  const regionPedida = (() => {
    const trozos = cuenta.split(/[_-]/);
    const ultimo = trozos[trozos.length - 1];
    return (trozos.length > 1 && /^[a-z]{2}$/.test(ultimo)) ? ultimo.toUpperCase() : null;
  })();

  let tienda = {};
  let fallo = '';
  let lista = [];
  try {
    const r = await T.tiendasDe(d.access_token);
    lista = (r && r.data && r.data.shops) || [];
  } catch (e) {
    fallo = String((e && e.message) || e);
  }

  const comoSalen = () => lista.map((x) =>
    '  ' + aTexto(x.name) + '  ·  region ' + aTexto(x.region) + '  ·  id ' + aTexto(x.id)).join('\n');

  if (!fallo && !lista.length) fallo = 'El token vale pero no ha devuelto ninguna tienda.';

  if (!fallo && regionPedida) {
    const suya = lista.find((x) => aTexto(x.region).toUpperCase() === regionPedida);
    if (!suya) {
      return pagina(res, 'No he guardado nada, y es a proposito',
        `<p>Has autorizado como <b>${escapar(cuenta)}</b>, o sea que esperaba una tienda de
         <b>${escapar(regionPedida)}</b>, y TikTok no ha devuelto ninguna de ese pais.</p>
         <p>Esto es lo que ha devuelto:</p>
         <pre>${escapar(comoSalen())}</pre>
         <p>Antes de repetir: mira que en el Centro de vendedores este seleccionada la tienda
         de ese pais, y que ese mercado este publicado en <b>Target sellers</b> de la app.</p>`,
        '#ff6b6b');
    }
    tienda = suya;
  } else if (!fallo) {
    tienda = lista[0] || {};
    if (lista.length > 1) {
      fallo = 'OJO: el permiso llega a ' + lista.length + ' tiendas y se ha guardado la primera.\n' +
              comoSalen() + '\nSi querias otra, autoriza con un nombre acabado en el pais (billys_de).';
    }
  }

  await T.guardar(cuenta, {
    tienda_id: aTexto(tienda.id),
    tienda_cifra: aTexto(tienda.cipher),
    tienda_nombre: aTexto(tienda.name || d.seller_name),
    region: aTexto(tienda.region || d.seller_base_region),
    abierto_id: aTexto(d.open_id),
    acceso: d.access_token,
    acceso_hasta: enSegundos(d.access_token_expire_in),
    refresco: aTexto(d.refresh_token),
    refresco_hasta: enSegundos(d.refresh_token_expire_in)
  });

  return pagina(res, 'Tienda conectada',
    `<p>Guardado como <b>${escapar(cuenta)}</b>.</p>
     <p>Tienda: <b>${escapar(tienda.name || d.seller_name || '(sin nombre)')}</b><br>
        Region: <b>${escapar(tienda.region || d.seller_base_region || '—')}</b><br>
        Shop cipher: <b>${tienda.cipher ? 'si' : 'NO'}</b></p>
     ${fallo ? `<pre>${escapar(fallo)}</pre>` : ''}
     <p>Ya puedes cerrar esta pestaña.</p>`, '#3ddc97');
});
