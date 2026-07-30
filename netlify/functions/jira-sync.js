// netlify/functions/jira-sync.js
//
// Esta función corre en el SERVIDOR de Netlify, no en el navegador.
// Lee la configuración de Jira desde Supabase (con la clave "service role",
// que puede saltar las reglas de seguridad RLS) y llama a la API de Jira
// desde acá, evitando el problema de CORS. Devuelve los issues en crudo;
// cada dashboard (APP TU, Productos Digitales) transforma esos datos
// a su propio formato en el navegador.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // ⚠️ Configurar en Netlify, nunca en el código

// Busca en el historial de cambios (changelog) la fecha del PRIMER cambio de estado a "En progreso".
// Devuelve un string ISO o null si el ticket nunca pasó por ese estado.
function extraerProgresoDesde(issue) {
  if (!issue.changelog || !Array.isArray(issue.changelog.histories)) return null;
  let earliest = null;
  issue.changelog.histories.forEach(h => {
    (h.items || []).forEach(item => {
      if (item.field === 'status' && item.toString === 'En progreso') {
        const d = new Date(h.created);
        if (!isNaN(d) && (!earliest || d < earliest)) earliest = d;
      }
    });
  });
  return earliest ? earliest.toISOString() : null;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return {
        statusCode: 500, headers,
        body: JSON.stringify({ error: 'Faltan las variables de entorno SUPABASE_URL o SUPABASE_SERVICE_KEY en Netlify.' })
      };
    }

    // 1. Leer la configuración de Jira desde Supabase (con service role, salta RLS)
    const configResp = await fetch(`${SUPABASE_URL}/rest/v1/jira_config?id=eq.1&select=*`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });

    if (!configResp.ok) {
      const t = await configResp.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'No se pudo
