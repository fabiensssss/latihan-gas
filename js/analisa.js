/* =====================================================================
 * analisa.js — Mesin "Bedah Gap" (fungsi murni, tanpa akses DOM)
 * ---------------------------------------------------------------------
 * Input  : report dari API { tanggal, rows, series, regions, settings }
 * Output : model siap tampil: indeks unit, anak per unit, peringkat gap,
 *          peringkat turun, label faktor penyebab, dan sorotan otomatis.
 * ===================================================================== */
(function (root) {
  'use strict';

  var DEFAULT_SETTINGS = {
    HKE_MIN: 90,            // % HKE panen minimal
    PKS_GE18_MAX: 0.30,     // porsi TBS diterima PKS >= 18.00 maksimal
    AKP_DROP_PCT: 0.15,     // AKP hari ini turun > 15% dari rata-rata bulan estate itu
    AKP_TOLERANSI: 0.05,    // AKP dianggap rendah bila > 5% di bawah AKP unit induk
    ACH_KUNING: 0.90        // batas warna kuning capaian
  };

  // Definisi label faktor (urutan = urutan tampil)
  var FAKTOR = [
    { key: 'hke', label: 'HKE rendah' },
    { key: 'luas', label: 'Luas panen kurang' },
    { key: 'pusingan', label: 'Pusingan terlambat' },
    { key: 'ancak', label: 'Ancak tdk selesai' },
    { key: 'restan', label: 'Restan' },
    { key: 'pks', label: 'Angkutan ≥18.00' },
    { key: 'akp', label: 'AKP rendah' },
    { key: 'akpdrop', label: 'AKP turun' }
  ];

  function n(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  function settingsOf(raw) {
    var s = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      var v = raw && raw[k] !== undefined && raw[k] !== '' ? Number(raw[k]) : DEFAULT_SETTINGS[k];
      s[k] = isFinite(v) ? v : DEFAULT_SETTINGS[k];
    });
    return s;
  }

  function fmt0(v) {
    return Math.round(v).toLocaleString('id-ID');
  }
  function fmt1(v) {
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  /** Label faktor untuk satu unit; pembanding AKP = unit induk */
  function faktorUnit(u, induk, S) {
    var out = [];
    if (u.hke_pct !== null && u.hke_pct !== undefined && u.hke_pct > 0 && u.hke_pct < S.HKE_MIN) {
      out.push({ key: 'hke', label: 'HKE ' + fmt1(u.hke_pct) + '%' });
    }
    if (u.ha_var !== null && u.ha_var < -0.5) {
      out.push({ key: 'luas', label: 'Luas panen ' + fmt0(u.ha_var) + ' Ha' });
    }
    var pus = n(u.p48r) + n(u.p36r);
    if (pus > 0.5) {
      var t = [];
      if (n(u.p48r) > 0.5) t.push('48R ' + fmt0(u.p48r));
      if (n(u.p36r) > 0.5) t.push('36R ' + fmt0(u.p36r));
      out.push({ key: 'pusingan', label: 'Pusingan ' + t.join(' · ') + ' Ha' });
    }
    if (n(u.ancak) > 0.5) out.push({ key: 'ancak', label: 'Ancak tdk selesai ' + fmt0(u.ancak) + ' Ha' });
    if (n(u.restan) > 0.5) out.push({ key: 'restan', label: 'Restan ' + fmt0(u.restan) + ' ton' });
    if (u.pks_ge18 !== null && u.pks_ge18 > S.PKS_GE18_MAX) {
      out.push({ key: 'pks', label: 'PKS ≥18.00 ' + Math.round(u.pks_ge18 * 100) + '%' });
    }
    if (u.akp > 0 && induk && induk.akp > 0 && u.akp < induk.akp * (1 - S.AKP_TOLERANSI)) {
      out.push({ key: 'akp', label: 'AKP ' + fmt1(u.akp) + ' (< ' + fmt1(induk.akp) + ')' });
    }
    if (u.akp > 0 && u.akp_rata_bulan > 0 && u.akp < u.akp_rata_bulan * (1 - S.AKP_DROP_PCT)) {
      out.push({ key: 'akpdrop', label: 'AKP turun ' + Math.round((1 - u.akp / u.akp_rata_bulan) * 100) + '% dari rata² bulan' });
    }
    return out;
  }

  /**
   * Bangun model laporan.
   * @param {object} rep { tanggal, rows:[...], series:[...], regions:[{region, wilayah, urutan}], settings:{} }
   */
  function build(rep) {
    var S = settingsOf(rep.settings);
    var by = {};
    var rows = rep.rows.map(function (r) {
      var u = Object.assign({}, r);
      u.gap = u.budget_harian ? n(u.prod_hi) - u.budget_harian : null;
      u.ach_harian = u.budget_harian ? n(u.prod_hi) / u.budget_harian : null;
      u.var_pct = u.prod_hl ? (n(u.prod_hi) - u.prod_hl) / u.prod_hl : null;
      by[u.unit] = u;
      return u;
    });

    // Urutan & wilayah region dari MASTER_REGION
    var regMeta = {};
    (rep.regions || []).forEach(function (m, i) {
      regMeta[m.region] = { wilayah: m.wilayah, urutan: Number(m.urutan) || i + 1 };
    });

    var byLevel = function (lv) { return rows.filter(function (x) { return x.level === lv; }); };
    var regions = byLevel('REGION');
    var estates = byLevel('ESTATE');
    regions.forEach(function (r, i) {
      var m = regMeta[r.unit] || {};
      r.wilayah = m.wilayah || '';
      r.urutan = m.urutan || 100 + i;
    });
    regions.sort(function (a, b) { return a.urutan - b.urutan; });
    estates.forEach(function (e, i) {
      var rg = by[e.parent];
      e.wilayah = rg ? rg.wilayah : '';
      e.mdo = rg ? rg.parent : '';
      e.urutanAsli = i;
    });

    var children = {};
    estates.forEach(function (e) { (children[e.parent] = children[e.parent] || []).push(e); });

    // Faktor penyebab
    var bga = by.BGA;
    regions.forEach(function (r) { r.faktor = faktorUnit(r, bga, S); });
    estates.forEach(function (e) { e.faktor = faktorUnit(e, by[e.parent], S); });

    // Kontribusi estate terhadap gap region (hanya gap negatif)
    regions.forEach(function (r) {
      var kids = children[r.unit] || [];
      var negGap = kids.reduce(function (s, e) { return s + Math.min(0, n(e.gap)); }, 0);
      var negVar = kids.reduce(function (s, e) { return s + Math.min(0, n(e.var_hl)); }, 0);
      kids.forEach(function (e) {
        e.shareGap = negGap < 0 && n(e.gap) < 0 ? e.gap / negGap : 0;
        e.shareVar = negVar < 0 && n(e.var_hl) < 0 ? e.var_hl / negVar : 0;
      });
    });

    function rankBy(list, key) {
      return list.filter(function (x) { return x[key] !== null && x[key] !== undefined; })
        .slice().sort(function (a, b) { return a[key] - b[key]; });
    }

    var model = {
      tanggal: rep.tanggal,
      settings: S,
      by: by,
      bga: bga,
      wilayah: byLevel('WILAYAH'),
      mdo: byLevel('MDO').sort(function (a, b) { return a.unit.localeCompare(b.unit, 'id', { numeric: true }); }),
      regions: regions,
      estates: estates,
      children: children,
      rank: {
        regionGap: rankBy(regions, 'gap'),
        regionVar: rankBy(regions, 'var_hl'),
        estateGap: rankBy(estates, 'gap'),
        estateVar: rankBy(estates, 'var_hl')
      },
      series: indexSeries(rep.series || []),
      sorotanManual: rep.sorotan || []
    };
    model.sorotanAuto = sorotanOtomatis(model);
    return model;
  }

  function indexSeries(series) {
    var out = {};
    series.forEach(function (s) {
      (out[s.unit] = out[s.unit] || []).push({ tanggal: s.tanggal, ton: Number(s.ton) || 0 });
    });
    Object.keys(out).forEach(function (k) {
      out[k].sort(function (a, b) { return a.tanggal < b.tanggal ? -1 : 1; });
    });
    return out;
  }

  function daftar(list, fn, max) {
    return list.slice(0, max || 3).map(fn).join(', ');
  }

  /** Sorotan utama otomatis (bisa diedit admin sebelum publish) */
  function sorotanOtomatis(m) {
    var out = [];
    var b = m.bga;
    if (!b) return out;
    var bulan = new Date(m.tanggal + 'T00:00:00').toLocaleDateString('id-ID', { month: 'long' });

    if (b.ach_harian !== null) {
      out.push('Produksi harian ' + Math.round(b.ach_harian * 100) + '% dari budget harian ' + bulan +
        ' (' + fmt0(b.prod_hi) + ' dari ' + fmt0(b.budget_harian) + ' ton, gap ' + fmt0(b.gap) + ' ton).');
    }
    var gapNeg = m.rank.regionGap.filter(function (r) { return r.gap < 0; });
    if (gapNeg.length) {
      var totNeg = gapNeg.reduce(function (s, r) { return s + r.gap; }, 0);
      var top2 = gapNeg.slice(0, 2).reduce(function (s, r) { return s + r.gap; }, 0);
      out.push('Gap terbesar ke budget harian: ' + daftar(gapNeg, function (r) { return r.unit + ' (' + fmt0(r.gap) + ' ton)'; }) +
        '; dua teratas menyumbang ' + Math.round(top2 / totNeg * 100) + '% dari total kekurangan.');
    }
    var turun = m.rank.regionVar.filter(function (r) { return r.var_hl < 0; });
    if (turun.length) {
      out.push('Produksi turun dari kemarin: ' + daftar(turun, function (r) { return r.unit + ' (' + fmt0(r.var_hl) + ' ton)'; }) + '.');
    }
    var hke = m.regions.filter(function (r) { return r.hke_pct > 0; }).sort(function (a, c) { return a.hke_pct - c.hke_pct; });
    if (hke.length) {
      out.push('HKE terendah: ' + daftar(hke, function (r) { return r.unit + ' (' + fmt1(r.hke_pct) + '%)'; }) + '.');
    }
    var p48 = m.regions.filter(function (r) { return n(r.p48r) > 0.5; }).sort(function (a, c) { return c.p48r - a.p48r; });
    var p36 = m.regions.filter(function (r) { return n(r.p36r) > 0.5; }).sort(function (a, c) { return c.p36r - a.p36r; });
    if (p48.length || p36.length) {
      var t = [];
      if (p48.length) t.push('48R ' + daftar(p48, function (r) { return r.unit + ' (' + fmt0(r.p48r) + ' Ha)'; }));
      if (p36.length) t.push('36R ' + daftar(p36, function (r) { return r.unit + ' (' + fmt0(r.p36r) + ' Ha)'; }));
      out.push('Pusingan terlambat: ' + t.join('; ') + '.');
    }
    var anc = m.regions.filter(function (r) { return n(r.ancak) > 0.5; }).sort(function (a, c) { return c.ancak - a.ancak; });
    if (anc.length) out.push('Ancak tidak tuntas: ' + daftar(anc, function (r) { return r.unit + ' (' + fmt0(r.ancak) + ' Ha)'; }) + '.');
    var pks = m.regions.filter(function (r) { return r.pks_ge18 !== null; }).sort(function (a, c) { return c.pks_ge18 - a.pks_ge18; });
    if (pks.length) {
      out.push('Penerimaan TBS di PKS ≥18.00 tertinggi: ' + daftar(pks, function (r) {
        return r.unit + ' (' + Math.round(r.pks_ge18 * 100) + '%)';
      }, 2) + '; BGA ' + Math.round(n(b.pks_ge18) * 100) + '%.');
    }
    var res = m.regions.filter(function (r) { return n(r.restan) > 0.5; }).sort(function (a, c) { return c.restan - a.restan; });
    if (res.length) out.push('Restan total ' + fmt0(n(b.restan)) + ' ton; terbesar ' + daftar(res, function (r) { return r.unit + ' (' + fmt0(r.restan) + ' ton)'; }, 2) + '.');
    return out;
  }

  var api = { build: build, faktorUnit: faktorUnit, FAKTOR: FAKTOR, DEFAULT_SETTINGS: DEFAULT_SETTINGS, settingsOf: settingsOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LHPAnalisa = api;
})(typeof window !== 'undefined' ? window : globalThis);
