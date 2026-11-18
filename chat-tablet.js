/* Billy's · comentarios del directo en la tablet · 0.75.0
 *
 * Fichero APARTE de app-directo.html a proposito. No llama a /api/tandas, no
 * lee ni toca nada del lanzamiento de subastas. Si falla, la pestana de
 * comentarios dice "sin conexion" y lo demas sigue igual.
 *
 * Uso:
 *   BillysChat.montar({ caja, estado, codigo, canal, alNuevos, abierto })
 *     caja      elemento donde se pintan los comentarios
 *     estado    elemento (opcional) para "conectado / reconectando"
 *     alNuevos  funcion(n) con los no vistos, para el numerito de la pestana
 *     abierto   funcion() que dice si la pestana esta a la vista
 *
 * Solo en memoria: se guardan los ultimos 60 y se pintan los ultimos 30. Al
 * recargar se pierden, y es lo que se quiere.
 */
var BillysChat = (function () {
  'use strict';
  var GUARDA = 60, PINTA = 30;
  var CLAVES = /\?|talla|tallas|size|gr(o|ö)(ss|ß)e|precio|cu[aá]nto|preis|price|how much|wie viel|env[ií]o|versand|shipping|medida|measure|ma(ss|ß)e|\bcm\b/i;

  /* Estilos propios, metidos desde aqui para no tocar los de app-directo.
   * Todo empieza por "chat-" y usa sus mismas variables de color. */
  function estilos() {
    if (document.getElementById('chat-estilos')) return;
    var s = document.createElement('style');
    s.id = 'chat-estilos';
    s.textContent =
      '.chat-caja{overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:6px;padding:4px 2px 10px}' +
      '.chat-m{background:var(--caja,#fff);border:1px solid var(--borde,#ccd4db);border-radius:12px;padding:9px 13px;' +
        'font-size:18px;line-height:1.35;color:var(--texto,#141a1f);word-wrap:break-word;user-select:none}' +
      '.chat-m b{font-weight:750;color:var(--suave,#5f6b76);margin-right:4px}' +
      '.chat-m.pregunta{border-color:var(--cian,#0e8c80);box-shadow:0 0 0 1px var(--cian,#0e8c80) inset}' +
      '.chat-m.regalo{background:#fff6dc;border-color:#d9a400}' +
      '.chat-m.hecho{opacity:.4}' +
      '.chat-vacio{color:var(--suave,#5f6b76);font-size:17px;padding:30px 6px;text-align:center}';
    document.head.appendChild(s);
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function montar(o) {
    var CFG = (typeof BILLYS_CHAT_CONFIG === 'object' && BILLYS_CHAT_CONFIG) || {};
    estilos();
    var caja = o.caja, eventos = [], vistos = new Set(), respondidos = new Set();
    caja.classList.add('chat-caja');
    var noVistos = 0, conexion = null, pausaHasta = 0, apagadoPorTablet = false;
    var pon = function (txt, malo) { if (o.estado) { o.estado.textContent = txt; o.estado.classList.toggle('malo', !!malo); } };

    if (!CFG.supabaseUrl || !CFG.supabaseKey || typeof BillysRealtime !== 'object') {
      caja.innerHTML = '<div class="chat-vacio">Comments are not set up yet.</div>';
      pon('off', true);
      return { visto: function () {} };
    }
    if (!o.codigo || !o.canal) {
      caja.innerHTML = '<div class="chat-vacio">The link is missing the code or the channel.</div>';
      pon('off', true);
      return { visto: function () {} };
    }

    function pintar() {
      var ultimos = eventos.slice(-PINTA);
      if (!ultimos.length) { caja.innerHTML = '<div class="chat-vacio">No comments yet.</div>'; return; }
      var abajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 40;
      caja.innerHTML = ultimos.map(function (e) {
        var cls = 'chat-m' + (e.tipo === 'gift' ? ' regalo' : (CLAVES.test(e.texto) ? ' pregunta' : '')) +
                  (respondidos.has(e.k) ? ' hecho' : '');
        var texto = e.tipo === 'gift' ? 'sent ' + esc(e.texto) + (e.n > 1 ? ' x' + e.n : '') : esc(e.texto);
        return '<div class="' + cls + '" data-k="' + esc(e.k) + '"><b>' + esc(e.nick || '·') + '</b> ' + texto + '</div>';
      }).join('');
      /* Baja sola al ultimo, salvo que alguien este leyendo mas arriba. */
      if (abajo || Date.now() > pausaHasta) caja.scrollTop = caja.scrollHeight;
    }

    function entra(p) {
      var lista = (p && Array.isArray(p.eventos)) ? p.eventos : [];
      var hay = 0;
      for (var i = 0; i < lista.length; i++) {
        var e = lista[i] || {};
        var k = (e.tipo || 'c') + ':' + (e.id || (e.nick + '|' + e.texto + '|' + e.t));
        if (vistos.has(k) || !e.texto) continue;
        vistos.add(k); hay++;
        eventos.push({ k: k, tipo: e.tipo === 'gift' ? 'gift' : 'comment', nick: String(e.nick || '').slice(0, 40),
                       texto: String(e.texto || '').slice(0, 200), n: Number(e.n) || 1, t: Number(e.t) || Date.now() });
      }
      if (!hay) return;
      if (eventos.length > GUARDA) eventos = eventos.slice(-GUARDA);
      if (vistos.size > 1000) vistos = new Set(eventos.map(function (x) { return x.k; }));
      if (!(o.abierto && o.abierto())) { noVistos += hay; o.alNuevos && o.alNuevos(noVistos); }
      pintar();
    }

    /* Tocar un comentario lo marca como contestado (solo en esta tablet). */
    caja.addEventListener('click', function (ev) {
      var d = ev.target.closest && ev.target.closest('.chat-m');
      if (!d) return;
      var k = d.getAttribute('data-k');
      if (respondidos.has(k)) respondidos.delete(k); else respondidos.add(k);
      d.classList.toggle('hecho');
    });
    caja.addEventListener('scroll', function () {
      if (caja.scrollHeight - caja.scrollTop - caja.clientHeight > 40) pausaHasta = Date.now() + 10000;
    }, { passive: true });

    function conectar() {
      if (conexion || apagadoPorTablet) return;
      BillysRealtime.sala(o.codigo, o.canal).then(function (sala) {
        if (conexion || apagadoPorTablet) return;
        conexion = BillysRealtime.Conexion({
          url: CFG.supabaseUrl, key: CFG.supabaseKey, sala: sala, alEvento: entra,
          alEstado: function (s) { pon(s === 'ok' ? 'live' : s === 'conectando' ? 'connecting…' : 'no connection', s === 'caido'); }
        });
      }).catch(function () { pon('no connection', true); });
    }
    function desconectar() { if (conexion) { conexion.cerrar(); conexion = null; } pon('paused', false); }

    /* Si la tablet se pausa (cartel de "paused" de app-directo), el chat
     * tambien. Se mira el cartel, no se toca su codigo. */
    var parada = document.getElementById('parada');
    if (parada && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () {
        apagadoPorTablet = parada.classList.contains('ver');
        if (apagadoPorTablet) desconectar(); else conectar();
      }).observe(parada, { attributes: true, attributeFilter: ['class'] });
    }
    /* Pantalla apagada o pestana detras mas de 5 minutos: se cierra. */
    var oculta = null;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { oculta = setTimeout(desconectar, 5 * 60 * 1000); }
      else { clearTimeout(oculta); conectar(); }
    });

    pintar();
    conectar();
    return {
      visto: function () { noVistos = 0; o.alNuevos && o.alNuevos(0); pausaHasta = 0; caja.scrollTop = caja.scrollHeight; }
    };
  }

  return { montar: montar };
})();
