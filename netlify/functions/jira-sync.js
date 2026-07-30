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
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'No se pudo leer la configuración de Supabase.', detail: t }) };
    }

    const rows = await configResp.json();
    const config = rows[0];

    if (!config || !config.dominio || !config.email || !config.api_token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Todavía no configuraste la conexión a Jira. Guardala desde el modal del dashboard.' }) };
    }

    // 2. Armar el JQL (usa el personalizado si existe, si no, arma uno con la clave de proyecto)
    const jql = config.jql && config.jql.trim()
      ? config.jql
      : `project = ${config.clave_proyecto} ORDER BY updated DESC`;

    // 3. Llamar a la API de Jira Cloud (Basic Auth con email + API token)
    const authHeader = 'Basic ' + Buffer.from(`${config.email}:${config.api_token}`).toString('base64');

    let allIssues = [];
    let fieldNames = {};
    let nextPageToken = null;

    // 3a. Descubrir los campos personalizados que necesitamos (una sola llamada liviana)
    const fieldsListResp = await fetch(`https://${config.dominio}/rest/api/3/field`, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
    });
    let neededCustomIds = [];
    if (fieldsListResp.ok) {
      const allFields = await fieldsListResp.json();
      const wanted = ['story point estimate', 'story points', 'fecha de inicio', 'start date', 'sprint'];
      allFields.forEach(f => {
        fieldNames[f.id] = f.name;
        if (wanted.includes((f.name||'').toLowerCase())) neededCustomIds.push(f.id);
      });
    }

    const baseFields = ['summary','status','assignee','duedate','resolutiondate','updated','created',
      'issuetype','parent','priority','labels','reporter'];
    const fieldsToRequest = [...baseFields, ...neededCustomIds];

    // 3b. Buscar los issues, pidiendo solo los campos necesarios (no *all) para no exceder el límite de tamaño de Netlify
    while (allIssues.length < 2000) {
      const jiraUrl = `https://${config.dominio}/rest/api/3/search/jql`;
      const body = {
        jql,
        maxResults: 100,
        fields: fieldsToRequest
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const jiraResp = await fetch(jiraUrl, {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!jiraResp.ok) {
        const t = await jiraResp.text();
        return {
          statusCode: jiraResp.status, headers,
          body: JSON.stringify({ error: 'Jira respondió con un error. Revisá dominio, email y token.', detail: t })
        };
      }

      const data = await jiraResp.json();
      allIssues = allIssues.concat(data.issues || []);

      if (data.isLast || !data.issues || data.issues.length === 0 || !data.nextPageToken) break;
      nextPageToken = data.nextPageToken;
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ issues: allIssues, total: allIssues.length, fieldNames, mapeoEstados: config.mapeo_estados || {} })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error inesperado en el proxy.', detail: String(err) }) };
  }
};
