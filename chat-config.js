/* Billy's · ajustes del chat para las tablets. Las MISMAS que chat-config.js
 * de la extension: Supabase > Project Settings > API, la "anon" o
 * "publishable" key. NUNCA la "service_role" ni la "secret".
 * Antes de rellenar esto, en Supabase tiene que estar apagada la Data API
 * (o todas las tablas con RLS): esta key se ve en la web.
 * canales: la pestana Comments SOLO sale en las tablets de estos canales
 * (piloto). Vacia o quitada = en todas. */
var BILLYS_CHAT_CONFIG = {
  supabaseUrl: 'https://okfogogchjldniiebqrz.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rZm9nb2djaGpsZG5paWVicXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MjQyNTIsImV4cCI6MjEwMjIwMDI1Mn0.ewUO-InVuX730foDAWqcBOjX1kOrev1-h3gB-LiYBAc',
  canales: ['de', 'de2']
};
