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

    // 3. Document Extraction & OCR API proxy (Gemini 2.5 Flash Multimodal Vision)
    if (url.pathname === '/api/document-scanner/extract-invoice' || url.pathname === '/api/tesseract/extract-invoice' || url.pathname === '/api/ocr/extract') {
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const rawImage = body.image || body.preview || body.data || '';
          const imageType = body.imageType || 'image/jpeg';
          const cleanBase64 = rawImage.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');

          if (!cleanBase64) {
            return new Response(JSON.stringify({ success: false, error: 'No image data provided' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          const geminiApiKey = env.GEMINI_API_KEY || "AIzaSyCjXAkJaMWgFrIST3so_VjppaiB0BOjE2c";
          const extractionPrompt = `You are an expert Bulgarian document extraction engine.
Analyze this image containing an invoice and/or cash receipt.
CRITICAL INSTRUCTIONS:
1. Vendor / Supplier (Доставчик / Издател):
   - If a receipt from a brand/store is attached (e.g. TERRANOVA), vendorName is 'TERRANOVA'.
   - Extract EIK / Булстат printed on the receipt or invoice (e.g. 201391518).
2. Customer / Buyer (Получател):
   - Look at the recipient box on the invoice (e.g. 'ОПА БИЛД ЕООД', EIK: '207769163', VAT: 'BG207769163', Address).
3. Document numbers & dates:
   - Extract invoiceNumber, invoiceDate (YYYY-MM-DD), dueDate.
4. Total amount & currency:
   - Extract the total amount printed (e.g. 10.00, 63.92, 120.00) and currency (BGN, EUR).
5. Line items:
   - Extract item or service descriptions from the invoice table or receipt (e.g. 'Услуги/обслужване в 10.2025г.-12.2025г.').
6. Return a single JSON object.

Schema:
{
  "invoiceNumber": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "dueDate": "YYYY-MM-DD or null",
  "vendorName": "string or null",
  "vendorTaxId": "string or null",
  "vendorVatId": "string or null",
  "iban": "string or null",
  "customerName": "string or null",
  "customerTaxId": "string or null",
  "customerVatNumber": "string or null",
  "customerAddress": "string or null",
  "items": [
    {
      "description": "string",
      "quantity": "number or null",
      "unit": "string or null",
      "unitPrice": "number or null",
      "totalPrice": "number or null",
      "vatRate": "number or null"
    }
  ],
  "subtotal": "number or null",
  "taxAmount": "number or null",
  "totalAmount": "number or null",
  "currency": "string"
}`;

          const mediaType = imageType.includes('png') ? 'image/png' : imageType.includes('webp') ? 'image/webp' : 'image/jpeg';
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiApiKey}`;

          const geminiResp = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: extractionPrompt },
                  { inlineData: { mimeType: mediaType, data: cleanBase64 } }
                ]
              }],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.0,
                maxOutputTokens: 1024
              }
            })
          });

          if (!geminiResp.ok) {
            const errText = await geminiResp.text();
            throw new Error(`Gemini API error (${geminiResp.status}): ${errText}`);
          }

          const geminiData = await geminiResp.json();
          const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
          let parsed = JSON.parse(rawText);
          if (Array.isArray(parsed)) {
            parsed = parsed[0] || {};
          }

          // Validate Mod 11 for Bulgarian EIK
          function isValidEik(eikStr) {
            if (!eikStr) return false;
            const d = eikStr.replace(/\D/g, '');
            if (d.length !== 9 && d.length !== 13) return false;
            let sum = 0;
            for (let i = 0; i < 8; i++) sum += parseInt(d[i], 10) * (i + 1);
            let rem = sum % 11;
            if (rem === 10) {
              sum = 0;
              for (let i = 0; i < 8; i++) sum += parseInt(d[i], 10) * (i + 3);
              rem = sum % 11;
              if (rem === 10) rem = 0;
            }
            if (rem !== parseInt(d[8], 10)) return false;
            if (d.length === 9) return true;
            const w1 = [2, 7, 3, 5, 1, 4, 1, 2, 7, 3, 5, 1];
            let sum13 = 0;
            for (let i = 0; i < 12; i++) sum13 += parseInt(d[i], 10) * w1[i];
            let rem13 = sum13 % 11;
            if (rem13 === 10) {
              const w2 = [4, 9, 5, 7, 3, 6, 2, 4, 9, 5, 7, 3];
              sum13 = 0;
              for (let i = 0; i < 12; i++) sum13 += parseInt(d[i], 10) * w2[i];
              rem13 = sum13 % 11;
              if (rem13 === 10) rem13 = 0;
            }
            return rem13 === parseInt(d[12], 10);
          }

          // Auto-enrich vendor from CompanyBook API if EIK is missing or fails Mod 11
          const cleanVendorEik = (parsed.vendorTaxId || '').replace(/\D/g, '');
          if (parsed.vendorName && !isValidEik(cleanVendorEik)) {
            try {
              const cbKey = env.COMPANYBOOK_API_KEY || COMPANYBOOK_API_KEY;
              const cleanQ = parsed.vendorName.replace(/[\"\'\(\)\.]/g, '').trim();
              const cbRes = await fetch(`https://api.companybook.bg/api/v2/companies/search?name=${encodeURIComponent(cleanQ)}`, {
                headers: { 'X-API-Key': cbKey, 'Accept': 'application/json' }
              });
              if (cbRes.ok) {
                const cbJson = await cbRes.json();
                const match = cbJson.results?.[0];
                if (match && match.uic) {
                  parsed.vendorTaxId = match.uic;
                  parsed.vendorVatId = `BG${match.uic}`;
                  if (match.name) {
                    parsed.vendorName = match.name;
                  }
                }
              }
            } catch (cbErr) {
              console.warn('CompanyBook enrichment skipped:', cbErr);
            }
          }

          // Auto-enrich customer from CompanyBook API if EIK is missing or fails Mod 11
          const cleanCustomerEik = (parsed.customerTaxId || '').replace(/\D/g, '');
          if (parsed.customerName && !isValidEik(cleanCustomerEik)) {
            try {
              const cbKey = env.COMPANYBOOK_API_KEY || COMPANYBOOK_API_KEY;
              const cleanQ = parsed.customerName.replace(/[\"\'\(\)\.]/g, '').trim();
              const cbRes = await fetch(`https://api.companybook.bg/api/v2/companies/search?name=${encodeURIComponent(cleanQ)}`, {
                headers: { 'X-API-Key': cbKey, 'Accept': 'application/json' }
              });
              if (cbRes.ok) {
                const cbJson = await cbRes.json();
                const match = cbJson.results?.[0];
                if (match && match.uic) {
                  parsed.customerTaxId = match.uic;
                  parsed.customerVatNumber = `BG${match.uic}`;
                }
              }
            } catch {}
          }

          if (parsed.vendorTaxId && !parsed.vendorVatId && /^\d{9,10}$/.test(parsed.vendorTaxId)) {
            parsed.vendorVatId = `BG${parsed.vendorTaxId}`;
          }

          return new Response(JSON.stringify({
            success: true,
            data: {
              ...parsed,
              rawText: rawText
            },
            engine: 'gemini-2.5-flash-edge',
            needsValidation: false,
            isMock: false
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        } catch (err) {
          console.error('Edge OCR extraction failed:', err);
          return new Response(JSON.stringify({ success: false, error: String(err.message || err) }), {
            status: 500,
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
