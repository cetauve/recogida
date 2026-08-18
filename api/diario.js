/* /api/diario — la caja negra del panel de almacén.
 *
 *   POST { fase, quien?, eventos:[{t, que, ...}] }   token de escritura
 *   GET  ?d=CODIGO[&dia=YYYY-MM-DD][&fase=1][&n=3]   código de lectura
 *
 * POR QUÉ EXISTE
 *
 * 18 ago 2026. Aaron: "la lectura y la cancelación funcionan sobre todo cuando
 * tengo delante la pantalla en la que el código está trabajando, es como si al
 * mirarla fuera mejor". Tiene razón y no es magia: Chrome estrangula los
 * temporizadores de las ventanas que no se ven —una ventana tapada por otra
 * cuenta como oculta— y el recorrido entero se arrastra o se corta por reloj.
 *
 * Pero eso hay que MEDIRLO, no suponerlo. Y lo mismo con "cancelar no va bien":
 * sin saber qué botón se pulsó, cuándo, y si lo pulsó una persona o el
 * programa, cada intento de arreglo es a ciegas.
 *
 * Así que el panel manda aquí lo que hace, paso a paso, con la hora de verdad,
 * si la ventana estaba visible u oculta en ese momento, y quién pulsó cada
 * botón —el navegador lo dice: `isTrusted` es true solo si lo pulsó una
 * persona—. Se guarda por día y se lee desde fuera, sin tener que estar
 * delante del ordenador del almacén.
 *
 * NO ES UN REGISTRO DE TRABAJO NI SE USA PARA NADA MÁS. Son eventos técnicos
 * para poder arreglar el programa; se pueden borrar cuando se quiera.
 */
const {
  db, puerta, puedeEscribir, puedeLeer, noAutorizado,
  diaDe, aEntero, aTexto, cuerpo
} = require('./_lib');

const MAX_EVENTOS = 4000;   // una fase larga son unos cientos; 4000 es de sobra

module.exports = puerta(async (req, res) => {
  const s = db();

  await s`
    create table if not exists diario (
      id      bigserial primary key,
      dia     text not null,
      fase    text not null default '',
      quien   text not null default '',
      cuando  timestamptz not null default now(),
      eventos jsonb not null default '[]'::jsonb
    )`;
  await s`create index if not exists diario_dia on diario (dia, cuando desc)`;

  if (req.method === 'POST') {
    if (!puedeEscribir(req)) return noAutorizado(res, 'escribir');
    const b = cuerpo(req);
    const dia = diaDe(b.dia);
    const eventos = (Array.isArray(b.eventos) ? b.eventos : []).slice(0, MAX_EVENTOS);
    if (!eventos.length) return res.status(400).json({ ok: false, error: 'sin-eventos' });
    const [f] = await s`
      insert into diario (dia, fase, quien, eventos)
      values (${dia}, ${aTexto(b.fase)}, ${aTexto(b.quien)}, ${s.json(eventos)})
      returning id`;
    return res.status(200).json({ ok: true, dia, id: f.id, eventos: eventos.length });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const q = req.query || {};
    const dia = diaDe(q.dia);
    const cuantas = Math.min(20, Math.max(1, aEntero(q.n) || 3));
    const fase = aTexto(q.fase).trim();
    const filas = fase
      ? await s`select id, dia, fase, quien, cuando, eventos from diario
                 where dia = ${dia} and fase = ${fase} order by cuando desc limit ${cuantas}`
      : await s`select id, dia, fase, quien, cuando, eventos from diario
                 where dia = ${dia} order by cuando desc limit ${cuantas}`;
    /* El resumen de arriba es lo que se mira primero: cuánto duró, cuánto
     * tiempo estuvo la ventana oculta y quién pulsó qué. El detalle está
     * debajo para cuando haga falta. */
    const resumen = filas.map((f) => {
      const ev = Array.isArray(f.eventos) ? f.eventos : [];
      const t0 = ev.length ? ev[0].t : null;
      const t1 = ev.length ? ev[ev.length - 1].t : null;
      const cuenta = {};
      let ocultaMs = 0, desdeOculta = null;
      for (const e of ev) {
        cuenta[e.que] = (cuenta[e.que] || 0) + 1;
        if (e.vis === 'hidden' && desdeOculta === null) desdeOculta = e.t;
        if (e.vis === 'visible' && desdeOculta !== null) { ocultaMs += e.t - desdeOculta; desdeOculta = null; }
      }
      if (desdeOculta !== null && t1) ocultaMs += t1 - desdeOculta;
      return {
        id: f.id, fase: f.fase, quien: f.quien, cuando: f.cuando,
        eventos: ev.length,
        duracionMs: t0 && t1 ? t1 - t0 : null,
        ocultaMs,
        clicsDePersona: ev.filter((e) => e.que === 'clic' && e.persona === true).length,
        clicsDelPrograma: ev.filter((e) => e.que === 'clic' && e.persona === false).length,
        porTipo: cuenta
      };
    });
    return res.status(200).json({ ok: true, dia, resumen, filas });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
