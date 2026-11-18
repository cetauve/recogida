/* Billy's · conexion del chat por Supabase Realtime (Broadcast) · 0.75.0
 *
 * El MISMO fichero va en la extension y en la web. Habla el protocolo de
 * Realtime a pelo (sin libreria): unirse a una sala, mandar y recibir
 * "broadcast", y un latido cada 25 s para que no se cierre.
 *
 * POR QUE BROADCAST Y NO LA BASE DE DATOS. Broadcast no escribe filas: el
 * mensaje pasa de un lado a otro y desaparece. El chat no toca ni el
 * servidor de las subastas (/api/tandas) ni la tabla directo_vivo. Es lo que
 * evita repetir lo del 22 y el 26 sep, cuando las llamadas de mas tumbaron
 * el servidor.
 *
 * LA SALA de cada directo sale del codigo de lectura y del canal (es-1, de...)
 * pasados por SHA-256: quien no tenga el codigo no puede adivinarla.
 */
var BillysRealtime = (function () {
  'use strict';

  function limpiarCanal(x) {
    return String(x || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  }

  function sala(codigo, canal) {
    var datos = new TextEncoder().encode('billys-chat|' + String(codigo || '') + '|' + limpiarCanal(canal));
    return crypto.subtle.digest('SHA-256', datos).then(function (h) {
      var b = new Uint8Array(h), s = '';
      for (var i = 0; i < 12; i++) s += ('0' + b[i].toString(16)).slice(-2);
      return 'chat-' + s;
    });
  }

  /* opts: { url, key, sala, alEvento(payload), alEstado('conectando'|'ok'|'caido') } */
  function Conexion(opts) {
    var ws = null, ref = 0, unido = false, cerrado = false, espera = 2000;
    var latido = null, reintento = null, joinRef = null, pendientes = [];
    var topic = 'realtime:' + opts.sala;
    var estado = function (e) { try { opts.alEstado && opts.alEstado(e); } catch (x) {} };

    function mandar(o) {
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
      return false;
    }

    function abrir() {
      if (cerrado) return;
      clearTimeout(reintento);
      estado('conectando');
      var base = String(opts.url || '').replace(/\/+$/, '').replace(/^http/, 'ws');
      try {
        ws = new WebSocket(base + '/realtime/v1/websocket?apikey=' + encodeURIComponent(opts.key) + '&vsn=1.0.0');
      } catch (e) { return reintentar(); }
      ws.onopen = function () {
        joinRef = String(++ref);
        mandar({ topic: topic, event: 'phx_join', ref: joinRef, join_ref: joinRef, payload: {
          config: { broadcast: { ack: false, self: false }, presence: { key: '' }, postgres_changes: [], private: false },
          access_token: opts.key
        } });
        clearInterval(latido);
        latido = setInterval(function () {
          mandar({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) });
        }, 25000);
      };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || m.topic !== topic) return;
        if (m.event === 'phx_reply' && m.ref === joinRef) {
          if (m.payload && m.payload.status === 'ok') {
            unido = true; espera = 2000; estado('ok');
            var p = pendientes; pendientes = [];
            for (var i = 0; i < p.length; i++) enviar(p[i]);
          } else { estado('caido'); try { ws.close(); } catch (e) {} }
        } else if (m.event === 'broadcast' && m.payload && m.payload.event === 'chat') {
          try { opts.alEvento && opts.alEvento(m.payload.payload); } catch (e) {}
        } else if (m.event === 'phx_error' || m.event === 'phx_close') {
          try { ws.close(); } catch (e) {}
        }
      };
      ws.onclose = function () { unido = false; clearInterval(latido); if (!cerrado) { estado('caido'); reintentar(); } };
      ws.onerror = function () { /* onclose viene detras */ };
    }

    /* Si se cae, se espera el doble cada vez, hasta un minuto. */
    function reintentar() {
      clearTimeout(reintento);
      reintento = setTimeout(abrir, espera);
      espera = Math.min(espera * 2, 60000);
    }

    function enviar(payload) {
      if (!unido) { if (pendientes.length < 20) pendientes.push(payload); return false; }
      return mandar({ topic: topic, event: 'broadcast', ref: String(++ref), join_ref: joinRef,
                      payload: { type: 'broadcast', event: 'chat', payload: payload } });
    }

    function cerrar() {
      cerrado = true; unido = false; clearInterval(latido); clearTimeout(reintento);
      try { ws && ws.close(); } catch (e) {}
      ws = null;
    }

    abrir();
    return { enviar: enviar, cerrar: cerrar, unido: function () { return unido; } };
  }

  return { limpiarCanal: limpiarCanal, sala: sala, Conexion: Conexion };
})();
