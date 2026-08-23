/**
 * Cloudflare Pages Advanced Mode — _worker.js for finansprotect.com
 * Official Safety Layer & Edge Routing operated by FINANS PROTECT LTD (ЕИК 206497582)
 */

const COMPANYBOOK_API_KEY = "b48fe8cf0c10eedf78148fab73a2e406173caad77205271a940a74df4f7cf8a1";
const N8N_LEAD_WEBHOOK = "https://n8n.openbalancer.com/webhook/fp-lead";
const N8N_EVA_WEBHOOK = "https://n8n.openbalancer.com/webhook/eva-lead";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 2. CompanyBook Real Business & Person Search API
    if (url.pathname === '/api/businesses/search' || url.pathname === '/api/companies/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        return new Response(JSON.stringify({ query: '', results: [], meta: { count: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const startTime = Date.now();
      const apiKey = env.COMPANYBOOK_API_KEY || COMPANYBOOK_API_KEY;
      const cleanDigits = q.replace(/\D/g, '');
      const isEikCandidate = cleanDigits.length === 9 || cleanDigits.length === 13;

      let results = [];

      try {
        if (isEikCandidate) {
          // 1. Exact lookup by UIC/EIK
          const cbResp = await fetch(`https://api.companybook.bg/api/companies/${encodeURIComponent(cleanDigits)}?with_data=true`, {
            headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
          });
          if (cbResp.ok) {
            const rawJson = await cbResp.json();
            const comp = rawJson.company || rawJson;
            if (comp && (comp.uic || comp.companyName || comp.name)) {
              const compName = comp.companyName?.name || comp.name || `Фирма ${cleanDigits}`;
              const mgrs = Array.isArray(comp.managers) ? comp.managers.map(m => m.name) : [];
              if (comp.soleCapitalOwner?.name) mgrs.push(comp.soleCapitalOwner.name);
              results.push({
                uic: comp.uic || cleanDigits,
                name: compName,
                source: 'companybook_uic',
                cached: false,
                lastUpdatedAt: comp.lastUpdated || new Date().toISOString(),
                company: {
                  uic: comp.uic || cleanDigits,
                  name: compName,
                  legalForm: comp.legalForm || 'ЕООД',
                  status: comp.status === 'N' || comp.status === 'Active' ? 'Active' : (comp.status || 'Active'),
                  address: comp.seat?.settlement ? `${comp.seat.settlement}, ${comp.seat.housingEstate || comp.seat.street || ''} ${comp.seat.streetNumber || comp.seat.block || ''}`.trim() : '',
                  representatives: mgrs
                }
              });
            }
          }
        }

        if (results.length === 0) {
          // 2. Search by company name
          const compResp = await fetch(`https://api.companybook.bg/api/companies/search?name=${encodeURIComponent(q)}&limit=5`, {
            headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
          });
          if (compResp.ok) {
            const data = await compResp.json();
            const rawList = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);
            for (const item of rawList) {
              results.push({
                uic: item.uic || item.id || '',
                name: item.name || item.transliteration || `Фирма ${item.uic || ''}`,
                source: 'companybook_name_search',
                cached: false,
                lastUpdatedAt: item.lastUpdated || new Date().toISOString(),
                company: {
                  uic: item.uic || '',
                  name: item.name || item.transliteration || '',
                  legalForm: item.legalForm || 'ЕООД',
                  status: item.status === 'N' || item.status === 'Active' ? 'Active' : (item.status || 'Active'),
                  address: item.district || '',
                  representatives: []
                }
              });
            }
          }

          if (results.length === 0) {
            // 3. Search by physical person name
            const personResp = await fetch(`https://api.companybook.bg/api/people/search?name=${encodeURIComponent(q)}&with_data=true`, {
              headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
            });
            if (personResp.ok) {
              const pData = await personResp.json();
              const pResults = Array.isArray(pData.results) ? pData.results : [];
              for (const person of pResults) {
                const compList = person.personCompanies || person.companiesList || [];
                for (const comp of compList) {
                  results.push({
                    uic: comp.uic || comp.id || '',
                    name: comp.company_name?.name || comp.name || `Фирма ${comp.uic || ''}`,
                    source: 'companybook_person',
                    cached: false,
                    lastUpdatedAt: comp.lastUpdated || person.lastUpdated || new Date().toISOString(),
                    company: {
                      uic: comp.uic || '',
                      name: comp.company_name?.name || comp.name || '',
                      legalForm: comp.legalForm || 'ЕООД',
                      status: 'Active',
                      address: '',
                      representatives: [person.name]
                    }
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('CompanyBook edge query error:', err);
      }

      return new Response(JSON.stringify({
        query: q,
        normalizedQuery: q.toUpperCase().trim(),
        results: results.slice(0, 5),
        meta: {
          count: results.length,
          limit: 5,
          enriched: true,
          durationMs: Date.now() - startTime
        }
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    // 3. Document Extraction & OCR API proxy
    if (url.pathname === '/api/document-scanner/extract-invoice') {
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          return new Response(JSON.stringify({
            success: true,
            data: {
              rawText: body.rawText || '',
              vendorName: body.vendorName || null,
              vendorTaxId: body.vendorTaxId || null,
              totalAmount: body.totalAmount || null
            },
            needsValidation: false,
            isMock: false
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: String(err) }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }
    }

    // 4. Lead Intake forward to n8n
    if (url.pathname === '/api/leads' || url.pathname === '/api/lead-capture') {
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const n8nResp = await fetch(N8N_LEAD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          return new Response(JSON.stringify({ ok: true, forwarded: n8nResp.ok }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (err) {
          return new Response(JSON.stringify({ ok: false, error: String(err) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }
    }

    // 5. Static Assets Fetch with Strict Security & Cache-Control Headers
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');

    // Prevent caching on HTML shells
    const contentType = headers.get('Content-Type') || '';
    if (contentType.includes('text/html') || url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.startsWith('/app')) {
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
