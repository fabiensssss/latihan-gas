/* =====================================================================
 * api/gas.js — Proxy Vercel ke Apps Script
 * ---------------------------------------------------------------------
 * Browser hanya berbicara dengan situs Vercel sendiri (tanpa CORS).
 * Server Vercel yang meneruskan permintaan ke Apps Script dan menangani
 * redirect 302 dengan benar (POST → lalu GET ke alamat echo).
 * Target dibatasi hanya ke Web App Apps Script (script.google.com/.../exec).
 * ===================================================================== */
const POLA = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

function bacaBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function balas(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const target = process.env.GAS_URL || url.searchParams.get('target') || '';
  if (!POLA.test(target)) {
    return balas(res, 400, { success: false, message: 'URL Apps Script tidak valid. Cek GAS_URL di js/config.js (harus berakhiran /exec).' });
  }

  try {
    let r;
    if (req.method === 'POST') {
      let body = req.body;
      if (body === undefined || body === null) body = await bacaBody(req);
      if (typeof body !== 'string') body = JSON.stringify(body);
      r = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'manual'
      });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        r = await fetch(loc, { method: 'GET', redirect: 'follow' });   // hasil doPost diambil dengan GET
      }
    } else {
      url.searchParams.delete('target');
      const qs = url.searchParams.toString();
      r = await fetch(target + (qs ? '?' + qs : ''), { redirect: 'follow' });
    }

    const text = await r.text();
    try {
      JSON.parse(text);
      return balas(res, 200, text);
    } catch (e) {
      const cuplikan = text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 220);
      return balas(res, 502, {
        success: false,
        message: 'Apps Script tidak mengembalikan data (status ' + r.status + '). Pesan dari Google: ' + (cuplikan || '(kosong)')
      });
    }
  } catch (err) {
    return balas(res, 502, { success: false, message: 'Server Vercel gagal menghubungi Apps Script: ' + err.message });
  }
};
