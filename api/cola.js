/* /api/cola — la cola de empaquetado.
 *
 *   POST { accion:'meter',     quien, paquetes:[{pedido, apodo, prendas, tanda, ficha, en}] }
 *   POST { accion:'siguiente', quien }
 *   POST { accion:'cerrar',    quien, pedido }
 *   POST { accion:'soltar',    quien, pedido }
 *   GET  ?d=CODIGO&dia=YYYY-MM-DD
 *
 * PARA QUÉ EXISTE
 * Hasta hoy, quien recogía y quien empaquetaba recorrían la MISMA lista, cada
 * uno en su móvil, y se cruzaban al final por comprador. Eso funciona con una
 * pareja fija. No funciona cuando hay un solo recogedor y tres personas
 * doblando, que es como se trabaja de verdad: no hay forma de que los tres
 * sepan cuál coger sin gritárselo, y dos acaban haciendo el mismo paquete.
 *
 * Así que el recogedor deja de mandar una lista y pasa a EMPUJAR: cada vez que
 * desliza un paquete, ese paquete entra aquí. Los que empaquetan no eligen:
 * piden "el siguiente" y el servidor reparte.
 *
 * EL REPARTO
 * `for update skip locked` es lo único que garantiza que a dos móviles no les
 * toque el mismo paquete cuando pulsan en el mismo instante. Sin eso, dos
 * transacciones leen la misma fila "en espera" y las dos se la llevan. No es
 * un caso raro: con tres personas pidiendo trabajo pasa el primer día.
 *
 * Si quien pide ya tiene uno a medias, se le devuelve EL SUYO en vez de darle
 * otro. Así recargar la página o volver de la pantalla de bloqueo no deja
 * paquetes huérfanos ni le quita el trabajo de las manos.
 *
 * ESCRIBE CON EL CÓDIGO, NO CON EL TOKEN
 * Por lo mismo que /api/toques y /api/tiempos: los móviles del almacén abren la
 * página con el código en la dirección. Si escribir aquí exigiera el token, el
 * token acabaría en la dirección de un móvil compartido.
 */
const {
  db, puerta, puedeLeer, noAutorizado, diaDe, aFecha, aEntero, aTexto, cuerpo
} = require('./_lib');

/* A partir de cuántos minutos un paquete cogido y no cerrado se considera
 * atascado. Doce: los paquetes que se cierran bien tardan de uno a cinco
 * minutos, así que doce es holgado de sobra para uno difícil y corto para
 * que nadie espere media hora por un móvil que se apagó. */
const ATASCO_MIN = 12;

/* Los dos extremos del reloj de un paquete se guardan además en `tiempos`, que
 * es de donde tira la página /tiempos. Así la cola no obliga a reescribir esa
 * página ni parte el histórico en dos sitios. */
async function apuntarTiempo(s, { dia, quien, modo, pedido, apodo, prendas, en }) {
  if (!quien || !pedido || !en) return;
  await s`
    insert into tiempos (dia, quien, modo, equipo, pedido, apodo, prendas, en, estado)
    values (${dia}, ${quien}, ${modo}, '', ${pedido}, ${apodo || null}, ${prendas}, ${en}, 'listo')
    on conflict (dia, quien, pedido, estado) do update set
      en      = excluded.en,
      prendas = coalesce(excluded.prendas, tiempos.prendas),
      apodo   = coalesce(excluded.apodo, tiempos.apodo)`;
}

module.exports = puerta(async (req, res) => {
  const s = db();

  if (req.method === 'POST') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const b = cuerpo(req);
    const dia = diaDe(b.dia);
    const quien = aTexto(b.quien).trim();
    const accion = aTexto(b.accion) || 'meter';

    /* ------------------------------------------------------------ METER
     * Lo llama el recogedor cada vez que desliza. Manda SIEMPRE todo lo que
     * lleva deslizado, no solo lo último: si un envío se perdió por falta de
     * cobertura, el siguiente lo arregla solo. Por eso `do nothing` — repetir
     * un paquete que ya está en la cola no puede tocarlo, que a lo mejor ya lo
     * está haciendo alguien. */
    if (accion === 'meter') {
      const brutos = (Array.isArray(b.paquetes) ? b.paquetes : [])
        .map((x) => ({
          pedido: aTexto(x.pedido).trim(),
          apodo: aTexto(x.apodo),
          tanda: aTexto(x.tanda),
          prendas: aEntero(x.prendas),
          ficha: x.ficha && typeof x.ficha === 'object' ? x.ficha : {},
          en: aFecha(x.en || x.t) || new Date()
        }))
        .filter((x) => x.pedido);
      if (!brutos.length) return res.status(400).json({ ok: false, error: 'sin-paquetes' });

      /* El número de paquete es lo que la gente se dice en voz alta ("voy con
       * el 12"). Tiene que ser correlativo y no saltar huecos, así que se
       * numera solo lo que de verdad es nuevo y se calcula desde el máximo que
       * ya hay guardado ese día. */
      const yaHay = await s`select pedido from cola where dia = ${dia}`;
      const dentro = new Set(yaHay.map((x) => x.pedido));
      const nuevos = brutos.filter((x) => !dentro.has(x.pedido));

      let metidos = 0;
      if (nuevos.length) {
        const [mx] = await s`select coalesce(max(numero), 0)::int as n from cola where dia = ${dia}`;
        const filas = nuevos.map((x, k) => ({
          dia, pedido: x.pedido, numero: mx.n + k + 1,
          apodo: x.apodo, tanda: x.tanda, prendas: x.prendas,
          /* s.json y no JSON.stringify: en una columna jsonb, una cadena se
           * guarda COMO cadena y al leerla vuelve texto, no la ficha. */
          ficha: s.json(x.ficha), estado: 'espera',
          quien_abrio: quien, abierto_en: x.en
        }));
        await s`
          insert into cola ${s(filas, 'dia', 'pedido', 'numero', 'apodo', 'tanda',
                              'prendas', 'ficha', 'estado', 'quien_abrio', 'abierto_en')}
          on conflict (dia, pedido) do nothing`;
        metidos = filas.length;

        /* El "listo" del recogedor es ABRIR el paquete: ahí arranca el reloj
         * del que empaqueta. Se apunta en el mismo gesto. */
        for (const x of nuevos) {
          await apuntarTiempo(s, { dia, quien, modo: 'recoge', pedido: x.pedido,
                                   apodo: x.apodo, prendas: x.prendas, en: x.en });
        }
      }

      const [c] = await s`
        select count(*) filter (where estado = 'espera')::int   as espera,
               count(*) filter (where estado = 'haciendo')::int as haciendo,
               count(*) filter (where estado = 'cerrado')::int  as cerrado
        from cola where dia = ${dia}`;
      return res.status(200).json({ ok: true, dia, metidos, recibidos: brutos.length, ...c });
    }

    if (!quien) return res.status(400).json({ ok: false, error: 'sin-quien' });

    /* --------------------------------------------------------- SIGUIENTE */
    if (accion === 'siguiente') {
      /* Primero, lo suyo. Recargar la página no puede costarle el paquete que
       * tiene en la mesa ni pedir otro encima. */
      const mio = await s`
        select * from cola
        where dia = ${dia} and estado = 'haciendo' and quien_cierra = ${quien}
        order by numero limit 1`;
      if (mio.length) return res.status(200).json({ ok: true, dia, hay: true, yaLoTenias: true, paquete: mio[0] });

      /* El reparto. El `skip locked` hace que dos móviles que pulsan a la vez
       * se lleven filas distintas en vez de pelearse por la misma. */
      const dado = await s`
        with elegido as (
          select pedido from cola
          where dia = ${dia} and estado = 'espera'
          order by numero
          for update skip locked
          limit 1
        )
        update cola c
           set estado = 'haciendo', quien_cierra = ${quien}, tomado_en = now()
          from elegido e
         where c.dia = ${dia} and c.pedido = e.pedido
        returning c.*`;
      if (dado.length) return res.status(200).json({ ok: true, dia, hay: true, paquete: dado[0] });

      /* --------------------------------------------------- LOS ATASCADOS
       * Un paquete que alguien cogió y nunca cerró se queda fuera de la
       * circulación para siempre: nadie más puede pedirlo. Pasa el primer
       * día —se va a comer, cierra la pestaña, cambia de móvil— y el paquete
       * no vuelve solo.
       *
       * No se sueltan solos cada X minutos: eso se lo quitaría de las manos
       * a quien está con uno difícil de verdad. Se rescatan solo cuando NO
       * QUEDA NADA MÁS QUE HACER, que es cuando el rescate no le quita el
       * trabajo a nadie y sí desatasca el día. Y se avisa de quién lo tenía,
       * para que lo compruebe antes de cerrarlo. */
      const rescatado = await s`
        with elegido as (
          select pedido, quien_cierra as antes, tomado_en as desde from cola
          where dia = ${dia} and estado = 'haciendo'
            and quien_cierra <> ${quien}
            and tomado_en < now() - ${ATASCO_MIN + ' minutes'}::interval
          order by tomado_en
          for update skip locked
          limit 1
        )
        update cola c
           set quien_cierra = ${quien}, tomado_en = now()
          from elegido e
         where c.dia = ${dia} and c.pedido = e.pedido
        returning c.*, e.antes, e.desde`;
      if (rescatado.length) {
        return res.status(200).json({ ok: true, dia, hay: true, rescatado: true,
          loTenia: rescatado[0].antes,
          minutos: Math.round((Date.now() - new Date(rescatado[0].desde)) / 60000),
          paquete: rescatado[0] });
      }

      const [c] = await s`
        select count(*) filter (where estado = 'haciendo')::int as haciendo,
               count(*) filter (where estado = 'cerrado')::int  as cerrado
        from cola where dia = ${dia}`;
      return res.status(200).json({ ok: true, dia, hay: false, ...c });
    }

    /* ------------------------------------------------------------ CERRAR */
    if (accion === 'cerrar') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const en = aFecha(b.en || b.t) || new Date();
      const fila = await s`
        update cola set estado = 'cerrado', cerrado_en = ${en},
                        quien_cierra = case when quien_cierra = '' then ${quien} else quien_cierra end
         where dia = ${dia} and pedido = ${pedido}
        returning *`;
      if (!fila.length) return res.status(404).json({ ok: false, error: 'no-esta-en-la-cola' });

      await apuntarTiempo(s, { dia, quien, modo: 'empaqueta', pedido,
                               apodo: fila[0].apodo, prendas: fila[0].prendas, en });

      const [c] = await s`
        select count(*) filter (where estado = 'espera')::int  as espera,
               count(*) filter (where estado = 'cerrado')::int as cerrado
        from cola where dia = ${dia}`;
      return res.status(200).json({ ok: true, dia, pedido, ...c });
    }

    /* ------------------------------------------------------------- TANDA
     * Quien recoge dice en qué tanda está y por dónde va. No es un candado
     * duro: es para que el otro lo VEA antes de meterse en la misma.
     *
     * Se puede quitar una tanda a alguien solo si lleva un rato largo sin dar
     * señales. Alguien que deja el móvil en la mesa diez minutos sigue
     * trabajando; alguien que cerró la pestaña hace media hora, no. */
    if (accion === 'tanda') {
      const tanda = aTexto(b.tanda).trim();
      if (!tanda) return res.status(400).json({ ok: false, error: 'sin-tanda' });
      const hechos = aEntero(b.hechos) || 0;
      const total = aEntero(b.total);
      const forzar = !!b.forzar;

      const [fila] = await s`
        insert into tandas_toma (dia, tanda, quien, hechos, total, actualizado)
        values (${dia}, ${tanda}, ${quien}, ${hechos}, ${total}, now())
        on conflict (dia, tanda) do update set
          quien       = case when tandas_toma.quien = ''
                              or tandas_toma.quien = ${quien}
                              or ${forzar}
                              or tandas_toma.actualizado < now() - interval '20 minutes'
                             then ${quien} else tandas_toma.quien end,
          hechos      = case when tandas_toma.quien = ${quien} or ${forzar}
                             then ${hechos} else tandas_toma.hechos end,
          total       = coalesce(${total}, tandas_toma.total),
          actualizado = case when tandas_toma.quien = ${quien} or ${forzar}
                             then now() else tandas_toma.actualizado end
        returning quien, hechos, total, actualizado`;

      return res.status(200).json({
        ok: true, dia, tanda,
        /* mia: false significa "esta tanda la está haciendo otro". Quien
         * pregunta decide si entra igual; aquí no se le prohíbe nada. */
        mia: fila.quien === quien,
        quien: fila.quien, hechos: fila.hechos, total: fila.total
      });
    }

    /* ------------------------------------------------------------ SOLTAR
     * Se lo ha pedido y no puede hacerlo (le falta una prenda, se va a comer).
     * Vuelve a la cola para que lo coja otro, en su sitio de siempre. */
    if (accion === 'soltar') {
      const pedido = aTexto(b.pedido).trim();
      if (!pedido) return res.status(400).json({ ok: false, error: 'sin-pedido' });
      const fila = await s`
        update cola set estado = 'espera', quien_cierra = '', tomado_en = null
         where dia = ${dia} and pedido = ${pedido} and estado = 'haciendo'
        returning pedido`;
      return res.status(200).json({ ok: true, dia, soltado: fila.length > 0 });
    }

    return res.status(400).json({ ok: false, error: 'accion-desconocida' });
  }

  if (req.method === 'GET') {
    if (!puedeLeer(req)) return noAutorizado(res, 'leer');
    const dia = diaDe((req.query || {}).dia);

    /* Sin la ficha: para ver cómo va la cola no hacen falta los números de
     * cada paquete, y son cuatrocientos. La ficha solo viaja cuando alguien
     * pide un paquete concreto para hacerlo. */
    const filas = await s`
      select pedido, numero, apodo, tanda, prendas, estado,
             quien_abrio, abierto_en, quien_cierra, tomado_en, cerrado_en
      from cola where dia = ${dia} order by numero`;

    const gente = {};
    for (const f of filas) {
      if (f.estado === 'cerrado' && f.quien_cierra) {
        const g = gente[f.quien_cierra] = gente[f.quien_cierra] || { quien: f.quien_cierra, cerrados: 0, prendas: 0 };
        g.cerrados++; g.prendas += (f.prendas || 0);
      }
    }

    /* Quién anda por cada tanda. Las que llevan mucho paradas se devuelven
     * marcadas como frías, para que el menú no diga "la hace Luis" de alguien
     * que se fue hace media hora. */
    const tandas = await s`
      select tanda, quien, hechos, total, actualizado,
             (actualizado < now() - interval '20 minutes') as fria
      from tandas_toma where dia = ${dia} order by tanda`;

    /* "Haciendo" y "atascado" no son lo mismo y confundirlos hace que nadie
     * mire: uno es trabajo en marcha y el otro es trabajo parado. */
    const limite = Date.now() - ATASCO_MIN * 60000;
    return res.status(200).json({
      ok: true, dia, tandas,
      espera:   filas.filter((f) => f.estado === 'espera').length,
      atascados: filas.filter((f) => f.estado === 'haciendo' &&
                   f.tomado_en && new Date(f.tomado_en).getTime() < limite).length,
      haciendo: filas.filter((f) => f.estado === 'haciendo').length,
      cerrado:  filas.filter((f) => f.estado === 'cerrado').length,
      gente: Object.values(gente),
      paquetes: filas
    });
  }

  return res.status(405).json({ ok: false, error: 'metodo' });
});
