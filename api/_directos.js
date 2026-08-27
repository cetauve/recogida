/* De que cuenta es cada producto. La pieza que faltaba.
 *
 * EL PROBLEMA: en cada directo se crea un articulo de subasta nuevo, asi que
 * el identificador de producto cambia cada noche y no se puede escribir en
 * ningun sitio a mano. Y el pedido NO dice de que cuenta viene: ni la busqueda
 * de pedidos, ni el detalle, ni la API de afiliacion.
 *
 * LA SALIDA: las analiticas del directo. Ahi si esta el nombre.
 *
 *   /analytics/202509/shop_lives/performance   -> los directos, con username
 *   /analytics/202512/shop/{id}/products_performance -> que se vendio en cada uno
 *
 * Encadenando las dos:
 *   producto 1729901714188572841 -> directo 7676808947009489686 -> billysvlc
 *
 * Comprobado con datos reales el 23 ago 2026.
 *
 * SE GUARDA LO APRENDIDO. Un articulo de subasta se usa en un directo y ya:
 * en cuanto se sabe de quien es, no cambia nunca mas. Preguntarlo dos veces
 * seria gastar llamadas para volver a saber lo mismo.
 *
 * OJO CON EL RETRASO: las analiticas van un dia por detras
 * (`latest_available_date`). El directo de anoche esta; el de hace dos horas
 * puede que todavia no. Por eso esto no es la unica via y quien llama tiene
 * que saber vivir con un "no lo se" en vez de inventarse un nombre.
 */
const { db, aTexto } = require('./_lib');
const T = require('./_tiktok');

const ESQUEMA = [
  `create table if not exists tiktok_productos (
     producto text primary key,
     cuenta   text not null default '',
     directo  text not null default '',
     titulo   text not null default '',
     visto    timestamptz not null default now()
   )`
];

let creando = null;
function asegurarTablas() {
  if (creando) return creando;
  creando = (async () => {
    const s = db();
    for (const x of ESQUEMA) await s.unsafe(x);
  })().catch((e) => { creando = null; throw e; });
  return creando;
}

/* TRES DIAS, NO DIEZ. El articulo que se busca es el de anoche: esta en los
 * directos de hoy o de ayer. Y desde el 27 ago 2026 hay que recorrer TODOS los
 * directos del dia para poder compararlos entre si (ver cuentaDe), asi que
 * cada dia de mas son tres llamadas de mas. */
const DIAS_ATRAS = 3;
const LIMITE_MS = 9000;

const soloFecha = (d) => new Date(d).toISOString().slice(0, 10);

/* Los directos de la tienda, del mas reciente al mas viejo. El nombre de la
 * cuenta viene en `username`. */
async function directos(cuenta, dias = DIAS_ATRAS) {
  const hoy = Date.now();
  const r = await T.comoCuenta(cuenta, {
    camino: '/analytics/202509/shop_lives/performance',
    params: {
      start_date_ge: soloFecha(hoy - dias * 86400000),
      end_date_lt: soloFecha(hoy + 86400000),
      page_size: 50
    }
  });
  if (!r || r.code !== 0) return [];
  const lista = ((r.data && r.data.live_stream_sessions) || []).map((x) => ({
    id: aTexto(x.id),
    cuenta: aTexto(x.username),
    empezo: x.start_time ? Number(x.start_time) * 1000 : null,
    acabo: x.end_time ? Number(x.end_time) * 1000 : null,
    prendas: (x.sales_performance && x.sales_performance.items_sold) || 0,
    gmv: (x.sales_performance && x.sales_performance.gmv && Number(x.sales_performance.gmv.amount)) || 0
  }));
  lista.sort((a, b) => (b.empezo || 0) - (a.empezo || 0));
  return lista;
}

async function productosDe(cuenta, directoId) {
  const r = await T.comoCuenta(cuenta, {
    camino: '/analytics/202512/shop/' + encodeURIComponent(directoId) + '/products_performance',
    params: { page_size: 50 }
  });
  if (!r || r.code !== 0) return [];
  return ((r.data && r.data.products) || []).map((p) => ({
    id: aTexto(p.id),
    titulo: aTexto(p.name),
    vendidas: (p.sales && p.sales.items_sold) || 0
  }));
}

async function loGuardado(ids) {
  await asegurarTablas();
  if (!ids.length) return new Map();
  const s = db();
  const filas = await s`select producto, cuenta from tiktok_productos where producto = any(${ids})`;
  return new Map(filas.filter((f) => f.cuenta).map((f) => [f.producto, f.cuenta]));
}

async function guardar(producto, cuenta, directo, titulo) {
  await asegurarTablas();
  const s = db();
  await s`
    insert into tiktok_productos (producto, cuenta, directo, titulo, visto)
    values (${producto}, ${cuenta}, ${directo}, ${titulo}, now())
    on conflict (producto) do update set
      cuenta = case when excluded.cuenta = '' then tiktok_productos.cuenta else excluded.cuenta end,
      directo = excluded.directo, titulo = excluded.titulo, visto = now()
    where tiktok_productos.directo <> 'a mano' or excluded.directo = 'a mano'`;
}

/* De que cuenta es cada uno de estos productos.
 *
 * Primero lo guardado, que no cuesta nada. Solo si queda alguno sin saber se
 * baja a las analiticas, y se recorren los directos del mas reciente al mas
 * viejo: el articulo de anoche esta en el primero o el segundo, asi que en la
 * practica son una o dos llamadas, no catorce. */
async function cuentaDe(cuenta, ids) {
  const unicos = [...new Set((ids || []).map(aTexto).filter(Boolean))];
  const mapa = await loGuardado(unicos);
  const faltan = new Set(unicos.filter((x) => !mapa.has(x)));
  if (!faltan.size) return { mapa, sinSaber: [], consultados: 0 };

  const t0 = Date.now();
  let consultados = 0;
  const lista = await directos(cuenta);

  /* =========================================================================
   * GANA EL DIRECTO DONDE MAS SE VENDIO, NO EL PRIMERO QUE LO NOMBRA.
   * =========================================================================
   * EL FALLO DEL 25 Y DEL 26 AGO 2026, con cientos de prendas mal rotuladas.
   *
   * TikTok lista el MISMO producto en las analiticas de varios directos, tambien
   * en los de las otras cuentas, con las unidades vendidas al lado. El 26 decia:
   *
   *     directo de billysvlc      -> producto ...614761: 350 vendidas
   *     directo de billystourvlc  -> producto ...614761:   0 vendidas
   *     directo de billystacos    -> producto ...614761:   0 vendidas
   *
   * El dueno es evidente: el unico donde se vendio algo. Pero esto se quedaba
   * con el PRIMERO de la lista que lo nombrara —y la lista va del mas reciente
   * al mas viejo—, sin mirar las unidades ni una vez. `vendidas` se pedia, se
   * recibia, se mapeaba y no se usaba nunca.
   *
   * Ahora: las apariciones con CERO ventas se tiran, y de las que quedan gana la
   * de mas unidades. Y no se decide hasta haber visto todos los directos de ese
   * dia, porque comparar exige tenerlos los tres delante. */
  const mejor = new Map();
  let diaBueno = null;
  const sinCandidato = () => [...faltan].filter((x) => !mejor.has(x)).length;

  for (const d of lista) {
    if (Date.now() - t0 > LIMITE_MS) break;
    if (!d.cuenta) continue;
    const dia = d.empezo ? soloFecha(d.empezo) : '';
    if (!sinCandidato() && diaBueno && dia !== diaBueno) break;

    consultados++;
    const productos = await productosDe(cuenta, d.id);
    for (const p of productos) {
      if (!p.id) continue;
      /* Cero ventas no es una pista: es el mismo articulo asomando en el
       * directo de otra cuenta. Guardarlo fue lo que rompio el perchero. */
      if (!p.vendidas) continue;
      const ya = mejor.get(p.id);
      if (!ya || p.vendidas > ya.vendidas) {
        mejor.set(p.id, { cuenta: d.cuenta, directo: d.id, titulo: p.titulo, vendidas: p.vendidas });
      }
      if (faltan.has(p.id) && !diaBueno) diaBueno = dia;
    }
  }

  /* Se escribe al final, con el ganador ya decidido. Antes se guardaba dentro
   * del bucle y la base acababa diciendo una cosa distinta de la que devolvia
   * esta misma llamada. */
  for (const [id, m] of mejor) {
    await guardar(id, m.cuenta, m.directo, m.titulo);
    if (faltan.has(id)) { mapa.set(id, m.cuenta); faltan.delete(id); }
  }

  return { mapa, sinSaber: [...faltan], consultados };
}

module.exports = { asegurarTablas, directos, productosDe, cuentaDe, guardar };
