/* /api/salud — para saber qué falta sin adivinar.
 *
 * Abierta a propósito, pero no enseña nada que valga: dice si cada pieza está
 * puesta (sí/no), nunca su valor. Los conteos solo con el código de lectura.
 *
 * Cuando algo no funcione, esta es la primera dirección que hay que abrir.
 */
const { db, puerta, puedeLeer, diaDeHoy } = require('./_lib');

module.exports = puerta(async (req, res) => {
  const s = db();
  const hoy = diaDeHoy();

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
