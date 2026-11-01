/* Pflegekreis – PDF-Erzeugung im Browser (Notfallkarte, Notfallblatt, Arzt-Bericht).
   Nutzt die lokal mitgelieferte Bibliothek vendor/jspdf.umd.min.js (MIT), kein CDN. Wird erst bei Bedarf geladen.
   Eingabe sind fertig aufbereitete Daten aus app.js (sosData / reportModel) – hier nur Layout. Standardschrift Helvetica (WinAnsi). */
(function () {
  const WIN = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  // Nur Zeichen, die Helvetica (WinAnsi) kennt; Rest wird ersetzt bzw. ohne Akzent ausgegeben
  const T = (s) => String(s ?? "").replace(/₂/g, "2").replace(/→/g, "->").replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/[\u2009\u202f\u2007]/g, " ").replace(/ı/g, "i")
    .replace(/[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F\u200D]/gu, "").replace(/[^\n\x20-\x7e\xa0-\xff]/g, (c) => (WIN.includes(c) ? c : (c.normalize("NFD")[0] || "").replace(/[^\x20-\x7e\xa0-\xff]/, ""))).replace(/[ \t]+\n/g, "\n");
  const PETROL = "#0F6B63", PETROL_D = "#0A4F49", TINT = "#EEF5F3", SOFT = "#DCECE8", INK = "#1E2629", MUTED = "#5B6568", LINE = "#D9D3CC", WARN = "#975A0C", WARN_SOFT = "#FAEFDC";
  const MM = 0.3528; // 1 pt in mm
  const lh = (pt, f = 1.28) => pt * MM * f;
  const mk = (orientation = "p") => new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation, compress: true });
  const tel = (p) => "tel:" + String(p || "").replace(/[^0-9+]/g, "");
  const font = (d, pt, style = "normal", color = INK) => { d.setFont("helvetica", style); d.setFontSize(pt); d.setTextColor(color); };
  const lines = (d, s, w) => d.splitTextToSize(T(s), w);

  // ---------- Notfallkarte: Scheckkarte zum Falten (3 Felder à 85,6 × 54 mm nebeneinander, A4 quer, 2 Exemplare) ----------
  const CW = 85.6, CH = 54;
  function cardPanel(d, x, y, blocks, { h = CH, top = 3.2, base = 6.6 } = {}) {
    // blocks: [{h: "Überschrift", t: "Text", hl: hervorheben, b: fett}] – Schrift wird verkleinert, bis alles passt (min. 4,8 pt), sonst gekürzt
    const pad = 3.2, w = CW - 2 * pad, avail = h - top - pad, bottom = y + h - pad;
    const measure = (pt) => blocks.reduce((a, b) => a + (b.h ? lh(pt * 0.92) : 0) + lines(d.setFontSize(pt), b.t, b.hl ? w - 2 : w).length * lh(pt, 1.18) + (b.hl ? 1.6 : 0) + 1.1, 0);
    let pt = base; while (pt > 4.8 && measure(pt) > avail) pt -= 0.2;
    let yy = y + top;
    for (const b of blocks) {
      if (yy > bottom - lh(pt)) break;
      if (b.h) { font(d, pt * 0.92, "bold", PETROL_D); d.text(T(b.h).toUpperCase(), x + pad, yy, { baseline: "top", charSpace: 0.15 }); yy += lh(pt * 0.92); }
      font(d, pt, b.b ? "bold" : "normal", INK);
      let ls = lines(d, b.t, b.hl ? w - 2 : w); const room = Math.floor((bottom - yy - (b.hl ? 1.6 : 0)) / lh(pt, 1.18));
      if (ls.length > room) { ls = ls.slice(0, Math.max(1, room)); ls[ls.length - 1] += " …"; }
      if (b.hl) { d.setFillColor(WARN_SOFT); d.roundedRect(x + pad - 0.6, yy - 0.5, w + 1.2, ls.length * lh(pt, 1.18) + 1.4, 1, 1, "F"); font(d, pt, "bold", "#5E3A08"); }
      d.text(ls, x + pad + (b.hl ? 1 : 0), yy + (b.hl ? 0.2 : 0), { baseline: "top", lineHeightFactor: 1.18 });
      yy += ls.length * lh(pt, 1.18) + (b.hl ? 1.6 : 0) + 1.1;
    }
  }
  function cardStrip(d, x, y, c) {
    // Schnittlinie (durchgezogen) und Faltlinien (gestrichelt)
    d.setDrawColor("#8A9497"); d.setLineWidth(0.25); d.setLineDashPattern([], 0); d.roundedRect(x, y, CW * 3, CH, 2.5, 2.5, "S");
    d.setLineDashPattern([1.4, 1.2], 0); d.line(x + CW, y, x + CW, y + CH); d.line(x + 2 * CW, y, x + 2 * CW, y + CH); d.setLineDashPattern([], 0);
    // Feld 1: Kopf
    d.setFillColor(PETROL); d.roundedRect(x + 0.4, y + 0.4, CW - 0.8, 11.5, 2.2, 2.2, "F"); d.rect(x + 0.4, y + 6, CW - 0.8, 5.9, "F");
    font(d, 6.2, "bold", "#FFFFFF"); d.text("NOTFALLKARTE", x + 3.2, y + 3.2, { baseline: "top", charSpace: 0.4 });
    font(d, 10.5, "bold", "#FFFFFF"); d.text(T(c.name).slice(0, 34), x + 3.2, y + 6.3, { baseline: "top" });
    font(d, 6, "bold", "#FFFFFF"); d.text("Notruf 112", x + CW - 3.2, y + 3.2, { baseline: "top", align: "right" });
    const id = [c.birth ? "geb. " + c.birth + (c.age ? ` (${c.age} J.)` : "") : "", c.blood ? "Blutgruppe " + c.blood : ""].filter(Boolean).join("  ·  ");
    const b1 = [];
    if (id) b1.push({ t: id, b: true });
    for (const f of c.flags) b1.push({ t: f.t + (f.d ? ": " + f.d : ""), hl: true });
    b1.push({ h: "Allergien / Unverträglichkeiten", t: c.allergies || "keine bekannt", hl: !!c.allergiesHl });
    cardPanel(d, x, y + 12, b1, { h: CH - 12, top: 1.5, base: 6.8 });
    // Feld 2: Diagnosen + Medikamente
    const meds = c.meds.length ? c.meds.map((m) => `${m.name}${m.dosage ? " " + m.dosage : ""}${m.times ? " – " + m.times : ""}`).join("\n") : "keine eingetragen";
    cardPanel(d, x + CW, y, [c.diagnoses ? { h: "Wichtige Diagnosen / Hinweise", t: c.diagnoses } : null, { h: "Medikamente", t: meds }].filter(Boolean));
    // Feld 3: Ärzte, Kontakte, Mobilität, Verfügung
    const b3 = [];
    if (c.doctors.length) b3.push({ h: "Ärzte", t: c.doctors.map((x) => `${x.role}: ${x.name}${x.phone ? "  " + x.phone : ""}`).join("\n") });
    if (c.contacts.length) b3.push({ h: "Notfallkontakte", t: c.contacts.map((x) => `${x.name}${x.org ? " (" + x.org + ")" : ""}${x.phone ? "  " + x.phone : ""}`).join("\n") });
    if (c.mobility) b3.push({ h: "Mobilität", t: c.mobility });
    if (c.directive) b3.push({ h: "Patientenverfügung / Vollmacht", t: c.directive });
    b3.push({ t: "Stand " + c.stand + " · Pflegekreis" });
    cardPanel(d, x + 2 * CW, y, b3);
  }
  function sosCard(c) {
    const d = mk("l"); d.setProperties({ title: T(`Notfallkarte ${c.name}`), creator: "Pflegekreis" });
    const X = (297 - CW * 3) / 2;
    font(d, 14, "bold", PETROL_D); d.text(T(`Notfallkarte zum Ausschneiden – ${c.name}`), X, 14, { baseline: "top" });
    font(d, 8.5, "normal", MUTED); d.text(T("Entlang der durchgezogenen Linie ausschneiden, an den gestrichelten Linien zickzack falten (Scheckkartengröße 85,6 × 54 mm). In Geldbörse, Rollator- oder Handtasche aufbewahren. Bitte in 100 % / „Tatsächliche Größe“ drucken."), X, 21, { baseline: "top", maxWidth: CW * 3 });
    cardStrip(d, X, 34, c);
    font(d, 7.5, "normal", MUTED); d.text("2. Exemplar (z. B. für Rollator oder Pflegemappe)", X, 34 + CH + 9, { baseline: "top" });
    cardStrip(d, X, 34 + CH + 14, c);
    font(d, 7.5, "normal", MUTED); d.text(T(`Erstellt mit Pflegekreis am ${c.stand}. Angaben der Familie – bitte aktuell halten. Bei Lebensgefahr immer 112 anrufen.`), X, 200, { baseline: "top" });
    return d.output("blob");
  }

  // ---------- Notfallblatt A4 hochkant (groß lesbar, z. B. für Kühlschrank / Pflegemappe) ----------
  function pager(d, { title, foot }) {
    const L = 16, R = 194, B = 279; let y = 16;
    const P = {
      L, R, W: R - L, get y() { return y; }, set y(v) { y = v; },
      need(h) { if (y + h > B) { d.addPage(); y = 16; if (title) { font(d, 8, "bold", MUTED); d.text(T(title), L, 9, { baseline: "top" }); } return true; } return false; },
      gap(h = 3) { y += h; },
      h2(t, keep = 20) { P.need(keep); y += 2.5; d.setFillColor(PETROL); d.rect(L, y + 0.6, 1.3, 4.6, "F"); font(d, 12.5, "bold", PETROL_D); d.text(T(t), L + 3.6, y, { baseline: "top" }); y += 7.4; },
      h3(t, keep = 22) { P.need(keep); font(d, 10, "bold", INK); d.text(T(t), L, y, { baseline: "top" }); y += 5.2; },
      p(t, { pt = 10, style = "normal", color = INK, x = L, w = R - L, f = 1.32 } = {}) {
        font(d, pt, style, color); const ls = lines(d, t, w);
        for (const l of ls) { P.need(lh(pt, f)); font(d, pt, style, color); d.text(l, x, y, { baseline: "top" }); y += lh(pt, f); }
      },
      box(t, { pt = 10.5, bg = WARN_SOFT, color = "#5E3A08", style = "bold" } = {}) {
        font(d, pt, style, color); const ls = lines(d, t, R - L - 7), h = ls.length * lh(pt, 1.3) + 4.2; P.need(h + 1.5);
        d.setFillColor(bg); d.roundedRect(L, y, R - L, h, 2, 2, "F"); font(d, pt, style, color); d.text(ls, L + 3.5, y + 2.2, { baseline: "top", lineHeightFactor: 1.3 }); y += h + 1.8;
      },
      // Tabelle: cols [{h, w, a}] (Breiten in mm, Rest = letzte Spalte), rows: [[...], {cells, mark, bold}]
      table(cols, rows, { pt = 9, head = true, zebra = true, markCol = -1 } = {}) {
        const ws = cols.map((c) => c.w), rest = R - L - ws.slice(0, -1).reduce((a, b) => a + (b || 0), 0); ws[ws.length - 1] = cols[cols.length - 1].w || rest;
        const drawHead = () => { font(d, pt - 0.8, "bold", MUTED); let x = L; d.setDrawColor(LINE); d.setLineWidth(0.3); cols.forEach((c, i) => { d.text(T(c.h), c.a === "r" ? x + ws[i] - 1.5 : x + 1.5, y, { baseline: "top", align: c.a === "r" ? "right" : "left" }); x += ws[i]; }); y += lh(pt) + 0.6; d.line(L, y, R, y); y += 0.9; };
        if (head) { P.need(lh(pt) * 3); drawHead(); }
        rows.forEach((r, ri) => {
          const cells = Array.isArray(r) ? r : r.cells, bold = !Array.isArray(r) && r.bold, mark = !Array.isArray(r) && r.mark;
          font(d, pt, bold ? "bold" : "normal", INK);
          const wr = cells.map((c, i) => lines(d, c ?? "", ws[i] - 3)), h = Math.max(...wr.map((x) => x.length)) * lh(pt, 1.22) + 1.6;
          if (P.need(h) && head) drawHead();
          if (mark) { d.setFillColor(WARN_SOFT); d.rect(L, y - 0.4, R - L, h, "F"); } else if (zebra && ri % 2) { d.setFillColor("#F7F5F2"); d.rect(L, y - 0.4, R - L, h, "F"); }
          let x = L; wr.forEach((ls, i) => { font(d, pt, bold || (mark && i === markCol) ? "bold" : "normal", mark && i === markCol ? "#5E3A08" : i === 0 ? INK : "#2E383B"); d.text(ls, cols[i].a === "r" ? x + ws[i] - 1.5 : x + 1.5, y + 0.4, { baseline: "top", align: cols[i].a === "r" ? "right" : "left", lineHeightFactor: 1.22 }); x += ws[i]; });
          if (!Array.isArray(r) && r.link) d.link(r.link.x ?? L, y, R - L, h, { url: r.link.url });
          y += h;
        });
        d.setDrawColor(LINE); d.line(L, y, R, y); y += 2.5;
      },
      footer(text) {
        const n = d.getNumberOfPages();
        for (let i = 1; i <= n; i++) { d.setPage(i); d.setDrawColor(LINE); d.setLineWidth(0.3); d.line(L, 284, R, 284); font(d, 7.5, "normal", MUTED); d.text(T(text), L, 286.5, { baseline: "top", maxWidth: R - L - 26 }); d.text(`Seite ${i} von ${n}`, R, 286.5, { baseline: "top", align: "right" }); }
      },
    };
    if (foot) P.foot = foot;
    return P;
  }
  function sosSheet(c) {
    const d = mk("p"); d.setProperties({ title: T(`Notfallblatt ${c.name}`), creator: "Pflegekreis" });
    const P = pager(d, { title: `Notfallblatt ${c.name}` });
    d.setFillColor(PETROL); d.roundedRect(P.L, 14, P.W, 25, 3, 3, "F");
    font(d, 9, "bold", "#FFFFFF"); d.text("NOTFALLBLATT", P.L + 6, 18.5, { baseline: "top", charSpace: 0.6 });
    font(d, 21, "bold", "#FFFFFF"); d.text(T(c.name), P.L + 6, 23.5, { baseline: "top" });
    const id = [c.birth ? "geb. " + c.birth + (c.age ? ` (${c.age} Jahre)` : "") : "", c.blood ? "Blutgruppe " + c.blood : ""].filter(Boolean).join("   ·   ");
    font(d, 10, "normal", "#FFFFFF"); if (id) d.text(T(id), P.L + 6, 32.5, { baseline: "top" });
    font(d, 15, "bold", "#FFFFFF"); d.text("Notruf 112", P.R - 6, 22, { baseline: "top", align: "right" }); d.link(P.R - 40, 20, 34, 9, { url: "tel:112" });
    font(d, 8, "normal", "#DCECE8"); d.text("Rettungsdienst & Feuerwehr", P.R - 6, 29, { baseline: "top", align: "right" });
    P.y = 44;
    for (const f of c.flags) P.box(f.t + (f.d ? ": " + f.d : ""), { pt: 12 });
    P.h2("Allergien / Unverträglichkeiten"); if (c.allergiesHl) P.box(c.allergies, { pt: 12 }); else P.p(c.allergies || "keine bekannt", { pt: 12 });
    if (c.diagnoses) { P.h2("Wichtige Diagnosen / Hinweise"); P.p(c.diagnoses, { pt: 12 }); }
    P.h2("Aktuelle Medikamente");
    if (c.meds.length) P.table([{ h: "Medikament", w: 52 }, { h: "Dosis", w: 42 }, { h: "Zeiten", w: 30 }, { h: "Hinweis" }], c.meds.map((m) => ({ cells: [m.name, m.dosage || "", m.times || "", m.notes || ""], mark: m.hl, bold: false })), { pt: 10.5, markCol: 0 });
    else P.p("Keine Medikamente eingetragen.", { pt: 11, color: MUTED });
    if (c.doctors.length) { P.h2("Ärztinnen und Ärzte"); P.table([{ h: "", w: 30 }, { h: "Name", w: 58 }, { h: "Praxis", w: 56 }, { h: "Telefon", a: "r" }], c.doctors.map((x) => ({ cells: [x.role, x.name, x.org || "", x.phone || ""], link: x.phone ? { url: tel(x.phone) } : null })), { pt: 10.5 }); }
    if (c.contacts.length) { P.h2("Notfallkontakte"); P.table([{ h: "Name", w: 62 }, { h: "Beziehung / Hinweis", w: 82 }, { h: "Telefon", a: "r" }], c.contacts.map((x) => ({ cells: [x.name, x.org || "", x.phone || ""], link: x.phone ? { url: tel(x.phone) } : null })), { pt: 10.5 }); }
    if (c.mobility) { P.h2("Mobilität"); P.p(c.mobility, { pt: 11.5 }); }
    if (c.directive) { P.h2("Patientenverfügung / Vollmacht"); P.p(c.directive, { pt: 11.5 }); }
    if (c.info) { P.h2("Weitere Hinweise"); P.p(c.info, { pt: 10.5 }); }
    P.footer(`Notfallblatt ${c.name} · Stand ${c.stand} · Angaben der Familie aus Pflegekreis – bitte aktuell halten. Bei Lebensgefahr 112.`);
    return d.output("blob");
  }

  // ---------- Diagramm (Vektor) ----------
  function chart(d, x, y, w, h, m) {
    // m: { from, to, series:[{pts:[[ms,v,c]], color, label}], band:[lo,hi], band2, dash:[v], unit, dec }
    const all = m.series.flatMap((s) => s.pts.map((p) => p[1])).concat(m.band ? m.band : [], m.band2 ? m.band2 : [], m.dash || []);
    let lo = Math.min(...all), hi = Math.max(...all); if (!isFinite(lo)) { lo = 0; hi = 1; }
    const span = hi - lo || Math.max(1, Math.abs(hi) * 0.1); lo -= span * 0.12; hi += span * 0.12;
    const step = niceStep((hi - lo) / 4); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const X = (t) => x + 12 + ((t - m.from) / (m.to - m.from || 1)) * (w - 14), Y = (v) => y + h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 9);
    d.setDrawColor(LINE); d.setLineWidth(0.2);
    for (let v = lo; v <= hi + 1e-9; v += step) { d.line(x + 12, Y(v), x + w - 2, Y(v)); font(d, 6.5, "normal", MUTED); d.text(fmt(v, step < 1 ? 1 : 0), x + 10.5, Y(v), { align: "right", baseline: "middle" }); }
    const bandR = (b, col) => { if (!b) return; const a = Y(Math.min(b[1], hi)), z = Y(Math.max(b[0], lo)); d.setFillColor(col); d.rect(x + 12, a, w - 14, z - a, "F"); };
    bandR(m.band, SOFT); bandR(m.band2, "#E6F0EE");
    for (const v of m.dash || []) { d.setDrawColor(PETROL); d.setLineDashPattern([1.2, 1], 0); d.setLineWidth(0.3); d.line(x + 12, Y(v), x + w - 2, Y(v)); d.setLineDashPattern([], 0); }
    // x-Achse: Datumsmarken
    const days = Math.round((m.to - m.from) / 864e5), every = days <= 8 ? 1 : days <= 31 ? 7 : 14;
    font(d, 6.5, "normal", MUTED);
    for (let t = m.from; t <= m.to; t += every * 864e5) { const dt = new Date(t); d.setDrawColor(LINE); d.line(X(t), y + h - 6, X(t), y + h - 5); d.text(`${dt.getDate()}.${dt.getMonth() + 1}.`, X(t), y + h - 4.2, { align: "center", baseline: "top" }); }
    for (const s of m.series) {
      const pts = s.pts.slice().sort((a, b) => a[0] - b[0]);
      d.setDrawColor(s.color); d.setLineWidth(0.45);
      for (let i = 1; i < pts.length; i++) d.line(X(pts[i - 1][0]), Y(pts[i - 1][1]), X(pts[i][0]), Y(pts[i][1]));
      for (const p of pts) {
        if (p[2] === "hi" || p[2] === "lo") { d.setFillColor("#FFFFFF"); d.setDrawColor(WARN); d.setLineWidth(0.5); d.circle(X(p[0]), Y(p[1]), 0.95, "FD"); }
        else { d.setFillColor(s.color); d.circle(X(p[0]), Y(p[1]), pts.length > 80 ? 0.45 : 0.65, "F"); }
      }
    }
    d.setDrawColor(LINE); d.setLineWidth(0.3); d.line(x + 12, y + h - 6, x + w - 2, y + h - 6);
  }
  const niceStep = (r) => { const p = Math.pow(10, Math.floor(Math.log10(r || 1))), n = r / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
  const fmt = (n, dec = 0) => Number(n).toLocaleString("de-DE", { minimumFractionDigits: dec, maximumFractionDigits: dec });

  // ---------- Arzt-Bericht ----------
  function report(m) {
    const d = mk("p"); d.setProperties({ title: T(`Arzt-Bericht ${m.person.name} ${m.range.label}`), creator: "Pflegekreis", subject: "Bericht für den Arztbesuch" });
    const P = pager(d, { title: `Arzt-Bericht ${m.person.name} · ${m.range.label}` });
    // Kopf
    font(d, 8.5, "bold", PETROL); d.text("PFLEGEKREIS · BERICHT FÜR DEN ARZTBESUCH", P.L, 14, { baseline: "top", charSpace: 0.4 });
    font(d, 20, "bold", INK); d.text(T(m.person.name), P.L, 19, { baseline: "top" });
    const id = [m.person.birth ? "geb. " + m.person.birth + (m.person.age ? ` (${m.person.age} Jahre)` : "") : "", m.person.blood ? "Blutgruppe " + m.person.blood : ""].filter(Boolean).join("  ·  ");
    font(d, 10, "normal", MUTED); if (id) d.text(T(id), P.L, 27.5, { baseline: "top" });
    d.setFillColor(TINT); d.roundedRect(P.L, 33, P.W, m.appt ? 19 : 13.5, 2, 2, "F");
    const kv = (k, v, xx, yy) => { font(d, 7.5, "bold", MUTED); d.text(T(k).toUpperCase(), xx, yy, { baseline: "top", charSpace: 0.2 }); font(d, 10, "bold", INK); d.text(T(v), xx, yy + 3.6, { baseline: "top" }); };
    kv("Zeitraum", m.range.label, P.L + 4, 35); kv("Erstellt", m.created, P.L + 92, 35);
    if (m.appt) { font(d, 9, "normal", INK); d.text(T("Für den Termin: " + m.appt), P.L + 4, 46, { baseline: "top", maxWidth: P.W - 8 }); }
    P.y = m.appt ? 56 : 50.5;
    if (m.basics) {
      for (const f of m.basics.flags) P.box(f.t + (f.d ? ": " + f.d : ""), { pt: 10 });
      const rows = [["Allergien / Unverträglichkeiten", m.basics.allergies || "keine bekannt"], m.basics.diagnoses ? ["Diagnosen / Hinweise (laut Familie)", m.basics.diagnoses] : null].filter(Boolean);
      P.table([{ h: "", w: 56 }, { h: "" }], rows.map((r) => ({ cells: r, bold: false })), { head: false, zebra: false, pt: 9.5 });
    }
    if (m.meds) {
      P.h2("Medikamentenplan");
      P.table([{ h: "Medikament", w: 50 }, { h: "Dosis", w: 40 }, { h: "Zeiten", w: 30 }, { h: "Hinweis" }], m.meds.map((x) => ({ cells: [x.name, x.dosage || "", x.times || "", x.notes || ""], mark: x.hl })), { pt: 9, markCol: 0 });
    }
    if (m.adh) {
      P.h2("Einnahmetreue");
      const a = m.adh;
      if (!a.rows.length) P.p(a.note || "Im Zeitraum wurden keine Einnahmen in Pflegekreis abgehakt.", { color: MUTED, pt: 9.5 });
      else {
        P.p(`${a.planned} geplante Einnahmen${a.since ? " (abgehakt in Pflegekreis seit " + a.since + ")" : ""}: ${a.given} gegeben${a.carer ? " (davon " + a.carer + " durch den Pflegedienst)" : ""}, ${a.missed} nicht als gegeben eingetragen${a.planned ? " – " + fmt((a.given / a.planned) * 100) + " % gegeben" : ""}.`, { pt: 9.5 });
        P.gap(1);
        if (a.carer) P.table([{ h: "Medikament", w: 46 }, { h: "Geplant", w: 16, a: "r" }, { h: "Gegeben", w: 17, a: "r" }, { h: "durch Pflegedienst", w: 30, a: "r" }, { h: "Vergessen", w: 18, a: "r" }, { h: "Vergessen am" }],
          a.rows.map((r) => ({ cells: [r.name + (r.dosage ? " " + r.dosage : ""), String(r.planned), String(r.given), r.carer ? String(r.carer) : "–", String(r.missed), r.missedList.join(", ") || "–"], mark: r.missed > 0 })), { pt: 8.8, markCol: 4 });
        else P.table([{ h: "Medikament", w: 52 }, { h: "Geplant", w: 18, a: "r" }, { h: "Gegeben", w: 19, a: "r" }, { h: "Vergessen", w: 20, a: "r" }, { h: "Vergessen am" }],
          a.rows.map((r) => ({ cells: [r.name + (r.dosage ? " " + r.dosage : ""), String(r.planned), String(r.given), String(r.missed), r.missedList.join(", ") || "–"], mark: r.missed > 0 })), { pt: 8.8, markCol: 3 });
        P.p(a.foot, { pt: 7.8, color: MUTED });
      }
    }
    if (m.vit && !m.vit.length) { P.h2("Messwerte"); P.p("Keine Messungen im Zeitraum.", { pt: 9.5, color: MUTED }); }
    if (m.vit && m.vit.length) {
      P.h2("Messwerte", m.vitCharts ? 95 : 40);
      if (m.vitCharts) for (const v of m.vit) {
        P.need(m.vitCharts ? 70 : 30);
        P.h3(`${v.name} (${v.unit})`);
        font(d, 8.5, "normal", MUTED); const sub = `${v.n} Messungen${v.target ? " · Zielbereich laut Familie: " + v.target : ""}${v.nout ? ` · ${v.nout} außerhalb des Zielbereichs` : ""}`;
        P.p(sub, { pt: 8.5, color: MUTED }); P.gap(0.8);
        // Kennzahlen
        P.table([{ h: "", w: 46 }, { h: "Minimum", w: 30, a: "r" }, { h: "Maximum", w: 30, a: "r" }, { h: "Durchschnitt", w: 30, a: "r" }, { h: "" }], v.stats.map((s) => [s.label, s.min, s.max, s.avg, ""]), { pt: 9, zebra: false });
        if (m.vitCharts && v.series.some((s) => s.pts.length)) {
          P.need(52); chart(d, P.L, P.y, P.W, 46, { from: m.range.from, to: m.range.to, series: v.series, band: v.band, band2: v.band2, dash: v.dash });
          P.y += 47;
          font(d, 7.3, "normal", MUTED); let lx = P.L + 12; const ly = P.y;
          for (const s of v.series) { d.setFillColor(s.color); d.circle(lx + 1, ly + 1.3, 0.8, "F"); d.text(T(s.label), lx + 3, ly, { baseline: "top" }); lx += 6 + d.getTextWidth(T(s.label)); }
          if (v.band) { d.setFillColor(SOFT); d.rect(lx, ly + 0.4, 4, 1.9, "F"); d.text(T(v.bandLabel || "Zielbereich"), lx + 5, ly, { baseline: "top" }); lx += 9 + d.getTextWidth(T(v.bandLabel || "Zielbereich")); }
          if (v.dash?.length) { d.setDrawColor(PETROL); d.setLineDashPattern([1.2, 1], 0); d.line(lx, ly + 1.3, lx + 4, ly + 1.3); d.setLineDashPattern([], 0); d.text(T(v.dashLabel || ""), lx + 5, ly, { baseline: "top" }); lx += 9 + d.getTextWidth(T(v.dashLabel || "")); }
          d.setDrawColor(WARN); d.setFillColor("#FFFFFF"); d.setLineWidth(0.5); d.circle(lx + 1, ly + 1.3, 0.9, "FD"); const ol = lx + 3 + d.getTextWidth("außerhalb des Zielbereichs") > P.L + P.W ? "außerhalb" : "außerhalb des Zielbereichs"; d.text(ol, lx + 3, ly, { baseline: "top" });
          P.y += 5.5;
        }
      }
      if (m.vitTable) {
        for (const v of m.vit) {
          if (!v.rows.length) continue;
          P.need(30); P.h3(`Messliste ${v.name} (${v.unit})`);
          const cols = v.kind === "bp" ? [{ h: "Datum", w: 26 }, { h: "Uhrzeit", w: 16 }, { h: "Blutdruck", w: 24, a: "r" }, { h: "Puls", w: 14, a: "r" }, { h: "Einordnung", w: 34 }, { h: "Notiz" }]
            : v.kind === "glucose" ? [{ h: "Datum", w: 26 }, { h: "Uhrzeit", w: 16 }, { h: "Wert", w: 18, a: "r" }, { h: "Kontext", w: 32 }, { h: "Einordnung", w: 34 }, { h: "Notiz" }]
            : v.kind === "spo2" ? [{ h: "Datum", w: 26 }, { h: "Uhrzeit", w: 16 }, { h: "SpO2", w: 18, a: "r" }, { h: "Puls", w: 14, a: "r" }, { h: "Einordnung", w: 34 }, { h: "Notiz" }]
            : [{ h: "Datum", w: 26 }, { h: "Uhrzeit", w: 16 }, { h: "Wert", w: 20, a: "r" }, { h: "Einordnung", w: 34 }, { h: "Notiz" }];
          P.table(cols, v.rows.map((r) => ({ cells: v.kind === "bp" || v.kind === "spo2" ? [r.d, r.t, r.val, r.pulse || "", r.cls, r.note || ""] : v.kind === "glucose" ? [r.d, r.t, r.val, r.ctx || "", r.cls, r.note || ""] : [r.d, r.t, r.val, r.cls, r.note || ""], mark: !!r.out })), { pt: 8.3, markCol: v.kind === "bp" || v.kind === "spo2" || v.kind === "glucose" ? 4 : 3 });
        }
      }
      P.p("Einordnung nur nach den Zielbereichen, die die Familie in Pflegekreis hinterlegt hat (keine Bewertung, keine Diagnose).", { pt: 7.8, color: MUTED });
    }
    if (m.journal) {
      P.h2("Befinden und Notizen (Tagebuch)");
      if (!m.journal.length) P.p("Keine Einträge im Zeitraum.", { pt: 9.5, color: MUTED });
      else { if (m.journalSummary) { P.p("Im Zeitraum: " + m.journalSummary, { pt: 9 }); P.gap(1); } P.table([{ h: "Wann", w: 34 }, { h: "Eintrag", w: 44 }, { h: "Notiz" }], m.journal.map((j) => ({ cells: [j.when, j.label, j.note || ""], mark: j.imp })), { pt: 8.8, markCol: 1 }); if (m.journalMore) P.p(`… und ${m.journalMore} ältere Einträge (in der App im Tagebuch).`, { pt: 8, color: MUTED }); }
    }
    if (m.questions != null) {
      P.h2("Fragen an den Arzt");
      const qs = String(m.questions || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
      for (const q of qs) { P.need(7); font(d, 10.5, "bold", PETROL); d.text("?", P.L + 1, P.y, { baseline: "top" }); P.p(q, { pt: 10.5, x: P.L + 6, w: P.W - 6 }); P.gap(1); }
      P.gap(2); P.need(30); font(d, 8, "normal", MUTED); d.text(qs.length ? "Antworten / Notizen beim Termin:" : "Platz für Fragen und Notizen beim Termin:", P.L, P.y, { baseline: "top" }); P.y += 6;
      d.setDrawColor(LINE); d.setLineWidth(0.3); for (let i = 0; i < 4; i++) { P.need(8); d.line(P.L, P.y + 5, P.R, P.y + 5); P.y += 8; }
    }
    P.gap(4); P.need(16);
    P.box("Hinweis: Dieser Bericht fasst Einträge der Familie in Pflegekreis zusammen. Er ist kein ärztliches Dokument und kein Ersatz für ärztlichen Rat. Messwerte stammen aus Heimgeräten.", { pt: 8.5, bg: TINT, color: PETROL_D, style: "normal" });
    P.footer(`Arzt-Bericht ${m.person.name} · ${m.range.label} · erstellt ${m.created} mit Pflegekreis · kein Ersatz für ärztlichen Rat`);
    return d.output("blob");
  }
  window.PF_PDF = { sosCard, sosSheet, report, T };
})();
