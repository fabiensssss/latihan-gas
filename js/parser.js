/* =====================================================================
 * parser.js — Membaca file Excel "LH Produksi BGA" (.xlsx) di browser
 * ---------------------------------------------------------------------
 * Membutuhkan SheetJS (XLSX) yang sudah dimuat di index.html.
 * Hasil: { tanggal, rows, series, warnings, info }
 *   - rows   : 1 baris per unit (BGA, Wilayah, MDO, Region, Estate)
 *   - series : produksi harian tgl 1..hari ini per unit (untuk grafik tren)
 *
 * Sumber kolom (sesuai PRD bagian 4):
 *   LH Produksi             : B induk, C unit, D luas, BF–BQ budget Jan–Des
 *   HKE                     : B bulan (JAN..DEC), C jumlah HKE (baris 4–15)
 *   Monitoring Produksi     : C3 hari, G–AK produksi tgl 1–31
 *   LH Produksi BGA (WA Jam 9): data harian & faktor panen
 *   Draft Laporan Produksi  : AL3 tanggal laporan ("04 November 2026")
 * ===================================================================== */
(function (root) {
  'use strict';

  var SHEET = {
    lh: 'LH Produksi',
    hke: 'HKE',
    mon: 'Monitoring Produksi',
    wa: 'LH Produksi BGA (WA Jam 9)',
    draft: 'Draft Laporan Produksi'
  };

  var BULAN_ID = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli',
    'agustus', 'september', 'oktober', 'november', 'desember'];
  var BULAN_EN3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // Kolom huruf -> indeks 0-based ("A" -> 0, "AL" -> 37)
  function col(letter) {
    var n = 0;
    for (var i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
    return n - 1;
  }

  // Kolom sheet "LH Produksi BGA (WA Jam 9)"
  var WA = {
    luas: col('D'), prod_hl: col('I'), prod_hi: col('J'), var_hl: col('K'),
    sd_hi: col('L'), rata2: col('M'), sd_bi: col('N'),
    growth_bi: col('O'), growth_sdbi: col('Q'), ach_bi: col('R'), ach_sdbi: col('T'),
    restan: col('U'), p48r: col('W'), p36r: col('X'), hke_pct: col('Y'),
    ha_normal: col('Z'), ha_aktual: col('AA'), ha_var: col('AB'), ancak: col('AC'),
    pks_lt18: col('AE'), pks_ge18: col('AF'), akp: col('AG')
  };

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (!s || s.charAt(0) === '#') return null;            // #REF!, #N/A, dst.
    var n = Number(s.replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  function txt(v) { return v === null || v === undefined ? '' : String(v).trim(); }

  function grid(wb, name) {
    var ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return null;
    // Paksa mulai dari A1 supaya indeks kolom selalu sama dengan huruf kolom Excel
    var rng = root.XLSX.utils.decode_range(ws['!ref']);
    rng.s.r = 0; rng.s.c = 0;
    return root.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true, range: rng });
  }

  function cell(g, r, c) { return g && g[r] ? g[r][c] : null; }

  function levelOf(unit) {
    if (unit === 'BGA') return 'BGA';
    if (/^(Kalteng|Kalbar|Riau)$/i.test(unit)) return 'WILAYAH';
    if (/^MDO\s*\d+$/i.test(unit)) return 'MDO';
    if (/^Reg\s*\S+$/i.test(unit)) return 'REGION';
    return 'ESTATE';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // "04 November 2026" -> "2026-11-04"
  function parseTanggalTeks(s) {
    var m = txt(s).toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
    if (!m) return null;
    var b = BULAN_ID.indexOf(m[2]);
    if (b < 0) return null;
    return m[3] + '-' + pad(b + 1) + '-' + pad(Number(m[1]));
  }

  /**
   * @param {object} wb  workbook hasil XLSX.read(...)
   * @param {string} [tanggalOverride] "yyyy-mm-dd" bila admin mengubah tanggal manual
   */
  function parseWorkbook(wb, tanggalOverride) {
    var warnings = [];
    var missing = [];
    Object.keys(SHEET).forEach(function (k) {
      if (!wb.Sheets[SHEET[k]]) missing.push(SHEET[k]);
    });
    if (missing.length) {
      throw new Error('Sheet tidak ditemukan: ' + missing.join(', ') +
        '. Pastikan file yang di-upload adalah "LH Produksi BGA".');
    }

    var gLH = grid(wb, SHEET.lh), gHKE = grid(wb, SHEET.hke),
        gMON = grid(wb, SHEET.mon), gWA = grid(wb, SHEET.wa), gDR = grid(wb, SHEET.draft);

    // ---------- Tanggal ----------
    var tanggal = tanggalOverride || parseTanggalTeks(cell(gDR, 2, col('AL')));
    if (!tanggal) throw new Error('Tanggal laporan tidak terbaca (sheet Draft Laporan Produksi, sel AL3). Isi tanggal secara manual.');
    var th = Number(tanggal.slice(0, 4)), bl = Number(tanggal.slice(5, 7)), hr = Number(tanggal.slice(8, 10));
    var hariMon = num(cell(gMON, 2, col('C')));
    if (hariMon && hariMon !== hr) {
      warnings.push('Hari di sheet Monitoring Produksi (' + hariMon + ') berbeda dengan tanggal laporan (' + hr + ').');
    }

    // ---------- HKE bulan berjalan ----------
    var hke = null;
    for (var r = 0; r < gHKE.length; r++) {
      if (txt(cell(gHKE, r, 1)).toUpperCase() === BULAN_EN3[bl - 1]) { hke = num(cell(gHKE, r, 2)); break; }
    }
    if (!hke) throw new Error('HKE bulan ' + BULAN_EN3[bl - 1] + ' tidak ditemukan di sheet HKE.');

    // ---------- Budget bulanan (LH Produksi) ----------
    var colBudget = col('BF') + (bl - 1);
    var lh = {};             // unit -> {parent, luas, budget_bulan, bgtHiExcel}
    gLH.forEach(function (row, i) {
      if (i < 7) return;
      var unit = txt(row[col('C')]) || txt(row[col('B')]);
      if (!unit || unit.indexOf('+') >= 0) return;
      if (levelOf(unit) !== 'ESTATE' && txt(row[col('C')]) === '' && txt(row[col('B')]) !== unit) return;
      lh[unit] = {
        parent: txt(row[col('B')]),
        luas: num(row[col('D')]),
        budget_bulan: num(row[colBudget]),
        bgtHiExcel: num(row[col('I')])
      };
    });
    // Baris BGA/Kalteng/Kalbar/MDO di LH Produksi: nama ada di kolom B (C kosong)
    gLH.forEach(function (row, i) {
      if (i < 7) return;
      var b = txt(row[col('B')]), c = txt(row[col('C')]);
      if (b && !c && !lh[b]) {
        lh[b] = { parent: '', luas: num(row[col('D')]), budget_bulan: num(row[colBudget]), bgtHiExcel: num(row[col('I')]) };
      }
    });

    // ---------- Data harian & faktor (WA Jam 9) ----------
    var rows = [];
    var seen = {};
    gWA.forEach(function (row, i) {
      if (i < 7) return;
      var unit = txt(row[col('C')]);
      if (!unit || unit.indexOf('+') >= 0 || seen[unit]) return;
      var level = levelOf(unit);
      var parentRaw = txt(row[col('B')]);
      var rec = {
        tanggal: tanggal, level: level, unit: unit,
        parent: level === 'REGION' || level === 'ESTATE' ? parentRaw : ''
      };
      Object.keys(WA).forEach(function (k) { rec[k] = num(row[WA[k]]); });

      var b = lh[unit];
      rec.budget_bulan = b ? b.budget_bulan : null;
      rec.hke_bulan = hke;
      rec.budget_harian = rec.budget_bulan ? rec.budget_bulan / hke : null;

      // Lewati unit kosong (Riau, Reg 9, PNDE, dll.)
      var kosong = !(rec.luas > 0) && !(rec.prod_hi > 0) && !(rec.budget_bulan > 0);
      if (kosong) return;

      if (!b) warnings.push('Unit ' + unit + ' tidak ditemukan di sheet LH Produksi (budget kosong).');
      else if (b.bgtHiExcel && rec.budget_harian && Math.abs(b.bgtHiExcel - rec.budget_harian) > 1) {
        warnings.push('Budget harian ' + unit + ' hasil hitung (' + rec.budget_harian.toFixed(1) +
          ') berbeda dengan kolom I LH Produksi (' + b.bgtHiExcel.toFixed(1) + ').');
      }
      seen[unit] = true;
      rows.push(rec);
    });

    // ---------- Produksi harian sebulan (Monitoring Produksi) ----------
    var series = [];
    var unitSet = {};
    rows.forEach(function (x) { unitSet[x.unit] = true; });
    var c1 = col('G');
    gMON.forEach(function (row, i) {
      if (i < 7) return;
      var unit = txt(row[col('C')]);
      if (!unitSet[unit]) return;
      for (var d = 1; d <= hr; d++) {
        var v = num(row[c1 + d - 1]);
        series.push({ tanggal: th + '-' + pad(bl) + '-' + pad(d), unit: unit, ton: v === null ? 0 : v });
      }
    });

    // ---------- Validasi ----------
    var byUnit = {};
    rows.forEach(function (x) { byUnit[x.unit] = x; });
    var estates = rows.filter(function (x) { return x.level === 'ESTATE'; });
    var regions = rows.filter(function (x) { return x.level === 'REGION'; });
    if (!byUnit.BGA) throw new Error('Baris BGA tidak ditemukan di sheet WA Jam 9.');
    var sumEst = estates.reduce(function (s, x) { return s + (x.prod_hi || 0); }, 0);
    if (Math.abs(sumEst - byUnit.BGA.prod_hi) > 1) {
      warnings.push('Jumlah produksi HI semua estate (' + sumEst.toFixed(1) + ') tidak sama dengan baris BGA (' +
        byUnit.BGA.prod_hi.toFixed(1) + ').');
    }
    regions.forEach(function (rg) {
      var s = estates.filter(function (e) { return e.parent === rg.unit; })
        .reduce(function (a, e) { return a + (e.prod_hi || 0); }, 0);
      if (Math.abs(s - (rg.prod_hi || 0)) > 1) warnings.push('Total estate ' + rg.unit + ' (' + s.toFixed(1) + ') ≠ baris region (' + (rg.prod_hi || 0).toFixed(1) + ').');
    });
    var tanpaFaktor = estates.filter(function (e) { return e.hke_pct === null || e.akp === null; });
    if (tanpaFaktor.length) warnings.push(tanpaFaktor.length + ' estate tanpa data %HKE/AKP: ' +
      tanpaFaktor.slice(0, 8).map(function (e) { return e.unit; }).join(', ') + (tanpaFaktor.length > 8 ? ', …' : ''));
    var dayCheck = series.filter(function (s) { return s.unit === 'BGA' && s.tanggal === tanggal; })[0];
    if (dayCheck && Math.abs(dayCheck.ton - byUnit.BGA.prod_hi) > 1) {
      warnings.push('Produksi BGA tgl ' + hr + ' di Monitoring Produksi (' + dayCheck.ton.toFixed(1) +
        ') berbeda dengan WA Jam 9 (' + byUnit.BGA.prod_hi.toFixed(1) + ').');
    }

    return {
      tanggal: tanggal,
      rows: rows,
      series: series,
      warnings: warnings,
      info: {
        hke: hke,
        estate: estates.length,
        region: regions.length,
        unit: rows.length,
        bga: byUnit.BGA
      }
    };
  }

  var api = { parseWorkbook: parseWorkbook, parseTanggalTeks: parseTanggalTeks, col: col };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LHPParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
