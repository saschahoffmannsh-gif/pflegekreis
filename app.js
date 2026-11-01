/* Pflegekreis – Pflege gemeinsam organisieren */
(() => {
"use strict";
const C = window.PF_CONFIG || {};
const DEMO = !C.supabaseUrl;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");

// ---------- Fehler-Überwachung (ohne Fremddienst) ----------
// JS-Fehler, unbehandelte Promises und fehlgeschlagene Server-Aufrufe gehen gedrosselt an die Edge Function (Tabelle pf_client_errors).
// Nur Fehlertext, gekürzter Stack, Seite (ohne IDs), App-Version – keine Chat- oder Gesundheitsinhalte. Max. 8 pro Sitzung, doppelte nur einmal.
const APP_V = ((document.querySelector('script[src*="app.js"]') || {}).src || "").match(/[?&]v=([^&]+)/)?.[1] || "dev";
const ERRS = { n: 0, max: 8, last: 0, seen: new Set() };
const errPage = () => (location.hash.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id") || "#/").slice(0, 80);
function reportError(kind, message, stack = "") {
  try {
    const msg = String(message || "").replace(/\s+/g, " ").trim().slice(0, 300); if (!msg) return;
    const k = `${kind}|${msg}|${errPage()}`;
    if (ERRS.seen.has(k) || ERRS.n >= ERRS.max || Date.now() - ERRS.last < 1000) return;
    ERRS.seen.add(k); ERRS.n++; ERRS.last = Date.now();
    const body = { action: "log_error", kind, message: msg, stack: String(stack || "").slice(0, 2000), page: errPage(), v: APP_V };
    if (DEMO) { try { const a = JSON.parse(localStorage.getItem("pf-demo-errors") || "[]"); a.push({ ...body, at: new Date().toISOString() }); localStorage.setItem("pf-demo-errors", JSON.stringify(a.slice(-50))); } catch {} return; }
    let tok = C.anonKey; try { tok = JSON.parse(localStorage.getItem("pf-auth") || "{}").access_token || tok; } catch {}
    fetch(`${C.supabaseUrl}/functions/v1/${C.functionName}`, { method: "POST", keepalive: true, headers: { "content-type": "application/json", apikey: C.anonKey, authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }).catch(() => {});
  } catch {}
}
window.addEventListener("error", (e) => { if (e.message) reportError("error", e.message, e.error?.stack || `${String(e.filename || "").split("/").pop()}:${e.lineno}:${e.colno}`); });
window.addEventListener("unhandledrejection", (e) => { const r = e.reason; reportError("promise", r?.message || String(r), r?.stack || ""); });

// ---------- Backend (live = Supabase, sonst Demo im Browser) ----------
function liveBackend() {
  const sb = supabase.createClient(C.supabaseUrl, C.anonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "pf-auth" } });
  const chk = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") window.dispatchEvent(new CustomEvent("pf-signedout", { detail: "" })); });
  const B = {
    demo: false,
    async session() { const { data: { session } } = await sb.auth.getSession(); return session ? { uid: session.user.id } : null; },
    async signIn(username, password) {
      const { error } = await sb.auth.signInWithPassword({ email: `${username}@${C.emailDomain}`, password });
      if (error) throw new Error(/invalid/i.test(error.message) ? "Benutzername oder Passwort stimmt nicht" : error.message);
    },
    async signOut() { await sb.auth.signOut(); },
    // Konto-Wechsler: die gespeicherte Sitzung (dieselbe, die supabase-js ohnehin unter „pf-auth“ ablegt) lesen bzw. einsetzen
    rawSession() { return localStorage.getItem("pf-auth"); },
    useRawSession(raw) { try { sb.auth.stopAutoRefresh(); } catch {} if (raw) localStorage.setItem("pf-auth", raw); else localStorage.removeItem("pf-auth"); },
    async fn(action, body = {}) {
      const pwAct = action === "change_password" || action === "set_new_password";
      if (pwAct) window.__pfPwSwitch = true;
      try { return await B._fn(action, body); } finally { if (pwAct) setTimeout(() => (window.__pfPwSwitch = false), 1500); }
    },
    async _fn(action, body) {
      const { data: { session } } = await sb.auth.getSession();
      let r;
      try {
        r = await fetch(`${C.supabaseUrl}/functions/v1/${C.functionName}`, {
          method: "POST",
          headers: { "content-type": "application/json", apikey: C.anonKey, authorization: `Bearer ${session?.access_token ?? C.anonKey}` },
          body: JSON.stringify({ action, ...body }),
        });
      } catch { if (navigator.onLine !== false) reportError("net", `${action}: keine Verbindung`); throw new Error("Keine Verbindung – bitte Internet prüfen"); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status >= 500 || r.status === 403) reportError("fn", `${action} → ${r.status}: ${j.error || ""}`);
        if (r.status === 401 && session) window.dispatchEvent(new CustomEvent("pf-signedout", { detail: j.error || "" }));
        throw new Error(j.error || `Fehler ${r.status}`);
      }
      // Passwort geändert → Supabase beendet alle Sitzungen; die Function liefert eine frische für dieses Gerät
      if (j.session?.access_token) { await sb.auth.setSession(j.session); delete j.session; }
      return j;
    },
    async me(uid) { return chk(await sb.from("pf_profiles").select("id,username,display_name,consent_health_at,must_change_password").eq("id", uid).maybeSingle()); },
    async families(uid) {
      const d = chk(await sb.from("pf_members").select("role, senior_id, pf_families(id,name,invite_code,invite_expires_at,created_at)").eq("user_id", uid));
      return (d || []).filter((m) => m.pf_families).map((m) => ({ ...m.pf_families, role: m.role, senior_id: m.senior_id || null }));
    },
    async load(fid, uid) {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const yday = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toLocaleDateString("sv-SE"); })(); // 7 Tage für Tagebuch/Woche
      const [members, seniors, tasks, appts, contacts, notes, prefs, meds, doses, care, handoffs, vitals, shifts] = await Promise.all([
        sb.from("pf_members").select("user_id,role,senior_id,joined_at,pf_profiles(display_name,username)").eq("family_id", fid),
        sb.from("pf_seniors").select("*").eq("family_id", fid).order("created_at"),
        sb.from("pf_tasks").select("*").eq("family_id", fid).or(`status.neq.done,completed_at.gte.${since}`).limit(500),
        sb.from("pf_appointments").select("*").eq("family_id", fid).gte("starts_at", new Date(Date.now() - 62 * 864e5).toISOString()).order("starts_at").limit(500),
        sb.from("pf_contacts").select("*").eq("family_id", fid).order("name").limit(500),
        sb.from("pf_notes").select("*").eq("family_id", fid).not("senior_id", "is", null).order("created_at").limit(500),
        sb.from("pf_notif_prefs").select("*").eq("user_id", uid).maybeSingle(),
        sb.from("pf_medications").select("*").eq("family_id", fid).order("created_at").limit(200),
        sb.from("pf_med_doses").select("*").eq("family_id", fid).gte("day", yday).limit(2000),
        sb.from("pf_care_entries").select("*").eq("family_id", fid).gte("created_at", new Date(Date.now() - 8 * 864e5).toISOString()).order("created_at", { ascending: false }).limit(300),
        sb.from("pf_handoffs").select("*").eq("family_id", fid).order("created_at", { ascending: false }).limit(100),
        sb.from("pf_vitals").select("*").eq("family_id", fid).gte("measured_at", new Date(Date.now() - 92 * 864e5).toISOString()).order("measured_at", { ascending: false }).limit(3000),
        sb.from("pf_carer_shifts").select("*").eq("family_id", fid).limit(1000),
      ]);
      return {
        members: chk(members).map((m) => ({ user_id: m.user_id, role: m.role, senior_id: m.senior_id || null, joined_at: m.joined_at, display_name: m.pf_profiles?.display_name ?? "?", username: m.pf_profiles?.username ?? "" })),
        seniors: chk(seniors), tasks: chk(tasks), appts: chk(appts), contacts: chk(contacts), notes: chk(notes), prefs: prefs.data || null, meds: chk(meds), doses: chk(doses), care: chk(care), handoffs: chk(handoffs), vitals: chk(vitals),
        shifts: shifts.error ? [] : shifts.data || [], // Einsatzplan (fehlt die Tabelle noch, läuft die App ohne)
      };
    },
    // Tagebuch: einen älteren Tag nachladen (nur lesen, per RLS)
    async journal(fid, day) {
      const a = new Date(day + "T00:00:00"), b = new Date(a); b.setDate(b.getDate() + 1);
      const A = a.toISOString(), Bs = b.toISOString();
      const [care, doses, handoffs, tasks, appts, vitals] = await Promise.all([
        sb.from("pf_care_entries").select("*").eq("family_id", fid).gte("created_at", A).lt("created_at", Bs).limit(500),
        sb.from("pf_med_doses").select("*").eq("family_id", fid).or(`day.eq.${day},and(given_at.gte.${A},given_at.lt.${Bs})`).limit(500),
        sb.from("pf_handoffs").select("*").eq("family_id", fid).lt("created_at", Bs).or(`ended_at.is.null,ended_at.gte.${A}`).limit(200),
        sb.from("pf_tasks").select("*").eq("family_id", fid).eq("status", "done").gte("completed_at", A).lt("completed_at", Bs).limit(300),
        sb.from("pf_appointments").select("*").eq("family_id", fid).gte("starts_at", A).lt("starts_at", Bs).limit(100),
        sb.from("pf_vitals").select("*").eq("family_id", fid).gte("measured_at", A).lt("measured_at", Bs).limit(300),
      ]);
      return { care: chk(care), doses: chk(doses), handoffs: chk(handoffs), tasks: chk(tasks), appts: chk(appts), vitals: chk(vitals) };
    },
    // Arzt-Bericht: Einnahmen (seitenweise, je bis 1000 Zeilen) und Befinden für bis zu 90 Tage nachladen (nur lesen, per RLS)
    async report(fid, fromIso, fromDay, medIds = []) {
      const doses = [];
      if (medIds.length) for (let i = 0; i < 10; i++) { const d = chk(await sb.from("pf_med_doses").select("medication_id,day,slot,given_at,given_by,missed_notified_at,done_by_kind,carer_contact_id").eq("family_id", fid).in("medication_id", medIds).gte("day", fromDay).order("day").range(i * 1000, i * 1000 + 999)); doses.push(...d); if (d.length < 1000) break; }
      const care = chk(await sb.from("pf_care_entries").select("*").eq("family_id", fid).gte("created_at", fromIso).order("created_at", { ascending: false }).limit(1000));
      return { doses, care };
    },
    realtime(fid, cb) {
      const ch = sb.channel("pf-" + fid);
      for (const t of ["pf_tasks", "pf_appointments", "pf_contacts", "pf_notes", "pf_seniors", "pf_members", "pf_medications", "pf_med_doses", "pf_care_entries", "pf_handoffs", "pf_vitals", "pf_carer_shifts"])
        ch.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `family_id=eq.${fid}` }, cb);
      ch.subscribe();
      return () => sb.removeChannel(ch);
    },
    async photoUrls(fid, paths) { return (await B.fn("media_urls", { family_id: fid, paths })).urls || {}; },
  };
  return B;
}
const API = DEMO ? window.PF_DEMO_BACKEND(C) : liveBackend();

// ---------- Konstanten ----------
const KINDS = { arzt: { e: "🩺", n: "Arzt" }, pflege: { e: "🤲", n: "Pflege" }, besuch: { e: "☕", n: "Besuch" }, sonstiges: { e: "📌", n: "Sonstiges" } };
const STATUS = { open: "Offen", in_progress: "In Arbeit", done: "Erledigt" };
const REC = { none: "Einmalig", daily: "Täglich", weekly: "Wöchentlich" };
// Personenfarben (Redesign): 0 = Koralle (z. B. Oma), 1 = Blau (z. B. Opa), danach weitere ruhige Töne.
// Die gespeicherte Nummer bleibt gleich – nur die Palette ist neu (keine Datenänderung nötig).
const SENIOR_COLORS = ["#D9785F", "#5B86A6", "#5E8C5A", "#8E6AA8", "#C08A2E", "#3F8C8A", "#B35C7A", "#6F7B86"];
// Kontakte (Adressbuch): Ärzte, Apotheke, Pflegedienst …
const CCAT = { arzt: ["Arzt / Ärztin", "steth"], facharzt: ["Fachärztin / Facharzt", "steth"], apotheke: ["Apotheke", "pill"], pflegedienst: ["Pflegedienst", "heart"], familie: ["Familie & Nachbarn", "fam"], sonstiges: ["Sonstiges", "user"] };
const CCAT_SHORT = { arzt: "Arzt", facharzt: "Fachärztin", apotheke: "Apotheke", pflegedienst: "Pflegedienst", familie: "Familie", sonstiges: "Sonstiges" };
const TASK_SUGGEST = ["Medikament geben", "Arztbesuch begleiten", "Einkaufen", "Besuch machen", "Rezept abholen", "Anrufen"];
const PREFS = [
  ["new_task", "Neue Aufgaben in der Familie"],
  ["assigned", "Mir zugewiesene Aufgaben (und wenn meine erledigt wurden)"],
  ["appointment", "Neue Termine"],
  ["med_missed", "Medikament nicht rechtzeitig als gegeben markiert"],
  ["handoff", "Übergaben („Ich bin jetzt da“ / „Ich gehe“)"],
  ["care_important", "Wichtige Kurz-Einträge (unruhig, Schmerzen, Besonderheit)"],
  ["carer_arrive", "Pflegedienst ist da (Beginn laut Einsatzplan)"],
];
const DEF_PREFS = { new_task: true, assigned: true, appointment: true, chat_family: false, chat_threads: false, med_missed: true, handoff: true, care_important: true, carer_arrive: false };
const CARE = {
  med: { e: "💊", n: "Medikament gegeben" }, ate_well: { e: "🍽️", n: "Hat gut gegessen" }, ate_little: { e: "🥄", n: "Wenig gegessen" },
  slept_well: { e: "😴", n: "Gut geschlafen" }, slept_bad: { e: "🌙", n: "Schlecht geschlafen" }, mood_good: { e: "😊", n: "Gute Laune" },
  restless: { e: "😟", n: "War unruhig", imp: true }, pain: { e: "🤕", n: "Hat Schmerzen", imp: true }, special: { e: "⚠️", n: "Besonderheit heute", imp: true },
};
// nur in der Senioren-Ansicht („Wie geht's mir?“, „Hilfe holen“) – nicht als Schnell-Chips für Helfer
const CARE_SR = { mood_ok: { e: "😐", n: "Geht so" }, mood_bad: { e: "☹️", n: "Fühlt sich nicht gut", imp: true }, help: { e: "🔔", n: "Hat um Hilfe gebeten", imp: true } };
const careK = (k) => CARE[k] || CARE_SR[k] || { e: "•", n: k };
const CONSENT_HEALTH = "Ich willige ausdrücklich ein, dass Pflegekreis die Gesundheitsdaten, die ich und meine Familie eintragen (z. B. Medikamente, Allergien, Befinden), speichert und den Mitgliedern meiner Familie anzeigt (Art. 9 Abs. 2 lit. a DSGVO). Ich kann das jederzeit widerrufen, z. B. indem ich mein Konto lösche.";
// CAPTCHA (vorbereitet, standardmäßig aus): Cloudflare Turnstile, nur wenn config.js captchaSiteKey enthält
let captchaId = null;
function mountCaptcha() {
  const go = () => { const el = $("#captcha"); if (el && window.turnstile) captchaId = window.turnstile.render(el, { sitekey: C.captchaSiteKey, language: "de" }); };
  if (window.turnstile) return go();
  if (!document.getElementById("ts-js")) { const sc = document.createElement("script"); sc.id = "ts-js"; sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; sc.async = true; sc.onload = go; document.head.appendChild(sc); }
}
const captchaToken = () => (C.captchaSiteKey && window.turnstile && captchaId != null ? window.turnstile.getResponse(captchaId) : undefined);
const MED_GRACE_MIN = 30; // gleiche Kulanzzeit wie in der Edge Function (PF_MED_GRACE_MIN)

// ---------- Zustand ----------
const S = { uid: null, me: null, fams: [], fid: localStorage.getItem("pf-fid"), D: null, photo: {}, unsub: null, pollT: null, taskFilter: localStorage.getItem("pf-plan-f") || "open", taskSenior: "", hh: localStorage.getItem("pf-hh") || "", onboard: null, drafts: {} };
{ const u = new URL(location.href); const inv = u.searchParams.get("invite"); if (inv) { localStorage.setItem("pf-invite", inv.trim().toUpperCase()); u.searchParams.delete("invite"); history.replaceState(null, "", u.pathname + u.search + u.hash); } }
const pendingInvite = () => localStorage.getItem("pf-invite");

// ---------- Helfer ----------
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
const parseD = (s) => new Date(s + "T12:00:00");
function dayLabel(s, long = false) {
  const t = today();
  if (s === t) return "Heute"; if (s === addDays(t, 1)) return "Morgen"; if (s === addDays(t, -1)) return "Gestern";
  return parseD(s).toLocaleDateString("de-DE", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" });
}
const hm = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const isoDay = (iso) => ymd(new Date(iso));
function rel(ts) {
  const d = new Date(ts), s = (Date.now() - d) / 1000;
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  const day = isoDay(ts);
  if (day === today()) return `heute, ${hm(ts)}`;
  if (day === addDays(today(), -1)) return `gestern, ${hm(ts)}`;
  return `${dayLabel(day)}, ${hm(ts)}`;
}
function toast(msg, ms = 3000) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; $("#toasts").appendChild(t); setTimeout(() => t.remove(), ms); }
const reduceMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Dunkler Toast mit Aktion (z. B. „Erledigt – danke, Sascha! · Rückgängig“)
function undoToast(msg, onUndo, ms = 6000, by = null) {
  $$("#toasts .toast2").forEach((x) => x.remove());
  const t = document.createElement("div"); t.className = "toast toast2"; t.setAttribute("role", "status");
  t.innerHTML = `<span class="tk" aria-hidden="true">${ICON.check}</span><span class="tx">${esc(msg)}${by ? `<button type="button" class="by" aria-label="Wer hat es gemacht? Ändern">${by.label}</button>` : ""}</span>${onUndo ? '<button type="button" class="undo">Rückgängig</button>' : ""}`;
  $("#toasts").appendChild(t);
  const kill = () => { clearTimeout(tm); t.classList.add("out"); setTimeout(() => t.remove(), reduceMotion() ? 0 : 220); };
  const tm = setTimeout(kill, ms);
  const b = $(".undo", t); if (b) b.onclick = () => { b.disabled = true; kill(); onUndo(); };
  const w = $(".by", t); if (w) w.onclick = () => { kill(); by.onClick(); };
  return t;
}
const member = (id) => S.D?.members.find((m) => m.user_id === id);
const nm = (id) => (id === S.uid ? "Du" : member(id)?.display_name ?? "Ehemaliges Mitglied");
const nmPlain = (id) => member(id)?.display_name ?? "Ehemaliges Mitglied";
const senior = (id) => S.D?.seniors.find((s) => s.id === id);
const fam = () => S.fams.find((f) => f.id === S.fid);
const isAdmin = () => fam()?.role === "admin";
const initials = (n) => (String(n || "?").trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")[0]).filter(Boolean).slice(0, 2).join("") || "?").toUpperCase();
const hue = (id) => SENIOR_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % SENIOR_COLORS.length];
// Mitgliederfarben: eigene, kräftigere Palette (≠ Personenfarben), stabil nach Beitrittsreihenfolge
const MEMBER_COLORS = ["#B4532A", "#2D6CA8", "#7448A8", "#23784F", "#A83C66", "#8A6508", "#17788A", "#4F5DB8"];
const mHue = (id) => { const i = (S.D?.members || []).findIndex((m) => m.user_id === id); return i >= 0 ? MEMBER_COLORS[i % MEMBER_COLORS.length] : MEMBER_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % MEMBER_COLORS.length]; };
const ava = (id, size = "") => `<span class="ava ${size}" style="background:${mHue(id)}">${esc(initials(nmPlain(id)))}</span>`;
// ---------- „Erledigt von“ (Phase 27): ich · Pflegedienst (Kontakt, ohne Konto) · anderes Familienmitglied ----------
// Eingetragen hat es weiterhin, wer abhakt (given_by / completed_by / created_by / author_id); done_by_* sagt, wer es gemacht hat.
const DONE_T = { dose: ["doses", "given_by", "given_at"], task: ["tasks", "completed_by", "completed_at"], vital: ["vitals", "created_by", "measured_at"], care: ["care", "author_id", "created_at"] };
const carerC = (x) => (x?.carer_contact_id && (S.D?.contacts || []).find((c) => c.id === x.carer_contact_id)) || null;
const carersFor = (sid) => (S.D?.contacts || []).filter((c) => c.category === "pflegedienst" && (!c.senior_id || !sid || c.senior_id === sid));
const isCarer = (x) => x?.done_by_kind === "carer";
const doerUid = (x, by) => (x?.done_by_kind === "member" && x.done_by_user) || by;
const carerName = (x) => carerC(x)?.name || "Pflegedienst";
const carerTag = (x, full = false) => `<span class="carer-tag" title="${esc(carerName(x))}">${ICON.carer}<span>${esc(full ? carerName(x) : "Pflegedienst")}</span></span>`;
const carerIco = () => `<span class="carer-ic" aria-hidden="true">${ICON.carer}</span>`;
const doerHtml = (x, by, { plain = false, full = false } = {}) => isCarer(x) ? carerTag(x, full) : esc(plain ? nmPlain(doerUid(x, by)) : nm(doerUid(x, by)));
const doerPlain = (x, by) => isCarer(x) ? carerName(x) : nmPlain(doerUid(x, by));
const enteredBy = (x, by) => x?.done_by_kind && x.done_by_kind !== "self" ? `eingetragen von ${by === S.uid ? "dir" : nmPlain(by)}` : "";
const canDoer = (by) => !isSenior() && (by === S.uid || isAdmin());
const doerKey = (x) => x?.done_by_kind === "carer" ? "c:" + (x.carer_contact_id || "") : x?.done_by_kind === "member" ? "m:" + x.done_by_user : "self";
function doerOpts(sid) {
  const cs = carersFor(sid);
  return [{ kind: "self", label: "Ich selbst", sub: "Standard", key: "self" },
    ...(cs.length ? cs.map((c) => ({ kind: "carer", id: c.id, label: c.name, sub: "Pflegedienst" + (c.org ? " · " + c.org : ""), key: "c:" + c.id }))
      : [{ kind: "carer", id: null, label: "Pflegedienst", sub: "Tipp: unter „Kontakte“ anlegen, dann steht hier der Name", key: "c:" }]),
    ...(S.D.members || []).filter((m) => m.user_id !== S.uid && m.role !== "senior").map((m) => ({ kind: "member", uid: m.user_id, label: m.display_name, sub: "Familie", key: "m:" + m.user_id }))];
}
const doneByOf = (o) => o.kind === "carer" ? { kind: "carer", carer_contact_id: o.id } : o.kind === "member" ? { kind: "member", user_id: o.uid } : { kind: "self" };
// Auswahl „Wer hat es gemacht?“ – kurz, ohne Pflicht: Standard bleibt „Ich“
function openDoer(what, id) {
  const T = DONE_T[what], x = (S.D[T[0]] || []).find((r) => r.id === id); if (!x) return;
  const sid = what === "dose" ? medById(x.medication_id)?.senior_id : x.senior_id, cur = doerKey(x), opts = doerOpts(sid);
  const q = { dose: "Wer hat es gegeben?", task: "Wer hat es erledigt?", vital: "Wer hat gemessen?", care: "Wer hat es beobachtet?" }[what];
  const { sh, close } = openSheet(`<div class="sheet-head"><h2>${q}</h2><p class="muted small">Eingetragen ${x[T[1]] === S.uid ? "von dir" : "von " + esc(nmPlain(x[T[1]]))} – das bleibt so. Hier hältst du nur fest, wer es gemacht hat.</p></div>
    <div class="choices doer-list" role="group" aria-label="${q}">${opts.map((o, i) => `<button class="choice doer-o ${o.key === cur ? "on" : ""}" data-o="${i}" aria-pressed="${o.key === cur}">${o.kind === "carer" ? `<span class="doer-ic">${ICON.carer}</span>` : ava(o.kind === "self" ? S.uid : o.uid)}<b>${esc(o.label)}</b><small>${esc(o.sub)}</small></button>`).join("")}</div>
    <div class="btns"><button class="btn ghost" data-close>Abbrechen</button></div>`, "doer-sheet");
  $$("[data-o]", sh).forEach((b) => (b.onclick = async () => {
    const o = opts[+b.dataset.o]; if (o.key === cur) return close();
    const r = await busy(b, () => call("done_by_set", { what, id, done_by: doneByOf(o) })).catch(() => null); if (!r) return;
    const row = r.row || {}; Object.assign(x, { done_by_kind: row.done_by_kind ?? null, carer_contact_id: row.carer_contact_id ?? null, done_by_user: row.done_by_user ?? null });
    close(); toast(o.kind === "self" ? "Eingetragen: von dir" : `Eingetragen: durch ${o.kind === "carer" ? "Pflegedienst" : o.label}`);
    if ($(".sheet")) sheetRefresh?.(); renderBehind(); reload().catch(() => {});
  }));
}
// Tipp auf „✓ Name · Uhrzeit“ öffnet die Auswahl (vor allen anderen Klick-Handlern, damit sich nicht die Zeile öffnet)
document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-doer]"); if (!b) return; e.preventDefault(); e.stopPropagation(); const [w, id] = b.dataset.doer.split(":"); openDoer(w, id); }, true);
const doerChip = (what, id, pick = null) => (isSenior() ? null : { label: `${pick && pick.by.kind !== "self" ? "Durch " + esc(pick.label) : "Von dir"} · <u>ändern</u>`, onClick: () => openDoer(what, id) });
// Formular-Auswahl (Messwert, Notiz): „Ich“ · Pflegedienst – Standard „Ich“
function doerSeg(sid, cur = "self") {
  if (isSenior()) return "";
  const cs = carersFor(sid).slice(0, 2), opts = [["self", "Ich"], ...(cs.length ? cs.map((c) => ["c:" + c.id, c.name.replace(/^Pflegedienst\s+/i, "")]) : [["c:", "Pflegedienst"]])];
  if (cur !== "self" && !opts.some((o) => o[0] === cur)) opts.push([cur, cur.startsWith("m:") ? nmPlain(cur.slice(2)) : "Pflegedienst"]);
  return `<div class="doer-seg"><span class="f">Gemacht von</span><div class="seg small wrap" role="group" aria-label="Gemacht von">${opts.map(([k, l]) => `<button type="button" data-dk="${esc(k)}" class="${k === cur ? "on" : ""}" aria-pressed="${k === cur}">${k.startsWith("c:") ? ICON.carer : ""}${esc(l)}</button>`).join("")}</div><input type="hidden" name="doer" value="${esc(cur)}"></div>`;
}
function bindDoerSeg(root) { $$("[data-dk]", root).forEach((b) => (b.onclick = () => { $$("[data-dk]", root).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); }); $('[name="doer"]', root).value = b.dataset.dk; })); }
const doneByVal = (v) => !v || v === "self" ? { kind: "self" } : v.startsWith("c:") ? { kind: "carer", carer_contact_id: v.slice(2) || null } : { kind: "member", user_id: v.slice(2) };
// ---------- Pflegedienst-Einsatzplan (Phase 28) ----------
// Wiederkehrende Einsätze (Wochentage + Von/Bis), Einzeltermine und Ausfälle je Person. Ob der Pflegedienst gerade „da“ ist,
// wird aus dem Plan berechnet (keine gespeicherte Übernahme): beginnt automatisch, endet automatisch mit „Bis“.
const wdOf = (d) => ((parseD(d).getDay() + 6) % 7) + 1; // 1 = Mo … 7 = So
const atLocal = (d, t) => new Date(`${d}T${t}:00`).getTime();
const hmMs = (ms) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const shiftsOf = (sid) => (S.D?.shifts || []).filter((r) => r.senior_id === sid);
const cShort = (c) => String(c?.name || "Pflegedienst").replace(/^Pflegedienst\s+/i, "") || c.name;
function carerWins(sid, d) {
  const rs = shiftsOf(sid), out = [];
  for (const r of rs) {
    if (r.kind === "weekly" ? !(r.days || []).includes(wdOf(d)) : r.kind !== "once" || r.on_date !== d) continue;
    if (r.kind === "weekly" && rs.some((k) => k.kind === "skip" && k.shift_id === r.id && k.on_date === d)) continue;
    const c = (S.D.contacts || []).find((x) => x.id === r.contact_id); if (!c) continue;
    out.push({ r, c, sid, d, s: atLocal(d, r.start_time), e: atLocal(d, r.end_time) });
  }
  return out.sort((a, b) => a.s - b.s);
}
const carerAt = (sid, ms) => carerWins(sid, ymd(new Date(ms))).find((w) => w.s <= ms && ms < w.e) || null;
const carerNow = (sid) => carerAt(sid, Date.now());
const carerNext = (sid) => carerWins(sid, today()).find((w) => w.s > Date.now()) || null;
function daysLabel(ds) {
  const d = [...new Set(ds || [])].map(Number).sort((a, b) => a - b);
  if (d.length === 7) return "Täglich";
  if (d.join() === "1,2,3,4,5") return "Mo–Fr";
  if (d.join() === "6,7") return "Sa + So";
  const runs = []; for (const x of d) { const l = runs[runs.length - 1]; if (l && l[1] === x - 1) l[1] = x; else runs.push([x, x]); }
  return runs.map(([a, b]) => b - a >= 2 ? `${WD[a - 1]}–${WD[b - 1]}` : a === b ? WD[a - 1] : `${WD[a - 1]}, ${WD[b - 1]}`).join(", ");
}
const shiftWhen = (r) => r.kind === "once" ? parseD(r.on_date).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" }) : daysLabel(r.days);
// Wer war zur Fälligkeit (ms) zuständig? Pflegedienst-Einsatz vor Übernahme durch ein anderes Mitglied; null = ich / niemand.
function respFor(sid, ms) {
  if (!sid || !ms || ms > Date.now() || isSenior()) return null;
  const w = carerAt(sid, ms);
  if (w) return { kind: "carer", c: w.c, w, label: w.c.name, sub: w.e > Date.now() ? `ist bis ${hmMs(w.e)} da` : `war ${hmMs(w.s)}–${hmMs(w.e)} da`, opt: { kind: "carer", id: w.c.id, key: "c:" + w.c.id } };
  const hs = uniqBy([...(S.D.handoffs || []), ...((S.j?.x?.handoffs) || [])]).filter((h) => h.senior_id === sid && new Date(h.created_at).getTime() <= ms && (hEnd(h) ?? Infinity) > ms);
  if (!hs.length || hs.some((h) => h.taken_by === S.uid)) return null;
  const h = hs.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!(S.D.members || []).some((m) => m.user_id === h.taken_by && m.role !== "senior")) return null;
  const e = hEnd(h);
  return { kind: "member", uid: h.taken_by, h, label: nmPlain(h.taken_by), sub: e ? `hatte übernommen ${hm(h.created_at)}–${hmMs(e)} Uhr` : `hat seit ${hm(h.created_at)} Uhr übernommen`, opt: { kind: "member", uid: h.taken_by, key: "m:" + h.taken_by } };
}
// „Wer hat's gemacht?“ vor dem nachträglichen Abhaken: Vorschlag = wer zur Fälligkeit zuständig war; Promise → done_by oder null (abgebrochen)
function whoSheet(rp, sid, what, due) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (done) return; done = true; res(v); };
    const rest = doerOpts(sid).filter((o) => o.kind !== "self" && o.key !== rp.opt.key && !(rp.kind === "carer" && o.kind === "carer" && !o.id));
    const ic = rp.kind === "carer" ? `<span class="doer-ic">${ICON.carer}</span>` : ava(rp.uid);
    const { sh, close } = openSheet(`<div class="sheet-head"><h2>Wer hat's gemacht?</h2><p class="muted small">${esc(what)} war um ${esc(due)} Uhr fällig. In der Zeit war ${rp.kind === "carer" ? "der Pflegedienst" : esc(rp.label)} zuständig.</p></div>
      <div class="choices doer-list who-list" role="group" aria-label="Wer hat's gemacht?">
        <button class="choice doer-o on who-sug" data-w="sug">${ic}<b>${esc(rp.label)} <em class="sug-b">Vorschlag</em></b><small>${esc(rp.sub)}</small></button>
        <button class="choice doer-o" data-w="self">${ava(S.uid)}<b>Ich selbst</b><small>Ich habe es gemacht</small></button>
        <button class="choice doer-o who-more" data-w="more" aria-expanded="false"><span class="doer-ic">…</span><b>Jemand anders</b><small>Pflegedienst oder Familie wählen</small></button>
        <div class="who-rest" hidden>${rest.map((o, i) => `<button class="choice doer-o" data-r="${i}">${o.kind === "carer" ? `<span class="doer-ic">${ICON.carer}</span>` : ava(o.uid)}<b>${esc(o.label)}</b><small>${esc(o.sub)}</small></button>`).join("")}</div>
      </div>
      <div class="btns"><button class="btn ghost" data-close>Abbrechen</button></div>`, "doer-sheet who-sheet");
    sh.addEventListener("sheetclose", () => fin(null));
    $('[data-w="sug"]', sh).onclick = () => { fin({ by: doneByOf(rp.opt), label: rp.kind === "carer" ? "Pflegedienst" : rp.label }); close(); };
    $('[data-w="self"]', sh).onclick = () => { fin({ by: { kind: "self" }, label: "dir" }); close(); };
    $('[data-w="more"]', sh).onclick = (e) => { const r = $(".who-rest", sh); r.hidden = !r.hidden; e.currentTarget.setAttribute("aria-expanded", String(!r.hidden)); };
    $$("[data-r]", sh).forEach((b) => (b.onclick = () => { const o = rest[+b.dataset.r]; fin({ by: doneByOf(o), label: o.kind === "carer" ? "Pflegedienst" : o.label }); close(); }));
  });
}
// Farbe mischen (#rrggbb): t = 0 → a, t = 1 → b
const mixHex = (a, b, t) => { const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), A = p(a), B = p(b); return "#" + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, "0")).join(""); };
const sTone = (s) => { const c = SENIOR_COLORS[(Number(s?.color) || 0) % SENIOR_COLORS.length]; return { c, s: mixHex(c, "#ffffff", 0.84), d: mixHex(c, "#000000", 0.36), l: mixHex(c, "#ffffff", 0.6) }; };
const sCol = (sid) => { const s = senior(sid); return s ? sTone(s).c : "#8A9497"; };
const sKind = (s) => { const n = String(s?.name || "").trim().toLowerCase(); return /^(oma|omi|uroma|großmutter|grossmutter)(\s|$)/.test(n) ? "oma" : /^(opa|opi|uropa|großvater|grossvater)(\s|$)/.test(n) ? "opa" : ""; };
let gidN = 0;
function illu(kind, t) {
  const id = "pg" + ++gidN, g1 = mixHex(t.c, "#ffffff", 0.62), g2 = mixHex(t.c, "#ffffff", 0.12), cloth = mixHex(t.c, "#000000", 0.12);
  const bg = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g1}"/><stop offset="1" stop-color="${g2}"/></linearGradient></defs><circle cx="40" cy="40" r="40" fill="url(#${id})"/>`;
  return kind === "oma"
    ? `<svg viewBox="0 0 80 80" aria-hidden="true">${bg}<path d="M14 80c2-15 12-22 26-22s24 7 26 22z" fill="${cloth}"/><path d="M33 58l7 9 7-9" fill="#fff" opacity=".9"/><circle cx="40" cy="38" r="15" fill="#F6DCCB"/><path d="M24 37c0-11 7-18 16-18s16 7 16 18c-3-6-8-9-16-9s-13 3-16 9z" fill="#E9E4DF"/><circle cx="40" cy="18" r="7" fill="#E9E4DF"/><circle cx="34.5" cy="38" r="3.4" fill="none" stroke="#6B5B53" stroke-width="1.4"/><circle cx="45.5" cy="38" r="3.4" fill="none" stroke="#6B5B53" stroke-width="1.4"/><path d="M38 38h4" stroke="#6B5B53" stroke-width="1.4"/><path d="M35.5 45c2.6 2.2 6.4 2.2 9 0" stroke="#B86A57" stroke-width="1.7" fill="none" stroke-linecap="round"/><circle cx="30.5" cy="44" r="2.2" fill="#F3B9A6" opacity=".7"/><circle cx="49.5" cy="44" r="2.2" fill="#F3B9A6" opacity=".7"/></svg>`
    : `<svg viewBox="0 0 80 80" aria-hidden="true">${bg}<path d="M14 80c2-15 12-22 26-22s24 7 26 22z" fill="${cloth}"/><path d="M34 58l6 8 6-8" fill="#fff" opacity=".85"/><circle cx="40" cy="38" r="15" fill="#F3D6C3"/><path d="M25 35c0-3 1-5 2-6 1 3 2 4 3 4M55 35c0-3-1-5-2-6-1 3-2 4-3 4" fill="#D9D4CF"/><path d="M28 30c3-6 7-8 12-8s9 2 12 8c-3-2-7-3-12-3s-9 1-12 3z" fill="#D9D4CF"/><path d="M31 35.5h6M43 35.5h6" stroke="#8C7B70" stroke-width="2" stroke-linecap="round"/><circle cx="34.5" cy="39" r="1.6" fill="#4B3F39"/><circle cx="45.5" cy="39" r="1.6" fill="#4B3F39"/><path d="M33 46c3-2 11-2 14 0-2 3-12 3-14 0z" fill="#E1DCD7"/><path d="M36.5 46.5c2 1.4 5 1.4 7 0" stroke="#A86A57" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`;
}
// Personen-Avatar: Illustration (Oma/Opa) bzw. Initialen; mit ring=true farbiger Ring wie im Entwurf
const sAva = (s, size = "", ring = false) => {
  if (!s) return "";
  const t = sTone(s), k = sKind(s), r = ring ? ` pring" style="--pc:${t.c}` : "";
  return k ? `<span class="ava pava ${size}${r}">${illu(k, t)}</span>` : `<span class="ava ${size}${r}"${ring ? "" : ` style="background:linear-gradient(140deg,${t.c},${t.d})"`}>${ring ? `<i style="background:linear-gradient(140deg,${t.c},${t.d})">${esc(initials(s.name))}</i>` : esc(initials(s.name))}</span>`;
};
// Personen-Chip (Entwurf: „tagp“) – kleiner Avatar + Name in der zarten Personenfarbe
const sChip = (sid) => { const s = senior(sid); if (!s) return ""; const t = sTone(s); return `<span class="chip-s tagp" style="--c:${t.c};--ps:${t.s};--pd:${t.d}">${sAva(s, "xxs")}${esc(s.name)}</span>`; };
// Basis-URL für Einladungslinks: zentral in config.js (publicUrl, z. B. eigene Domain); in der nativen App Pflicht, im Web sonst die aktuelle Adresse
const baseUrl = () => { const u = String(C.publicUrl || "").trim(); if (u) return u.endsWith("/") ? u : u + "/"; return location.origin + location.pathname.replace(/index\.html$/, ""); };
const inviteLink = (code) => `${baseUrl()}?invite=${encodeURIComponent(code)}`;
const invExp = (f) => (f?.invite_expires_at ? new Date(f.invite_expires_at) : null);
const invExpired = (f) => { const d = invExp(f); return !!d && d.getTime() < Date.now(); };
const invNote = (f, admin) => { const d = invExp(f); if (!d) return ""; return invExpired(f) ? `<p class="err center inv-exp">Dieser Code ist abgelaufen.${admin ? " Erzeuge einen neuen." : " Bitte einen Admin um einen neuen Code."}</p>` : `<p class="muted small center inv-valid">Gültig bis ${d.toLocaleDateString("de-DE", { day: "numeric", month: "long" })}</p>`; };
const LEGAL = `<nav class="legal-links"><a href="datenschutz.html" target="_blank" rel="noopener">Datenschutz</a><span aria-hidden="true">·</span><a href="impressum.html" target="_blank" rel="noopener">Impressum</a></nav>`;
const ICON = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  tasks: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  feed: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z"/></svg>',
  fam: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.6c2.6.1 4.4 1.7 5 4.4"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  rep: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12 20 4l-6 16-3-7z"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M12 12h5.5"/><circle cx="19" cy="12" r="2"/><path d="M12 9H7"/><circle cx="5" cy="9" r="2"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  pill: '<svg viewBox="0 0 24 24"><path d="M10.2 4.6a5 5 0 0 1 7.1 7.1l-5.6 5.6a5 5 0 0 1-7.1-7.1z"/><path d="m7.4 7.4 7.1 7.1"/></svg>',
  people: '<svg viewBox="0 0 24 24"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><circle cx="12" cy="12.5" r="2.2"/><path d="M8.6 20c.4-2.4 1.8-3.7 3.4-3.7s3 1.3 3.4 3.7"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 19.5s-7.5-4.6-7.5-10.1A4.1 4.1 0 0 1 12 7a4.1 4.1 0 0 1 7.5 2.4c0 5.5-7.5 10.1-7.5 10.1z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8.5h5M9 13h7M9 16.5h5"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4.2"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3.2 5 6v5.4c0 4.3 3 7.9 7 9.4 4-1.5 7-5.1 7-9.4V6z"/><path d="M12 8.2v4.6M12 15.8v.2"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.5 2H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 4.2 3 19.5h18z"/><path d="M12 10v4.2M12 16.8v.2"/></svg>',
  done: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8.4 12.3 2.5 2.5 4.8-5"/></svg>',
  handoff: '<svg viewBox="0 0 24 24"><path d="M4 9h12.5M13 5.5 16.5 9 13 12.5"/><path d="M20 15H7.5M11 11.5 7.5 15l3.5 3.5"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4.5 19.5 5.3 15.6 15.6 5.3a2 2 0 0 1 2.9 0l.2.2a2 2 0 0 1 0 2.9L8.4 18.7z"/><path d="m13.8 7.1 3.1 3.1"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M5 8.5h13M14.5 5 18 8.5 14.5 12M19 15.5H6M9.5 12 6 15.5 9.5 19"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M14 4.5H6v15h8"/><path d="M10.5 12H20M16.5 8.5 20 12l-3.5 3.5"/></svg>',
  door: '<svg viewBox="0 0 24 24"><path d="M6 20V4h9.5v16M3.5 20h17"/><path d="M12.5 12.2v.3"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4.8" r="1.8"/><path d="m9 21 2.3-6.5L14 17v4M8 11.5l3-3.5h3l2 3.5 2.5 1M11.3 14.5 12.6 8"/></svg>',
  ban: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20c.8-3.9 3.6-6 7.2-6s6.4 2.1 7.2 6"/></svg>',
  contacts: '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-11z"/><path d="M4 7.5h3.5M4 12h3.5M4 16.5h3.5"/><circle cx="12.8" cy="10" r="2.4"/><path d="M9.2 16.5c.5-2 1.8-3.1 3.6-3.1s3.1 1.1 3.6 3.1"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M5.2 3.8h3.3l1.7 4.4-2.2 1.4a11.5 11.5 0 0 0 6.4 6.4l1.4-2.2 4.4 1.7v3.3a1.6 1.6 0 0 1-1.7 1.6C10.7 19.9 4.1 13.3 3.6 5.5a1.6 1.6 0 0 1 1.6-1.7z"/></svg>',
  route: '<svg viewBox="0 0 24 24"><path d="M20.5 3.5 3.5 10.8l7.2 2.5 2.5 7.2z"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7.5 8 6 8-6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  carer: '<svg viewBox="0 0 24 24"><path d="M11 14h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 16"/><path d="m7 20 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9"/><path d="m2 15 6 6"/><path d="M19.5 8.5c.7-.7 1.5-1.6 1.5-2.7A2.73 2.73 0 0 0 16 4a2.78 2.78 0 0 0-5 1.8c0 1.2.8 2 1.5 2.8L16 12Z"/></svg>',
  steth: '<svg viewBox="0 0 24 24"><path d="M6 3.5H5v5a4 4 0 0 0 8 0v-5h-1"/><path d="M9 12.5v2.5a5 5 0 0 0 10 0v-2"/><circle cx="19" cy="10.5" r="2.2"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
  vit: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.1A4.1 4.1 0 0 1 12 7.5a4.1 4.1 0 0 1 7.5 2.4c0 5.5-7.5 10.1-7.5 10.1z"/><path d="M3.5 12.5h4.2l1.6-2.6 2.4 4.6 1.6-2h7.2"/></svg>',
  drop: '<svg viewBox="0 0 24 24"><path d="M12 3.5s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11z"/><path d="M9.5 15a2.6 2.6 0 0 0 2.5 2.5"/></svg>',
  scale: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 10a5 5 0 0 1 7 0l-2.4 2.6"/></svg>',
  thermo: '<svg viewBox="0 0 24 24"><path d="M10 14.2V5.5a2 2 0 0 1 4 0v8.7a4 4 0 1 1-4 0z"/><path d="M12 10v6.5"/></svg>',
  o2: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M7.5 12.5h2l1.3-2.6 2 5 1.3-2.4h2.4"/></svg>',
  sos: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M12 8.2v7.6M8.2 12h7.6"/></svg>',
  report: '<svg viewBox="0 0 24 24"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8.5h5"/><path d="m8.5 16.5 2.3-2.8 2 1.6 3-3.8"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M7 10.5H5.5v10h13v-10H17"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3.5v11M8 10.5l4 4 4-4"/><path d="M4.5 16.5v3h15v-3"/></svg>',
  aid: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M6 6l3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9"/></svg>',
  euro: '<svg viewBox="0 0 24 24"><path d="M17.5 6.5a6.5 6.5 0 1 0 0 11"/><path d="M4.5 10.5h9M4.5 13.5h9"/></svg>',
  bed: '<svg viewBox="0 0 24 24"><path d="M3.5 18.5v-12M3.5 14.5h17v4M20.5 14.5v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="11" r="1.8"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M13.5 4.5h6v6M19.5 4.5l-8 8"/><path d="M17.5 13.5v5h-13v-13h5"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>',
};
// Kategorien: je Bereich EIN Symbol + EINE dezente Farbe, überall gleich (Überschriften, Neu-Menü, leere Zustände, Legenden)
const CAT = {
  appt: ["cal", "Termine"], task: ["tasks", "Aufgaben"], med: ["pill", "Medikamente"], here: ["people", "Wer ist da?"],
  care: ["heart", "Befinden"], journal: ["book", "Tagebuch"], note: ["note", "Notizen"], info: ["shield", "Wichtig zu wissen"],
  fam: ["fam", "Familie"], settings: ["sliders", "Einstellungen"], soon: ["clock", "Demnächst"], late: ["alert", "Überfällig"],
  done: ["done", "Erledigt"], handoff: ["handoff", "Übergabe"], contact: ["contacts", "Kontakte"], vit: ["vit", "Werte"],
  allergy: ["alert", "Allergien"], mob: ["walk", "Mobilität"], like: ["heart", "Mag"], dislike: ["ban", "Mag nicht"], hint: ["pin", "Hinweise"],
  aid: ["aid", "Hilfen & Ansprüche"],
};
const sico = (c, size = "") => `<span class="sico k-${c} ${size}" aria-hidden="true">${ICON[CAT[c][0]]}</span>`;
const h2i = (c, t) => `<h2 class="hi">${sico(c)}<span>${t}</span></h2>`;

// Tastatur: Sheets und Navigation folgen der Bildschirmtastatur (inkl. iPhone-Safe-Area).
// Wichtig (iOS-PWA): Nach dem Schließen der Tastatur lässt iOS die Seite manchmal verschoben stehen (Scroll über das Ende hinaus,
// visualViewport.offsetTop > 0) bzw. meldet eine zu kleine visualViewport-Höhe. Dann liegen die Tippflächen von festen Elementen
// (Navigation, Kopfzeile) verschoben oder die Navigation bliebe ausgeblendet. Darum wird der Tastaturzustand nur angenommen, solange
// wirklich ein Textfeld fokussiert ist, und bei Blur, Seitenwechsel, App-Wechsel und beim nächsten Tippen komplett zurückgesetzt.
const isField = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|file|color|image|hidden)$/.test(el.type)) || el.isContentEditable);
function settleViewport() {
  const se = document.scrollingElement, vv = window.visualViewport, max = Math.max(0, se.scrollHeight - window.innerHeight), y = se.scrollTop;
  // Über das Seitenende hinaus gescrollt (Rest der Tastatur) → zurück; bei verschobenem visualViewport Layout neu ankoppeln
  if (y > max + 1 || y < 0) window.scrollTo(0, Math.min(Math.max(y, 0), max));
  else if (vv && vv.offsetTop > 1 && (vv.scale || 1) <= 1.01) window.scrollTo(0, y);
}
function resetKeyboard(blur = false) {
  if (blur && isField(document.activeElement)) document.activeElement.blur();
  const st = document.documentElement.style;
  st.setProperty("--kb", "0px"); st.setProperty("--vvh", window.innerHeight + "px");
  document.body.classList.remove("kb");
  sheetKb(false); fitComposer(); settleViewport();
}
function updateViewport() {
  const vv = window.visualViewport, st = document.documentElement.style, ae = document.activeElement;
  const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  const typing = kb > 80 && isField(ae) && document.visibilityState !== "hidden";
  if (!typing) { if (document.body.classList.contains("kb") || st.getPropertyValue("--kb") !== "0px") resetKeyboard(); else fitComposer(); return; }
  st.setProperty("--kb", kb + "px");
  st.setProperty("--vvh", Math.round(vv.height) + "px");
  document.body.classList.add("kb");
  sheetKb(true); fitComposer();
}
// Sheets bei offener Tastatur: Die Höhe bleibt genau so wie vor der Tastatur (kein Schrumpfen, kein Springen beim Tippen).
// Passt das ganze Sheet über die Tastatur, rückt es als Ganzes darauf; ein hohes Sheet bleibt stehen und bekommt unten so viel
// Innenabstand, wie die Tastatur verdeckt – der Inhalt scrollt intern, das fokussierte Feld wird in den sichtbaren Teil geholt.
function sheetKb(on) {
  const all = $$(".sheet"), top = all[all.length - 1], vv = window.visualViewport;
  for (const sh of all) if (!on || sh !== top) {
    if (!sh.__kb) continue; sh.__kb = false; sh.__h = 0;
    Object.assign(sh.style, { top: "", bottom: "", height: "", maxHeight: "", paddingBottom: "" });
  }
  if (!on || !top || !vv) return;
  if (!top.__kb) { top.__h = top.offsetHeight; top.__pb = parseFloat(getComputedStyle(top).paddingBottom) || 0; top.__kb = true; }
  const H = top.__h, visH = vv.height, T0 = Math.max(0, window.innerHeight - H);
  const fits = H <= visH - 8, T = fits ? Math.min(T0, visH - H) : T0;   // Abstand vom oberen Rand des sichtbaren Bereichs
  const hidden = Math.max(0, T + H - visH);                               // so viel deckt die Tastatur noch ab
  Object.assign(top.style, { top: Math.round(vv.offsetTop + T) + "px", bottom: "auto", height: H + "px", maxHeight: "none", paddingBottom: Math.round(top.__pb + hidden) + "px" });
  const ae = document.activeElement;
  if (isField(ae) && top.contains(ae)) {
    const sr = top.getBoundingClientRect(), fr = ae.getBoundingClientRect(), fTop = fr.top - sr.top, fBot = fr.bottom - sr.top, vis = H - hidden;
    if (fBot + 24 > vis) top.scrollTop += Math.ceil(fBot + 24 - vis);
    else if (fTop < 56) top.scrollTop = Math.max(0, top.scrollTop - (56 - fTop));
  }
}
function fitComposer() {
  const st = document.documentElement.style, nav = $(".nav");
  if (nav && nav.offsetHeight) st.setProperty("--nav-h", nav.offsetHeight + "px");
}
const navRO = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitComposer()) : null;
function watchComposer() { fitComposer(); if (!navRO) return; navRO.disconnect(); const n = $(".nav"); if (n) navRO.observe(n); }
if (window.visualViewport) { visualViewport.addEventListener("resize", updateViewport); visualViewport.addEventListener("scroll", updateViewport); }
window.addEventListener("resize", updateViewport);
window.addEventListener("orientationchange", () => setTimeout(updateViewport, 300));
window.addEventListener("pageshow", () => { resetKeyboard(); clearStaleLayers(); setTimeout(updateViewport, 250); });
document.addEventListener("focusin", () => { [60, 320, 650].forEach((t) => setTimeout(updateViewport, t)); });
document.addEventListener("focusout", () => [0, 150, 400, 800].forEach((t) => setTimeout(() => { if (!isField(document.activeElement)) resetKeyboard(); else updateViewport(); }, t)));
// Überbleibsel entfernen, die Taps abfangen könnten: Intro/Ladebildschirm nach Ablauf, Hintergrund ohne Sheet, Scroll-Sperre ohne Sheet
function clearStaleLayers() {
  const sp = window.PF_SPLASH, done = !sp || performance.now() > sp.t0 + sp.dur + 1500;
  if (done) ["splash"].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
  if (done) document.documentElement.classList.remove("splashing");
  if (!$(".sheet")) { $$(".backdrop").forEach((x) => x.remove()); document.body.classList.remove("noscroll"); }
}
// Sicherheitsnetz: Jede Berührung außerhalb eines Textfelds hebt einen hängengebliebenen Tastaturzustand sofort auf
document.addEventListener("pointerdown", (e) => {
  if (document.body.classList.contains("kb") && !isField(document.activeElement) && !isField(e.target)) resetKeyboard();
  clearStaleLayers();
}, true);

function openSheet(html, cls = "") {
  const bd = document.createElement("div"); bd.className = "backdrop";
  const sh = document.createElement("div"); sh.className = "sheet " + cls; sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true");
  sh.innerHTML = `<div class="grab" aria-hidden="true"><i></i></div>${html}`;
  document.body.append(bd, sh); document.body.classList.add("noscroll");
  requestAnimationFrame(() => { bd.classList.add("in"); sh.classList.add("in"); });
  let closed = false;
  const onKey = (e) => { if (e.key === "Escape" && sh === $$(".sheet").pop()) close(); };
  // Jeder Weg zu (Knopf, Hintergrund, Escape, Wischen) läuft hier durch und meldet „sheetclose“
  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey);
    bd.remove(); sh.remove(); if (!$(".sheet")) document.body.classList.remove("noscroll");
    sh.dispatchEvent(new Event("sheetclose"));
  };
  bd.onclick = () => sh.__close(); sh.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => sh.__close()));
  sh.__close = close;
  document.addEventListener("keydown", onKey);
  swipeToClose(sh, bd);
  return { sh, close };
}
// Wischen nach unten schließt ein Sheet: am Griff immer, sonst nur, wenn der Inhalt ganz oben steht.
// Schwelle: ein Drittel der Höhe (max. 140 px) oder ein schneller Wisch; sonst federt das Sheet zurück.
// Nur Touch (Maus/Tastatur: Hintergrund, Abbrechen, Escape). Ein offenes Textfeld wird beim Ziehen geschlossen (kein iOS-Tastatur-Hänger).
function swipeToClose(sh, bd) {
  let on = false, drag = false, grab = false, y0 = 0, x0 = 0, dy = 0, pts = [];
  const reset = () => { sh.classList.remove("dragging"); sh.style.transform = ""; bd.style.opacity = ""; };
  sh.addEventListener("touchstart", (e) => {
    on = false; if (e.touches.length !== 1 || !sh.classList.contains("in")) return;
    const t = e.target; grab = !!t.closest(".grab");
    if (!grab && (sh.scrollTop > 0 || t.closest("input[type=range],.noswipe"))) return;
    on = true; drag = false; y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; pts = [[y0, performance.now()]];
  }, { passive: true });
  sh.addEventListener("touchmove", (e) => {
    if (!on) return;
    const y = e.touches[0].clientY, d = y - y0, dx = Math.abs(e.touches[0].clientX - x0);
    if (!drag) {
      if (d < -3 || (dx > 8 && dx > d)) { on = false; return; } // nach oben bzw. seitlich → normales Scrollen
      if (d < 10) return;
      if (!grab && sh.scrollTop > 0) { on = false; return; }
      drag = true; sh.classList.add("dragging");
      if (isField(document.activeElement) && sh.contains(document.activeElement)) document.activeElement.blur();
    }
    if (e.cancelable) e.preventDefault();
    dy = Math.max(0, d - 10);
    const now = performance.now(); pts.push([y, now]); while (pts.length > 2 && now - pts[0][1] > 120) pts.shift();
    sh.style.transform = `translateY(${dy}px)`;
    bd.style.opacity = String(Math.max(0.05, 1 - dy / Math.max(240, sh.offsetHeight)));
  }, { passive: false });
  const end = () => {
    if (!on) return; on = false;
    if (!drag) return; drag = false;
    const h = sh.offsetHeight, [a, b] = [pts[0], pts[pts.length - 1]], v = b && a && b[1] > a[1] ? (b[0] - a[0]) / (b[1] - a[1]) : 0;
    if (dy > Math.min(140, h * 0.33) || (v > 0.55 && dy > 24)) {
      sh.classList.remove("dragging"); sh.classList.add("leaving"); sh.style.transform = `translateY(${h + 20}px)`; bd.style.opacity = "0";
      setTimeout(() => sh.__close(), reduceMotion() ? 0 : 200);
    } else {
      sh.classList.remove("dragging"); sh.classList.add("spring"); sh.style.transform = ""; bd.style.opacity = "";
      setTimeout(() => sh.classList.remove("spring"), 360);
    }
  };
  sh.addEventListener("touchend", end); sh.addEventListener("touchcancel", () => { if (on && drag) { on = drag = false; reset(); } else on = false; });
}
function confirmSheet(title, text, okLabel = "Löschen", danger = true) {
  return new Promise((res) => {
    const { sh, close } = openSheet(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="btns"><button class="btn ghost" data-close>Abbrechen</button><button class="btn ${danger ? "danger" : ""}" id="cf-ok">${esc(okLabel)}</button></div>`);
    $("#cf-ok", sh).onclick = () => { res(true); close(); };
    sh.addEventListener("sheetclose", () => res(false)); // Abbrechen, Hintergrund, Escape, Wischen
  });
}
async function busy(btn, fn, quiet = false) {
  if (btn) { btn.disabled = true; btn.dataset.l = btn.innerHTML; btn.innerHTML = '<span class="spin"></span>'; }
  try { return await fn(); }
  catch (e) { if (!quiet) toast(e.message || String(e), 4200); throw e; }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.l; } }
}
const call = (action, body = {}) => API.fn(action, { family_id: S.fid, ...body });
const fd = (form) => Object.fromEntries(new FormData(form).entries());
const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(label)}</option>`;
const seniorOptions = (sel, none = "Niemand Bestimmtes") => opt("", none, !sel) + S.D.seniors.filter((s) => s.id === sel || inFocus(s.id)).map((s) => opt(s.id, s.name, s.id === sel)).join("");
const memberOptions = (sel) => opt("", "Offen – noch niemand", !sel) + S.D.members.filter((m) => m.role !== "senior" || m.user_id === sel).map((m) => opt(m.user_id, m.user_id === S.uid ? `${m.display_name} (ich)` : m.display_name, m.user_id === sel)).join("");

// ---------- Start / Auth ----------
// Ladebildschirm: Vorname für die Begrüßung merken (nächster Start zeigt ihn sofort); Push-Marker aus der Adresse entfernen
function splashName() {
  const n = (S.me?.display_name || "").trim().split(/\s+/)[0];
  if (!n) return;
  try { localStorage.setItem("pf-name", n); } catch {}
  const el = document.getElementById("sp-hello"); if (el) el.textContent = "Willkommen, " + n;
}
// Sitzung serverseitig beendet (z. B. Passwort von einem Admin zurückgesetzt oder auf einem anderen Gerät geändert) → zurück zum Login
window.addEventListener("pf-signedout", async (e) => {
  if (!S.uid || S.loggingOut || window.__pfPwSwitch) return;
  accDrop(S.uid);
  S.uid = S.me = S.D = null; S.fams = []; S.unsub?.(); S.unsub = null; clearInterval(S.pollT); sosClear();
  try { await API.signOut(); } catch {}
  $$(".sheet,.backdrop").forEach((x) => x.remove()); document.body.classList.remove("noscroll");
  renderAuth(e.detail || "Du wurdest abgemeldet – bitte neu anmelden.");
});
async function boot() {
  if (/[?&](pf_push|nosplash)\b/.test(location.search)) { const u = new URL(location.href); u.searchParams.delete("pf_push"); u.searchParams.delete("nosplash"); history.replaceState(null, "", u.pathname + u.search + u.hash); }
  try {
    const s = await API.session();
    let sw = null; try { sw = sessionStorage.getItem("pf-acc-switch"); sessionStorage.removeItem("pf-acc-switch"); } catch {}
    if (!s) { if (sw) { accDrop(sw); return renderAuth("Dieses Konto ist auf dem Gerät nicht mehr angemeldet – bitte neu anmelden."); } return renderAuth(); }
    S.uid = s.uid; S.me = await API.me(s.uid);
    if (!S.me) { await API.signOut(); return renderAuth("Kein Profil gefunden – bitte neu registrieren."); }
    splashName();
    if (sw && sw !== s.uid) accDrop(sw);
    await afterLogin();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="boot"><p>Pflegekreis konnte nicht laden.</p><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Neu laden</button>${sosSnap()?.uid === S.uid && S.uid ? `<button class="btn soft block sos-offbtn" id="sos-off">${ICON.sos} Notfallkarten (offline gespeichert)</button>` : ""}</div>`;
    const b = $("#sos-off"); if (b) b.onclick = () => sosOffline(sosSnap());
  }
}
// Einwilligung Art. 9 DSGVO: bestehende Konten (vor Oktober 2026 angelegt) werden einmalig gefragt
async function consentGate() {
  if (!S.me || S.me.consent_health_at !== null) return;
  await new Promise((resolve) => {
    app.innerHTML = `<main class="auth consent-gate">
      <div class="brand"><img src="icons/logo.svg?v=2" alt="Pflegekreis-Logo" width="56" height="56"><div><h1>Pflegekreis</h1><p class="muted">Kurz noch deine Zustimmung</p></div></div>
      <form id="cgf" class="card form">
        <p>In Pflegekreis tragt ihr auch <b>Gesundheitsdaten</b> ein – z. B. Medikamente, Allergien oder „hat Schmerzen“. Dafür brauchen wir einmalig deine ausdrückliche Einwilligung.</p>
        <label class="cbx"><input type="checkbox" name="consent_health" required><span>${CONSENT_HEALTH}</span></label>
        <p class="err"></p>
        <button class="btn block big" type="submit">Zustimmen und weiter</button>
      </form>
      <p class="center"><button class="link" id="cg-lo">Nicht jetzt – abmelden</button></p>
      ${LEGAL}
    </main>`;
    $("#cgf").onsubmit = async (e) => {
      e.preventDefault();
      try { await busy(e.target.querySelector("button"), () => API.fn("consent_save", { consent_health: true })); S.me.consent_health_at = new Date().toISOString(); resolve(); }
      catch (ex) { $("#cgf .err").textContent = ex.message; }
    };
    $("#cg-lo").onclick = logout;
  });
}
// Passwort-Felder (Ändern / nach Admin-Reset) – Prüfung mit deutschen Meldungen statt Browser-Blasen
const pwFields = (withOld) => `${withOld ? `<label class="f" for="pw-old">Bisheriges Passwort</label><input class="inp" id="pw-old" name="old" type="password" required autocomplete="current-password">` : ""}
  <label class="f" for="pw-new1">Neues Passwort</label><input class="inp" id="pw-new1" name="new1" type="password" required maxlength="72" autocomplete="new-password" placeholder="mindestens 8 Zeichen">
  <label class="f" for="pw-new2">Neues Passwort wiederholen</label><input class="inp" id="pw-new2" name="new2" type="password" required maxlength="72" autocomplete="new-password">`;
const pwProblem = (v) => String(v.new1 || "").length < 8 ? "Das neue Passwort braucht mindestens 8 Zeichen" : v.new1 !== v.new2 ? "Die beiden neuen Passwörter stimmen nicht überein" : v.old !== undefined && v.old === v.new1 ? "Das neue Passwort muss sich vom bisherigen unterscheiden" : "";
// Nach Admin-Reset: beim ersten Login eigenes Passwort festlegen
async function pwGate() {
  if (!S.me?.must_change_password) return;
  await new Promise((resolve) => {
    app.innerHTML = `<main class="auth pw-gate">
      <div class="brand"><img src="icons/logo.svg?v=2" alt="Pflegekreis-Logo" width="56" height="56"><div><h1>Pflegekreis</h1><p class="muted">Eigenes Passwort festlegen</p></div></div>
      <form id="pwg" class="card form" autocomplete="on">
        <div class="pw-note"><span class="ico ln">${ICON.key}</span><p>Ein Admin deiner Familie hat dein Passwort zurückgesetzt. Lege jetzt ein <b>eigenes Passwort</b> fest – das Einmal-Passwort gilt danach nicht mehr.</p></div>
        <input type="text" name="username" value="${esc(S.me.username)}" autocomplete="username" hidden>
        ${pwFields(false)}
        <p class="err"></p>
        <button class="btn block big" type="submit">Passwort speichern</button>
      </form>
      <p class="center"><button class="link" id="pwg-lo">Abmelden</button></p>
    </main>`;
    $("#pwg").onsubmit = async (e) => {
      e.preventDefault();
      const v = fd(e.target), el = $("#pwg .err"), bad = pwProblem(v);
      if (bad) { el.textContent = bad; return; }
      el.textContent = "";
      try { await busy(e.target.querySelector("[type=submit]"), () => API.fn("set_new_password", { new_password: v.new1 }), true); S.me.must_change_password = false; toast("Neues Passwort gespeichert ✓"); resolve(); }
      catch (ex) { el.textContent = ex.message; }
    };
    $("#pwg-lo").onclick = logout;
  });
}
function passwordSheet() {
  const { sh, close } = openSheet(`<h2>Passwort ändern</h2><p class="muted">Danach wirst du auf deinen anderen Geräten abgemeldet.</p>
    <form id="pwf" class="form" autocomplete="on"><input type="text" name="username" value="${esc(S.me.username)}" autocomplete="username" hidden>${pwFields(true)}<p class="err"></p>
    <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">Speichern</button></div></form>`);
  $("#pwf", sh).onsubmit = async (e) => {
    e.preventDefault();
    const v = fd(e.target), el = $("#pwf .err", sh), bad = pwProblem(v);
    if (bad) { el.textContent = bad; return; }
    el.textContent = "";
    try { await busy(e.target.querySelector("[type=submit]"), () => API.fn("change_password", { old_password: v.old, new_password: v.new1 }), true); close(); toast("Passwort geändert ✓"); }
    catch (ex) { el.textContent = ex.message; }
  };
}
async function resetMemberPw(m, closeMember) {
  if (!(await confirmSheet(`Passwort von ${m.display_name} zurücksetzen?`, `Du bekommst ein Einmal-Passwort, das du ${m.display_name} persönlich gibst. ${m.display_name} wird auf allen Geräten abgemeldet und muss beim nächsten Anmelden ein eigenes Passwort festlegen.`, "Zurücksetzen", false))) return;
  closeMember?.();
  const r = await busy(null, () => call("reset_member_password", { user_id: m.user_id })).catch(() => null);
  if (!r) return;
  const until = new Date(r.expires_at).toLocaleString("de-DE", { weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const { sh } = openSheet(`<h2>Einmal-Passwort für ${esc(m.display_name)}</h2>
    <p class="muted">Gib es ${esc(m.display_name)} persönlich oder am Telefon – am besten nicht schriftlich weiterleiten.</p>
    <div class="codebox pwbox" id="pw-temp">${esc(r.temp_password)}</div>
    <p class="inv-valid">Gültig bis ${esc(until)}</p>
    <ol class="pw-steps"><li>Anmelden mit <b>@${esc(m.username)}</b> und diesem Einmal-Passwort</li><li>Danach sofort ein eigenes Passwort festlegen</li></ol>
    <div class="btns"><button class="btn ghost" id="pw-copy">Kopieren</button><button class="btn" data-close>Fertig</button></div>`);
  $("#pw-copy", sh).onclick = async () => { try { await navigator.clipboard.writeText(r.temp_password); toast("Kopiert"); } catch { toast("Bitte abschreiben – Kopieren ging nicht"); } };
}
async function afterLogin() {
  await consentGate();
  await pwGate();
  S.fams = await API.families(S.uid);
  const inv = pendingInvite();
  if (inv) {
    localStorage.removeItem("pf-invite");
    try {
      if (!S.fams.length) { const r = await API.fn("join_family", { code: inv }); S.fams = await API.families(S.uid); S.fid = r.family.id; S.onboard = null; toast(`Willkommen in „${r.family.name}“!`); }
      else { const info = await API.fn("invite_info", { code: inv }); if (await confirmSheet("Einladung annehmen?", `Möchtest du „${info.name}“ beitreten?`, "Beitreten", false)) { const r = await API.fn("join_family", { code: inv }); S.fams = await API.families(S.uid); S.fid = r.family.id; } }
    } catch (e) { toast(e.message, 4500); }
  }
  // neu hinzugefügtes Konto (Konto-Wechsler) bzw. Sitzung des aktiven Kontos in der Geräteliste aktuell halten
  let added = false; try { added = !!sessionStorage.getItem("pf-acc-add"); sessionStorage.removeItem("pf-acc-add"); } catch {}
  if (!S.fams.length) { accRemember(added); return renderOnboarding(); }
  S.onboard = null;
  if (!S.fams.some((f) => f.id === S.fid)) S.fid = S.fams[0].id;
  accRemember(added);
  if (added) toast(`${S.me.display_name} ist jetzt auf diesem Gerät – wechseln über das Kürzel oben rechts`, 4500);
  await openFamily(S.fid);
}
async function openFamily(fid) {
  S.fid = fid; localStorage.setItem("pf-fid", fid); S.photo = {}; S.onboard = null;
  await reload();
  S.unsub?.(); S.unsub = API.realtime(fid, debounce(() => reload().catch(() => {}), 350));
  pushRefresh();
  clearInterval(S.pollT); S.pollT = setInterval(() => { if (document.visibilityState === "visible") reload().catch(() => {}); }, 45000);
  registerSW();
  if (!location.hash) location.hash = "#/";
  render();
}
function debounce(f, ms) { let t; return () => { clearTimeout(t); t = setTimeout(f, ms); }; }
async function reload() {
  if (!S.uid || !S.fid) return;
  const [fams, D] = await Promise.all([API.families(S.uid), API.load(S.fid, S.uid)]);
  S.fams = fams;
  if (!fams.some((f) => f.id === S.fid)) { if (fams.length) return openFamily(fams[0].id); S.D = null; return renderOnboarding(); }
  S.D = D; S.D.contacts ||= []; S.D.messages = [];
  sosSave();
  if (S.onboard) return;
  if (!$(".sheet")) render(true); else { sheetRefresh?.(); renderBehind(); }
}
let sheetRefresh = null;
function renderBehind() { const y = window.scrollY; render(true); window.scrollTo(0, y); }

function renderAuth(err = "") {
  const inv = pendingInvite();
  let mode = localStorage.getItem("pf-known") ? "login" : "register";
  const draw = () => {
    app.innerHTML = `<main class="auth">
      <div class="brand"><img src="icons/logo.svg?v=2" alt="Pflegekreis-Logo" width="56" height="56"><div><h1>Pflegekreis</h1><p class="muted">Pflege gemeinsam organisieren</p></div></div>
      ${inv ? `<div class="banner" id="inv-banner">Du wurdest eingeladen. Erstelle ein Konto oder melde dich an – danach bist du sofort in der Familie.</div>` : `<h2 class="hero">Weniger Chaos.<br>Mehr Zeit füreinander.</h2><p class="muted lead">Aufgaben, Termine und Neuigkeiten rund um eure Liebsten – für die ganze Familie an einem Ort.</p>`}
      ${DEMO ? `<div class="banner demo">Demo-Modus: Alles bleibt nur in diesem Browser. <button class="link" id="demo-fill">Mit Beispielfamilie ansehen</button></div>` : ""}
      ${accList().length ? `<div class="card list-card acc-auth"><p class="muted small">Auf diesem Gerät angemeldet – zum Wechseln antippen:</p>${accRows(null)}</div>` : ""}
      <div class="seg" role="tablist"><button data-m="register" class="${mode === "register" ? "on" : ""}">Neu hier</button><button data-m="login" class="${mode === "login" ? "on" : ""}">Anmelden</button></div>
      <form id="authf" class="card form" autocomplete="on">
        ${mode === "register" ? `<p class="step">Schritt 1 von 3 · Konto anlegen</p><label class="f" for="a-display">Dein Name</label><input class="inp" id="a-display" name="display" placeholder="z. B. Sascha" required maxlength="40" autocomplete="name">` : ""}
        <label class="f" for="a-user">Benutzername</label>
        <input class="inp" id="a-user" name="username" placeholder="z. B. sascha" required autocapitalize="none" autocomplete="username" minlength="3" maxlength="24">
        <label class="f" for="a-pw">Passwort</label>
        <input class="inp" id="a-pw" name="password" type="password" required minlength="${mode === "register" ? 8 : 1}" autocomplete="${mode === "register" ? "new-password" : "current-password"}" placeholder="${mode === "register" ? "mindestens 8 Zeichen" : ""}">
        ${mode === "register" ? `<label class="cbx"><input type="checkbox" name="consent" required><span>Ich habe die <a href="datenschutz.html" target="_blank" rel="noopener">Datenschutzerklärung</a> gelesen. Meine Angaben werden gespeichert und nur den Mitgliedern meiner Familie angezeigt.</span></label>
        <label class="cbx"><input type="checkbox" name="consent_health" required><span>${CONSENT_HEALTH}</span></label>
        ${C.captchaSiteKey ? `<div id="captcha" class="captcha"></div>` : ""}` : ""}
        <p class="err">${esc(err)}</p>
        <button class="btn block big" type="submit">${mode === "register" ? "Konto erstellen" : "Anmelden"}</button>
      </form>
      ${mode === "login" ? `<p class="forgot"><span class="ico ln">${ICON.key}</span><span><b>Passwort vergessen?</b> Frag den Admin deiner Familie – er kann dir unter Einstellungen (Kürzel oben rechts) › Mitglieder ein Einmal-Passwort erzeugen.</span></p>` : ""}
      <p class="muted small center">Keine E-Mail nötig. Nur deine Familie sieht eure Daten.</p>
      ${LEGAL}
    </main>`;
    if (mode === "register" && C.captchaSiteKey) mountCaptcha();
    $$(".seg button").forEach((b) => (b.onclick = () => { mode = b.dataset.m; err = ""; draw(); }));
    $$("[data-acc]").forEach((b) => (b.onclick = () => accSwitch(b.dataset.acc)));
    if ($("#demo-fill")) $("#demo-fill").onclick = async () => { await API.seedDemo(); location.replace(location.pathname + "?nosplash" + location.hash); };
    $("#authf").onsubmit = async (e) => {
      e.preventDefault();
      const v = fd(e.target), username = String(v.username).trim().toLowerCase(), btn = e.target.querySelector("button[type=submit]");
      try {
        await busy(btn, async () => {
          if (mode === "register") await API.fn("signup", { username, password: v.password, display_name: v.display, consent: !!v.consent, consent_health: !!v.consent_health, captcha_token: captchaToken() });
          await API.signIn(username, v.password);
        });
        localStorage.setItem("pf-known", "1");
        const s = await API.session(); S.uid = s.uid; S.me = await API.me(s.uid); splashName();
        await afterLogin();
      } catch (ex) { const el = $(".err"); if (el) el.textContent = ex.message; }
    };
  };
  draw();
}

// ---------- Onboarding (Schritt 2 + 3) ----------
function renderOnboarding(step = 2) {
  S.onboard = { step };
  window.scrollTo(0, 0);
  if (step === 2) {
    const back = S.fams.length ? `<p class="center"><button class="link" id="ob-back">Zurück zu „${esc(S.fams[0].name)}“</button></p>` : "";
    app.innerHTML = `<main class="auth">
      <p class="step">Schritt 2 von 3</p>
      <h2 class="hero sm">Hallo ${esc(S.me?.display_name || "")}!<br>Gründe eure Familie.</h2>
      <form id="famf" class="card form">
        <label class="f" for="f-name">Name der Familie</label>
        <input class="inp" id="f-name" name="name" required maxlength="60" placeholder="z. B. Familie Hammel">
        <button class="btn block big" type="submit">Familie gründen</button>
      </form>
      <div class="or"><span>oder du hast eine Einladung</span></div>
      <form id="joinf" class="card form">
        <label class="f" for="j-code">Einladungscode</label>
        <input class="inp code" id="j-code" name="code" required maxlength="16" placeholder="z. B. K7P2QX9MZT" autocapitalize="characters" autocomplete="off" spellcheck="false">
        <button class="btn block ghost big" type="submit">Familie beitreten</button>
      </form>
      ${back}<p class="center"><button class="link" id="lo">Abmelden</button></p>
    </main>`;
    $("#famf").onsubmit = async (e) => {
      e.preventDefault(); const name = fd(e.target).name;
      const r = await busy(e.target.querySelector("button"), () => API.fn("create_family", { name })).catch(() => null);
      if (!r) return;
      S.fams = await API.families(S.uid); S.fid = r.family.id; localStorage.setItem("pf-fid", S.fid);
      renderOnboarding(3);
    };
    $("#joinf").onsubmit = async (e) => {
      e.preventDefault(); const code = fd(e.target).code;
      const r = await busy(e.target.querySelector("button"), () => API.fn("join_family", { code })).catch(() => null);
      if (!r) return;
      toast(`Willkommen in „${r.family.name}“!`); location.hash = "#/"; await openFamily(r.family.id);
    };
    if ($("#ob-back")) $("#ob-back").onclick = () => openFamily(S.fams.some((f) => f.id === S.fid) ? S.fid : S.fams[0].id);
    $("#lo").onclick = logout;
    return;
  }
  const f = S.fams.find((x) => x.id === S.fid);
  app.innerHTML = `<main class="auth">
    <p class="step">Schritt 3 von 3</p>
    <h2 class="hero sm">Für wen sorgt ihr?</h2>
    <p class="muted lead">Lege die Person an, um die ihr euch kümmert. Weitere kannst du jederzeit ergänzen.</p>
    <form id="senf" class="card form">
      <label class="f" for="s-name">Name</label>
      <input class="inp" id="s-name" name="name" required maxlength="60" placeholder="z. B. Oma Hilde">
      <button class="btn block big" type="submit">Fertig – los geht's</button>
    </form>
    <div class="card invite">
      <h3>Familie einladen</h3>
      <p class="muted">Schick den Link an Geschwister, Partner oder Kinder:</p>
      <div class="codebox">${esc(f?.invite_code || "")}</div>${invNote(f, true)}
      <div class="btns"><button class="btn ghost" id="share">Link teilen</button><button class="btn ghost" id="copy">Kopieren</button></div>
    </div>
    <p class="center"><button class="link" id="skip">Überspringen</button></p>
  </main>`;
  bindInvite(f);
  const done = async () => { location.hash = "#/"; await openFamily(S.fid); };
  $("#senf").onsubmit = async (e) => {
    e.preventDefault(); const name = fd(e.target).name;
    const ok = await busy(e.target.querySelector("button"), () => call("senior_save", { name, color: 0 })).catch(() => null);
    if (ok) { await done(); toast("Alles bereit – leg los!"); }
  };
  $("#skip").onclick = done;
}
function bindInvite(f, root = document) {
  if (!f) return;
  const link = inviteLink(f.invite_code), text = `Komm in unseren Pflegekreis „${f.name}“ – hier organisieren wir gemeinsam die Pflege. Code: ${f.invite_code}`;
  const sh = $("#share", root), cp = $("#copy", root);
  if (sh) sh.onclick = async () => { if (navigator.share) { try { await navigator.share({ title: "Pflegekreis", text, url: link }); } catch {} } else { await copy(`${text}\n${link}`); } };
  if (cp) cp.onclick = () => copy(link);
}
async function copy(t) { try { await navigator.clipboard.writeText(t); toast("Kopiert"); } catch { prompt("Zum Kopieren:", t); } }
async function logout() { accDrop(S.uid); S.loggingOut = true; S.pushChecked = false; S.pushMove = false; setTimeout(() => (S.loggingOut = false), 3000); S.unsub?.(); S.unsub = null; clearInterval(S.pollT); await unsubscribePush(true); await API.signOut(); S.uid = S.me = S.D = null; S.fams = []; try { localStorage.removeItem("pf-name"); } catch {} sosClear(); S.onboard = null; history.replaceState(null, "", location.pathname); renderAuth(); }

// ---------- Konten auf diesem Gerät (sicherer Konto-Wechsler) ----------
// Jedes Konto meldet sich einmal ganz normal an. Danach bleibt seine Sitzung (wie sonst auch) nur in diesem Browser gespeichert –
// kein Passwort, kein Generalschlüssel. Wechseln = gespeicherte Sitzung wieder einsetzen; „Abmelden“ beendet sie und entfernt das Konto vom Gerät.
const ACC_KEY = "pf-accounts", ACC_MAX = 6;
const accList = () => { try { const a = JSON.parse(localStorage.getItem(ACC_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => x && x.uid && x.raw) : []; } catch { return []; } };
const accSave = (a) => { try { if (a.length) localStorage.setItem(ACC_KEY, JSON.stringify(a.slice(0, ACC_MAX))); else localStorage.removeItem(ACC_KEY); } catch {} };
const accDrop = (uid) => accSave(accList().filter((x) => x.uid !== uid));
// aktuelles Konto (mit frischer Sitzung) in der Liste ablegen – nur, wenn die Liste schon benutzt wird oder force
function accRemember(force = false) {
  if (!S.uid || !S.me) return;
  const a = accList(); if (!a.length && !force) return;
  const raw = API.rawSession(); if (!raw) return;
  const e = { uid: S.uid, name: S.me.display_name, user: S.me.username, fid: S.fid, raw, at: Date.now() };
  const i = a.findIndex((x) => x.uid === S.uid); if (i >= 0) a[i] = e; else a.push(e);
  accSave(a);
}
function accSwitch(uid) {
  const t = accList().find((x) => x.uid === uid); if (!t) return;
  if (S.uid) { accRemember(true); S.unsub?.(); clearInterval(S.pollT); }
  API.useRawSession(t.raw);
  try { if (t.fid) localStorage.setItem("pf-fid", t.fid); localStorage.setItem("pf-name", (t.name || "").split(/\s+/)[0]); sessionStorage.setItem("pf-acc-switch", uid); } catch {}
  location.replace(location.pathname + "?nosplash#/");
}
function accAdd() {
  accRemember(true);
  S.unsub?.(); clearInterval(S.pollT);
  API.useRawSession(null); // nur lokal vergessen – die Sitzung bleibt gültig und in der Liste
  try { sessionStorage.setItem("pf-acc-add", "1"); localStorage.setItem("pf-known", "1"); } catch {}
  location.replace(location.pathname + "?nosplash");
}
const accAva = (x) => `<span class="ava" style="background:${mHue(x.uid)}">${esc(initials(x.name || x.user || "?"))}</span>`;
const accRows = (cur) => accList().map((x) => `<button class="mrow acc${x.uid === cur ? " cur" : ""}" data-acc="${esc(x.uid)}" ${x.uid === cur ? 'aria-current="true"' : ""}>${accAva(x)}<span><b>${esc(x.name || x.user)}</b><small class="muted">@${esc(x.user || "")}</small></span>${x.uid === cur ? '<span class="role">Aktiv</span>' : `<span class="chev">${ICON.chev}</span>`}</button>`).join("");
function accountSheet() {
  accRemember(true);
  const { sh, close } = openSheet(`<h2>Konto wechseln</h2><p class="muted">Diese Konten sind auf diesem Gerät angemeldet. Ein Tipp genügt zum Wechseln.</p>
    <div class="card list-card">${accRows(S.uid)}
      <button class="mrow add" id="acc-add"><span class="ico plus">${ICON.plus}</span><span><b>Konto hinzufügen</b><small class="muted">Einmal normal anmelden</small></span></button></div>
    <p class="muted small">🔒 Es werden keine Passwörter gespeichert. „Abmelden“ entfernt das aktuelle Konto von diesem Gerät. Nur auf eigenen Geräten nutzen.</p>
    <div class="btns"><button class="btn ghost" data-close>Schließen</button></div>`, "acc-sheet");
  $$("[data-acc]", sh).forEach((b) => (b.onclick = () => { if (b.dataset.acc !== S.uid) { close(); accSwitch(b.dataset.acc); } }));
  $("#acc-add", sh).onclick = () => { close(); accAdd(); };
}
window.__pfAcc = { list: () => accList().map((x) => ({ uid: x.uid, user: x.user, name: x.name })), sheet: () => accountSheet() };

// ---------- Senioren-Modus ----------
// Mitglied mit Rolle „senior“ (vom Admin eingestellt, verknüpft mit einer Person): große, ruhige Ansicht mit wenigen Kernfunktionen.
// Was erlaubt ist, prüft der Server (Edge Function) – die Ansicht blendet nur aus.
const isSenior = () => fam()?.role === "senior";
const srSid = () => fam()?.senior_id || null;
const SRZ = [1, 1.15, 1.3];
const srZ = () => { const n = +(localStorage.getItem("pf-sr-size") || 0); return SRZ[n] ? n : 0; };
const SR_FEEL = [["mood_good", "😊", "Gut"], ["mood_ok", "😐", "Geht so"], ["mood_bad", "☹️", "Nicht gut"], ["pain", "🤕", "Schmerzen"], ["slept_well", "😴", "Gut geschlafen"], ["slept_bad", "🌙", "Schlecht geschlafen"]];
const SR_CCAT = { familie: "Familie", arzt: "Hausarzt", facharzt: "Facharzt", pflegedienst: "Pflegedienst", apotheke: "Apotheke" };
const srGreet = () => { const h = new Date().getHours(); return h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend"; };
const srFirst = () => (S.me?.display_name || "").trim().split(/\s+/)[0];
function srDoses(sid) {
  const now = Date.now(), xs = medDoses(today(), sid);
  return { now: xs.filter((x) => x.status !== "given" && x.sched <= now + 60 * 60000), later: xs.filter((x) => x.status !== "given" && x.sched > now + 60 * 60000), done: xs.filter((x) => x.status === "given"), all: xs };
}
function srAppts(sid) {
  const t = today(), mine = (a) => !a.senior_id || a.senior_id === sid;
  const xs = (S.D.appts || []).filter(mine).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const tod = xs.filter((a) => isoDay(a.starts_at) === t), next = xs.find((a) => isoDay(a.starts_at) > t && new Date(a.starts_at) - Date.now() < 21 * 864e5);
  return { tod, next };
}
const srCalls = (sid) => sortContacts((S.D.contacts || []).filter((c) => c.phone && SR_CCAT[c.category] && (!c.senior_id || c.senior_id === sid)))
  .sort((a, b) => (a.category === "familie" ? 0 : 1) - (b.category === "familie" ? 0 : 1));
function srHome(s) {
  const d = srDoses(s.id), ap = srAppts(s.id), feel = (S.D.care || []).find((e) => e.senior_id === s.id && e.author_id === S.uid && isoDay(e.created_at) === today() && SR_FEEL.some((f) => f[0] === e.kind));
  const medSub = !d.all.length ? "Heute keine" : d.now.length ? `<b class="sr-due">${d.now.length} jetzt fällig</b>` : d.later.length ? `Nächste um ${d.later[0].slot} Uhr` : "Alles genommen ✓";
  const apSub = ap.tod.length ? `${ap.tod.length === 1 ? "1 Termin" : ap.tod.length + " Termine"} · ${hm(ap.tod[0].starts_at)} Uhr` : ap.next ? `Nächster: ${shortDay(isoDay(ap.next.starts_at))}` : "Keine Termine";
  const tile = (href, ico, title, sub, cls = "") => `<a class="sr-tile ${cls}" href="${href}"><span class="sr-ico" aria-hidden="true">${ico}</span><span class="sr-tt"><b>${title}</b><small>${sub}</small></span></a>`;
  const cw = carerNow(s.id), cn = !cw && carerNext(s.id);
  const carer = cw ? `<div class="sr-carer now"><span class="sr-cico" aria-hidden="true">${ICON.carer}</span><span><b>Der Pflegedienst ist jetzt da</b><small>${esc(cw.c.name)} · bis ${hmMs(cw.e)} Uhr</small></span></div>`
    : cn ? `<div class="sr-carer"><span class="sr-cico" aria-hidden="true">${ICON.carer}</span><span><b>Heute kommt der Pflegedienst um ${hmMs(cn.s)} Uhr</b><small>${esc(cn.c.name)}</small></span></div>` : "";
  return `${carer}<div class="sr-grid">
    ${tile("#/s/med", "💊", "Meine Medikamente", medSub, d.now.length ? "due" : "")}
    ${tile("#/s/heute", "📅", "Heute", apSub)}
    ${tile("#/s/wie", feel ? careK(feel.kind).e : "🙂", "Wie geht's mir?", feel ? `Eingetragen ${hm(feel.created_at)} Uhr` : "Kurz antippen")}
    ${tile("#/s/mess", "🩺", "Wert messen", "Blutdruck · Zucker")}
    ${tile("#/s/ruf", "📞", "Anrufen", "Familie · Arzt")}
    ${tile(`#/notfall/${s.id}`, "🚑", "Notfall", "Notfallkarte · 112", "sos")}
  </div>
  <button class="sr-help" id="sr-help"><span aria-hidden="true">🔔</span><span><b>Hilfe holen</b><small>Deine Familie bekommt sofort Bescheid</small></span></button>`;
}
function srMeds(s) {
  const d = srDoses(s.id);
  const row = (x) => `<div class="sr-dose ${x.status}" data-fk="d:${x.med.id}|${x.slot}"><div class="sr-dt"><b>${x.slot}</b><small>Uhr</small></div><div class="sr-db"><b>${esc(x.med.name)}</b>${x.med.dosage ? `<small>${esc(x.med.dosage)}</small>` : ""}${x.med.note ? `<small class="muted">${esc(x.med.note)}</small>` : ""}
    ${x.status === "given" ? `<span class="sr-ok">✓ Genommen ${hm(x.dose.given_at)} Uhr${x.dose.given_by !== S.uid ? ` · ${esc(nmPlain(x.dose.given_by))}` : ""}</span>` : x.status === "missed" ? `<span class="sr-late">Noch nicht genommen</span>` : ""}</div>
    ${x.status === "given" ? (x.dose.given_by === S.uid ? `<button class="sr-undo" data-undo="${x.dose.id}">Zurück</button>` : "") : `<button class="sr-take" data-give="${x.med.id}|${x.day}|${x.slot}">${ICON.check}<span>Genommen</span></button>`}</div>`;
  const sec = (t, xs) => xs.length ? `<h2 class="sr-h">${t}</h2><div class="sr-list">${xs.map(row).join("")}</div>` : "";
  return `<h1 class="sr-title">💊 Meine Medikamente</h1>
    ${!d.all.length ? `<p class="sr-empty">Für heute sind keine Medikamente eingetragen.</p>` : !d.now.length ? `<p class="sr-empty good">${d.later.length ? "Gerade ist nichts fällig. 👍" : "Alles für heute genommen. 👍"}</p>` : ""}
    ${sec("Jetzt", d.now)}${sec("Später heute", d.later)}${sec("Schon genommen", d.done)}`;
}
function srToday(s) {
  const { tod, next } = srAppts(s.id);
  const row = (a, day) => `<div class="sr-appt"><div class="sr-dt"><b>${hm(a.starts_at)}</b><small>Uhr</small></div><div class="sr-db"><b>${esc(a.title)}</b>${day ? `<small>${esc(day)}</small>` : ""}${a.location ? `<small class="muted">📍 ${esc(a.location.split("\n")[0])}</small>` : ""}</div></div>`;
  const dl = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  return `<h1 class="sr-title">📅 Heute</h1><p class="sr-sub">${esc(dl)}</p>
    ${tod.length ? `<div class="sr-list">${tod.map((a) => row(a)).join("")}</div>` : `<p class="sr-empty">Heute keine Termine.</p>`}
    ${next ? `<h2 class="sr-h">Als Nächstes</h2><div class="sr-list">${row(next, new Date(next.starts_at).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" }))}</div>` : ""}`;
}
function srFeel(s) {
  const mine = (S.D.care || []).filter((e) => e.senior_id === s.id && e.author_id === S.uid && isoDay(e.created_at) === today()).slice(0, 4);
  return `<h1 class="sr-title">Wie geht's dir?</h1><p class="sr-sub">Tippe an, was passt. Deine Familie sieht es im Tagebuch.</p>
    <div class="sr-feel">${SR_FEEL.map(([k, e, l]) => `<button class="sr-face" data-feel="${k}"><span aria-hidden="true">${e}</span><b>${l}</b></button>`).join("")}</div>
    <form id="sr-note" class="sr-form"><label class="sr-lab" for="sr-nt">Möchtest du etwas dazu sagen?</label><textarea id="sr-nt" name="note" rows="2" maxlength="280" placeholder="z. B. Knie tut weh"></textarea><button class="sr-btn" type="submit">Senden</button><p class="err"></p></form>
    ${mine.length ? `<h2 class="sr-h">Heute schon eingetragen</h2><div class="sr-list">${mine.map((e) => `<div class="sr-mini">${careK(e.kind).e} ${esc(careK(e.kind).n)}${e.note ? ` – ${esc(e.note)}` : ""} <small>${hm(e.created_at)} Uhr</small></div>`).join("")}</div>` : ""}`;
}
function srMeasure(s) {
  const k = S.srKind || "bp", mm = gluMmol();
  const last = (S.D.vitals || []).filter((v) => v.senior_id === s.id && v.kind === k).slice(0, 3);
  return `<h1 class="sr-title">🩺 Wert messen</h1>
    <div class="sr-seg" role="tablist"><button data-sk="bp" class="${k === "bp" ? "on" : ""}" role="tab" aria-selected="${k === "bp"}">Blutdruck</button><button data-sk="glucose" class="${k === "glucose" ? "on" : ""}" role="tab" aria-selected="${k === "glucose"}">Blutzucker</button></div>
    <form id="sr-vf" class="sr-form" novalidate>
      ${k === "bp" ? `<div class="sr-bp"><label><span>Oben</span><input name="v1" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" aria-label="Oberer Wert"></label><i aria-hidden="true">/</i><label><span>Unten</span><input name="v2" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" aria-label="Unterer Wert"></label></div>
        <label class="sr-one"><span>Puls <small>(wenn angezeigt)</small></span><input name="pulse" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off"></label>`
      : `<label class="sr-one"><span>Zucker in ${gluU()}</span><input name="v1" inputmode="decimal" maxlength="5" autocomplete="off"></label>
        <div class="sr-ctx">${["fasting", "before_meal", "after_meal", "bedtime"].map((c) => `<label><input type="radio" name="context" value="${c}"><span>${GCTX[c]}</span></label>`).join("")}</div>`}
      <p class="err" role="alert"></p><button class="sr-btn big" type="submit">${ICON.check}<span>Speichern</span></button></form>
    ${last.length ? `<h2 class="sr-h">Zuletzt</h2><div class="sr-list">${last.map((v) => { const c = vClass(v); return `<div class="sr-mini"><b>${vMain(v)}</b> ${esc(vUnit(v.kind))}${v.pulse ? ` · Puls ${v.pulse}` : ""} <small>${shortDay(isoDay(v.measured_at))}, ${hm(v.measured_at)} Uhr</small>${c ? ` <span class="sr-vc ${c}">${c === "in" ? "im Zielbereich" : c === "hi" ? "erhöht" : "niedrig"}</span>` : ""}</div>`; }).join("")}</div>` : ""}`;
}
function srCall(s) {
  const cs = srCalls(s.id);
  return `<h1 class="sr-title">📞 Anrufen</h1><p class="sr-sub">Tippe auf einen Namen – das Telefon wählt.</p>
    <div class="sr-calls">${cs.map((c) => `<a class="sr-call ${c.category === "familie" ? "fam" : ""}" href="${telUrl(c.phone)}"><span class="sr-cico" aria-hidden="true">${ICON.phone}</span><span><b>${esc(c.name)}</b><small>${esc(SR_CCAT[c.category])}${c.org && c.org !== c.name ? " · " + esc(c.org) : ""}</small></span></a>`).join("") || `<p class="sr-empty">Noch keine Nummern eingetragen – deine Familie kann sie unter „Kontakte“ ergänzen.</p>`}
      <a class="sr-call sos" href="tel:112"><span class="sr-cico" aria-hidden="true">${ICON.phone}</span><span><b>Notruf 112</b><small>Rettungsdienst · Feuerwehr</small></span></a></div>`;
}
function srSos(s) { const c = sosData(s.id); return c ? sosHtml(c, { offline: true }) : ""; }
function renderSenior(r) {
  const s = senior(srSid());
  const sub = r.page === "s" ? r.id : r.page === "notfall" ? "notfall" : "home";
  const pages = { home: srHome, med: srMeds, heute: srToday, wie: srFeel, mess: srMeasure, ruf: srCall, notfall: srSos };
  const pg = s && pages[sub] ? sub : "home";
  if (r.page !== "home" && r.page !== "s" && !(r.page === "notfall" && r.id === s?.id)) { history.replaceState(null, "", "#/"); }
  const y = window.scrollY, same = lastPage === location.hash;
  app.innerHTML = `<div class="srv" style="--srz:${SRZ[srZ()]}">
    <header class="sr-top">${pg === "home" ? `<div class="sr-hi"><small>${esc(new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" }))}</small><b>${srGreet()}${srFirst() ? ", " + esc(srFirst()) : ""}</b></div>` : `<a class="sr-back" href="#/">${ICON.back}<span>Zurück</span></a>`}
      ${DEMO ? '<span class="demo-tag">Demo</span>' : ""}<button type="button" class="me sr-me" id="me-btn" aria-label="Mein Konto (lange drücken: Konto wechseln)">${ava(S.uid)}</button></header>
    <main class="sr-page" id="page">${s ? pages[pg](s) : `<p class="sr-empty">Dein Konto ist noch mit keiner Person verknüpft. Bitte deine Familie, das unter Einstellungen › Mitglieder einzustellen.</p>`}</main></div>`;
  lastPage = location.hash;
  bindSenior(pg, s);
  window.scrollTo(0, same ? y : 0);
}
function srHelp(s) {
  const { sh, close } = openSheet(`<div class="sr-sheet" style="--srz:${SRZ[srZ()]}"><h2>Hilfe holen?</h2><p>Deine Familie bekommt sofort eine Nachricht aufs Handy.</p>
    <div class="sr-btns"><button class="sr-btn big warn" id="h-go">🔔 <span>Ja, Hilfe holen</span></button><button class="sr-btn ghost" data-close>Abbrechen</button></div>
    <a class="sr-call sos" href="tel:112"><span class="sr-cico" aria-hidden="true">${ICON.phone}</span><span><b>Notfall? 112 anrufen</b><small>Rettungsdienst</small></span></a></div>`, "sr-sh");
  $("#h-go", sh).onclick = async (e) => {
    const r = await busy(e.currentTarget, () => call("help_request", { senior_id: s.id })).catch(() => null);
    if (!r) return;
    close(); if (r.entry) S.D.care = [r.entry, ...(S.D.care || [])];
    openSheet(`<div class="sr-sheet" style="--srz:${SRZ[srZ()]}"><h2>✓ Bescheid gesagt</h2><p>${r.notified ? `${r.notified === 1 ? "1 Person wurde" : r.notified + " Personen wurden"} benachrichtigt. Jemand meldet sich bei dir.` : "Deine Bitte steht im Tagebuch."}</p><p class="muted">Wenn es dringend ist: 112 anrufen.</p>
      <div class="sr-btns"><button class="sr-btn big" data-close>OK</button></div></div>`, "sr-sh");
  };
}
function srMeSheet() {
  const z = srZ();
  const { sh, close } = openSheet(`<div class="sr-sheet" style="--srz:${SRZ[z]}"><div class="sheet-head row">${ava(S.uid, "lg")}<div><h2>${esc(S.me.display_name)}</h2><p class="muted">@${esc(S.me.username)} · ${esc(fam()?.name || "")}</p></div></div>
    <h3 class="sr-lab">Schriftgröße</h3><div class="sr-seg zs">${SRZ.map((_, i) => `<button data-z="${i}" class="${i === z ? "on" : ""}" style="font-size:${1 + i * 0.25}em" aria-label="Schriftgröße ${["normal", "groß", "sehr groß"][i]}">A</button>`).join("")}</div>
    <div class="sr-btns"><button class="sr-btn ghost" id="sr-lo">${ICON.logout}<span>Abmelden</span></button><button class="sr-btn" data-close>Schließen</button></div></div>`, "sr-sh");
  $$("[data-z]", sh).forEach((b) => (b.onclick = () => { localStorage.setItem("pf-sr-size", b.dataset.z); close(); render(true); srMeSheet(); }));
  $("#sr-lo", sh).onclick = async () => { if (await confirmSheet("Abmelden?", "Zum Wiederkommen brauchst du Benutzername und Passwort.", "Abmelden", false)) { close(); logout(); } };
}
// Kürzel: Tippen → „Mein Konto“; lange drücken (0,7 s) → Konto wechseln (dezent, für Familie/Tests)
function bindLongPress(el, onLong, onTap) {
  let t = null, long = false;
  const start = () => { long = false; clearTimeout(t); t = setTimeout(() => {
    long = true; try { navigator.vibrate?.(20); } catch {}
    // den Klick, den der Browser nach dem Loslassen erzeugt, schlucken – sonst schließt er das frisch geöffnete Sheet gleich wieder
    const kill = (e) => { e.stopPropagation(); e.preventDefault(); long = false; };
    document.addEventListener("click", kill, { capture: true, once: true }); setTimeout(() => document.removeEventListener("click", kill, true), 900);
    onLong();
  }, 700); };
  const stop = () => clearTimeout(t);
  el.addEventListener("pointerdown", start); el.addEventListener("pointerup", stop); el.addEventListener("pointerleave", stop); el.addEventListener("pointercancel", stop);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.onclick = (e) => { if (long) { e.preventDefault(); long = false; return; } onTap(); };
}
function bindSenior(pg, s) {
  bindLongPress($("#me-btn"), () => { $$(".sheet").forEach((x) => x.__close?.()); accountSheet(); }, srMeSheet);
  if (!s) return;
  const root = $("#page");
  if ($("#sr-help")) $("#sr-help").onclick = () => srHelp(s);
  $$("[data-give]", root).forEach((b) => (b.onclick = async () => {
    const [medication_id, day, slot] = b.dataset.give.split("|");
    const r = await busy(b, () => call("dose_give", { medication_id, day, slot })).catch(() => null);
    if (r?.dose) { S.D.doses = S.D.doses.filter((d) => d.id !== r.dose.id).concat(r.dose); toast("Eingetragen ✓ Gut gemacht!"); render(true); }
    reload().catch(() => {});
  }));
  $$("[data-undo]", root).forEach((b) => (b.onclick = async () => {
    if (!(await confirmSheet("Zurücknehmen?", "Das Medikament gilt dann wieder als nicht genommen.", "Zurücknehmen", false))) return;
    await busy(null, () => call("dose_undo", { id: b.dataset.undo })).catch(() => {}); await reload();
  }));
  $$("[data-feel]", root).forEach((b) => (b.onclick = async () => {
    const r = await busy(b, () => call("care_add", { senior_id: s.id, kind: b.dataset.feel, note: "" })).catch(() => null);
    if (r?.entry) { S.D.care = [r.entry, ...(S.D.care || [])]; toast("Danke! Deine Familie sieht es im Tagebuch."); render(true); }
  }));
  if ($("#sr-note")) $("#sr-note").onsubmit = async (e) => {
    e.preventDefault(); const note = String(fd(e.target).note || "").trim(), el = $(".err", e.target);
    if (!note) { el.textContent = "Bitte zuerst etwas schreiben"; return; }
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("care_add", { senior_id: s.id, kind: "special", note }), true).catch((er) => { el.textContent = er.message; return null; });
    if (r?.entry) { S.D.care = [r.entry, ...(S.D.care || [])]; toast("Gesendet ✓"); render(true); }
  };
  $$("[data-sk]", root).forEach((b) => (b.onclick = () => { S.srKind = b.dataset.sk; render(true); }));
  if ($("#sr-vf")) $("#sr-vf").onsubmit = async (e) => {
    e.preventDefault();
    const f = fd(e.target), k = S.srKind || "bp", el = $(".err", e.target), mm = gluMmol();
    const num = (x) => (x == null || String(x).trim() === "" ? null : Number(String(x).replace(",", ".")));
    let v1 = num(f.v1); const v2 = num(f.v2), pulse = num(f.pulse);
    const bad = (m, n) => { el.textContent = m; e.target.querySelector(`[name=${n}]`)?.focus(); };
    if (v1 == null || !isFinite(v1)) return bad(k === "bp" ? "Bitte den oberen Wert eintragen" : "Bitte den Zuckerwert eintragen", "v1");
    if (k === "glucose" && mm) v1 = Math.round(v1 * MMOL);
    const R = k === "bp" ? [50, 260] : [10, 700];
    if (v1 < R[0] || v1 > R[1]) return bad(k === "glucose" && mm ? `Bitte einen Wert zwischen ${fmtN(R[0] / MMOL, 1)} und ${fmtN(R[1] / MMOL, 1)} eintragen` : `Bitte einen Wert zwischen ${R[0]} und ${R[1]} eintragen`, "v1");
    if (k === "bp") { if (v2 == null || !isFinite(v2)) return bad("Bitte den unteren Wert eintragen", "v2"); if (v2 < 30 || v2 > 160) return bad("Unterer Wert: bitte zwischen 30 und 160", "v2"); if (v1 <= v2) return bad("Der obere Wert muss größer als der untere sein", "v1"); }
    if (pulse != null && (!isFinite(pulse) || pulse < 25 || pulse > 230)) return bad("Puls: bitte zwischen 25 und 230", "pulse");
    if (k === "glucose" && !f.context) { el.textContent = "Bitte antippen, wann gemessen wurde"; return; }
    el.textContent = "";
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("vital_save", { senior_id: s.id, kind: k, v1, v2: k === "bp" ? v2 : null, pulse: k === "bp" ? pulse : null, context: k === "glucose" ? f.context : null, note: "", measured_at: new Date().toISOString() }), true).catch((er) => { el.textContent = er.message; return null; });
    if (r?.vital) {
      S.D.vitals = [r.vital, ...(S.D.vitals || []).filter((v) => v.id !== r.vital.id)];
      const c = vClass(r.vital); toast(`Gespeichert ✓ ${vMain(r.vital)} ${vUnit(k)}${c === "in" ? " – im Zielbereich" : c === "hi" ? " – etwas hoch" : c === "lo" ? " – etwas niedrig" : ""}`, 4200); render(true);
    }
  };
  $$("[data-act]", root).forEach((b) => (b.onclick = () => act(b.dataset.act, b)));
}
window.__pfSr = { on: () => isSenior() };

// ---------- Hilfen & Ansprüche (Einstellungen › Hilfen & Ansprüche) ----------
// Allgemeine Infos, keine Rechtsberatung. Beträge geprüft gegen BMG „Leistungsansprüche der Versicherten im Jahr 2026“ (Stand 04.11.2025)
// und gesund.bund.de (Hausnotruf, Stand April 2026). Bei Änderungen bitte AID_STAND + Texte anpassen.
const AID_STAND = "Stand 2026";
const AID = [
  { k: "info", i: "note", t: "Pflegegrad beantragen", s: "Der erste Schritt zu allen Leistungen",
    p: "Den Antrag stellt man bei der Pflegekasse – sie sitzt bei der Krankenkasse. Ein Anruf oder ein formloses Schreiben genügt; auch Angehörige können ihn mit Vollmacht stellen. Danach kommt der Medizinische Dienst zur Begutachtung, meist nach Terminabsprache zu Hause. Die Pflegekasse soll innerhalb von 25 Arbeitstagen entscheiden.",
    src: [["BMG: Antragsverfahren", "https://www.bundesgesundheitsministerium.de/themen/pflege/online-ratgeber-pflege/pflegebeduerftig-was-nun"]] },
  { k: "task", i: "box", t: "Pflegehilfsmittel zum Verbrauch", s: "Bis zu 42 € im Monat (§ 40 SGB XI)",
    p: "Ab Pflegegrad 1 übernimmt die Pflegekasse bei Pflege zu Hause bis zu 42 € im Monat für Verbrauchsprodukte wie Einmalhandschuhe, Bettschutzeinlagen oder Desinfektionsmittel. Dafür braucht es einmal einen Antrag bei der Pflegekasse, ein Rezept ist nicht nötig. Man kann die Produkte auch selbst in Drogerie oder Apotheke kaufen und die Quittungen zur Erstattung einreichen.",
    src: [["Verbraucherzentrale", "https://www.verbraucherzentrale.de/wissen/gesundheit-pflege/pflege-zu-hause/pflegehilfsmittel-zum-verbrauch-diese-regeln-sollten-sie-kennen-95810"], ["gesund.bund.de", "https://gesund.bund.de/pflegehilfsmittel"]] },
  { k: "soon", i: "bell", t: "Hausnotruf", s: "Zuschuss bis zu 27 € im Monat",
    p: "Ein Hausnotruf gilt als Pflegehilfsmittel. Mit Pflegegrad kann die Pflegekasse auf Antrag bis zu 27 € im Monat übernehmen – das deckt meist den Basistarif. Voraussetzung ist in der Regel, dass die Person überwiegend allein ist und im Notfall sonst keine Hilfe rufen könnte. Der Anbieter muss von der Pflegekasse anerkannt sein; Extras wie Sturzsensor zahlt man meist selbst.",
    src: [["gesund.bund.de: Hausnotruf", "https://gesund.bund.de/hausnotruf"]] },
  { k: "journal", i: "euro", t: "Entlastungsbetrag", s: "Bis zu 131 € im Monat, auch bei Pflegegrad 1",
    p: "Wer zu Hause gepflegt wird, hat bei jedem Pflegegrad Anspruch auf bis zu 131 € im Monat. Das Geld ist für anerkannte Entlastungsangebote gedacht, z. B. Alltagsbegleitung, Haushaltshilfe, Tages- oder Kurzzeitpflege. Die Pflegekasse erstattet gegen Rechnung; nicht genutzte Beträge lassen sich ansparen und bis zum 30. Juni des Folgejahres verwenden.",
    src: [["BMG: Entlastungsbetrag", "https://www.bundesgesundheitsministerium.de/pflege-zu-hause/weitere-leistungen-und-angebote-zur-unterstuetzung-im-alltag"], ["gesund.bund.de", "https://gesund.bund.de/entlastungsbetrag"]] },
  { k: "note", i: "home", t: "Wohnung anpassen", s: "Zuschuss bis zu 4.180 € je Maßnahme",
    p: "Für Umbauten, die die Pflege zu Hause ermöglichen oder deutlich erleichtern – etwa eine bodengleiche Dusche, Türverbreiterung, Rampe oder Treppenlift – kann die Pflegekasse bis zu 4.180 € zahlen. Wichtig: vor dem Umbau beantragen. Wohnen mehrere Pflegebedürftige zusammen, sind bis zu 16.720 € möglich.",
    src: [["BMG: Zuschüsse zur Wohnungsanpassung", "https://www.bundesgesundheitsministerium.de/pflege-zu-hause/zuschuesse-zur-wohnungsanpassung"]] },
  { k: "contact", i: "chat", t: "Pflegeberatung", s: "Kostenlos – § 7a und § 37 Abs. 3 SGB XI",
    p: "Jede Person mit Pflegebedarf und ihre Angehörigen können sich kostenlos von der Pflegekasse oder einem Pflegestützpunkt beraten lassen (§ 7a), auf Wunsch auch zu Hause. Wer nur Pflegegeld bezieht, muss außerdem halbjährlich einen Beratungsbesuch zu Hause abrufen (§ 37 Abs. 3) – sonst kann das Pflegegeld gekürzt werden.",
    src: [["BMG: Häusliche Pflege", "https://www.bundesgesundheitsministerium.de/pflege-zu-hause"], ["gesund.bund.de: Beratung", "https://gesund.bund.de/beratung-und-schulung"]] },
  { k: "vit", i: "bed", t: "Verhinderungs- & Kurzzeitpflege", s: "Gemeinsam bis zu 3.539 € im Jahr",
    p: "Seit 1. Juli 2025 gibt es ab Pflegegrad 2 einen gemeinsamen Jahresbetrag von bis zu 3.539 € für Verhinderungspflege (Ersatz, wenn die Pflegeperson Urlaub macht oder krank ist) und Kurzzeitpflege (vorübergehend im Heim). Das Geld lässt sich frei auf beide aufteilen, jeweils bis zu acht Wochen im Jahr. Eine Vorpflegezeit ist nicht mehr nötig.",
    src: [["BMG: Gemeinsamer Jahresbetrag", "https://www.bundesgesundheitsministerium.de/presse/pressemitteilungen/das-aendert-sich-zum-1-juli-in-der-pflege"], ["gesund.bund.de", "https://gesund.bund.de/verhinderungspflege"]] },
];
// Partner (Anzeige): nur aus partners.js, nur https-Links, höchstens 2 – solange leer bleibt alles unsichtbar
function partners() {
  const P = window.PF_PARTNERS; if (!P || !P.enabled || !Array.isArray(P.items)) return [];
  return P.items.filter((x) => x && x.title && /^https:\/\/[^\s"'<>]+$/.test(String(x.url || ""))).slice(0, 2);
}
const recOn = () => { try { return localStorage.getItem("pf-recs") !== "off"; } catch { return true; } };
const recSet = (on) => { try { on ? localStorage.removeItem("pf-recs") : localStorage.setItem("pf-recs", "off"); } catch {} };
const extA = (href, label, rel = "noopener noreferrer") => `<a class="aid-src" href="${esc(href)}" target="_blank" rel="${rel}" referrerpolicy="no-referrer">${ICON.ext}<span>${esc(label)}</span></a>`;
function aidSheet() {
  if (isSenior()) return;
  const ps = recOn() ? partners() : [];
  const { sh } = openSheet(`<div class="aid">
    <div class="sheet-head row">${sico("aid", "lg")}<div><h2>Hilfen &amp; Ansprüche</h2><p class="muted">Was die Pflegekasse zahlt – kurz erklärt</p></div></div>
    <p class="aid-note">Allgemeine Informationen, keine Rechts- oder Leistungsberatung. ${AID_STAND}, Angaben ohne Gewähr. Verbindlich entscheidet die Pflegekasse.</p>
    <div class="aid-list">${AID.map((a, n) => `<details class="aid-card" data-aid="${n}"><summary><span class="sico k-${a.k}">${ICON[a.i]}</span><span class="aid-t"><b>${esc(a.t)}</b><small>${esc(a.s)}</small></span><span class="chev">${ICON.chev}</span></summary>
      <div class="aid-b"><p>${esc(a.p)}</p><div class="aid-srcs">${a.src.map(([l, u]) => extA(u, l)).join("")}</div></div></details>`).join("")}</div>
    <p class="muted small aid-tip">Tipp: Pflegestützpunkte und die Pflegeberatung der Pflegekasse helfen kostenlos beim Antrag.</p>
    ${ps.length ? `<h3 class="sec aid-rec-h">Empfehlungen <span class="ad-tag">Anzeige</span></h3><div class="aid-recs">${ps.map((x) => `<a class="aid-ad" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer sponsored nofollow" referrerpolicy="no-referrer">
        <span class="sico k-aid">${ICON[x.icon] && ["box", "bell", "home", "euro", "heart", "aid"].includes(x.icon) ? ICON[x.icon] : ICON.aid}</span><span class="aid-t"><small class="ad-tag">Anzeige</small><b>${esc(x.title)}</b>${x.text ? `<small>${esc(x.text)}</small>` : ""}<span class="aid-cta">${esc(x.cta || "Zum Angebot")} ${ICON.ext}</span></span></a>`).join("")}</div>
      <p class="muted small aid-tip">Externe Angebote. Pflegekreis gibt dabei keine Daten weiter. In den Einstellungen abschaltbar.</p>` : ""}
    <div class="btns"><button class="btn ghost" data-close>Schließen</button></div></div>`, "aid-sh");
  // nur eine Karte gleichzeitig offen – bleibt übersichtlich
  $$(".aid-card", sh).forEach((d) => d.addEventListener("toggle", () => { if (d.open) $$(".aid-card", sh).forEach((o) => o !== d && (o.open = false)); }));
}
window.__pfAid = { partners: () => partners(), on: () => recOn(), open: () => aidSheet() };

// ---------- Layout ----------
function route() { const h = location.hash.replace(/^#\/?/, "").split("/"); return { page: h[0] || "home", id: h[1] || null, sub: h[2] || null }; }
const NAV = [["home", "#/", "Heute", ICON.home], ["werte", "#/werte", "Werte", ICON.vit], ["tagebuch", "#/tagebuch", "Tagebuch", ICON.book], ["kontakte", "#/kontakte", "Kontakte", ICON.contacts]];
let lastPage = null;
// „Neu“ sitzt fest in der Navigationsleiste (kein schwebender Knopf über Kacheln). Seiten können die Aktion anpassen (z. B. Tagebuch → „Eintrag“).
let FAB = null;
const fabCtx = (act, label, sid = "") => { FAB = { act, label, sid }; return ""; };
const navNew = () => { const f = FAB || { act: "new-any", label: "Neu", sid: "" };
  return `<button type="button" class="nav-new" data-act="${f.act}"${f.sid ? ` data-sid="${f.sid}"` : ""} aria-label="${f.label === "Neu" ? "Neu anlegen" : "Eintrag hinzufügen"}"><i>${ICON.plus}</i><span>${f.label}</span></button>`; };
function render(soft = false) {
  if (!S.D || S.onboard) return;
  const r = route();
  document.body.classList.toggle("sr-mode", isSenior());
  if (isSenior()) return renderSenior(r);
  // Alte Adressen (Push-Links, Lesezeichen) bleiben gültig: #/aufgaben[/id], #/kalender[/id], #/uebergabe[/id];
  // Chat und Familie gibt es nicht mehr als Reiter → Startseite bzw. Einstellungen (Kürzel oben rechts)
  // Der Plan (Aufgaben + Termine) steht jetzt auf der Startseite unter den Medikamenten → #/plan, #/aufgaben, #/kalender führen dorthin
  if (r.page === "aufgaben" || r.page === "kalender" || r.page === "plan") {
    const t = r.page === "aufgaben" && r.id && S.D.tasks.some((x) => x.id === r.id) ? r.id : null, a = r.page === "kalender" && r.id && S.D.appts.some((x) => x.id === r.id) ? r.id : null;
    history.replaceState(null, "", "#/"); render(soft);
    if (!soft) ($("#plan-s") || $("#calo"))?.scrollIntoView({ block: "start" });
    if (!soft && t) taskSheet(t); if (!soft && a) apptSheet(a);
    return;
  }
  if (r.page === "werte" && r.id && senior(r.id)) { S.vSen = r.id; history.replaceState(null, "", "#/werte"); return render(soft); }
  if (r.page === "bericht" && r.id && senior(r.id)) { history.replaceState(null, "", "#/person/" + r.id); render(soft); if (!soft) reportSheet(r.id); return; }
  if (r.page === "chat" || r.page === "updates") { history.replaceState(null, "", "#/"); return render(soft); }
  if (r.page === "familie" || r.page === "einstellungen") { history.replaceState(null, "", "#/"); render(soft); if (!soft) settingsSheet(); return; }
  if (r.page === "kontakte" && r.id) { const c = contact(r.id); history.replaceState(null, "", "#/kontakte"); render(soft); if (!soft && c) contactSheet(c.id); return; }
  if (r.page === "uebergabe" && (r.id ? senior(r.id) : S.D.seniors.length === 1)) { const sid = r.id || S.D.seniors[0].id; (S.pTab ||= {})[sid] = "heute"; history.replaceState(null, "", "#/person/" + sid); return render(soft); }
  if (r.page === "person" && r.sub && senior(r.id)) { (S.pTab ||= {})[r.id] = r.sub; history.replaceState(null, "", "#/person/" + r.id); return render(soft); }
  if (r.page === "tagebuch" && r.id) { const J = jState(); if (senior(r.id)) { J.sen = r.id; J.view = "day"; } else if (/^\d{4}-\d{2}-\d{2}$/.test(r.id)) { J.day = r.id > today() ? today() : r.id; J.view = "day"; } history.replaceState(null, "", "#/tagebuch"); return render(soft); }
  const pages = { notfall: pageSos, home: pageHome, werte: pageVitals, tagebuch: pageJournal, kontakte: pageContacts, medikamente: pageMeds, person: pageSenior, uebergabe: pageHandoffPick };
  const pg = pages[r.page] ? r.page : "home";
  const navKey = pg === "person" || pg === "uebergabe" || pg === "medikamente" || pg === "notfall" ? "home" : pg;
  const y = window.scrollY;
  const f = fam();
  const same = soft && lastPage === location.hash;
  const flip = same ? flipFirst() : null;
  if (!soft && pg !== "home") { S.planDay = ""; S.wkScroll = 0; }
  FAB = null;
  app.innerHTML = `
    <header class="top ${pg === "home" ? "top-home" : ""}">${pg === "home" ? `<h1 class="top-h">${S.fams.length > 1 ? `<button class="fam-switch fs-home" id="famsw" aria-label="Familie wechseln – ${esc(f?.name || "")}">Heute<span class="caret">▾</span></button>` : "Heute"}</h1>` : `
      <button class="fam-switch" id="famsw" aria-label="Familie wechseln"><img class="logo-dot" src="icons/logo.svg?v=2" alt=""><span><small>Pflegekreis</small><b>${esc(f?.name || "")}</b></span>${S.fams.length > 1 ? '<span class="caret">▾</span>' : ""}</button>`}
      ${DEMO ? '<span class="demo-tag">Demo</span>' : ""}
      <button type="button" class="me" id="me-btn" aria-label="Einstellungen öffnen" aria-haspopup="dialog">${ava(S.uid)}</button>
    </header>
    <main class="page" id="page">${pages[pg](r.id)}</main>
    <nav class="nav">${NAV.map(([k, h, l, i]) => `<a href="${h}" data-nav="${k}" class="${navKey === k ? "on" : ""}" ${navKey === k ? 'aria-current="page"' : ""}>${i}<span>${l}</span></a>`).map((x, n) => (n === 2 ? navNew() : "") + x).join("")}</nav>`;
  lastPage = location.hash;
  if (S.swipeIn) { const d = S.swipeIn; S.swipeIn = 0; if (!reduceMotion()) { const pgEl = $("#page"); pgEl.classList.add(d > 0 ? "sw-in-l" : "sw-in-r"); pgEl.addEventListener("animationend", () => pgEl.classList.remove("sw-in-l", "sw-in-r"), { once: true }); } }
  if ($("#famsw")) $("#famsw").onclick = famSwitcher;
  $("#me-btn").onclick = () => settingsSheet();
  bindPage(pg, r.id);
  $$(".nav [data-act]").forEach((b) => (b.onclick = () => act(b.dataset.act, b)));
  watchComposer();
  if (same) window.scrollTo(0, y); else window.scrollTo(0, 0);
  if (flip) flipPlay(flip);
  animRings($("#page"));
}
// ---------- Wischen zwischen den Reitern (Heute ↔ Werte ↔ Tagebuch ↔ Kontakte; „+“ ist kein Reiter) ----------
// Nach links wischen = nächster Reiter, nach rechts = voriger. Nur auf den vier Reiter-Seiten, nicht im Senioren-Modus.
// Keine Auslösung, wenn die Geste in einem waagerecht scrollbaren Bereich (Haushalt-Kacheln, Personen-Spalten, Wochenstreifen,
// Filter-Chips, Diagramme …), in einem offenen Sheet oder Eingabefeld startet, oder am linken Rand (iOS-Zurück-Geste, ~20 px).
// Schwelle 60 px und klar waagerecht (|dx| > 1,5·|dy|). Passive Listener → senkrechtes Scrollen bleibt unberührt.
const SWIPE_TABS = NAV.map((n) => n[0]);
const SWIPE_NO = "input,textarea,select,[contenteditable],.noswipe,.sheet,.backdrop,.toast2,canvas,.chart,.spark,.nav,header.top";
// Streifen, die waagerecht scrollen können – blockieren nur, wenn sie gerade wirklich breiter sind als sichtbar
const SWIPE_SCROLL = ".hhtabs,.ocols,.wkstrip,.chips,.pchips,.tabs,.seg";
function swipeTab() { const p = route().page || "home"; return SWIPE_TABS.includes(p) ? p : null; }
function swipeBlocked(t) {
  if (!(t instanceof Element)) return true;
  if (t.closest(SWIPE_NO)) return true;
  const sc = t.closest(SWIPE_SCROLL); if (sc && sc.scrollWidth > sc.clientWidth + 2) return true;
  // allgemein: jeder Vorfahr, der waagerecht scrollen kann
  for (let el = t; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 2) { const ox = getComputedStyle(el).overflowX; if (ox === "auto" || ox === "scroll") return true; }
  }
  return false;
}
let swipeN = 0;
function swipeGo(dir) { // dir 1 = nächster, -1 = voriger
  const cur = swipeTab(); if (!cur) return false;
  swipeN++;
  const i = SWIPE_TABS.indexOf(cur) + dir; if (i < 0 || i >= SWIPE_TABS.length) return false;
  const key = SWIPE_TABS[i], h = NAV[i][1], pg = $("#page");
  $$(".nav [data-nav]").forEach((a) => { const on = a.dataset.nav === key; a.classList.toggle("on", on); on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); });
  S.swipeIn = dir;
  const go = () => { if (location.hash === h || (h === "#/" && !location.hash)) render(); else location.hash = h; };
  if (pg && !reduceMotion()) { pg.classList.remove("sw-drag"); pg.style.transform = ""; pg.style.opacity = ""; pg.classList.add(dir > 0 ? "sw-out-l" : "sw-out-r"); setTimeout(go, 150); }
  else go();
  return true;
}
window.__pfSwipe = { go: (d) => swipeGo(d), blocked: (sel) => swipeBlocked(document.querySelector(sel)), n: () => swipeN };
(function swipeTabs() {
  let on = false, lock = 0, x0 = 0, y0 = 0, dx = 0, dy = 0; // lock: 0 offen, 1 waagerecht, -1 senkrecht
  const pg = () => $("#page");
  const reset = () => { const p = pg(); if (p) { p.classList.remove("sw-drag"); p.style.transform = ""; p.style.opacity = ""; } };
  document.addEventListener("touchstart", (e) => {
    on = false; lock = 0; dx = dy = 0;
    if (e.touches.length !== 1 || isSenior() || !S.D || S.onboard || !swipeTab() || $(".sheet")) return;
    const t = e.touches[0];
    if (t.clientX < 20) return; // iOS-Zurück-Geste
    if (!pg()?.contains(e.target) || swipeBlocked(e.target)) return;
    on = true; x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!on) return;
    const t = e.touches[0]; dx = t.clientX - x0; dy = t.clientY - y0;
    if (!lock) { if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { lock = -1; on = false; return; } if (Math.abs(dx) > 12 && Math.abs(dx) > 1.5 * Math.abs(dy)) lock = 1; else return; }
    if (lock !== 1 || reduceMotion()) return;
    const i = SWIPE_TABS.indexOf(swipeTab()), edge = (dx > 0 && i === 0) || (dx < 0 && i === SWIPE_TABS.length - 1);
    const p = pg(); if (!p) return;
    const m = edge ? dx * 0.12 : dx * 0.35; // am Rand nur leichter Widerstand
    p.classList.add("sw-drag"); p.style.transform = `translateX(${Math.max(-90, Math.min(90, m))}px)`; p.style.opacity = edge ? "" : String(Math.max(0.55, 1 - Math.abs(dx) / 500));
  }, { passive: true });
  const end = () => {
    if (!on) return; on = false;
    const ok = lock === 1 && Math.abs(dx) >= 60 && Math.abs(dx) > 1.5 * Math.abs(dy);
    if (!(ok && swipeGo(dx < 0 ? 1 : -1))) { const p = pg(); if (p && p.classList.contains("sw-drag")) { p.classList.remove("sw-drag"); p.classList.add("sw-back"); p.style.transform = ""; p.style.opacity = ""; setTimeout(() => p.classList.remove("sw-back"), 260); } }
  };
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", () => { on = false; reset(); }, { passive: true });
})();
// FLIP-Animation: Einträge gleiten an ihren neuen Platz (z. B. erledigt → nach unten), neue gleiten ein
function flipFirst() {
  if (reduceMotion()) return null;
  const m = new Map(); $$("#page [data-fk]").forEach((el) => { const r = el.getBoundingClientRect(); if (r.height) m.set(el.dataset.fk, r.top); });
  return m;
}
function flipPlay(first) {
  if (!first || !first.size) return;
  const els = $$("#page [data-fk]"); if (els.length > 120) return;
  for (const el of els) {
    const r = el.getBoundingClientRect(); if (!r.height || !el.animate) continue;
    const was = first.get(el.dataset.fk);
    if (was === undefined) el.animate([{ opacity: 0, transform: "translateY(-10px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" });
    else if (Math.abs(was - r.top) > 2) el.animate([{ transform: `translateY(${was - r.top}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}
// Ringe: von altem auf neuen Stand animieren
function animRings(root) {
  const prev = (S.ringPrev ||= {});
  $$("circle[data-rk]", root).forEach((c) => {
    const k = c.dataset.rk, to = c.style.strokeDasharray, from = prev[k]; prev[k] = to;
    if (!from || from === to || reduceMotion()) return;
    c.style.transition = "none"; c.style.strokeDasharray = from; c.getBoundingClientRect();
    c.style.transition = ""; requestAnimationFrame(() => (c.style.strokeDasharray = to));
  });
}
function famSwitcher() {
  const { sh, close } = openSheet(`<h2>Familie wählen</h2><div class="list">${S.fams.map((f) => `<button class="row-btn ${f.id === S.fid ? "on" : ""}" data-f="${f.id}"><b>${esc(f.name)}</b><span class="muted">${f.role === "admin" ? "Admin" : "Mithelfer"}</span></button>`).join("")}</div>
    <div class="btns"><button class="btn ghost" id="fs-new">Weitere Familie gründen oder beitreten</button></div>`);
  $$("[data-f]", sh).forEach((b) => (b.onclick = async () => { close(); if (b.dataset.f !== S.fid) { location.hash = "#/"; await openFamily(b.dataset.f); } }));
  $("#fs-new", sh).onclick = () => { close(); S.unsub?.(); S.unsub = null; renderOnboarding(2); };
}

// ---------- Gemeinsame Bausteine ----------
const multiSen = () => (S.D?.seniors.length || 0) > 1;
const sDot = (sid) => { const s = senior(sid); return s ? `<span class="sdot" style="--c:${sTone(s).c}">${esc(s.name)}</span>` : ""; };
// Fortschreitende Offenlegung: die ersten n Einträge, der Rest hinter „Mehr anzeigen“
const more = (items, n, label = "Mehr anzeigen") => items.length <= n ? items.join("") : items.slice(0, n).join("") + `<details class="more"><summary>${label} (${items.length - n})</summary><div class="list">${items.slice(n).join("")}</div></details>`;
// ---------- Aufgaben-Bausteine ----------
const openTasks = () => S.D.tasks.filter((t) => t.status !== "done");
function sortTasks(a, b) { return (a.due_date || "9999").localeCompare(b.due_date || "9999") || (a.due_time || "99").localeCompare(b.due_time || "99") || a.created_at.localeCompare(b.created_at); }
function dueText(t) {
  if (!t.due_date) return "";
  const od = t.status !== "done" && t.due_date < today();
  return `<span class="${od ? "overdue" : ""}">${od ? "Überfällig · " : ""}${dayLabel(t.due_date)}${t.due_time ? ", " + t.due_time : ""}</span>`;
}
// Zuständigkeit: „Für dich“ (petrol hervorgehoben), „Offen“ (+ Übernehmen) oder Kürzel/Name der zuständigen Person
const whoTag = (x, what) => x.assignee_id === S.uid ? `<span class="who forme">${ava(S.uid, "xs")}Für dich</span>`
  : x.assignee_id ? `<span class="who other">${ava(x.assignee_id, "xs")} ${esc(nm(x.assignee_id))}</span>`
  : `<span class="who free">${ICON.user}Offen</span><button class="take" data-take="${what}:${x.id}" aria-label="${esc(x.title)}: Ich mach's">Ich mach's</button>`;
async function takeOver(what, id, uid = S.uid, btn = null) {
  const list = what === "appt" ? S.D.appts : S.D.tasks, x = list.find((y) => y.id === id); if (!x) return;
  const prev = x.assignee_id; x.assignee_id = uid; if ($(".sheet")) sheetRefresh?.(); renderBehind();
  try {
    await call("assign", { what, id, assignee_id: uid, only_if_open: uid === S.uid && !prev });
    if (uid === S.uid) undoToast(`Übernommen – danke, ${firstName()}!`, async () => { x.assignee_id = prev; if ($(".sheet")) sheetRefresh?.(); renderBehind(); try { await call("assign", { what, id, assignee_id: prev || null }); } catch (e) { toast(e.message); } await reload().catch(() => {}); });
    else toast(uid ? `Jetzt bei ${nmPlain(uid)}` : "Wieder offen – jemand anderes kann übernehmen");
    await reload();
  } catch (e) { x.assignee_id = prev; if ($(".sheet")) sheetRefresh?.(); renderBehind(); toast(e.message); await reload().catch(() => {}); }
}
const assignBox = (x, what) => x.assignee_id === S.uid
  ? `<div class="asg forme">${ava(S.uid)}<div><b>Für dich</b><small>Du kümmerst dich darum.</small></div><button class="btn small ghost" data-give="${what}:${x.id}">Abgeben</button></div>`
  : x.assignee_id ? `<div class="asg">${ava(x.assignee_id)}<div><b>${esc(nm(x.assignee_id))}</b><small>kümmert sich darum</small></div><button class="btn small ghost" data-take2="${what}:${x.id}">Ich mach's</button></div>`
  : `<div class="asg free"><span class="asg-ico">${ICON.user}</span><div><b>Offen</b><small>Noch niemand zuständig.</small></div><button class="btn small" data-take2="${what}:${x.id}" id="take">Ich mach's</button></div>`;
function bindAssign(root) {
  $$("[data-take]", root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const [w, id] = b.dataset.take.split(":"); b.disabled = true; takeOver(w, id); }));
  $$("[data-take2]", root).forEach((b) => (b.onclick = () => { const [w, id] = b.dataset.take2.split(":"); takeOver(w, id); }));
  $$("[data-give]", root).forEach((b) => (b.onclick = () => { const [w, id] = b.dataset.give.split(":"); takeOver(w, id, null); }));
}
function taskRow(t, opts = {}) {
  const done = t.status === "done", ip = t.status === "in_progress";
  const meta = [
    !opts.noSenior && t.senior_id ? sChip(t.senior_id) : "",
    dueText(t),
    t.recurrence !== "none" ? `<span class="rec">${ICON.rep}${REC[t.recurrence]}</span>` : "",
    t.appointment_id ? `<span class="ti k-appt">${ICON.cal}Termin</span>` : "",
  ].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');
  const who = done ? `<span class="who done-by">✓ ${doerHtml(t, t.completed_by)} · ${rel(t.completed_at)}</span>`
    : ip ? `<span class="who ip">In Arbeit · ${esc(nm(t.started_by || t.assignee_id))}</span>`
    : whoTag(t, "task");
  return `<div class="task ${done ? "done" : ""} ${ip ? "ip" : ""} ${!done && t.assignee_id === S.uid ? "mine" : ""}" data-task="${t.id}" data-fk="t:${t.id}" role="button" tabindex="0">
    <button class="tick" data-tick="${t.id}" aria-label="${done ? "Wieder öffnen" : "Als erledigt markieren"}">${done ? ICON.check : ip ? '<span class="half"></span>' : ""}</button>
    <div class="t-body"><div class="t-title">${esc(t.title)}</div>${meta ? `<div class="t-meta">${meta}</div>` : ""}<div class="t-who">${who}${t.notes ? `<span class="nn" aria-label="Mit Notiz">${ICON.note}</span>` : ""}</div></div>
  </div>`;
}
const firstName = () => (S.me?.display_name || "").trim().split(/\s+/)[0] || "dir";
// Abhaken: Kreis pulsiert, kleine Funken, Eintrag gleitet nach unten (FLIP), Toast mit „Rückgängig“
async function tick(id, btn) {
  const t = S.D.tasks.find((x) => x.id === id); if (!t || S.ticking?.[id]) return;
  const st = t.status === "done" ? "open" : "done";
  const prev = { ...t };
  // nachträglich abhaken (Aufgabe mit Uhrzeit): war zur Fälligkeit jemand anderes zuständig? → „Wer hat's gemacht?“
  let pick = null;
  if (st === "done" && t.due_date && t.due_time && t.senior_id) {
    const rp = respFor(t.senior_id, new Date(`${t.due_date}T${t.due_time}:00`).getTime());
    if (rp) { S.ticking = { ...(S.ticking || {}), [id]: true }; try { pick = await whoSheet(rp, t.senior_id, t.title, t.due_time); } finally { delete S.ticking[id]; } if (!pick) return; }
  }
  (S.ticking ||= {})[id] = true;
  try {
    if (st === "done" && btn && !reduceMotion()) {
      btn.classList.add("pulse"); btn.innerHTML = ICON.check + '<i class="spark" aria-hidden="true"><b></b><b></b><b></b><b></b><b></b><b></b></i>';
      btn.closest(".task")?.classList.add("ticking");
      await sleep(380);
    }
    const dk = pick?.by || { kind: "self" };
    Object.assign(t, { status: st, completed_by: st === "done" ? S.uid : null, completed_at: st === "done" ? new Date().toISOString() : null,
      done_by_kind: st === "done" && dk.kind !== "self" ? dk.kind : null, carer_contact_id: dk.carer_contact_id || null, done_by_user: dk.user_id || null });
    if ($(".sheet")) sheetRefresh?.(); renderBehind();
    const r = await call("task_status", { id, status: st, ...(pick ? { done_by: pick.by } : {}) });
    if (st === "done") {
      const nx = r.next || null;
      undoToast(prev.recurrence !== "none" ? `Erledigt – danke, ${firstName()}! Nächstes Mal ist eingeplant.` : `Erledigt – danke, ${firstName()}!`, async () => {
        const t2 = S.D.tasks.find((x) => x.id === id); if (t2) Object.assign(t2, { status: prev.status, completed_by: null, completed_at: null, recurrence: prev.recurrence });
        if (nx) S.D.tasks = S.D.tasks.filter((x) => x.id !== nx);
        if ($(".sheet")) sheetRefresh?.(); renderBehind();
        try { await call("task_status", { id, status: prev.status === "in_progress" ? "in_progress" : "open", undo_next: nx || undefined }); toast("Rückgängig gemacht"); } catch (e) { toast(e.message); }
        await reload().catch(() => {});
      }, 7000, doerChip("task", id, pick));
    }
    await reload();
  } catch (e) { Object.assign(t, prev); renderBehind(); toast(e.message); }
  finally { delete S.ticking[id]; }
}
function renderBehindFlip() { const f = flipFirst(); renderBehind(); if (f) flipPlay(f); }
function dynSheet(draw) {
  const o = openSheet("");
  const close = () => o.close();
  o.sh.addEventListener("sheetclose", () => { if (sheetRefresh === me) sheetRefresh = null; });
  const me = () => draw(o.sh, close);
  sheetRefresh = me;
  sheetRefresh();
  return close;
}
function taskSheet(id) {
  dynSheet((sh, close) => {
    const t = S.D.tasks.find((x) => x.id === id);
    if (!t) { close(); return false; }
    const top = sh; $$(":scope > :not(.grab)", sh).forEach((x) => x.remove()); const box = document.createElement("div"); box.className = "ts-top"; sh.appendChild(box);
    const ap = t.appointment_id && S.D.appts.find((a) => a.id === t.appointment_id);
    box.innerHTML = `
      <div class="sheet-head"><h2>${esc(t.title)}</h2>${t.senior_id ? sChip(t.senior_id) : ""}</div>
      <div class="seg status" role="group" aria-label="Status">${Object.entries(STATUS).map(([k, l]) => `<button data-st="${k}" class="${t.status === k ? "on " + k : ""}" aria-pressed="${t.status === k}">${l}</button>`).join("")}</div>
      ${t.status === "done" ? `<p class="done-line">✓ Erledigt von <b>${doerHtml(t, t.completed_by, { full: true })}</b> · ${rel(t.completed_at)}${enteredBy(t, t.completed_by) ? ` <small class="muted">(${enteredBy(t, t.completed_by)})</small>` : ""}${canDoer(t.completed_by) ? ` <button type="button" class="link small" data-doer="task:${t.id}">ändern</button>` : ""}</p>` : t.status === "in_progress" ? `<p class="ip-line">${esc(nm(t.started_by))} ${t.started_by === S.uid ? "kümmerst dich" : "kümmert sich"} gerade darum.</p>` : ""}
      <dl class="facts">
        <dt>Fällig</dt><dd>${t.due_date ? dayLabel(t.due_date, true) + (t.due_time ? ", " + t.due_time + " Uhr" : "") : '<span class="muted">Ohne Datum</span>'}</dd>
        <dt>Wiederholung</dt><dd>${REC[t.recurrence]}</dd>
        ${t.notes ? `<dt>Notiz</dt><dd class="pre">${esc(t.notes)}</dd>` : ""}
        ${ap ? `<dt>Termin</dt><dd><button class="link" data-appt="${ap.id}">${KINDS[ap.kind].e} ${esc(ap.title)} · ${dayLabel(isoDay(ap.starts_at))}, ${hm(ap.starts_at)}</button></dd>` : ""}
        <dt>Angelegt</dt><dd class="muted">von ${esc(nm(t.created_by))}, ${rel(t.created_at)}</dd>
      </dl>
      ${t.status !== "done" ? assignBox(t, "task") : ""}
      <div class="btns"><button class="btn ghost" id="t-edit">Bearbeiten</button><button class="btn ghost danger-t" id="t-del">Löschen</button></div>`;
    $$("[data-st]", top).forEach((b) => (b.onclick = () => { if (b.dataset.st === t.status) return; const st = b.dataset.st, prev = { ...t };
      Object.assign(t, { status: st, completed_by: st === "done" ? S.uid : null, completed_at: st === "done" ? new Date().toISOString() : null, started_by: st === "in_progress" ? S.uid : st === "open" ? null : t.started_by });
      sheetRefresh?.(); renderBehind();
      busy(null, async () => { const r = await call("task_status", { id, status: st }); if (st === "done") undoToast(prev.recurrence !== "none" ? "Erledigt – die nächste Wiederholung ist angelegt" : `Erledigt – danke, ${firstName()}!`, null, 7000, doerChip("task", id)); await reload(); if (r.next) { close(); taskSheet(r.next); } }).catch(() => { Object.assign(t, prev); sheetRefresh?.(); renderBehind(); }); }));
    bindAssign(top);
    $("#t-edit", top).onclick = () => { close(); taskForm(t); };
    $("#t-del", top).onclick = async () => { if (await confirmSheet("Aufgabe löschen?", `„${t.title}“ wird für alle gelöscht.`)) { close(); await busy(null, () => call("task_delete", { id })).catch(() => {}); await reload(); } };
    $$("[data-appt]", top).forEach((b) => (b.onclick = () => { close(); apptSheet(b.dataset.appt); }));
  });
}
function notesList(notes) {
  if (!notes.length) return `<p class="muted small">Noch keine Notizen.</p>`;
  return `<ul class="notes">${notes.map((n) => `<li>${ava(n.author_id, "xs")}<div><div class="pre">${esc(n.body)}</div><small class="muted">${esc(nm(n.author_id))} · ${rel(n.created_at)}${n.author_id === S.uid || isAdmin() ? ` · <button class="link" data-delnote="${n.id}">löschen</button>` : ""}</small></div></li>`).join("")}</ul>`;
}
function bindNotes(root) {
  $$("[data-delnote]", root).forEach((b) => (b.onclick = () => busy(null, async () => { await call("note_delete", { id: b.dataset.delnote }); await reload(); }).catch(() => {})));
}
function taskForm(t = {}, preset = {}) {
  t = { recurrence: "none", ...preset, ...t };
  const upcoming = S.D.appts.filter((a) => new Date(a.starts_at) > Date.now() - 864e5 || a.id === t.appointment_id);
  const { sh, close } = openSheet(`<h2>${t.id ? "Aufgabe bearbeiten" : "Neue Aufgabe"}</h2>
    <form id="tf" class="form">
      <label class="f" for="tf-title">Was ist zu tun?</label>
      <input class="inp" id="tf-title" name="title" required maxlength="120" value="${esc(t.title || "")}" placeholder="z. B. Medikament geben">
      ${t.id ? "" : `<div class="suggest">${TASK_SUGGEST.map((s) => `<button type="button" class="pill" data-sg="${esc(s)}">${esc(s)}</button>`).join("")}</div>`}
      <div class="grid2">
        <div><label class="f" for="tf-sen">Für wen?</label><select class="inp" id="tf-sen" name="senior_id">${seniorOptions(t.senior_id, "Allgemein")}</select></div>
        <div><label class="f" for="tf-as">Wer macht's?</label><select class="inp" id="tf-as" name="assignee_id">${memberOptions(t.assignee_id)}</select></div>
        <div><label class="f" for="tf-d">Fällig am</label><input class="inp" type="date" id="tf-d" name="due_date" value="${esc(t.due_date || "")}"></div>
        <div><label class="f" for="tf-t">Uhrzeit</label><input class="inp" type="time" id="tf-t" name="due_time" value="${esc(t.due_time || "")}"></div>
      </div>
      <label class="f">Wiederholen</label>
      <div class="seg small" id="tf-rec">${Object.entries(REC).map(([k, l]) => `<button type="button" data-rec="${k}" class="${t.recurrence === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <input type="hidden" name="recurrence" value="${t.recurrence}">
      ${upcoming.length ? `<label class="f" for="tf-ap">Mit Termin verknüpfen</label><select class="inp" id="tf-ap" name="appointment_id">${opt("", "Kein Termin", !t.appointment_id)}${upcoming.map((a) => opt(a.id, `${KINDS[a.kind].e} ${a.title} · ${dayLabel(isoDay(a.starts_at))} ${hm(a.starts_at)}`, a.id === t.appointment_id)).join("")}</select>` : ""}
      <label class="f" for="tf-n">Notiz (optional)</label><textarea class="inp" id="tf-n" name="notes" rows="2" maxlength="1000" placeholder="z. B. Rezept liegt im Flur">${esc(t.notes || "")}</textarea>
      <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">${t.id ? "Speichern" : "Aufgabe anlegen"}</button></div>
    </form>`);
  $$("[data-sg]", sh).forEach((b) => (b.onclick = () => { $("#tf-title", sh).value = b.dataset.sg; }));
  $$("[data-rec]", sh).forEach((b) => (b.onclick = () => { $$("[data-rec]", sh).forEach((x) => x.classList.toggle("on", x === b)); sh.querySelector('[name="recurrence"]').value = b.dataset.rec; if (b.dataset.rec !== "none" && !$("#tf-d", sh).value) $("#tf-d", sh).value = today(); }));
  $("#tf", sh).onsubmit = async (e) => {
    e.preventDefault(); const v = fd(e.target);
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("task_save", { ...v, id: t.id })).catch(() => null);
    if (!r) return; close(); toast(t.id ? "Gespeichert" : "Aufgabe angelegt"); await reload();
    if (!t.id && r.id) taskSheet(r.id);
  };
}

// ---------- Termine ----------
function apptRow(a) {
  const d = isoDay(a.starts_at);
  const c = a.contact_id ? contact(a.contact_id) : null, where = c ? c.org || c.name : a.location;
  const past = new Date(a.ends_at || a.starts_at) < Date.now() - 3600e3;
  return `<div class="appt ${!past && a.assignee_id === S.uid ? "mine" : ""}" data-appt="${a.id}" data-fk="a:${a.id}" role="button" tabindex="0">
    <span class="when"><b>${hm(a.starts_at)}</b><small>${dayLabel(d)}</small></span>
    <span class="a-body"><span class="a-title">${KINDS[a.kind].e} ${esc(a.title)}</span><span class="t-meta">${a.senior_id ? sChip(a.senior_id) : ""}${where ? `<span class="ell">${c ? "" : "📍 "}${esc(where)}</span>` : ""}</span>${past ? "" : `<span class="t-who">${whoTag(a, "appt")}</span>`}</span>
    <span class="chev">${ICON.chev}</span></div>`;
}
const upcomingAppts = () => S.D.appts.filter((a) => new Date(a.ends_at || a.starts_at) >= new Date(Date.now() - 3600e3)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
function apptSheet(id) {
  dynSheet((sh, close) => {
    const a = S.D.appts.find((x) => x.id === id); if (!a) { close(); return false; }
    const tasks = S.D.tasks.filter((t) => t.appointment_id === id), c = a.contact_id ? contact(a.contact_id) : null;
    $$(":scope > :not(.grab)", sh).forEach((x) => x.remove()); const top = document.createElement("div"); top.className = "ts-top"; sh.appendChild(top);
    top.innerHTML = `
      <div class="sheet-head"><span class="kind-badge">${KINDS[a.kind].e} ${KINDS[a.kind].n}</span><h2>${esc(a.title)}</h2></div>
      <dl class="facts">
        <dt>Wann</dt><dd>${dayLabel(isoDay(a.starts_at), true)}, ${hm(a.starts_at)}${a.ends_at ? "–" + hm(a.ends_at) : ""} Uhr</dd>
        ${a.senior_id ? `<dt>Für</dt><dd>${sChip(a.senior_id)}</dd>` : ""}
        ${a.location ? `<dt>Ort</dt><dd><a class="link" href="${mapsUrl(a.location)}" target="_blank" rel="noopener">${esc(a.location)}</a></dd>` : ""}
        ${a.notes ? `<dt>Notiz</dt><dd class="pre">${esc(a.notes)}</dd>` : ""}
        <dt>Eingetragen</dt><dd class="muted">von ${esc(nm(a.created_by))}</dd>
      </dl>
      ${new Date(a.ends_at || a.starts_at) >= Date.now() - 3600e3 ? assignBox(a, "appt") : a.assignee_id ? `<p class="muted small">Zuständig war ${esc(nm(a.assignee_id))}.</p>` : ""}
      ${c ? contactCard(c, a.location) : ""}
      ${a.senior_id && senior(a.senior_id) && (a.kind === "arzt" || c?.category === "arzt" || c?.category === "facharzt") ? `<button class="btn block soft rep-btn" id="a-rep">${ICON.report}<span>Bericht für diesen Termin (PDF)</span></button>` : ""}
      <h3 class="sec">Aufgaben zum Termin</h3>
      <div class="list">${tasks.map((t) => taskRow(t, { noSenior: true })).join("") || '<p class="muted small">Noch keine – z. B. „Fahrt organisieren“ oder „Begleitung“.</p>'}</div>
      <button class="btn block soft" id="a-task">${ICON.plus} Aufgabe zum Termin</button>
      <div class="btns"><button class="btn ghost" id="a-edit">Bearbeiten</button><button class="btn ghost danger-t" id="a-del">Löschen</button></div>`;
    bindTaskRows(top, close); bindAssign(top);
    $$("[data-contact]", top).forEach((b) => (b.onclick = () => { close(); contactSheet(b.dataset.contact); }));
    $("#a-task", top).onclick = () => { close(); taskForm({}, { appointment_id: a.id, senior_id: a.senior_id, due_date: isoDay(a.starts_at), title: a.kind === "arzt" ? `Begleitung: ${a.title}` : "" }); };
    $("#a-edit", top).onclick = () => { close(); apptForm(a); };
    if ($("#a-rep", top)) $("#a-rep", top).onclick = () => { close(); reportSheet(a.senior_id, a.id); };
    $("#a-del", top).onclick = async () => { if (await confirmSheet("Termin löschen?", `„${a.title}“ wird für alle gelöscht. Verknüpfte Aufgaben und der Kontakt bleiben erhalten.`)) { close(); await busy(null, () => call("appt_delete", { id })).catch(() => {}); await reload(); } };
  });
}
function apptForm(a = {}, preset = {}) {
  a = { kind: "arzt", ...preset, ...a };
  const d = a.starts_at ? isoDay(a.starts_at) : (preset.day || today());
  const { sh, close } = openSheet(`<h2>${a.id ? "Termin bearbeiten" : "Neuer Termin"}</h2>
    <form id="af" class="form">
      <label class="f">Art</label>
      <div class="seg small wrap" id="af-kind">${Object.entries(KINDS).map(([k, v]) => `<button type="button" data-k="${k}" class="${a.kind === k ? "on" : ""}">${v.e} ${v.n}</button>`).join("")}</div>
      <input type="hidden" name="kind" value="${a.kind}">
      <label class="f" for="af-title">Titel</label>
      <input class="inp" id="af-title" name="title" required maxlength="120" value="${esc(a.title || "")}" placeholder="z. B. Hausarzt Dr. Weber">
      <div class="grid2">
        <div><label class="f" for="af-sen">Für wen?</label><select class="inp" id="af-sen" name="senior_id">${seniorOptions(a.senior_id, "Allgemein")}</select></div>
        <div><label class="f" for="af-as">Wer kümmert sich?</label><select class="inp" id="af-as" name="assignee_id">${memberOptions(a.assignee_id)}</select></div>
      </div>
      <label class="f" for="af-d">Datum</label><input class="inp" type="date" id="af-d" name="day" required value="${d}">
      <div class="grid2">
        <div><label class="f" for="af-s">Von</label><input class="inp" type="time" id="af-s" name="start" required value="${a.starts_at ? hm(a.starts_at) : "10:00"}"></div>
        <div><label class="f" for="af-e">Bis (optional)</label><input class="inp" type="time" id="af-e" name="end" value="${a.ends_at ? hm(a.ends_at) : ""}"></div>
      </div>
      <label class="f" for="af-c">Kontakt (Arzt, Praxis …)</label>
      <div class="cpick"><select class="inp" id="af-c" name="contact_id">${contactOptions(a.contact_id)}</select><button type="button" class="btn soft cnew" id="af-cnew" aria-label="Neuen Kontakt anlegen">${ICON.plus}<span>Neu</span></button></div>
      <p class="muted small cp-hint" id="af-ch">${(S.D.contacts || []).length ? "Übernimmt Adresse und Name – im Termin dann direkt anrufen oder hinnavigieren." : "Lege Ärzte einmal an – danach einfach auswählen."}</p>
      <label class="f" for="af-loc">Ort (optional)</label><input class="inp" id="af-loc" name="location" maxlength="200" value="${esc(a.location || "")}" placeholder="z. B. Praxis, Hauptstr. 5">
      <label class="f" for="af-n">Notiz (optional)</label><textarea class="inp" id="af-n" name="notes" rows="2" maxlength="1000" placeholder="z. B. Versichertenkarte und Medikamentenplan mitnehmen">${esc(a.notes || "")}</textarea>
      <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">${a.id ? "Speichern" : "Termin eintragen"}</button></div>
    </form>`);
  $$("[data-k]", sh).forEach((b) => (b.onclick = () => { $$("[data-k]", sh).forEach((x) => x.classList.toggle("on", x === b)); sh.querySelector('[name="kind"]').value = b.dataset.k; }));
  // Kontakt wählen → Ort, Titel, Person und Art übernehmen (nur, was noch leer bzw. vom vorigen Kontakt übernommen ist)
  let lastFill = { loc: a.location || "", title: a.title || "" };
  const pick = (c) => {
    if (!c) return;
    const loc = $("#af-loc", sh), ti = $("#af-title", sh), se = $("#af-sen", sh);
    if (c.address && (!loc.value.trim() || loc.value === lastFill.loc)) loc.value = c.address.replace(/\s*\n\s*/g, ", ").slice(0, 200);
    if (!ti.value.trim() || ti.value === lastFill.title) ti.value = (c.org && /^dr\.?\s/i.test(c.name) ? c.name : c.org || c.name).slice(0, 120);
    if (c.senior_id && !se.value && senior(c.senior_id)) se.value = c.senior_id;
    if (!a.id) { const k = c.category === "arzt" || c.category === "facharzt" || c.category === "apotheke" ? "arzt" : c.category === "pflegedienst" ? "pflege" : null; if (k) $(`[data-k="${k}"]`, sh)?.click(); }
    lastFill = { loc: loc.value, title: ti.value };
  };
  $("#af-c", sh).onchange = (e) => pick(contact(e.target.value));
  $("#af-cnew", sh).onclick = () => contactForm({}, { senior_id: $("#af-sen", sh).value || null, category: "arzt" }, (c) => {
    const sel = $("#af-c", sh); if (!sel) return;
    sel.innerHTML = contactOptions(c.id); pick(c); toast(`${c.name} angelegt und ausgewählt`);
  });
  $("#af", sh).onsubmit = async (e) => {
    e.preventDefault(); const v = fd(e.target);
    const starts = new Date(`${v.day}T${v.start}`), ends = v.end ? new Date(`${v.day}T${v.end}`) : null;
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("appt_save", { id: a.id, title: v.title, kind: v.kind, senior_id: v.senior_id, starts_at: starts.toISOString(), ends_at: ends?.toISOString() ?? null, location: v.location, notes: v.notes, contact_id: v.contact_id || null, assignee_id: v.assignee_id || null })).catch(() => null);
    if (!r) return; close(); toast(a.id ? "Gespeichert" : "Termin eingetragen"); await reload();
    if (!a.id && r.id) apptSheet(r.id);
  };
}

// ---------- Medikamente ----------
// Einnahmen eines Tages aus den Uhrzeiten der Medikamente + eingetragenen Gaben (pf_med_doses)
function medDoses(day = today(), sid = null) {
  const out = [], now = Date.now();
  for (const med of S.D.meds || []) {
    if (sid && med.senior_id !== sid) continue;
    if (!sid && !inFocus(med.senior_id)) continue; // übernommen → nur die eigene(n) Person(en)
    for (const slot of med.times || []) {
      const sched = new Date(`${day}T${slot}:00`).getTime();
      const dose = (S.D.doses || []).find((d) => d.medication_id === med.id && d.day === day && d.slot === slot);
      const deadline = sched + MED_GRACE_MIN * 60000;
      const status = dose?.given_at ? "given" : dose?.missed_notified_at || (now > deadline && deadline > new Date(med.created_at).getTime()) ? "missed" : "open";
      out.push({ med, slot, day, sched, dose, status });
    }
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot) || a.med.name.localeCompare(b.med.name));
}
const medLabel = (m) => esc(m.name) + (m.dosage ? ` <span class="d-dos">${esc(m.dosage)}</span>` : "");
function doseRow(x, { noSenior } = {}) {
  const mine = x.dose?.given_by === S.uid, soon = x.sched - Date.now();
  const st = x.status === "given" ? (canDoer(x.dose.given_by) ? `<button type="button" class="d-st ok doer" data-doer="dose:${x.dose.id}" aria-label="Gegeben von ${esc(doerPlain(x.dose, x.dose.given_by))} – ändern">✓ ${doerHtml(x.dose, x.dose.given_by, { plain: true })} · ${hm(x.dose.given_at)}</button>` : `<span class="d-st ok">✓ ${doerHtml(x.dose, x.dose.given_by, { plain: true })} · ${hm(x.dose.given_at)}</span>`)
    : x.status === "missed" ? `<span class="d-st bad">Verpasst – noch nicht gegeben</span>`
    : `<span class="d-st">${soon > 0 && soon < 3 * 3600e3 ? `in ${soon < 3600e3 ? Math.round(soon / 60000) + " Min." : Math.round(soon / 3600e3) + " Std."}` : soon > 0 ? "Offen" : "Jetzt fällig"}</span>`;
  const btn = x.status === "given" ? (mine || isAdmin() ? `<button class="link small" data-undo="${x.dose.id}" aria-label="Gabe zurücknehmen">Zurück</button>` : "")
    : `<button class="btn small give" data-give="${x.med.id}|${x.day}|${x.slot}">${ICON.check} Gegeben</button>`;
  return `<div class="dose ${x.status}" data-fk="d:${x.med.id}|${x.slot}"><div class="d-time"><b>${x.slot}</b><small>Uhr</small></div>
    <div class="d-body"><b class="d-name">${medLabel(x.med)}</b>${noSenior || !multiSen() ? "" : `<span class="d-who">${sDot(x.med.senior_id)}</span>`}${st}</div>${btn}</div>`;
}
function bindDoses(root) {
  $$("[data-give]", root).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const [medication_id, day, slot] = b.dataset.give.split("|");
    // nachträglich: war zur Fälligkeit jemand anderes zuständig (Pflegedienst-Einsatz / Übernahme)? → erst fragen, wer es gemacht hat
    const med = (S.D.meds || []).find((m) => m.id === medication_id), rp = med && respFor(med.senior_id, new Date(`${day}T${slot}:00`).getTime());
    let pick = null;
    if (rp) { pick = await whoSheet(rp, med.senior_id, med.name, slot); if (!pick) return; }
    const r = await busy(b, () => call("dose_give", { medication_id, day, slot, ...(pick ? { done_by: pick.by } : {}) })).catch(() => null);
    if (r?.dose) { S.D.doses = S.D.doses.filter((d) => d.id !== r.dose.id).concat(r.dose); undoToast("Als gegeben eingetragen", null, 7000, doerChip("dose", r.dose.id, pick)); render(true); }
    reload().catch(() => {});
  }));
  $$("[data-undo]", root).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    if (!(await confirmSheet("Gabe zurücknehmen?", "Die Einnahme gilt dann wieder als offen.", "Zurücknehmen", false))) return;
    await busy(null, () => call("dose_undo", { id: b.dataset.undo })).catch(() => {}); await reload();
  }));
  $$("[data-med]", root).forEach((b) => (b.onclick = () => medForm((S.D.meds || []).find((m) => m.id === b.dataset.med))));
}
function medForm(m, preset = {}) {
  m = m || { senior_id: preset.senior_id || visSen()[0]?.id, times: ["08:00"] };
  let times = [...m.times];
  const { sh, close } = openSheet(`<h2>${m.id ? "Medikament bearbeiten" : "Medikament hinzufügen"}</h2>
    <form id="mf" class="form">
      <label class="f" for="mf-n">Medikament</label><input class="inp" id="mf-n" name="name" required maxlength="80" value="${esc(m.name || "")}" placeholder="z. B. Ramipril">
      <label class="f" for="mf-d">Dosierung (optional)</label><input class="inp" id="mf-d" name="dosage" maxlength="80" value="${esc(m.dosage || "")}" placeholder="z. B. 5 mg · 1 Tablette">
      <label class="f" for="mf-s">Für</label><select class="inp" id="mf-s" name="senior_id" required>${(m.id ? S.D.seniors : visSen()).map((s) => `<option value="${s.id}" ${s.id === m.senior_id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      <label class="f">Uhrzeiten (täglich)</label><div class="times" id="mf-t"></div>
      <button type="button" class="btn soft small" id="mf-add">${ICON.plus} Uhrzeit</button>
      <label class="f" for="mf-x">Hinweis (optional)</label><input class="inp" id="mf-x" name="notes" maxlength="500" value="${esc(m.notes || "")}" placeholder="z. B. mit Essen, liegt in der Wochenbox">
      <p class="hint small">Wird eine Einnahme ${MED_GRACE_MIN} Min. nach der Uhrzeit nicht als gegeben markiert, erscheint ein Hinweis im Tagebuch und es gibt eine Push-Nachricht.</p>
      <p class="err" id="mf-e"></p>
      <div class="btns">${m.id ? `<button type="button" class="btn ghost danger-t" id="mf-del">Löschen</button>` : `<button type="button" class="btn ghost" data-close>Abbrechen</button>`}<button class="btn" type="submit">Speichern</button></div>
    </form>`);
  const drawT = () => {
    $("#mf-t", sh).innerHTML = times.map((t, i) => `<span class="tm"><input class="inp" type="time" value="${t}" data-i="${i}" aria-label="Uhrzeit ${i + 1}" required>${times.length > 1 ? `<button type="button" class="x" data-rm="${i}" aria-label="Uhrzeit entfernen">×</button>` : ""}</span>`).join("");
    $$("#mf-t input", sh).forEach((x) => (x.onchange = () => (times[x.dataset.i] = x.value)));
    $$("#mf-t [data-rm]", sh).forEach((x) => (x.onclick = () => { times.splice(Number(x.dataset.rm), 1); drawT(); }));
  };
  drawT();
  $("#mf-add", sh).onclick = () => { if (times.length < 8) { times.push(times.length ? "20:00" : "08:00"); drawT(); } };
  $("#mf", sh).onsubmit = async (e) => {
    e.preventDefault(); const v = fd(e.target);
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("med_save", { id: m.id, ...v, times: times.filter(Boolean) })).catch((er) => { $("#mf-e", sh).textContent = er.message; return null; });
    if (r) { close(); toast("Gespeichert"); await reload(); }
  };
  if ($("#mf-del", sh)) $("#mf-del", sh).onclick = async () => { if (await confirmSheet(`${m.name} löschen?`, "Das Medikament und seine eingetragenen Gaben werden entfernt.")) { close(); await busy(null, () => call("med_delete", { id: m.id })).catch(() => {}); await reload(); } };
}
function medList(sid, withName = null) {
  const ms = (S.D.meds || []).filter((m) => m.senior_id === sid);
  return `<section><div class="sec-h">${withName ? `<h2 class="hi">${sAva(withName, "sm")}<span>${esc(withName.name)}</span></h2>` : h2i("med", "Medikamentenplan")}</div>
    ${ms.length ? `<div class="list">${ms.map((m) => `<button class="med" data-med="${m.id}">${sico("med", "lg")}<span class="m-b"><b>${medLabel(m)}</b><span class="m-times">${m.times.map((t) => `<i>${t}</i>`).join("")}</span>${m.notes ? `<small class="muted">${esc(m.notes)}</small>` : ""}</span><span class="chev">${ICON.chev}</span></button>`).join("")}</div>` : '<p class="muted small">Noch keine Medikamente eingetragen.</p>'}
    <button class="btn block soft" data-act="new-med" data-sid="${sid}">${ICON.plus} Medikament</button></section>`;
}
// Vollständiger Tagesablauf: alle Einnahmen von heute chronologisch – gegeben (wer, wann), offen, verpasst
function dayList(sid = null) {
  const ds = medDoses(today(), sid); if (!ds.length) return "";
  const out = []; let last = -1;
  for (const x of ds) {
    const h = Number(x.slot.slice(0, 2)), part = h < 11 ? 0 : h < 14 ? 1 : h < 18 ? 2 : 3;
    if (part !== last) { out.push(`<h3 class="grp dpart">${["Morgens", "Mittags", "Nachmittags", "Abends"][part]}</h3>`); last = part; }
    out.push(doseRow(x, { noSenior: !!sid }));
  }
  return `<section class="daylist" id="daylist"><div class="sec-h">${h2i("med", "Tagesablauf heute")}<span class="muted small">${ds.length} ${ds.length === 1 ? "Einnahme" : "Einnahmen"}</span></div><div class="list">${out.join("")}</div></section>`;
}
// Kreisdiagramm (Entwurf mock_03): gegeben / geplant
function ringSvg(done, total, size, ok, stroke, key = "") {
  const r = (size - stroke) / 2 - 1, c = 2 * Math.PI * r, f = total ? Math.min(1, done / total) : 0, col = ok ? "#2D7350" : "#D23C47";
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${ok ? "rgba(45,115,80,.16)" : "rgba(210,60,71,.14)"}" stroke-width="${stroke}"/><circle class="rv" ${key ? `data-rk="${key}"` : ""} cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round" style="stroke-dasharray:${(c * f).toFixed(1)} ${c.toFixed(1)}"/></svg>`;
}
const medStats = (ds) => ({ total: ds.length, given: ds.filter((x) => x.status === "given").length, missed: ds.filter((x) => x.status === "missed").length });
const openDoses = (ds) => ds.filter((x) => x.status !== "given").sort((a, b) => (a.status === "missed" ? 0 : 1) - (b.status === "missed" ? 0 : 1) || a.slot.localeCompare(b.slot));
// Nächste Einnahme morgen (für „Morgen um 08:00 geht es weiter“)
const firstSlotTomorrow = (sid) => { const xs = (S.D.meds || []).filter((m) => !sid || m.senior_id === sid).flatMap((m) => m.times || []).sort(); return xs[0] || ""; };
// Mini-Kachel auf der Startseite (Ring + nächste Einnahme + „Gegeben“)
function medMini(sid = null) {
  const ds = medDoses(today(), sid); if (!ds.length) return "";
  const st = medStats(ds), ok = st.given === st.total, nx = openDoses(ds)[0], key = "mini" + (sid || "");
  return `<section class="medmini ${ok ? "ok" : ""} ${st.missed ? "bad" : ""}" data-go="#/medikamente" role="link" tabindex="0" aria-label="Medikamente: ${st.given} von ${st.total} gegeben">
    <div class="ring sm">${ringSvg(st.given, st.total, 64, ok, 7, key)}<div class="ring-c">${ok ? `<span class="okc">${ICON.check}</span>` : `<b>${st.given}</b><small>/${st.total}</small>`}</div></div>
    <div class="mm-b"><b>Medikamente</b>${ok ? `<small class="ok-t">Alle ${st.total} für heute gegeben ✓</small>` : `<small class="${nx.status === "missed" ? "danger-t" : ""}">${nx.status === "missed" ? "Verpasst" : "Nächste"}: <b>${nx.slot}</b> ${esc(nx.med.name)}${!sid && multiSen() ? " · " + esc(senior(nx.med.senior_id)?.name || "") : ""}</small>`}</div>
    ${ok ? `<span class="chev">${ICON.chev}</span>` : `<button class="btn small give" data-give="${nx.med.id}|${nx.day}|${nx.slot}">${ICON.check} Gegeben</button>`}</section>`;
}
// Große Ring-Kachel (Seite „Medikamente“ und Person › Medikamente)
function ringTile(sid = null, { summary = false } = {}) {
  const ds = medDoses(today(), sid); if (!ds.length) return "";
  const st = medStats(ds), ok = st.given === st.total, open = openDoses(ds), key = "big" + (sid || "");
  const per = sid ? [] : visSen().map((s) => ({ s, ...medStats(medDoses(today(), s.id)) })).filter((x) => x.total);
  const tm = firstSlotTomorrow(sid);
  return `<section class="ringtile ${ok ? "ok" : ""}">
    <div class="rt-top"><div class="ring">${ringSvg(st.given, st.total, 132, ok, 12, key)}<div class="ring-c">${ok ? `<span class="okc big">${ICON.check}</span><small>alles gegeben</small>` : `<b>${st.given}<span>/${st.total}</span></b><small>gegeben</small>`}</div></div>
      <div class="rside"><h2>${ok ? "Alles gegeben" : st.missed ? `${st.missed} verpasst` : `Noch ${st.total - st.given} offen`}</h2>
        ${per.length > 1 ? `<div class="minis">${per.map((x) => `<div class="mini">${sAva(x.s, "xs")}<span class="bar"><i style="width:${Math.round((x.given / x.total) * 100)}%;background:${sTone(x.s).c}"></i></span><small>${x.given}/${x.total}</small></div>`).join("")}</div>` : `<p class="muted small">${st.given} von ${st.total} Einnahmen heute</p>`}</div></div>
    ${summary ? (ok ? `<p class="okmsg">🌿 Danke euch!${tm ? ` Morgen um ${tm} Uhr geht es weiter.` : ""}</p>` : "") : ok ? `<p class="okmsg">🌿 Danke euch!${tm ? ` Morgen um ${tm} Uhr geht es weiter.` : ""}</p>` : `<div class="nextd-list">${open.map((x) => `<div class="nextd ${x.status}" data-fk="d:${x.med.id}|${x.slot}"><span class="nt"><b>${x.slot}</b><small>${x.status === "missed" ? "verpasst" : "Uhr"}</small></span><span class="nb"><b>${medLabel(x.med)}</b>${sid ? "" : sChip(x.med.senior_id)}</span><button class="btn small give" data-give="${x.med.id}|${x.day}|${x.slot}">${ICON.check} Gegeben</button></div>`).join("")}</div>`}
    ${st.given && !summary ? `<details class="gdone-l"${ok ? " open" : ""}><summary>Gegeben (${st.given})</summary>${ds.filter((x) => x.status === "given").map((x) => `<div class="gdone">${ICON.check}<span><b>${x.slot}</b> ${esc(x.med.name)}${sid ? "" : " · " + esc(senior(x.med.senior_id)?.name || "")}<small> – ${doerHtml(x.dose, x.dose.given_by, { plain: true })}, ${hm(x.dose.given_at)}</small></span>${x.dose.given_by === S.uid || isAdmin() ? `<button class="link small" data-undo="${x.dose.id}" aria-label="Gabe zurücknehmen">Zurück</button>` : ""}</div>`).join("")}</details>` : ""}
  </section>`;
}
function pageMeds() {
  const has = (S.D.meds || []).length;
  return `<a href="#/" class="back">${ICON.back} Heute</a><div class="page-h"><h1>Medikamente</h1><p class="muted">${new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</p></div>
    ${ringTile(null, { summary: true }) || emptyBox("med", has ? "Heute sind keine Einnahmen geplant." : "Noch keine Medikamente eingetragen.")}
    ${dayList()}
    ${visSen().map((s) => medList(s.id, s)).join("") || `<div class="card empty"><p>Lege zuerst eine Person an.</p><button class="btn" data-act="add-senior">Person anlegen</button></div>`}${fabCtx("new-med-any", "Medikament")}`;
}
// ---------- Werte: Blutdruck, Blutzucker, Gewicht, Temperatur, Sauerstoff ----------
// Nur zum Festhalten für die Familie – neutrale Einordnung „im Zielbereich“ / „darüber“ / „darunter“, keine Diagnosen.
const VK = {
  bp: { n: "Blutdruck", u: "mmHg", i: "vit" }, glucose: { n: "Blutzucker", u: "mg/dl", i: "drop" },
  weight: { n: "Gewicht", u: "kg", i: "scale", d: 1 }, temp: { n: "Temperatur", u: "°C", i: "thermo", d: 1 }, spo2: { n: "Sauerstoff", u: "% SpO₂", i: "o2" },
};
const VORDER = ["bp", "glucose", "weight", "temp", "spo2"];
const GCTX = { fasting: "nüchtern", before_meal: "vor dem Essen", after_meal: "nach dem Essen", bedtime: "vor dem Schlafen", other: "sonstiges" };
const VDEF = { bp_sys: [90, 140], bp_dia: [60, 90], pulse: [50, 100], glu_pre: [70, 130], glu_post: [70, 180], temp: [36, 37.5], spo2: [94, 100] };
const VTK = { bp_sys: "Blutdruck oben (systolisch)", bp_dia: "Blutdruck unten (diastolisch)", pulse: "Puls", glu_pre: "Zucker nüchtern / vor dem Essen", glu_post: "Zucker nach dem Essen / abends", weight: "Gewicht", temp: "Temperatur", spo2: "Sauerstoff (SpO₂)" };
const VTR = { bp_sys: [60, 250], bp_dia: [30, 150], pulse: [25, 230], glu_pre: [20, 600], glu_post: [20, 600], weight: [20, 300], temp: [33, 43], spo2: [50, 100] };
const MMOL = 18.016;
const vTargets = (sid) => ({ ...VDEF, ...(senior(sid)?.vital_targets || {}) });
const gluMmol = () => localStorage.getItem("pf-glu-unit") === "mmol";
const gluU = () => (gluMmol() ? "mmol/l" : "mg/dl");
const gluShow = (mg) => (gluMmol() ? fmtN(mg / MMOL, 1) : fmtN(mg, 0));
const fmtN = (n, d = 0) => Number(n).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
const vSid = () => (S.vSen && senior(S.vSen) && inFocus(S.vSen) ? S.vSen : visSen()[0]?.id || "");
const vOf = (sid, kind) => (S.D.vitals || []).filter((v) => v.senior_id === sid && v.kind === kind).sort((a, b) => b.measured_at.localeCompare(a.measured_at));
const vUnit = (k) => (k === "glucose" ? gluU() : VK[k].u);
const vMain = (v) => v.kind === "bp" ? `${fmtN(v.v1)}/${fmtN(v.v2)}` : v.kind === "glucose" ? gluShow(v.v1) : fmtN(v.v1, VK[v.kind].d || 0);
const vText = (v) => `${vMain(v)} ${vUnit(v.kind)}${v.pulse ? ` · Puls ${v.pulse}` : ""}${v.kind === "glucose" && v.context ? ` · ${GCTX[v.context]}` : ""}`;
const gluKey = (ctx) => (ctx === "fasting" || ctx === "before_meal" ? "glu_pre" : "glu_post");
// Einordnung gegen die Zielbereiche: "in" | "hi" | "lo" | "" (kein Zielbereich)
function vClass(v) {
  const T = vTargets(v.senior_id), cmp = (x, r) => (!r || x == null ? null : x > r[1] ? "hi" : x < r[0] ? "lo" : "in");
  const xs = v.kind === "bp" ? [cmp(v.v1, T.bp_sys), cmp(v.v2, T.bp_dia)] : v.kind === "glucose" ? [cmp(v.v1, T[gluKey(v.context)])] : [cmp(v.v1, T[v.kind])];
  const ys = xs.filter(Boolean);
  return !ys.length ? "" : ys.includes("hi") ? "hi" : ys.includes("lo") ? "lo" : "in";
}
const VCL = { in: "im Zielbereich", hi: "über dem Zielbereich", lo: "unter dem Zielbereich" };
const vPill = (c) => (c ? `<span class="vpill ${c}">${c === "in" ? ICON.check : c === "hi" ? "↑" : "↓"} ${VCL[c]}</span>` : "");
const vWhen = (iso) => { const d = isoDay(iso), t = today(); return `${d === t ? "heute" : d === addDays(t, -1) ? "gestern" : parseD(d).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" })}, ${hm(iso)}`; };
const vWho = (id) => (id === S.uid ? "du" : id ? nmPlain(id) : "");
const vIco = (k, size = "") => `<span class="sico k-vit ${size}" aria-hidden="true">${ICON[VK[k].i]}</span>`;
// Zielbereich als y-Intervall der Diagramme (Zucker: nüchtern-Band, nach dem Essen als gestrichelte Obergrenze)
function vBands(sid, kind) {
  const T = vTargets(sid);
  if (kind === "bp") return [T.bp_sys, T.bp_dia].filter(Boolean);
  if (kind === "glucose") return [T.glu_pre].filter(Boolean);
  return [T[kind]].filter(Boolean);
}
const vConv = (kind, y) => (kind === "glucose" && gluMmol() ? y / MMOL : y);
// SVG-Liniendiagramm: Punkte über die Zeit, Zielbereich als sanftes Band
function vChart(sid, kind, days, { w = 340, h = 170, spark = false } = {}) {
  const since = Date.now() - days * 864e5, xs = vOf(sid, kind).filter((v) => new Date(v.measured_at).getTime() >= since).reverse();
  const bands = vBands(sid, kind).map((b) => b.map((y) => vConv(kind, y))), post = kind === "glucose" ? vTargets(sid).glu_post : null;
  const series = kind === "bp" ? [xs.map((v) => [v, v.v1]), xs.map((v) => [v, v.v2])] : [xs.map((v) => [v, vConv(kind, Number(v.v1))])];
  const ys = series.flat().map((p) => p[1]).concat(spark ? [] : bands.flat()).concat(post && !spark ? [vConv(kind, post[1])] : []);
  if (!xs.length) return spark ? `<svg class="vspark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="M2 ${h / 2}H${w - 2}" class="sp-empty"/></svg>` : `<div class="vchart-empty muted small">In diesem Zeitraum wurde nichts eingetragen.</div>`;
  let lo = Math.min(...ys), hi = Math.max(...ys); const padY = Math.max((hi - lo) * 0.12, kind === "temp" ? 0.2 : kind === "weight" ? 0.5 : 3); lo -= padY; hi += padY;
  const L = spark ? 2 : 34, R = spark ? 2 : 8, Tp = spark ? 3 : 10, B = spark ? 3 : 24;
  const t0 = spark ? new Date(xs[0].measured_at).getTime() : since, t1 = Date.now();
  const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (w - L - R), Y = (y) => Tp + (1 - (y - lo) / (hi - lo)) * (h - Tp - B);
  let g = "";
  for (const b of bands) g += `<rect class="vband" x="${L}" y="${Y(Math.min(hi, b[1])).toFixed(1)}" width="${w - L - R}" height="${Math.max(0, Y(Math.max(lo, b[0])) - Y(Math.min(hi, b[1]))).toFixed(1)}" rx="3"/>`;
  if (post && !spark) g += `<path class="vpost" d="M${L} ${Y(vConv(kind, post[1])).toFixed(1)}H${w - R}"/>`;
  if (!spark) {
    const fmtY = (y) => fmtN(y, kind === "temp" || (kind === "glucose" && gluMmol()) || kind === "weight" ? 1 : 0);
    for (let i = 0; i <= 3; i++) { const y = lo + ((hi - lo) * i) / 3; g += `<text class="vax" x="${L - 6}" y="${(Y(y) + 4).toFixed(1)}" text-anchor="end">${fmtY(y)}</text><path class="vgl" d="M${L} ${Y(y).toFixed(1)}H${w - R}"/>`; }
    const ticks = days <= 7 ? 7 : 4;
    for (let i = 0; i <= ticks; i++) { if (days <= 7 && i === 0) continue; const t = t0 + ((t1 - t0) * i) / ticks, d = new Date(t); g += `<text class="vax" x="${X(t).toFixed(1)}" y="${h - 6}" text-anchor="${i === ticks ? "end" : "middle"}">${days <= 7 ? d.toLocaleDateString("de-DE", { weekday: "short" }) : d.toLocaleDateString("de-DE", { day: "numeric", month: "numeric" })}</text>`; }
  }
  series.forEach((pts, si) => {
    const d = pts.map(([v, y], i) => `${i ? "L" : "M"}${X(new Date(v.measured_at).getTime()).toFixed(1)} ${Y(y).toFixed(1)}`).join("");
    g += `<path class="vline ${si ? "l2" : ""}" d="${d}"/>`;
    if (!spark || pts.length < 40) g += pts.map(([v, y]) => { const c = vClass(v); return `<circle class="vdot ${si ? "l2" : ""} ${c !== "in" && c ? "out" : ""}" cx="${X(new Date(v.measured_at).getTime()).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="${spark ? 1.6 : pts.length > 60 ? 2.2 : 3.2}"/>`; }).join("");
  });
  return `<svg class="${spark ? "vspark" : "vchart"}" viewBox="0 0 ${w} ${h}" ${spark ? 'aria-hidden="true"' : `role="img" aria-label="${esc(VK[kind].n)}: ${xs.length} Messungen in ${days} Tagen"`} preserveAspectRatio="none">${g}</svg>`;
}
function vTile(sid, kind, big) {
  const xs = vOf(sid, kind), v = xs[0], c = v ? vClass(v) : "";
  if (!v) return `<button class="vtile ${big ? "big" : ""} empty" data-act="new-vital" data-sid="${sid}" data-kind="${kind}"><span class="vt-h">${vIco(kind, big ? "" : "sm")}<b>${VK[kind].n}</b></span><span class="vt-e muted small">${ICON.plus} Ersten Wert eintragen</span></button>`;
  const n7 = xs.filter((x) => new Date(x.measured_at).getTime() > Date.now() - 7 * 864e5).length;
  return `<button class="vtile ${big ? "big" : ""} st-${c || "none"}" data-vital="${kind}" data-sid="${sid}" aria-label="${esc(VK[kind].n)}: ${esc(vText(v))}, ${esc(vWhen(v.measured_at))}${c ? ", " + VCL[c] : ""} – Verlauf öffnen">
    <span class="vt-h">${vIco(kind, big ? "" : "sm")}<b>${VK[kind].n}</b>${big ? `<span class="chev">${ICON.chev}</span>` : ""}</span>
    <span class="vt-v"><b>${vMain(v)}</b><small>${vUnit(kind)}</small></span>
    ${big ? `<span class="vt-x">${v.pulse ? `Puls ${v.pulse}` : ""}${v.kind === "glucose" && v.context ? GCTX[v.context] : ""}</span>${vPill(c)}` : c && c !== "in" ? vPill(c) : ""}
    ${big ? vChart(sid, kind, 14, { w: 150, h: 34, spark: true }) : ""}
    <span class="vt-m">${esc(vWhen(v.measured_at))}${v.created_by ? ` · ${isCarer(v) ? "Pflegedienst" : esc(vWho(doerUid(v, v.created_by)))}` : ""}${big && n7 > 1 ? ` · ${n7}× in 7 Tagen` : ""}</span></button>`;
}
const VNOTE = `<p class="vnote">${ICON.shield}<span>Zum Festhalten und Teilen in der Familie. Die Einordnung richtet sich nur nach euren Zielbereichen – <b>kein Ersatz für ärztlichen Rat</b>. Bei Beschwerden bitte Arzt oder Notruf 112.</span></p>`;
function pageVitals() {
  if (!S.D.seniors.length) return `<div class="page-h"><h1 class="hi">${sico("vit")}<span>Werte</span></h1></div><div class="card empty">${sico("care", "lg c")}<h3>Für wen sorgt ihr?</h3><p class="muted">Lege zuerst eine Person an, dann könnt ihr Blutdruck, Zucker und mehr eintragen.</p><button class="btn" data-act="add-senior">Person anlegen</button></div>`;
  const sid = vSid(), s = senior(sid);
  const pchips = visSen().length > 1 ? `<div class="pchips" role="group" aria-label="Für wen?">${visSen().map((x) => `<button class="pchip ${sid === x.id ? "on" : ""}" data-vs="${x.id}" aria-pressed="${sid === x.id}" style="--pc:${sTone(x).c};--ps:${sTone(x).s};--pd:${sTone(x).d}">${sAva(x, "sm")}${esc(x.name)}</button>`).join("")}</div>` : "";
  const glu = vOf(sid, "glucose").filter((v) => isoDay(v.measured_at) === today());
  return `<div class="page-h"><h1 class="hi">${sico("vit")}<span>Werte</span></h1><p class="muted small">Blutdruck, Blutzucker und mehr – wer hat wann gemessen</p></div>${focusHint()}${pchips}
    <div class="vgrid big">${vTile(sid, "bp", true)}${vTile(sid, "glucose", true)}</div>
    ${glu.length ? `<div class="vday card"><span class="muted small">Zucker heute</span>${glu.slice().reverse().map((v) => `<span class="vchip st-${vClass(v) || "none"}"><b>${gluShow(v.v1)}</b><small>${hm(v.measured_at)} · ${GCTX[v.context || "other"]}</small></span>`).join("")}</div>` : ""}
    <div class="vgrid sm">${vTile(sid, "weight")}${vTile(sid, "temp")}${vTile(sid, "spo2")}</div>
    <button class="btn block" data-act="new-vital" data-sid="${sid}">${ICON.plus} Wert eintragen</button>
    <button class="btn block soft rep-btn" data-act="report" data-sid="${sid}">${ICON.report}<span>Arzt-Bericht als PDF</span></button>
    <div class="vlinks"><button class="link small" data-act="vtargets" data-sid="${sid}">${ICON.sliders} Zielbereiche für ${esc(s.name)}</button><button class="link small" data-act="glu-unit">Zucker in ${gluU()}</button></div>
    ${VNOTE}${fabCtx("new-vital", "Messen", sid)}`;
}
function vitalSheet(sid, kind) {
  S.vRange = S.vRange || 30;
  dynSheet((sh) => {
    $$(":scope > :not(.grab)", sh).forEach((x) => x.remove());
    const days = S.vRange, all = vOf(sid, kind), xs = all.filter((v) => new Date(v.measured_at).getTime() >= Date.now() - days * 864e5);
    const cl = xs.map(vClass).filter(Boolean), inn = cl.filter((c) => c === "in").length;
    const avg = (f) => xs.length ? xs.reduce((a, v) => a + Number(f(v)), 0) / xs.length : 0;
    const avgTxt = !xs.length ? "–" : kind === "bp" ? `${fmtN(avg((v) => v.v1))}/${fmtN(avg((v) => v.v2))}` : kind === "glucose" ? gluShow(avg((v) => v.v1)) : fmtN(avg((v) => v.v1), VK[kind].d || 0);
    const T = vTargets(sid), tgt = kind === "bp" ? (T.bp_sys && T.bp_dia ? `${T.bp_sys[0]}–${T.bp_sys[1]} / ${T.bp_dia[0]}–${T.bp_dia[1]}` : "") : kind === "glucose" ? [T.glu_pre && `nüchtern ${gluShow(T.glu_pre[0])}–${gluShow(T.glu_pre[1])}`, T.glu_post && `nach dem Essen bis ${gluShow(T.glu_post[1])}`].filter(Boolean).join(" · ") : T[kind] ? `${fmtN(T[kind][0], VK[kind].d || 0)}–${fmtN(T[kind][1], VK[kind].d || 0)}` : "";
    let lastD = "";
    const rows = xs.map((v) => { const d = isoDay(v.measured_at), hd = d !== lastD ? `<h3 class="grp vdh">${esc(dayLabel(d, true))}</h3>` : ""; lastD = d; const c = vClass(v), can = v.created_by === S.uid || isAdmin();
      return `${hd}<div class="vrow st-${c || "none"}" ${can ? `data-vedit="${v.id}" role="button" tabindex="0"` : ""}><time>${hm(v.measured_at)}</time><span class="vr-b"><b>${vMain(v)} <small>${vUnit(kind)}</small></b><small class="muted">${[v.pulse ? `Puls ${v.pulse}` : "", kind === "glucose" ? GCTX[v.context || "other"] : "", isCarer(v) ? carerTag(v) : esc(vWho(doerUid(v, v.created_by))), v.note ? esc(v.note) : ""].filter(Boolean).join(" · ")}</small></span>${c ? `<i class="vdot-l ${c}" title="${VCL[c]}"></i>` : ""}${can ? `<span class="chev">${ICON.chev}</span>` : ""}</div>`; });
    const box = document.createElement("div"); box.className = "vsheet";
    box.innerHTML = `<div class="sheet-head row">${vIco(kind)}<div><h2>${VK[kind].n}</h2><p class="muted small">${esc(senior(sid)?.name || "")} · ${vUnit(kind)}</p></div></div>
      <div class="seg small" role="group" aria-label="Zeitraum">${[7, 30, 90].map((d) => `<button data-vr="${d}" class="${d === days ? "on" : ""}" aria-pressed="${d === days}">${d} Tage</button>`).join("")}</div>
      <div class="card vchart-c">${vChart(sid, kind, days)}${kind === "bp" ? `<p class="vleg"><i class="l1"></i>oben (systolisch) <i class="l2"></i>unten (diastolisch) <i class="bd"></i>Zielbereich</p>` : kind === "glucose" ? `<p class="vleg"><i class="l1"></i>Messwert <i class="bd"></i>Ziel nüchtern <i class="dash"></i>Grenze nach dem Essen</p>` : `<p class="vleg"><i class="l1"></i>Messwert${tgt ? ` <i class="bd"></i>Zielbereich` : ""}</p>`}</div>
      <div class="vstats"><span><small>Messungen</small><b>${xs.length}</b></span><span><small>Durchschnitt</small><b>${avgTxt}</b></span>${cl.length ? `<span><small>im Zielbereich</small><b>${inn} von ${cl.length}</b></span>` : ""}</div>
      ${tgt ? `<p class="muted small">Zielbereich: ${tgt} ${kind === "bp" ? "mmHg" : kind === "glucose" ? gluU() : ""} · <button class="link small" data-vt>anpassen</button></p>` : `<p class="muted small"><button class="link small" data-vt>Zielbereich festlegen</button></p>`}
      <div class="btns"><button class="btn" data-vadd>${ICON.plus} ${VK[kind].n} eintragen</button></div>
      <section><div class="sec-h"><h2>Einträge</h2><span class="muted small">${days} Tage</span></div><div class="list vlist">${rows.length ? more(rows, 25) : `<p class="muted small">Noch keine Einträge in diesem Zeitraum.</p>`}</div></section>
      ${VNOTE}<div class="btns"><button class="btn ghost" data-close>Schließen</button></div>`;
    sh.appendChild(box);
    $$("[data-vr]", box).forEach((b) => (b.onclick = () => { S.vRange = Number(b.dataset.vr); sheetRefresh?.(); }));
    $$("[data-vedit]", box).forEach((b) => (b.onclick = () => vitalForm((S.D.vitals || []).find((v) => v.id === b.dataset.vedit))));
    $("[data-vadd]", box).onclick = () => vitalForm(null, { senior_id: sid, kind });
    $("[data-vt]", box).onclick = () => vTargetsForm(sid);
    $$("[data-close]", box).forEach((b) => (b.onclick = () => sh.__close()));
  });
}
const localDT = (iso) => { const d = iso ? new Date(iso) : new Date(); return [ymd(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`]; };
function vitalForm(v, preset = {}) {
  v = v || { senior_id: preset.senior_id || vSid(), kind: preset.kind || S.vLastKind || "bp", context: "" };
  if (!senior(v.senior_id)) v.senior_id = visSen()[0]?.id;
  let kind = v.kind;
  const [d0, t0] = localDT(v.measured_at), mm = gluMmol();
  const hr = new Date().getHours(), ctx0 = v.context || (hr < 10 ? "fasting" : hr >= 21 ? "bedtime" : "");
  const own = !v.id || v.created_by === S.uid || isAdmin();
  const { sh, close } = openSheet(`<h2>${v.id ? "Messwert bearbeiten" : "Wert eintragen"}</h2>
    <form id="vf" class="form" novalidate>
      ${v.id ? "" : `<label class="f">Was wurde gemessen?</label>
      <div class="seg small wrap vkinds" id="vf-k" role="group" aria-label="Messart">${VORDER.map((k) => `<button type="button" data-vk="${k}" class="${k === kind ? "on" : ""}" aria-pressed="${k === kind}">${ICON[VK[k].i]} ${VK[k].n}</button>`).join("")}</div>`}
      ${visSen().length > 1 ? `<label class="f" for="vf-sen">Bei wem?</label><select class="inp" id="vf-sen" name="senior_id">${visSen().map((s) => opt(s.id, s.name, s.id === v.senior_id)).join("")}</select>` : `<input type="hidden" name="senior_id" value="${v.senior_id}">`}
      <div id="vf-f"></div>
      <div class="grid2"><div><label class="f" for="vf-d">Datum</label><input class="inp" type="date" id="vf-d" name="day" value="${d0}" max="${today()}" required></div><div><label class="f" for="vf-t">Uhrzeit</label><input class="inp" type="time" id="vf-t" name="time" value="${t0}" required></div></div>
      <label class="f" for="vf-n">Notiz (optional)</label><input class="inp" id="vf-n" name="note" maxlength="300" value="${esc(v.note || "")}" placeholder="z. B. nach dem Spaziergang, linker Arm" autocomplete="off">
      ${own ? `<div id="vf-doer">${doerSeg(v.senior_id, doerKey(v))}</div>` : ""}
      <p class="err" id="vf-e" role="alert"></p>
      <div class="btns">${v.id && own ? `<button type="button" class="btn ghost danger-t" id="vf-del">Löschen</button>` : `<button type="button" class="btn ghost" data-close>Abbrechen</button>`}<button class="btn" type="submit">Speichern</button></div>
      <p class="muted small center">Kein Ersatz für ärztlichen Rat.</p>
    </form>`, "vform");
  const num = (name, label, val, { dec = false, ph = "", req = true, unit = "" } = {}) => `<div class="vin"><label class="f" for="vf-${name}">${label}${req ? "" : " <span class=\"muted\">(optional)</span>"}</label><span class="inp-u"><input class="inp big" id="vf-${name}" name="${name}" type="text" inputmode="${dec ? "decimal" : "numeric"}" autocomplete="off" enterkeyhint="next" value="${val == null || val === "" ? "" : esc(String(val).replace(".", ","))}" placeholder="${ph}"><small>${unit}</small></span></div>`;
  const drawF = () => {
    const keep = (n) => $(`#vf-${n}`, sh)?.value;
    const same = kind === v.kind, g = same && v.kind === "glucose" && v.v1 != null ? (mm ? fmtN(v.v1 / MMOL, 1) : String(Math.round(v.v1))) : "";
    let html = "";
    if (kind === "bp") html = `<div class="grid3">${num("v1", "Oben", keep("v1") ?? (same ? v.v1 : ""), { ph: "135", unit: "mmHg" })}${num("v2", "Unten", keep("v2") ?? (same ? v.v2 : ""), { ph: "85", unit: "mmHg" })}${num("pulse", "Puls", keep("pulse") ?? (same ? v.pulse : ""), { ph: "72", req: false, unit: "/min" })}</div>`;
    else if (kind === "glucose") html = `${num("v1", "Blutzucker", g, { dec: mm, ph: mm ? "6,2" : "112", unit: gluU() })}
      <label class="f">Wann gemessen?</label><div class="seg small wrap" id="vf-c" role="group" aria-label="Zeitpunkt der Messung">${Object.entries(GCTX).map(([k, l]) => `<button type="button" data-gc="${k}" class="${k === ctx0 ? "on" : ""}" aria-pressed="${k === ctx0}">${l}</button>`).join("")}</div><input type="hidden" name="context" value="${ctx0}">`;
    else if (kind === "weight") html = num("v1", "Gewicht", same ? v.v1 : "", { dec: true, ph: "68,5", unit: "kg" });
    else if (kind === "temp") html = num("v1", "Temperatur", same ? v.v1 : "", { dec: true, ph: "36,8", unit: "°C" });
    else html = `<div class="grid2">${num("v1", "Sauerstoff", same ? v.v1 : "", { ph: "96", unit: "%" })}${num("pulse", "Puls", same ? v.pulse : "", { ph: "72", req: false, unit: "/min" })}</div>`;
    $("#vf-f", sh).innerHTML = html;
    $$("[data-gc]", sh).forEach((b) => (b.onclick = () => { $$("[data-gc]", sh).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); }); $('[name="context"]', sh).value = b.dataset.gc; }));
  };
  drawF(); bindDoerSeg(sh);
  $("#vf-sen", sh)?.addEventListener("change", (e) => { const box = $("#vf-doer", sh); if (box) { box.innerHTML = doerSeg(e.target.value, "self"); bindDoerSeg(box); } });
  $$("[data-vk]", sh).forEach((b) => (b.onclick = () => { kind = b.dataset.vk; $$("[data-vk]", sh).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); }); drawF(); }));
  $("#vf", sh).onsubmit = async (e) => {
    e.preventDefault(); const f = fd(e.target), el = $("#vf-e", sh);
    const n = (x) => (x == null || String(x).trim() === "" ? null : Number(String(x).trim().replace(",", ".")));
    let v1 = n(f.v1); const v2 = n(f.v2), pulse = n(f.pulse);
    const bad = (m, id) => { el.textContent = m; $(`#vf-${id}`, sh)?.focus(); return false; };
    if (v1 == null || !isFinite(v1)) return bad(kind === "bp" ? "Bitte den oberen Wert eintragen" : `Bitte ${kind === "glucose" ? "den Zuckerwert" : "einen Wert"} eintragen`, "v1");
    if (kind === "glucose" && mm) v1 = Math.round(v1 * MMOL);
    const R = { bp: [50, 260], glucose: [10, 700], weight: [20, 300], temp: [33, 43], spo2: [50, 100] }[kind];
    if (v1 < R[0] || v1 > R[1]) return bad(kind === "glucose" && mm ? `Bitte einen Wert zwischen ${fmtN(R[0] / MMOL, 1)} und ${fmtN(R[1] / MMOL, 1)} mmol/l eintragen` : `Bitte einen Wert zwischen ${fmtN(R[0])} und ${fmtN(R[1])} eintragen`, "v1");
    if (kind === "bp") { if (v2 == null || !isFinite(v2)) return bad("Bitte den unteren Wert eintragen", "v2"); if (v2 < 30 || v2 > 160) return bad("Unterer Wert: bitte zwischen 30 und 160 eintragen", "v2"); if (v1 <= v2) return bad("Der obere Wert muss größer als der untere sein", "v1"); }
    if (pulse != null && (!isFinite(pulse) || pulse < 25 || pulse > 230)) return bad("Puls: bitte zwischen 25 und 230 eintragen", "pulse");
    if (kind === "glucose" && !f.context) { el.textContent = "Bitte wählen, wann gemessen wurde (z. B. nüchtern)"; return; }
    const at = new Date(`${f.day}T${f.time || "12:00"}:00`);
    if (isNaN(at)) return bad("Bitte Datum und Uhrzeit prüfen", "d");
    if (at.getTime() > Date.now() + 10 * 60000) return bad("Der Zeitpunkt liegt in der Zukunft", "t");
    el.textContent = "";
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("vital_save", { id: v.id, senior_id: f.senior_id, kind, v1, v2: kind === "bp" ? v2 : null, pulse: kind === "bp" || kind === "spo2" ? pulse : null, context: kind === "glucose" ? f.context : null, note: f.note || "", measured_at: at.toISOString(), ...(f.doer != null ? { done_by: doneByVal(f.doer) } : {}) }), true).catch((er) => { el.textContent = er.message; return null; });
    if (!r) return;
    if (r.vital) S.D.vitals = (S.D.vitals || []).filter((x) => x.id !== r.vital.id).concat(r.vital);
    S.vLastKind = kind; S.vSen = f.senior_id;
    close(); const c = r.vital ? vClass(r.vital) : "";
    toast(`${v.id ? "Gespeichert" : VK[kind].n + " eingetragen"} ✓${c ? " · " + VCL[c] : ""}`);
    renderBehind(); await reload().catch(() => {});
  };
  if ($("#vf-del", sh)) $("#vf-del", sh).onclick = async () => { if (await confirmSheet("Messwert löschen?", `${vText(v)} vom ${vWhen(v.measured_at)} wird entfernt.`)) { close(); await busy(null, () => call("vital_delete", { id: v.id })).catch(() => {}); S.D.vitals = (S.D.vitals || []).filter((x) => x.id !== v.id); renderBehind(); await reload().catch(() => {}); } };
}
function vTargetsForm(sid) {
  const s = senior(sid); if (!s) return;
  const T = vTargets(sid), mm = gluMmol();
  const sh0 = (k, x) => (x == null ? "" : k.startsWith("glu") ? (mm ? fmtN(x / MMOL, 1) : String(x)) : String(x).replace(".", ","));
  const unit = (k) => (k.startsWith("bp") ? "mmHg" : k === "pulse" ? "/min" : k.startsWith("glu") ? gluU() : k === "weight" ? "kg" : k === "temp" ? "°C" : "%");
  const { sh, close } = openSheet(`<h2>Zielbereiche für ${esc(s.name)}</h2><p class="muted small">Am besten mit Hausarzt oder Diabetes-Praxis absprechen. Werte außerhalb werden nur neutral markiert.</p>
    <form id="vtf" class="form vtf" novalidate>${Object.keys(VTK).map((k) => `<div class="vtr"><span class="vtl">${VTK[k]} <small class="muted">${unit(k)}</small></span><span class="vtv"><input class="inp" name="${k}_lo" inputmode="decimal" aria-label="${esc(VTK[k])} von" value="${sh0(k, T[k]?.[0])}" placeholder="von"><span>–</span><input class="inp" name="${k}_hi" inputmode="decimal" aria-label="${esc(VTK[k])} bis" value="${sh0(k, T[k]?.[1])}" placeholder="bis"></span></div>`).join("")}
      <p class="muted small">Leer lassen = Standardwert. Beim Gewicht gibt es ohne Eintrag keine Einordnung.</p>
      <p class="err" id="vt-e" role="alert"></p>
      <div class="btns"><button type="button" class="btn ghost" id="vt-def">Standard</button><button class="btn" type="submit">Speichern</button></div></form>`);
  const save = async (targets, btn) => {
    const r = await busy(btn, () => call("vital_targets_save", { senior_id: sid, targets }), true).catch((er) => { $("#vt-e", sh).textContent = er.message; return null; });
    if (!r) return; s.vital_targets = targets; close(); toast("Zielbereiche gespeichert"); renderBehind(); sheetRefresh?.(); await reload().catch(() => {});
  };
  $("#vt-def", sh).onclick = (e) => save(null, e.currentTarget);
  $("#vtf", sh).onsubmit = (e) => {
    e.preventDefault(); const f = fd(e.target), out = {};
    for (const k of Object.keys(VTK)) {
      const p = (x) => (String(x || "").trim() === "" ? null : Number(String(x).trim().replace(",", ".")));
      let lo = p(f[k + "_lo"]), hi = p(f[k + "_hi"]);
      if (lo == null && hi == null) continue;
      if (k.startsWith("glu") && mm) { lo = lo == null ? null : Math.round(lo * MMOL); hi = hi == null ? null : Math.round(hi * MMOL); }
      if (lo == null || hi == null || !isFinite(lo) || !isFinite(hi) || lo >= hi || lo < VTR[k][0] || hi > VTR[k][1]) { $("#vt-e", sh).textContent = `${VTK[k]}: bitte „von“ kleiner als „bis“ eintragen (${VTR[k][0]}–${VTR[k][1]})`; return; }
      out[k] = [lo, hi];
    }
    save(Object.keys(out).length ? out : null, e.target.querySelector("[type=submit]"));
  };
}
function gluUnitSheet() {
  const { sh, close } = openSheet(`<h2>Einheit für Blutzucker</h2><p class="muted small">Gilt für dieses Gerät. Gespeichert wird immer in mg/dl – ihr könnt jederzeit wechseln.</p>
    <div class="choices">${[["mg", "mg/dl", "In Deutschland meist üblich"], ["mmol", "mmol/l", "z. B. bei manchen Messgeräten"]].map(([k, l, t]) => `<button class="choice ${(k === "mmol") === gluMmol() ? "on" : ""}" data-gu="${k}"><b>${l}</b><small>${t}</small></button>`).join("")}</div>`);
  $$("[data-gu]", sh).forEach((b) => (b.onclick = () => { localStorage.setItem("pf-glu-unit", b.dataset.gu); close(); toast(`Blutzucker in ${gluU()}`); renderBehind(); sheetRefresh?.(); }));
}
// ---------- Kontakte (Adressbuch) ----------
const contact = (id) => (S.D?.contacts || []).find((c) => c.id === id);
const telUrl = (p) => "tel:" + String(p || "").replace(/[^0-9+]/g, "");
const mapsUrl = (a) => "https://maps.apple.com/?q=" + encodeURIComponent(String(a || "").replace(/\s*\n\s*/g, ", "));
const routeUrl = (a) => "https://maps.apple.com/?daddr=" + encodeURIComponent(String(a || "").replace(/\s*\n\s*/g, ", "));
const cIco = (c) => `<span class="sico k-contact lg" aria-hidden="true">${ICON[(CCAT[c.category] || CCAT.sonstiges)[1]]}</span>`;
const CORDER = ["arzt", "facharzt", "apotheke", "pflegedienst", "familie", "sonstiges"];
const sortContacts = (xs) => [...xs].sort((a, b) => CORDER.indexOf(a.category) - CORDER.indexOf(b.category) || a.name.localeCompare(b.name, "de"));
function contactOptions(sel) {
  const xs = sortContacts((S.D.contacts || []).filter((c) => c.id === sel || inFocus(c.senior_id)));
  return opt("", xs.length ? "Kein Kontakt" : "Noch keine Kontakte", !sel) + CORDER.map((k) => { const g = xs.filter((c) => c.category === k); return g.length ? `<optgroup label="${esc(CCAT[k][0])}">${g.map((c) => opt(c.id, c.name + (c.org && c.org !== c.name ? " · " + c.org : ""), c.id === sel)).join("")}</optgroup>` : ""; }).join("");
}
// Kontaktkarte im Termin: Name, Praxis, Adresse, Anrufen/Route
function contactCard(c, loc) {
  const addr = c.address || loc || "";
  return `<div class="ccard"><button class="cc-h" data-contact="${c.id}">${cIco(c)}<span><b>${esc(c.name)}</b><small class="muted">${esc(c.org || CCAT_SHORT[c.category] || "")}</small></span><span class="chev">${ICON.chev}</span></button>
    ${addr ? `<a class="cc-addr" href="${mapsUrl(addr)}" target="_blank" rel="noopener">${ICON.pin}<span class="pre">${esc(addr)}</span></a>` : ""}
    <div class="cc-act">${c.phone ? `<a class="btn cact call" href="${telUrl(c.phone)}">${ICON.phone}<span>Anrufen</span></a>` : ""}${addr ? `<a class="btn cact soft" href="${routeUrl(addr)}" target="_blank" rel="noopener">${ICON.route}<span>Route</span></a>` : ""}</div></div>`;
}
function contactRow(c) {
  return `<div class="crow" data-fk="c:${c.id}" data-q="${esc((c.name + " " + (c.org || "") + " " + (c.address || "") + " " + (CCAT_SHORT[c.category] || "")).toLowerCase())}">
    <button class="cr-main" data-contact="${c.id}">${cIco(c)}<span class="cr-b"><b>${esc(c.name)}</b><small class="muted ell">${esc(c.org || CCAT_SHORT[c.category])}</small>${c.senior_id && senior(c.senior_id) ? sChip(c.senior_id) : ""}</span></button>
    ${c.phone ? `<a class="cr-call" href="${telUrl(c.phone)}" aria-label="${esc(c.name)} anrufen">${ICON.phone}</a>` : ""}</div>`;
}
function pageContacts() {
  const xs = sortContacts((S.D.contacts || []).filter((c) => inFocus(c.senior_id))); // übernommen → nur Kontakte der eigenen Person(en) + allgemeine
  const groups = CORDER.map((k) => { const g = xs.filter((c) => c.category === k); return g.length ? `<section class="cgroup"><h3 class="grp">${esc(CCAT[k][0])} <span class="muted">${g.length}</span></h3><div class="card list-card clist">${g.map(contactRow).join("")}</div></section>` : ""; }).join("");
  return `<div class="page-h"><h1>Kontakte</h1><p class="muted">Ärzte, Apotheke, Pflegedienst – mit einem Tipp anrufen oder hinnavigieren.</p></div>${focusHint()}
    ${xs.length > 5 ? `<label class="csearch">${ICON.search}<input class="inp" id="csearch" type="search" placeholder="Suchen …" aria-label="Kontakte durchsuchen" autocomplete="off"></label>` : ""}
    ${xs.length ? groups + `<p class="muted small center" id="c-none" hidden>Nichts gefunden.</p>` : `<div class="card empty">${sico("contact", "lg c")}<h3>Noch keine Kontakte</h3><p class="muted">Leg Hausarzt, Fachärzte, Apotheke oder Pflegedienst einmal mit Adresse und Telefon an – bei Terminen wählst du sie dann einfach aus.</p><button class="btn" data-act="new-contact">Kontakt anlegen</button></div>`}
    ${fabCtx("new-contact", "Kontakt")}`;
}
function contactSheet(id) {
  dynSheet((sh, close) => {
    const c = contact(id); if (!c) { close(); return; }
    const ap = upcomingAppts().filter((a) => a.contact_id === id).slice(0, 5);
    $$(":scope > :not(.grab)", sh).forEach((x) => x.remove()); const top = document.createElement("div"); sh.appendChild(top);
    top.innerHTML = `<div class="sheet-head row">${cIco(c)}<div><span class="kind-badge k-contact">${esc(CCAT_SHORT[c.category])}</span><h2>${esc(c.name)}</h2>${c.org ? `<p class="muted">${esc(c.org)}</p>` : ""}</div></div>
      <div class="cc-act big">${c.phone ? `<a class="btn cact call" href="${telUrl(c.phone)}">${ICON.phone}<span>Anrufen</span></a>` : ""}${c.address ? `<a class="btn cact soft" href="${routeUrl(c.address)}" target="_blank" rel="noopener">${ICON.route}<span>Route</span></a>` : ""}${c.email ? `<a class="btn cact soft" href="mailto:${esc(c.email)}">${ICON.mail}<span>E-Mail</span></a>` : ""}</div>
      <dl class="facts">
        ${c.phone ? `<dt>Telefon</dt><dd><a class="link" href="${telUrl(c.phone)}">${esc(c.phone)}</a></dd>` : ""}
        ${c.address ? `<dt>Adresse</dt><dd><a class="link pre" href="${mapsUrl(c.address)}" target="_blank" rel="noopener">${esc(c.address)}</a></dd>` : ""}
        ${c.email ? `<dt>E-Mail</dt><dd><a class="link" href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>` : ""}
        ${c.senior_id && senior(c.senior_id) ? `<dt>Für</dt><dd>${sChip(c.senior_id)}</dd>` : ""}
        ${c.note ? `<dt>Notiz</dt><dd class="pre">${esc(c.note)}</dd>` : ""}
      </dl>
      ${ap.length ? `<h3 class="sec">Nächste Termine</h3><div class="list">${ap.map(apptRow).join("")}</div>` : ""}
      ${c.category === "pflegedienst" && S.D.seniors.length ? `<h3 class="sec">Einsatzzeiten</h3><div class="list-card shift-list">${shiftRows(shiftRules((r) => r.contact_id === c.id), { showSen: true, showC: false })}
        <button class="link-row add" data-shift-new="${c.senior_id || ""}" data-cid="${c.id}"><span class="lr-ic">${ICON.plus}</span><span><b>Einsatzzeit eintragen</b><small>Wochentage und Von/Bis</small></span></button></div>` : ""}
      <button class="btn block soft" id="c-appt">${ICON.cal} Termin bei ${esc(c.name)} eintragen</button>
      <div class="btns"><button class="btn ghost" id="c-edit">Bearbeiten</button><button class="btn ghost danger-t" id="c-del">Löschen</button></div>`;
    $$("[data-appt]", top).forEach((b) => (b.onclick = () => { close(); apptSheet(b.dataset.appt); }));
    $("#c-appt", top).onclick = () => { close(); apptForm({ contact_id: c.id, location: (c.address || "").replace(/\s*\n\s*/g, ", ").slice(0, 200), title: (c.org && /^dr\.?\s/i.test(c.name) ? c.name : c.org || c.name).slice(0, 120), senior_id: c.senior_id || null, kind: c.category === "pflegedienst" ? "pflege" : c.category === "familie" ? "besuch" : "arzt" }); };
    $("#c-edit", top).onclick = () => { close(); contactForm(c); };
    $("#c-del", top).onclick = async () => { if (await confirmSheet(`${c.name} löschen?`, "Der Kontakt wird für alle entfernt. Termine bleiben erhalten (ohne Verknüpfung).")) { close(); await busy(null, () => call("contact_delete", { id })).catch(() => {}); await reload(); } };
  });
}
// ---------- Pflegedienst-Zeiten (Einsatzplan) ----------
const shiftRules = (pred) => (S.D.shifts || []).filter((r) => r.kind !== "skip" && (r.kind !== "once" || r.on_date >= today()) && pred(r))
  .sort((a, b) => (a.kind === "once") - (b.kind === "once") || (a.on_date || "").localeCompare(b.on_date || "") || a.start_time.localeCompare(b.start_time));
const skipsOf = (r) => (S.D.shifts || []).filter((k) => k.kind === "skip" && k.shift_id === r.id && k.on_date >= today()).sort((a, b) => a.on_date.localeCompare(b.on_date));
const dayShort = (d) => parseD(d).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" });
function shiftRows(rs, { showSen = false, showC = true } = {}) {
  return rs.map((r) => { const c = contact(r.contact_id), sk = skipsOf(r);
    return `<button class="link-row shift-row" data-shift="${r.id}"><span class="lr-ic carer">${ICON.carer}</span><span><b>${esc(shiftWhen(r))} · ${r.start_time}–${r.end_time}</b><small>${[showC ? esc(c?.name || "Pflegedienst") : "", showSen ? esc(senior(r.senior_id)?.name || "") : "", sk.length ? `fällt aus: ${sk.slice(0, 2).map((k) => dayShort(k.on_date)).join(", ")}` : ""].filter(Boolean).join(" · ")}</small></span>${ICON.chev}</button>`; }).join("");
}
function shiftSection(s) {
  const rs = shiftRules((r) => r.senior_id === s.id), w = carerNow(s.id);
  return `<section class="shifts-s"><div class="sec-h"><h2 class="hi"><span class="sico k-carer">${ICON.carer}</span><span>Pflegedienst-Zeiten</span></h2></div>
    <div class="card list-card">${w ? `<p class="shift-now">${carerIco()}<span><b>${esc(w.c.name)}</b> ist gerade da · bis ${hmMs(w.e)} Uhr</span></p>` : ""}${shiftRows(rs)}
      <button class="link-row add" data-shift-new="${s.id}"><span class="lr-ic">${ICON.plus}</span><span><b>Einsatzzeit eintragen</b><small>z. B. Mo–Fr 07:30–08:15 – in der Zeit gilt ${esc(s.name)} als vom Pflegedienst übernommen</small></span></button></div></section>`;
}
// Tipp auf eine Einsatzzeit / „eintragen“ (Person, Kontakt) – vor anderen Klick-Handlern, offene Sheets schließen
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-shift],[data-shift-new]"); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  $$(".sheet").forEach((x) => x.__close?.());
  if (b.dataset.shift) shiftForm((S.D.shifts || []).find((r) => r.id === b.dataset.shift));
  else shiftForm(null, { senior_id: b.dataset.shiftNew || undefined, contact_id: b.dataset.cid || undefined });
}, true);
function shiftForm(r, preset = {}) {
  r = r ? { ...r } : { kind: "weekly", days: [1, 2, 3, 4, 5], start_time: "07:30", end_time: "08:15", senior_id: preset.senior_id || contact(preset.contact_id)?.senior_id || visSen()[0]?.id || S.D.seniors[0]?.id, contact_id: preset.contact_id || "" };
  let days = new Set(r.days || []), kind = r.kind === "once" ? "once" : "weekly";
  const cOpts = (sid) => carersFor(sid);
  const { sh, close } = openSheet(`<h2>${r.id ? "Einsatzzeit bearbeiten" : "Pflegedienst-Zeit eintragen"}</h2>
    <form id="shf" class="form" novalidate>
      <label class="f" for="shf-s">Für</label><select class="inp" id="shf-s" name="senior_id">${S.D.seniors.map((x) => `<option value="${x.id}" ${x.id === r.senior_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      <label class="f" for="shf-c">Pflegedienst</label><div id="shf-cw"></div>
      <label class="f">Wie oft?</label>
      <div class="seg small" id="shf-k" role="group" aria-label="Wie oft?"><button type="button" data-k="weekly" class="${kind === "weekly" ? "on" : ""}" aria-pressed="${kind === "weekly"}">Jede Woche</button><button type="button" data-k="once" class="${kind === "once" ? "on" : ""}" aria-pressed="${kind === "once"}">Einmalig</button></div>
      <div id="shf-w" ${kind === "weekly" ? "" : "hidden"}><label class="f">Wochentage</label>
        <div class="wdchips" role="group" aria-label="Wochentage">${WD.map((l, i) => `<button type="button" class="wdc ${days.has(i + 1) ? "on" : ""}" data-wd="${i + 1}" aria-pressed="${days.has(i + 1)}">${l}</button>`).join("")}</div>
        <div class="wdpre"><button type="button" class="link small" data-pre="5">Mo–Fr</button><button type="button" class="link small" data-pre="7">Täglich</button></div></div>
      <div id="shf-o" ${kind === "once" ? "" : "hidden"}><label class="f" for="shf-d">Datum</label><input class="inp" id="shf-d" type="date" name="on_date" min="${today()}" value="${esc(r.on_date || today())}"></div>
      <div class="tm2"><span><label class="f" for="shf-a">Von</label><input class="inp" id="shf-a" type="time" name="start_time" value="${esc(r.start_time)}" required></span><span><label class="f" for="shf-b">Bis</label><input class="inp" id="shf-b" type="time" name="end_time" value="${esc(r.end_time)}" required></span></div>
      <p class="hint small">In dieser Zeit gilt die Person automatisch als vom Pflegedienst übernommen – danach ist sie wieder frei. Ihr könnt trotzdem parallel übernehmen. Im Tagebuch steht der Einsatz als eigene Zeile.</p>
      ${r.id && r.kind === "weekly" ? `<div class="shf-skip"><label class="f" for="shf-x">Fällt aus am</label><div class="row"><input class="inp" id="shf-x" type="date" min="${today()}" value="${today()}"><button type="button" class="btn soft small" id="shf-xb">Fällt aus</button></div>
        <div class="skips">${skipsOf(r).map((k) => `<span class="skip">${esc(dayShort(k.on_date))}<button type="button" class="x" data-unskip="${k.on_date}" aria-label="Ausfall am ${esc(dayShort(k.on_date))} zurücknehmen">×</button></span>`).join("")}</div></div>` : ""}
      <p class="err" id="shf-e"></p>
      <div class="btns">${r.id ? `<button type="button" class="btn ghost danger-t" id="shf-del">Löschen</button>` : `<button type="button" class="btn ghost" data-close>Abbrechen</button>`}<button class="btn" type="submit">Speichern</button></div>
    </form>`, "shift-sheet");
  const err = (m) => ($("#shf-e", sh).textContent = m || "");
  const drawC = () => {
    const sid = $("#shf-s", sh).value, cs = cOpts(sid), cur = cs.some((c) => c.id === r.contact_id) ? r.contact_id : cs[0]?.id;
    $("#shf-cw", sh).innerHTML = cs.length ? `<select class="inp" id="shf-c" name="contact_id">${cs.map((c) => `<option value="${c.id}" ${c.id === cur ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`
      : `<p class="hint small">Noch kein Pflegedienst in den Kontakten.</p><button type="button" class="btn soft small" id="shf-nc">${ICON.plus} Pflegedienst anlegen</button>`;
    const nc = $("#shf-nc", sh); if (nc) nc.onclick = () => { const keep = collect(); close(); contactForm({}, { category: "pflegedienst", senior_id: sid }, (c) => shiftForm(r.id ? { ...r, ...keep, contact_id: c?.id } : null, { senior_id: sid, contact_id: c?.id })); };
  };
  const collect = () => { const v = fd($("#shf", sh)); return { senior_id: v.senior_id, contact_id: v.contact_id, kind, days: [...days].sort(), on_date: v.on_date, start_time: v.start_time, end_time: v.end_time }; };
  drawC(); $("#shf-s", sh).onchange = drawC;
  $$("[data-k]", sh).forEach((b) => (b.onclick = () => { kind = b.dataset.k; $$("[data-k]", sh).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }); $("#shf-w", sh).hidden = kind !== "weekly"; $("#shf-o", sh).hidden = kind !== "once"; }));
  const drawD = () => $$("[data-wd]", sh).forEach((x) => { const on = days.has(+x.dataset.wd); x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); });
  $$("[data-wd]", sh).forEach((b) => (b.onclick = () => { const d = +b.dataset.wd; days.has(d) ? days.delete(d) : days.add(d); drawD(); }));
  $$("[data-pre]", sh).forEach((b) => (b.onclick = () => { days = new Set(b.dataset.pre === "5" ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 7]); drawD(); }));
  $("#shf", sh).onsubmit = async (e) => {
    e.preventDefault(); const v = collect();
    if (!v.contact_id) return err("Bitte zuerst einen Pflegedienst anlegen");
    if (kind === "weekly" && !v.days.length) return err("Bitte mindestens einen Wochentag wählen");
    if (!v.start_time || !v.end_time) return err("Bitte Von und Bis eintragen");
    if (v.end_time <= v.start_time) return err("„Bis“ muss nach „Von“ liegen");
    err("");
    const res = await busy(e.target.querySelector("[type=submit]"), () => call("shift_save", { id: r.id, ...v }), true).catch((er) => { err(er.message); return null; });
    if (!res) return;
    if (res.shift) S.D.shifts = (S.D.shifts || []).filter((x) => x.id !== res.shift.id).concat(res.shift);
    close(); toast(r.id ? "Gespeichert" : `Eingetragen: ${shiftWhen(res.shift || v)} ${v.start_time}–${v.end_time}`); render(true); reload().catch(() => {});
  };
  const xb = $("#shf-xb", sh);
  if (xb) xb.onclick = async () => {
    const on = $("#shf-x", sh).value; if (!on) return err("Bitte ein Datum wählen");
    const res = await busy(xb, () => call("shift_skip", { shift_id: r.id, on_date: on })).catch((er) => { err(er.message); return null; });
    if (!res) return; if (res.shift) S.D.shifts = (S.D.shifts || []).filter((x) => !(x.shift_id === r.id && x.on_date === on)).concat(res.shift);
    close(); toast(`Fällt aus am ${dayShort(on)}`); render(true); reload().catch(() => {});
  };
  $$("[data-unskip]", sh).forEach((b) => (b.onclick = async () => {
    const on = b.dataset.unskip; const res = await busy(b, () => call("shift_skip", { shift_id: r.id, on_date: on, undo: true })).catch((er) => { err(er.message); return null; });
    if (!res) return; S.D.shifts = (S.D.shifts || []).filter((x) => !(x.kind === "skip" && x.shift_id === r.id && x.on_date === on)); b.parentElement.remove(); render(true); reload().catch(() => {});
  }));
  const del = $("#shf-del", sh);
  if (del) del.onclick = async () => {
    if (!(await confirmSheet("Einsatzzeit löschen?", "Vergangene Einsätze verschwinden dann auch aus dem Tagebuch.", "Löschen"))) return;
    const res = await busy(del, () => call("shift_delete", { id: r.id })).catch((er) => { err(er.message); return null; }); if (!res) return;
    S.D.shifts = (S.D.shifts || []).filter((x) => x.id !== r.id && x.shift_id !== r.id); close(); toast("Gelöscht"); render(true); reload().catch(() => {});
  };
}
function contactForm(c = {}, preset = {}, onSaved = null) {
  c = { category: "arzt", ...preset, ...c };
  const { sh, close } = openSheet(`<h2>${c.id ? "Kontakt bearbeiten" : "Neuer Kontakt"}</h2>
    <form id="cfm" class="form" novalidate>
      <label class="f">Art</label>
      <div class="seg small wrap" id="cf-cat">${CORDER.map((k) => `<button type="button" data-cat="${k}" class="${c.category === k ? "on" : ""}">${CCAT_SHORT[k]}</button>`).join("")}</div>
      <input type="hidden" name="category" value="${c.category}">
      <label class="f" for="cf-name">Name</label><input class="inp" id="cf-name" name="name" required maxlength="80" value="${esc(c.name || "")}" placeholder="z. B. Dr. Weber" autocomplete="off">
      <label class="f" for="cf-org">Praxis / Firma (optional)</label><input class="inp" id="cf-org" name="org" maxlength="120" value="${esc(c.org || "")}" placeholder="z. B. Hausarztpraxis am Markt" autocomplete="off">
      <label class="f" for="cf-ph">Telefon</label><input class="inp" id="cf-ph" name="phone" type="tel" inputmode="tel" maxlength="40" value="${esc(c.phone || "")}" placeholder="z. B. 0221 123456" autocomplete="off">
      <label class="f" for="cf-ad">Adresse</label><textarea class="inp" id="cf-ad" name="address" rows="2" maxlength="300" placeholder="Straße Nr., PLZ Ort">${esc(c.address || "")}</textarea>
      <label class="f" for="cf-em">E-Mail (optional)</label><input class="inp" id="cf-em" name="email" type="email" inputmode="email" maxlength="120" value="${esc(c.email || "")}" autocapitalize="none" autocomplete="off">
      ${S.D.seniors.length ? `<label class="f" for="cf-sen">Gehört zu (optional)</label><select class="inp" id="cf-sen" name="senior_id">${seniorOptions(c.senior_id, "Allen")}</select>` : ""}
      <label class="f" for="cf-no">Notiz (optional)</label><textarea class="inp" id="cf-no" name="note" rows="2" maxlength="500" placeholder="z. B. Sprechzeiten Mo–Fr 8–12 Uhr">${esc(c.note || "")}</textarea>
      <p class="err" id="cf-e"></p>
      <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">${c.id ? "Speichern" : "Kontakt anlegen"}</button></div>
    </form>`);
  $$("[data-cat]", sh).forEach((b) => (b.onclick = () => { $$("[data-cat]", sh).forEach((x) => x.classList.toggle("on", x === b)); sh.querySelector('[name="category"]').value = b.dataset.cat; }));
  $("#cfm", sh).onsubmit = async (e) => {
    e.preventDefault(); const v = fd(e.target), el = $("#cf-e", sh);
    if (!String(v.name || "").trim()) { el.textContent = "Bitte einen Namen eintragen"; $("#cf-name", sh).focus(); return; }
    if (v.phone && !/^[0-9+()\/.\s-]{3,40}$/.test(v.phone.trim())) { el.textContent = "Die Telefonnummer darf nur Ziffern, Leerzeichen und + ( ) / - enthalten"; return; }
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) { el.textContent = "Die E-Mail-Adresse sieht nicht richtig aus"; return; }
    el.textContent = "";
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("contact_save", { id: c.id, ...v, senior_id: v.senior_id || null }), true).catch((er) => { el.textContent = er.message; return null; });
    if (!r) return;
    if (r.contact) { S.D.contacts = (S.D.contacts || []).filter((x) => x.id !== r.contact.id).concat(r.contact); }
    close();
    if (onSaved) onSaved(r.contact || contact(r.id)); else toast(c.id ? "Gespeichert" : "Kontakt angelegt");
    await reload().catch(() => {});
  };
  if (!c.id) setTimeout(() => $("#cf-name", sh)?.focus(), 260);
}
// ---------- Seiten ----------
// ---------- Übergabe: Care-Profil, Kurz-Einträge, „Ich bin jetzt da“, Protokoll ----------
const curHandoff = (sid) => { const hs = activeCare(sid); return hs.find((h) => h.taken_by === S.uid) || hs[0]; };
const careOf = (sid, hours = 24) => (S.D.care || []).filter((c) => c.senior_id === sid && Date.now() - new Date(c.created_at).getTime() < hours * 3600e3);
const since = (iso) => `${isoDay(iso) === today() ? "" : dayLabel(isoDay(iso)) + ", "}${hm(iso)} Uhr`;
function careRow(e, { withSenior } = {}) {
  const k = careK(e.kind);
  const del = e.author_id === S.uid || isAdmin() ? `<button class="x" data-cdel="${e.id}" aria-label="Eintrag löschen">×</button>` : "";
  return `<li class="ce ${k.imp ? "imp" : ""}"><span class="ce-e" aria-hidden="true">${k.e}</span><div class="ce-b"><b>${k.n}${withSenior ? ` · ${esc(senior(e.senior_id)?.name || "")}` : ""}</b>${e.note ? `<span>${esc(e.note)}</span>` : ""}<small class="muted">${doerHtml(e, e.author_id)} · ${since(e.created_at)}</small></div>${del}</li>`;
}
function careList(sid, hours = 24, max = 8) {
  const es = careOf(sid, hours).slice(0, max);
  return es.length ? `<ul class="care-list">${es.map((e) => careRow(e)).join("")}</ul>` : `<p class="muted small">In den letzten ${hours} Std. noch nichts notiert.</p>`;
}
const quickChips = (sid) => `<div class="qchips" role="group" aria-label="Kurz notieren">${Object.entries(CARE).map(([k, v]) => `<button class="qchip ${v.imp ? "imp" : ""}" data-care="${k}" data-sid="${sid}"><span aria-hidden="true">${v.e}</span>${v.n}</button>`).join("")}</div>`;
function lastStatus(sid) {
  const es = careOf(sid, 24);
  if (!es.length) { const e = (S.D.care || []).find((c) => c.senior_id === sid); return e ? `${careK(e.kind).e || ""} ${careK(e.kind).n || ""}${e.note ? " – " + esc(e.note) : ""} <small class="muted">(${since(e.created_at)})</small>` : ""; }
  const seen = new Set(), parts = [];
  for (const e of es) if (!seen.has(e.kind)) { seen.add(e.kind); parts.push(`${careK(e.kind).e || ""} ${careK(e.kind).n || e.kind}`); }
  return parts.slice(0, 4).join(" · ") + ` <small class="muted">(zuletzt ${since(es[0].created_at)})</small>`;
}
function profileCard(s) {
  const idl = [s.birthdate ? `geb. ${fmtDate(s.birthdate)}${ageOf(s.birthdate) != null ? ` (${ageOf(s.birthdate)} Jahre)` : ""}` : "", s.blood_type ? `Blutgruppe ${s.blood_type}` : ""].filter(Boolean).join(" · ");
  const rows = [["info", "Person", idl], ["allergy", "Allergien", s.allergies, "alert"], ["hint", "Diagnosen / Hinweise", s.diagnoses], ["mob", "Mobilität", s.mobility], ["like", "Mag", s.likes], ["dislike", "Mag nicht", s.dislikes], ["note", "Patientenverfügung / Vollmacht", s.directive], ["hint", "Wichtige Hinweise", s.info]];
  const has = rows.some((r) => r[2]);
  return `<div class="card profile">${has ? `<dl>${rows.filter((r) => r[2]).map(([e, l, v, c]) => `<div class="pr ${c || ""}"><dt>${sico(e, "xs")}${l}</dt><dd class="pre">${esc(v)}</dd></div>`).join("")}</dl>` : `<p class="muted small">Noch kein Profil – trage Allergien, Mobilität und Vorlieben ein, damit Einspringende Bescheid wissen.</p>`}
    <div class="pr-f">${s.profile_updated_at ? `<small class="muted">Aktualisiert von ${esc(nm(s.profile_updated_by))} · ${rel(s.profile_updated_at)}</small>` : "<span></span>"}<button class="link small" data-act="edit-profile" data-id="${s.id}">Bearbeiten</button></div></div>`;
}
function respLine(sid) {
  const h = curHandoff(sid);
  return h ? `<span class="resp">${ava(h.taken_by, "xs")}<span><b>${h.taken_by === S.uid ? "Du bist" : esc(nmPlain(h.taken_by)) + " ist"} gerade da</b><small>seit ${since(h.created_at)}</small></span></span>`
    : `<span class="resp none"><span class="ava xs ghost">?</span><span><b>Gerade ist niemand eingetragen</b><small>Wer vor Ort ist, tippt „Ich bin jetzt da“</small></span></span>`;
}
// Übergabe: Aufgaben dieser Person plus allgemeine ohne Person
function todayTasksOf(sid) { const t = today(); return openTasks().filter((x) => (x.senior_id === sid || !x.senior_id) && ((x.due_date && x.due_date <= t) || x.status === "in_progress")).sort(sortTasks); }
function nextDoses(sid) { return medDoses(today(), sid).filter((x) => x.status !== "given").sort((a, b) => (a.status === "missed" ? 0 : 1) - (b.status === "missed" ? 0 : 1) || a.slot.localeCompare(b.slot)); }
function handoffLog(sid, max = 8) {
  const hs = (S.D.handoffs || []).filter((h) => h.senior_id === sid).slice(0, max);
  if (!hs.length) return `<p class="muted small">Noch keine Übergaben.</p>`;
  return `<ul class="ho-log">${hs.map((h) => {
    const o = h.open_snapshot || {}, n = (o.tasks?.length || 0) + (o.meds?.length || 0);
    return `<li><details><summary>${ava(h.taken_by, "xs")}<span><b>${esc(nm(h.taken_by))} ${h.taken_by === S.uid ? "hast" : "hat"} übernommen</b><small class="muted">${since(h.created_at)}${h.from_user ? ` · von ${esc(nmPlain(h.from_user))}` : ""}${h.ended_at ? ` · bis ${since(h.ended_at)}` : " · <b class=\"ok-t\">gerade da</b>"}</small><small>${n ? `Offen beim Übernehmen: ${n}` : "Beim Übernehmen war nichts offen"}</small></span></summary>
      <div class="ho-snap">${o.tasks?.length ? `<p><b>Aufgaben:</b> ${o.tasks.map(esc).join(" · ")}</p>` : ""}${o.meds?.length ? `<p><b>Medikamente:</b> ${o.meds.map(esc).join(" · ")}</p>` : ""}${o.appt ? `<p><b>Nächster Termin:</b> ${esc(o.appt)}</p>` : ""}${h.note ? `<p><b>Notiz:</b> ${esc(h.note)}</p>` : ""}${h.ended_note ? `<p><b>Übergabe-Notiz:</b> ${esc(h.ended_note)}</p>` : ""}${!n && !o.appt && !h.note && !h.ended_note ? `<p class="muted">Keine Details.</p>` : ""}</div></details></li>`;
  }).join("")}</ul>`;
}
function careSheet(kind, sid) {
  const k = CARE[kind], s = senior(sid);
  const open = kind === "med" ? medDoses(today(), sid).filter((x) => x.status !== "given") : [];
  const { sh, close } = openSheet(`<h2>${k.e} ${k.n}</h2><p class="muted">${esc(s.name)} · ${hm(new Date().toISOString())} Uhr</p>
    ${kind === "med" ? `${open.length ? `<p class="small"><b>Aus dem Medikamentenplan abhaken:</b></p><div class="list">${open.map((x) => doseRow(x, { noSenior: true })).join("")}</div><p class="muted small">Oder ein anderes Medikament (z. B. Bedarf) kurz notieren:</p>` : `<p class="muted small">Alle geplanten Medikamente sind abgehakt. Hier kannst du z. B. ein Bedarfsmedikament notieren.</p>`}` : ""}
    <form id="cf" class="form">
      <label class="f" for="cf-n">${kind === "special" ? "Was ist heute besonders?" : kind === "med" ? "Welches Medikament?" : "Kurze Notiz (optional)"}</label>
      <input class="inp" id="cf-n" name="note" maxlength="280" ${kind === "special" || kind === "med" ? "required" : ""} placeholder="${kind === "special" ? "z. B. Knie geschwollen, Arzt anrufen" : kind === "med" ? "z. B. 1 Ibuprofen 400 mg gegen Knieschmerz" : "z. B. Haferbrei, halbe Portion"}">
      ${doerSeg(sid)}
      <p class="muted small">${k.imp ? "Steht im Tagebuch – die Familie bekommt zusätzlich einen Hinweis (je nach Einstellung)." : "Erscheint im Tagebuch."}</p>
      <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">Notieren</button></div></form>`);
  bindDoses(sh); bindDoerSeg(sh); sheetRefresh = null;
  $$("[data-give]", sh).forEach((b) => b.addEventListener("click", () => setTimeout(close, 400)));
  $("#cf", sh).onsubmit = async (e) => {
    e.preventDefault();
    const r = await busy(e.target.querySelector("[type=submit]"), () => call("care_add", { senior_id: sid, kind, note: fd(e.target).note, done_by: doneByVal(fd(e.target).doer) })).catch(() => null);
    if (r?.entry) { S.D.care = [r.entry, ...(S.D.care || [])]; close(); toast("Notiert ✓"); render(true); reload().catch(() => {}); }
  };
  if (kind !== "med" && kind !== "special") setTimeout(() => $("#cf-n", sh)?.focus(), 250);
}
function handoffSheet(sid, end) {
  const s = senior(sid), ds = nextDoses(sid), tt = todayTasksOf(sid), cur = curHandoff(sid);
  const sum = [tt.length ? `<li><b>${tt.length}</b> ${tt.length === 1 ? "Aufgabe" : "Aufgaben"} heute offen</li>` : "", ds.length ? `<li><b>${ds.length}</b> ${ds.length === 1 ? "Medikament" : "Medikamente"} noch nicht gegeben${ds.some((x) => x.status === "missed") ? ` <b class="danger-t">(verpasst!)</b>` : ""}</li>` : ""].join("");
  const { sh, close } = openSheet(end
    ? `<h2>👋 Übergabe abschließen</h2><p class="muted">Du bist seit ${since(cur.created_at)} bei ${esc(s.name)}.</p>${sum ? `<ul class="ho-sum">${sum}</ul>` : `<p>✓ Gerade ist nichts offen.</p>`}
      <form id="hf" class="form"><label class="f" for="hf-n">Was soll der/die Nächste wissen? (optional)</label><textarea class="inp" id="hf-n" name="note" rows="3" maxlength="500" placeholder="z. B. Hat um 15 Uhr gegessen, Tabletten für abends liegen bereit"></textarea>
      <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">Abschließen</button></div></form>`
    : `<h2>🙋 Ich bin jetzt da</h2><p class="muted">Du kümmerst dich jetzt um ${esc(s.name)}${cur && cur.taken_by !== S.uid ? ` – <b>${esc(nmPlain(cur.taken_by))}</b> ist auch eingetragen, ihr könnt beide da sein` : ""}. Die Familie wird benachrichtigt; um Mitternacht endet die Übernahme automatisch.</p>${sum ? `<ul class="ho-sum">${sum}</ul>` : `<p>✓ Gerade ist nichts offen.</p>`}
      <form id="hf" class="form"><label class="f" for="hf-n">Kurze Notiz (optional)</label><input class="inp" id="hf-n" name="note" maxlength="500" placeholder="z. B. Bleibe bis 18 Uhr">
      <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">Übernehmen</button></div></form>`);
  $("#hf", sh).onsubmit = async (e) => {
    e.preventDefault();
    const r = await busy(e.target.querySelector("[type=submit]"), () => call(end ? "care_release" : "care_take", { senior_ids: [sid], note: fd(e.target).note })).catch(() => null);
    if (r) { close(); toast(end ? "Übergabe abgeschlossen" : `Du bist jetzt für ${s.name} eingetragen`); await reload(); window.scrollTo(0, 0); }
  };
}
function profileForm(s) {
  const F = (id, n, l, ph, max = 500, rows = 2) => `<label class="f" for="pf-${id}">${l}</label><textarea class="inp" id="pf-${id}" name="${n}" rows="${rows}" maxlength="${max}" placeholder="${ph}">${esc(s[n] || "")}</textarea>`;
  const { sh, close } = openSheet(`<h2>Care-Profil: ${esc(s.name)}</h2>
    <form id="pf" class="form">
      <div class="grid2"><div><label class="f" for="pf-b">Geburtsdatum</label><input class="inp" type="date" id="pf-b" name="birthdate" min="1900-01-01" max="${today()}" value="${esc(s.birthdate || "")}"></div>
        <div><label class="f" for="pf-bt">Blutgruppe</label><select class="inp" id="pf-bt" name="blood_type">${opt("", "Unbekannt", !s.blood_type)}${BLOOD.map((b) => opt(b, b, s.blood_type === b)).join("")}</select></div></div>
      ${F("a", "allergies", "⚠️ Allergien / Unverträglichkeiten", "z. B. Penicillin, Nüsse")}
      ${F("dg", "diagnoses", "🩺 Wichtige Diagnosen / Hinweise für den Notfall", "z. B. Diabetes Typ 2, Vorhofflimmern (Blutverdünner), Herzschrittmacher", 800, 3)}
      ${F("m", "mobility", "🦯 Mobilität", "z. B. Rollator, Treppe nur mit Hilfe")}
      ${F("l", "likes", "💚 Mag", "z. B. Tee am Morgen, Schlager, Spaziergang")}
      ${F("d", "dislikes", "🚫 Mag nicht", "z. B. Kaffee, laute Musik")}
      ${F("v", "directive", "📄 Patientenverfügung / Vollmacht (optional)", "z. B. Liegt im blauen Ordner im Wohnzimmer · Vorsorgevollmacht: Sascha", 300)}
      <p class="muted small">Steht auf der Notfallkarte. Die aktuellen Medikamente und Ärzte kommen automatisch aus dem Medikamentenplan und den Kontakten.</p>
      <div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">Speichern</button></div></form>`);
  $("#pf", sh).onsubmit = async (e) => { e.preventDefault(); const r = await busy(e.target.querySelector("[type=submit]"), () => call("profile_save", { id: s.id, ...fd(e.target) })).catch(() => null); if (r) { close(); toast("Profil gespeichert"); await reload(); } };
}
function bindHandoff(root) {
  $$("[data-care]", root).forEach((b) => (b.onclick = () => careSheet(b.dataset.care, b.dataset.sid)));
  $$("[data-cdel]", root).forEach((b) => (b.onclick = async () => { if (await confirmSheet("Eintrag löschen?", "Der Kurz-Eintrag wird entfernt.")) { await busy(null, () => call("care_delete", { id: b.dataset.cdel })).catch(() => {}); await reload(); } }));
  $$("[data-ho-take]", root).forEach((b) => (b.onclick = () => handoffSheet(b.dataset.hoTake, false)));
  $$("[data-ho-end]", root).forEach((b) => (b.onclick = () => handoffSheet(b.dataset.hoEnd, true)));
}
function greet() { const h = new Date().getHours(); return h < 11 ? "Guten Morgen" : h < 18 ? "Hallo" : "Guten Abend"; }
function lastStatusShort(sid) {
  const e = careOf(sid, 24)[0]; if (!e) return "";
  const k = careK(e.kind);
  return `${k.e} ${k.n}${e.note && k.imp ? ` – ${esc(e.note.length > 40 ? e.note.slice(0, 40) + "…" : e.note)}` : ""} · ${hm(e.created_at)} Uhr`;
}
// Personen-Karte (Wer ist da / nächster Termin)
function personCard(s) {
  const h = curHandoff(s.id), t = today(), ap = upcomingAppts().find((a) => a.senior_id === s.id && isoDay(a.starts_at) <= addDays(t, 1));
  const line = h ? `<span class="pc-l isthere"><i class="dotok" aria-hidden="true"></i>${h.taken_by === S.uid ? "Du bist da" : esc(nmPlain(h.taken_by)) + " ist da"}</span>` : `<span class="pc-l muted">Gerade niemand da</span>`;
  const sub = ap ? `<span class="pc-s">${ICON.cal}${isoDay(ap.starts_at) === t ? "" : "Morgen "}${hm(ap.starts_at)} ${esc(ap.title)}</span>` : lastStatusShort(s.id) ? `<span class="pc-s ell">${lastStatusShort(s.id)}</span>` : "";
  return `<a class="pcard" href="#/person/${s.id}" style="--pc:${sTone(s).c};--ps:${sTone(s).s}">${sAva(s, "xl", true)}<b>${esc(s.name)}</b>${line}${sub}</a>`;
}
// ---------- Startseite (Phase 26): „Heute“ – Kalender-Kachel, Haushalte (nach Adresse), Übersicht ↔ Übernehmen ----------
// Übersicht: alle Personen eines Haushalts als Spalten, nur lesen. Übernehmen: nur die übernommene(n) Person(en), alles abhakbar.
// Übernahmen sind pf_handoffs ohne ended_at – sie gelten bis Mitternacht (Ortszeit) oder bis „Abgeben“; parallel erlaubt.
const HH_NONE = "_";
const hhKey = (a) => String(a || "").split(/[,\n]/)[0].toLowerCase().replace(/stra(ß|ss)e/g, "str").replace(/[^\p{L}\p{N}]/gu, "");
const hhLabel = (a) => String(a || "").split(/[,\n]/)[0].trim();
function households() {
  const m = new Map();
  for (const s of S.D.seniors) {
    const k = hhKey(s.address) || HH_NONE;
    if (!m.has(k)) m.set(k, { key: k, label: k === HH_NONE ? "Ohne Adresse" : hhLabel(s.address), people: [] });
    m.get(k).people.push(s);
  }
  return [...m.values()].sort((a, b) => (a.key === HH_NONE) - (b.key === HH_NONE));
}
const midnightAfter = (iso) => { const d = new Date(iso); d.setHours(24, 0, 0, 0); return d.getTime(); };
// Ende einer Übernahme (ms) – offen gebliebene vom Vortag enden um Mitternacht; null = läuft noch
const hEnd = (h) => (h.ended_at ? new Date(h.ended_at).getTime() : isoDay(h.created_at) < today() ? midnightAfter(h.created_at) : null);
const hActive = (h) => hEnd(h) === null;
const activeCare = (sid) => (S.D.handoffs || []).filter((h) => h.senior_id === sid && hActive(h));
const myCare = () => (S.D.handoffs || []).filter((h) => h.taken_by === S.uid && hActive(h) && senior(h.senior_id));
// Fokus: Hat ICH jemanden übernommen, zeigen alle Reiter (Heute, Werte, Tagebuch, Kontakte, Medikamente, „+ Neu“) nur diese Person(en)
const focusIds = () => { if (!S.D || isSenior()) return null; const m = myCare(); return m.length ? new Set(m.map((h) => h.senior_id)) : null; };
const visSen = () => { const f = focusIds(); return f ? S.D.seniors.filter((s) => f.has(s.id)) : S.D?.seniors || []; };
const inFocus = (sid) => { const f = focusIds(); return !f || !sid || f.has(sid); };
const focusHint = () => { const f = focusIds(); if (!f) return ""; const ppl = visSen(); return `<p class="focus-hint">${ppl.slice(0, 3).map((p) => sAva(p, "xxs")).join("")}<span>Nur <b>${esc(joinDe(ppl.map((p) => p.name)))}</b> – du kümmerst dich gerade. Nach dem Abgeben siehst du wieder alle.</span></p>`; };
const joinDe = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " und " + xs[xs.length - 1]);
// Kurzname für Knöpfe: „Oma Hilde“ → „Oma“, „Tante Gerda“ → „Gerda“, „Maria Schulz“ → „Maria“
const shortName = (s) => { const w = String(s?.name || "").trim().split(/\s+/); return /^(oma|opa)$/i.test(w[0]) ? w[0] : /^(tante|onkel|frau|herr)$/i.test(w[0]) && w[1] ? w[1] : w[0] || "?"; };
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const wd = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - wd); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return Math.ceil(((t - y0) / 864e5 + 1) / 7); };
const EYE = '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
// Ruhiger Ring für die Startseite (petrol auf zartem Rosé; verpasste Einnahmen färben den Ring nicht rot)
function calmRing(done, total, size, stroke, key, label = true) {
  const r = (size - stroke) / 2 - 1, c = 2 * Math.PI * r, f = total ? Math.min(1, done / total) : 0, ok = total && done >= total;
  return `<span class="cring" style="width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#F3DCDF" stroke-width="${stroke}"/><circle class="rv" data-rk="${key}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${ok ? "#2D7350" : "#3A9488"}" stroke-width="${stroke}" stroke-linecap="round" style="stroke-dasharray:${(c * f).toFixed(1)} ${c.toFixed(1)}"/></svg>${label ? `<b>${ok ? ICON.check : `${done}/${total}`}</b>` : ""}</span>`;
}
// Zuständigkeit klein (nur Anzeige): Für dich · Offen · Kürzel
const whoMini = (x) => x.status === "in_progress" ? `<span class="wm wm-ip">In Arbeit · ${esc(initials(nmPlain(x.started_by || x.assignee_id)))}</span>`
  : x.assignee_id === S.uid ? `<span class="wm wm-me">Für dich</span>` : x.assignee_id ? `<span class="wm wm-ot" title="${esc(nmPlain(x.assignee_id))}" style="--m:${mHue(x.assignee_id)}">${esc(initials(nmPlain(x.assignee_id)))}</span>` : `<span class="wm wm-free">Offen</span>`;
const todayAppts = (forS) => S.D.appts.filter((a) => forS(a) && isoDay(a.starts_at) === today()).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
const todayTasks = (forS) => S.D.tasks.filter((x) => forS(x) && x.status !== "done" && ((x.due_date && x.due_date <= today()) || x.status === "in_progress")).sort(sortTasks);
// ---- Kalender-Kachel (schmal) → Monatsansicht mit Punkten je Person (● Termin, ○ Aufgabe) + Tagesliste ----
function calMarks(forS, from, to) {
  const marks = {}, add = (d, k, sid) => { if (!d || d < from || d > to) return; const m = (marks[d] ||= []); if (m.length < 4 && !m.some((x) => x.k === k && x.s === (sid || ""))) m.push({ k, s: sid || "" }); };
  for (const a of S.D.appts) if (forS(a)) add(isoDay(a.starts_at), "a", a.senior_id);
  for (const x of S.D.tasks) if (forS(x) && x.status !== "done") add(x.due_date, "t", x.senior_id);
  return marks;
}
const dotCol = (sid) => (sid && senior(sid) ? sCol(sid) : "#8A9497");
function calTile(forS, live) {
  const t = today(), dt = parseD(t), ta = todayAppts(forS), tt = todayTasks(forS).filter((x) => x.due_date === t);
  const dots = [...new Set([...ta, ...tt].map((x) => x.senior_id || ""))].slice(0, 4);
  const sumTxt = `KW ${isoWeek(dt)} · heute ${ta.length ? `${ta.length} ${ta.length === 1 ? "Termin" : "Termine"}` : "keine Termine"}`;
  if (!S.calOpen) return `<button class="card calt" id="calt" aria-expanded="false" aria-label="Kalender öffnen – ${esc(sumTxt)}">${sico("appt")}
    <span class="calt-t"><b>${dt.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</b><small>${sumTxt}</small></span>
    <span class="calt-d" aria-hidden="true">${dots.map((s) => `<i style="background:${dotCol(s)}"></i>`).join("")}</span><span class="calt-c" aria-hidden="true">${ICON.chev}</span></button>`;
  const m0 = S.calMonth || t.slice(0, 7), first = m0 + "-01", fd0 = parseD(first), start = addDays(first, -((fd0.getDay() + 6) % 7));
  const nDays = new Date(fd0.getFullYear(), fd0.getMonth() + 1, 0).getDate(), last = `${m0}-${String(nDays).padStart(2, "0")}`;
  const weeks = Math.ceil(((fd0.getDay() + 6) % 7 + nDays) / 7), end = addDays(start, weeks * 7 - 1), marks = calMarks(forS, start, end), sel = S.calDay || t;
  let cells = WD.map((w) => `<span class="mw">${w}</span>`).join("");
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i), m = marks[d] || [], out = d < first || d > last;
    cells += `<button class="md ${out ? "out" : ""} ${d === t ? "today" : ""} ${d === sel ? "on" : ""}" data-cday="${d}" aria-pressed="${d === sel}" aria-label="${esc(parseD(d).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" }))}${m.length ? " – Einträge" : ""}"><b>${parseD(d).getDate()}</b><span class="dots">${m.map((x) => `<i class="${x.k}" style="--c:${dotCol(x.s)}"></i>`).join("")}</span></button>`;
  }
  const ppl = S.D.seniors.filter((s) => forS({ senior_id: s.id }));
  const legend = `<div class="mleg"><span><i class="a" style="--c:#5B6568"></i>Termin</span><span><i class="t" style="--c:#5B6568"></i>Aufgabe</span>${ppl.length > 1 ? ppl.map((s) => `<span><i class="a" style="--c:${sCol(s.id)}"></i>${esc(shortName(s))}</span>`).join("") : ""}</div>`;
  const da = S.D.appts.filter((a) => forS(a) && isoDay(a.starts_at) === sel).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const dtk = S.D.tasks.filter((x) => forS(x) && x.due_date === sel).sort((a, b) => (a.status === "done") - (b.status === "done") || sortTasks(a, b));
  const row = (tm, title, sid, kind, attr, done) => `<${live ? `button type="button" ${attr}` : "div"} class="dl-r ${done ? "done" : ""}"><span class="tm">${tm}</span>${sico(kind, "xs")}<span class="tt">${esc(title)}</span>${sid && senior(sid) ? `<i class="pd" style="background:${sCol(sid)}" title="${esc(senior(sid).name)}"></i>` : ""}</${live ? "button" : "div"}>`;
  const lbl = (sel === t ? "Heute, " : sel === addDays(t, 1) ? "Morgen, " : "") + parseD(sel).toLocaleDateString("de-DE", { weekday: sel === t || sel === addDays(t, 1) ? undefined : "long", day: "numeric", month: "long" });
  return `<div class="card calo" id="calo"><div class="calo-h">${sico("appt")}<b>${fd0.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</b>
      <span class="calo-n"><button class="ib" data-cm="-1" aria-label="Voriger Monat">${ICON.chev}</button><button class="ib" data-cm="1" aria-label="Nächster Monat">${ICON.chev}</button><button class="ib up" id="calt" aria-expanded="true" aria-label="Kalender schließen">${ICON.chev}</button></span></div>
    <div class="mgrid">${cells}</div>${legend}
    <div class="dayl"><h3>${esc(lbl)}</h3>${da.map((a) => row(hm(a.starts_at), a.title, a.senior_id, "appt", `data-appt="${a.id}"`, false)).join("")}${dtk.map((x) => row(x.due_time ? x.due_time.slice(0, 5) : "", x.title, x.senior_id, "task", `data-task="${x.id}"`, x.status === "done")).join("")}
      ${!da.length && !dtk.length ? `<p class="muted small">Nichts eingetragen.</p>` : ""}${!live ? `<p class="dl-n">${EYE}Nur Übersicht</p>` : ""}</div></div>`;
}
// ---- Übersicht: Spalte je Person (nichts anklickbar) ----
function ovCol(s) {
  const t = today(), forS = (x) => x.senior_id === s.id, ap = todayAppts(forS), ts = todayTasks(forS);
  const ds = medDoses(t, s.id), st = medStats(ds), nx = openDoses(ds)[0], age = ageOf(s.birthdate);
  const others = activeCare(s.id).filter((h) => h.taken_by !== S.uid), now = Date.now();
  const cw = carerNow(s.id), cn = !cw && carerNext(s.id);
  const carerL = cw ? `<p class="ocare carer-now">${carerIco()}<span><b>${esc(cw.c.name)}</b> ist da · bis ${hmMs(cw.e)}</span></p>`
    : cn ? `<p class="ocare carer-next">${carerIco()}<span>Heute ${hmMs(cn.s)}–${hmMs(cn.e)}: ${esc(cn.c.name)}</span></p>` : "";
  const ro = (tm, title, sub) => `<div class="ro"><span class="tm">${tm}</span><div><div class="tt">${esc(title)}</div>${sub ? `<div class="ss">${sub}</div>` : ""}</div></div>`;
  const apH = ap.slice(0, 3).map((a) => { const past = new Date(a.ends_at || a.starts_at).getTime() < now; return ro(hm(a.starts_at), a.title, [a.location ? `<span class="ell">${esc(a.location)}</span>` : "", past ? `<span class="wm wm-ok">vorbei</span>` : whoMini(a)].filter(Boolean).join(" ")); }).join("");
  const tsH = ts.slice(0, 4).map((x) => ro(x.due_time ? x.due_time.slice(0, 5) : "", x.title, [x.due_date && x.due_date < t ? `<span class="wm wm-late">überfällig</span>` : "", whoMini(x)].filter(Boolean).join(" "))).join("");
  const med = ds.length ? `<div class="omed"><div class="omh">${calmRing(st.given, st.total, 46, 5, "ov" + s.id)}<p><b>Medikamente</b>${st.given === st.total ? "Alle gegeben" : nx.status === "missed" ? `Verpasst: ${nx.slot}` : `Nächste ${nx.slot}`}</p></div>
      <div class="oml">${ds.slice(0, 4).map((x) => `<div class="${x.status}"><span class="t">${x.slot}</span>${x.status === "given" ? `<span class="ok">${ICON.check}</span><span class="x">${esc(x.med.name)}</span>` : `<span class="o"></span><span>${esc(x.med.name)}</span>`}</div>`).join("")}${ds.length > 4 ? `<small class="muted">+ ${ds.length - 4} weitere</small>` : ""}</div></div>` : `<p class="oempty">${sico("med", "xs")}Heute keine Medikamente</p>`;
  return `<article class="ocol" data-col="${s.id}" style="--pc:${sTone(s).c};--ps:${sTone(s).s}" aria-label="${esc(s.name)} – Übersicht">
    <div class="oph">${sAva(s, "md")}<div><b>${esc(s.name)}</b><small>${age != null ? age + " J." : households().length > 1 && s.address ? esc(hhLabel(s.address)) : ""}</small></div></div>
    ${others.length ? `<p class="ocare">${others.slice(0, 2).map((h) => ava(h.taken_by, "xs")).join("")}<span><b>${esc(joinDe(others.map((h) => nmPlain(h.taken_by))))}</b> ${others.length === 1 ? "kümmert" : "kümmern"} sich gerade</span></p>` : ""}${carerL}
    <h3 class="ocs a">${ICON.cal}Termine heute</h3>${apH || `<p class="oempty">Keine Termine</p>`}${ap.length > 3 ? `<p class="omore">+ ${ap.length - 3} weitere</p>` : ""}
    <h3 class="ocs t">${ICON.tasks || ICON.check}Aufgaben</h3>${tsH || `<p class="oempty">Nichts offen</p>`}${ts.length > 4 ? `<p class="omore">+ ${ts.length - 4} weitere</p>` : ""}
    ${med}<span class="ospace"></span>
    <button class="otake" data-ctake="${s.id}">${ICON.handoff}<span>${esc(shortName(s))} übernehmen</span></button></article>`;
}
function homeOverview() {
  const hs = households(), cur = hs.find((h) => h.key === S.hh) || hs[0], ppl = cur.people, admin = isAdmin();
  const tabs = hs.length > 1 ? `<div class="hhtabs" id="hhtabs" role="tablist" aria-label="Haushalte">${hs.map((h, i) => `<button class="hht ${h === cur ? "on" : ""}" role="tab" aria-selected="${h === cur}" data-hh="${esc(h.key)}"><span class="hhi">${h.key === HH_NONE ? ICON.user : i === 0 ? ICON.home : ICON.pin}</span><span class="hht-t"><b>${esc(h.label)}</b><small><span class="avs">${h.people.slice(0, 4).map((p) => sAva(p, "xxs")).join("")}</span>${esc(h.people.map(shortName).join(", "))}</small></span></button>`).join("")}</div>` : "";
  const gen = todayTasks((x) => !x.senior_id), genA = todayAppts((a) => !a.senior_id);
  const general = gen.length || genA.length ? `<div class="card ogen"><h3 class="ocs">${ICON.user}Für alle · heute</h3>${[...genA.map((a) => `<div class="ro"><span class="tm">${hm(a.starts_at)}</span><div><div class="tt">${esc(a.title)}</div><div class="ss">${whoMini(a)}</div></div></div>`), ...gen.map((x) => `<div class="ro"><span class="tm">${x.due_time ? x.due_time.slice(0, 5) : ""}</span><div><div class="tt">${esc(x.title)}</div><div class="ss">${whoMini(x)}</div></div></div>`)].slice(0, 5).join("")}</div>` : "";
  const hhBtn = ppl.length > 1 ? `<button class="hhtake" data-ctake="${ppl.map((p) => p.id).join(",")}">${ICON.home}<span>${cur.key === HH_NONE ? (ppl.length === 2 ? "Beide" : "Alle") : esc(cur.label)} übernehmen</span></button>` : "";
  return `${tabs}<div class="ocols n${Math.min(ppl.length, 3)}" id="ocols">${ppl.map(ovCol).join("")}</div>
    ${ppl.length > 2 ? `<p class="oswipe" aria-hidden="true">${ppl.map((p, i) => `<i class="${i < 2 ? "on" : ""}"></i>`).join("")}</p>` : ""}
    ${hhBtn}<p class="onote">${EYE}Nur Übersicht · zum Abhaken Person übernehmen</p>${general}
    ${admin ? `<button class="addp" data-act="add-senior">${ICON.plus}Person hinzufügen</button>` : ""}`;
}
// ---- Übernommen: nur die eigene(n) Person(en), alles abhakbar ----
function homeFocus(mine) {
  const sids = [...new Set(mine.map((h) => h.senior_id))], ppl = sids.map(senior), set = new Set(sids), t = today();
  const forS = (x) => !x.senior_id || set.has(x.senior_id), f = S.taskFilter === "mine" || S.taskFilter === "free" ? S.taskFilter : "open";
  const mineOk = (x) => (f !== "mine" || x.assignee_id === S.uid) && (f !== "free" || !x.assignee_id);
  const since = mine.map((h) => h.created_at).sort()[0];
  const others = [...new Set(sids.flatMap((sid) => activeCare(sid).filter((h) => h.taken_by !== S.uid).map((h) => h.taken_by)))];
  const ap = todayAppts(forS).filter(mineOk), ts = todayTasks(forS).filter(mineOk);
  const doneT = S.D.tasks.filter((x) => forS(x) && mineOk(x) && x.status === "done" && x.completed_at && isoDay(x.completed_at) === t);
  const ds = sids.flatMap((sid) => medDoses(t, sid)).sort((a, b) => a.slot.localeCompare(b.slot)), st = medStats(ds), nx = openDoses(ds)[0];
  const cnt = (k) => [...todayAppts(forS), ...todayTasks(forS)].filter((x) => (k === "mine" ? x.assignee_id === S.uid : !x.assignee_id)).length;
  const fchips = `<div class="chips fchips" role="group" aria-label="Filtern: wer ist zuständig?">${[["mine", "Für mich"], ["free", "Offen"], ["open", "Alle"]].map(([k, l]) => { const n = k === "open" ? 0 : cnt(k); return `<button class="chip f-${k} ${f === k ? "on" : ""}" data-tf="${k}" aria-pressed="${f === k}">${k === "mine" ? ava(S.uid, "xs") : k === "free" ? '<i class="odot" aria-hidden="true"></i>' : ""}${l}${n ? ` <span class="cn">${n}</span>` : ""}</button>`; }).join("")}</div>`;
  const hidden = S.D.seniors.filter((s) => !set.has(s.id));
  const names = joinDe(ppl.map((p) => p.name));
  // Pflegedienst laut Einsatzplan gerade da (oder heute noch erwartet) – automatisch, parallel zur eigenen Übernahme
  const carerL = ppl.map((p) => { const w = carerNow(p.id), n = !w && carerNext(p.id); return w ? `<p class="cb-carer now">${carerIco()}<span><b>${esc(w.c.name)}</b> ist ${ppl.length > 1 ? "bei " + esc(shortName(p)) + " " : ""}da · bis ${hmMs(w.e)}</span></p>` : n ? `<p class="cb-carer">${carerIco()}<span>${esc(n.c.name)} kommt ${ppl.length > 1 ? "zu " + esc(shortName(p)) + " " : ""}heute um ${hmMs(n.s)}</span></p>` : ""; }).join("");
  // Medikamente: standardmäßig eingeklappt (Ring + Kurztext); eine gerade fällige/überfällige Einnahme steht direkt darunter
  const medOpen = foldOpen("med"), dueNow = ds.filter((x) => x.status !== "given" && x.sched <= Date.now()).sort((a, b) => (a.status === "missed" ? 0 : 1) - (b.status === "missed" ? 0 : 1) || a.sched - b.sched)[0];
  const restDs = ds.filter((x) => x !== dueNow);
  const medTxt = nx ? `${nx.status === "missed" ? "Verpasst" : nx.sched <= Date.now() ? "Fällig" : "Nächste"}: ${esc(nx.med.name)} ${nx.slot}` : "Alles für heute erledigt ✓";
  return `<div class="carebar" id="carebar"><span class="cb-av">${ppl.slice(0, 3).map((p) => sAva(p, "md")).join("")}</span>
      <div class="cb-t"><b>Du kümmerst dich gerade um ${esc(names)}</b><small>seit ${hm(since)} Uhr · ${others.length ? `${esc(joinDe(others.map(nmPlain)))} auch` : "Familie sieht das"}</small></div>
      <button class="cb-give" id="care-give">Abgeben</button></div>${carerL}
    ${fchips}
    <div class="card blk"><h3 class="bh a">${ICON.cal}Termine heute <span class="muted">${ap.length || ""}</span></h3><div class="list">${ap.map(apptRow).join("") || `<p class="muted small bempty">Heute keine Termine${f !== "open" ? " in diesem Filter" : ""}.</p>`}</div></div>
    <div class="card blk"><h3 class="bh t">${ICON.tasks || ICON.check}Aufgaben <span class="muted">${ts.length || ""}</span></h3><div class="list">${ts.map((x) => taskRow(x, { noSenior: ppl.length < 2 })).join("")}${f !== "free" ? doneT.map((x) => taskRow(x, { noSenior: ppl.length < 2 })).join("") : ""}${!ts.length && !doneT.length ? `<p class="muted small bempty">Für heute nichts offen. 🌿</p>` : ""}</div></div>
    ${ds.length ? `<div class="card blk medblk foldc ${medOpen ? "open" : ""}"><h3 class="bh m">${ICON.pill}Medikamente</h3>
      <button type="button" class="mbig mtog" data-fold="med" aria-expanded="${medOpen}" aria-controls="med-fold">${calmRing(st.given, st.total, 72, 8, "fm")}<p><b>${st.given} von ${st.total} gegeben</b>${medTxt}</p><span class="fchev" aria-hidden="true">${ICON.chev}</span><span class="vhide">${medOpen ? "Liste einklappen" : "Alle Einnahmen zeigen"}</span></button>
      ${dueNow ? `<div class="list mdue">${doseRow(dueNow, { noSenior: ppl.length < 2 })}</div>` : ""}
      ${restDs.length ? `<div class="fold" id="med-fold" ${medOpen ? "" : "inert"}><div class="fold-in"><div class="list">${restDs.map((x) => doseRow(x, { noSenior: ppl.length < 2 })).join("")}</div></div></div>` : ""}</div>` : ""}
    <section class="plan-s" id="plan-s" aria-label="Demnächst und erledigt">${planBody({ forS, home: true })}</section>
    <div class="plinks">${ppl.map((p) => `<a class="plink card" href="#/person/${p.id}">${sAva(p, "sm")}<span><b>${esc(p.name)}</b><small>Profil, Notfallkarte, Kurz notieren</small></span>${ICON.chev}</a>`).join("")}</div>
    ${hidden.length ? `<p class="hidn"><span class="avs">${hidden.slice(0, 4).map((p) => sAva(p, "xxs")).join("")}</span><span>${esc(joinDe(hidden.map(shortName)))} ${hidden.length === 1 ? "ist" : "sind"} ausgeblendet und ${hidden.length === 1 ? "kommt" : "kommen"} nach dem Abgeben zurück.</span></p>` : ""}`;
}
function pageHome() {
  const pushHint = !DEMO && "Notification" in window && "PushManager" in window && Notification.permission === "default" && !localStorage.getItem("pf-pushhint");
  const mine = myCare(), live = mine.length > 0, set = new Set(mine.map((h) => h.senior_id));
  const forS = live ? (x) => !x.senior_id || set.has(x.senior_id) : () => true;
  return `<div class="home ${live ? "focus" : "ov"}">${calTile(forS, live)}
    ${pushHint ? `<div class="banner push"><span>${S.pushMove ? "🔔 Pflegekreis hat eine neue Adresse – bitte Benachrichtigungen hier einmal neu einschalten." : "🔔 Erfahre sofort, wenn dir jemand eine Aufgabe gibt."}</span><div class="row"><button class="btn small" id="push-on">Aktivieren</button><button class="link small" id="push-later">Später</button></div></div>` : ""}
    ${!S.D.seniors.length ? `<div class="card empty">${sico("care", "lg c")}<h3>Für wen sorgt ihr?</h3><p class="muted">Lege die erste Person an, um Aufgaben, Termine und Medikamente zuzuordnen.</p><button class="btn" data-act="add-senior">Person anlegen</button></div>
      <section class="plan-s" id="plan-s" aria-label="Plan: Aufgaben und Termine">${planBody()}</section>`
      : live ? homeFocus(mine) : homeOverview()}</div>`;
}
// Auf-/Zuklappen (Startseite): Zustand pro Sitzung merken, sanft animiert (CSS grid-rows), ohne neu zu zeichnen
const foldOpen = (k) => { try { return sessionStorage.getItem("pf-fold-" + k) === "1"; } catch { return false; } };
function bindFolds(root) {
  $$("[data-fold]", root).forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const box = b.closest(".foldc"), o = !box.classList.contains("open"), f = $(":scope > .fold", box);
    box.classList.toggle("open", o); b.setAttribute("aria-expanded", String(o)); if (f) f.inert = !o;
    const sr = $(".vhide", b); if (sr) sr.textContent = o ? "Liste einklappen" : "Alle Einnahmen zeigen";
    try { sessionStorage.setItem("pf-fold-" + b.dataset.fold, o ? "1" : "0"); } catch {}
  }));
}
async function careTake(ids) {
  ids = ids.filter((id) => senior(id)); if (!ids.length) return;
  const ppl = ids.map(senior), now = new Date().toISOString();
  // sofort umschalten (optimistisch), Server bestätigt
  for (const id of ids) if (!activeCare(id).some((h) => h.taken_by === S.uid)) S.D.handoffs.unshift({ id: "tmp-" + id, senior_id: id, taken_by: S.uid, from_user: null, created_at: now, ended_at: null });
  S.calDay = ""; render(true); window.scrollTo(0, 0);
  try { await call("care_take", { senior_ids: ids }); toast(`Du kümmerst dich jetzt um ${joinDe(ppl.map((p) => p.name))}`); }
  catch (e) { S.D.handoffs = S.D.handoffs.filter((h) => !String(h.id).startsWith("tmp-")); render(true); }
  await reload();
}
async function careRelease() {
  const mine = myCare(), names = joinDe([...new Set(mine.map((h) => senior(h.senior_id)?.name).filter(Boolean))]), now = new Date().toISOString();
  for (const h of mine) h.ended_at = now;
  S.calDay = ""; render(true); window.scrollTo(0, 0);
  try { await call("care_release", {}); toast(`${names} abgegeben – alle sind wieder da`); } catch {}
  await reload();
}
function bindHome(root) {
  const tile = $("#calt", root); if (tile) tile.onclick = () => { S.calOpen = !S.calOpen; if (!S.calOpen) { S.calMonth = ""; S.calDay = ""; } render(true); };
  $$("[data-cm]", root).forEach((b) => (b.onclick = () => { const [y, m] = (S.calMonth || today().slice(0, 7)).split("-").map(Number), d = new Date(y, m - 1 + Number(b.dataset.cm), 1); S.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; render(true); }));
  $$("[data-cday]", root).forEach((b) => (b.onclick = () => { S.calDay = b.dataset.cday; render(true); }));
  $$("[data-hh]", root).forEach((b) => (b.onclick = () => { S.hh = b.dataset.hh; localStorage.setItem("pf-hh", S.hh); render(true); }));
  $$("[data-ctake]", root).forEach((b) => (b.onclick = () => careTake(b.dataset.ctake.split(","))));
  const g = $("#care-give", root); if (g) g.onclick = () => careRelease();
  bindFolds(root);
  const cols = $("#ocols", root), dots = $$(".oswipe i", root);
  if (cols && dots.length) cols.addEventListener("scroll", () => { const w = cols.firstElementChild?.getBoundingClientRect().width || 1, i = Math.round(cols.scrollLeft / (w + 10)); dots.forEach((d, n) => d.classList.toggle("on", n >= i && n < i + 2)); }, { passive: true });
  const hh = $("#hhtabs .on", root), hc = $("#hhtabs", root); if (hh && hc) hc.scrollLeft += hh.getBoundingClientRect().left - hc.getBoundingClientRect().left - 16;
}
// Schmaler Wochenstreifen: 7 Tage je Seite, seitlich wischbar (6 Wochen), Punkte in Personenfarbe (● Termin, ○ Aufgabe)
const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
function weekStrip(forS) {
  const t = today(), mon = addDays(t, -((parseD(t).getDay() + 6) % 7)), marks = {};
  const add = (d, k, sid) => { if (!d) return; const m = (marks[d] ||= []); if (m.length < 3 && !m.some((x) => x.k === k && x.s === (sid || ""))) m.push({ k, s: sid || "" }); };
  for (const a of S.D.appts) if (forS(a)) add(isoDay(a.starts_at), "a", a.senior_id);
  for (const x of openTasks()) if (forS(x)) add(x.due_date, "t", x.senior_id);
  let pages = "";
  for (let w = 0; w < 6; w++) {
    let cells = "";
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, w * 7 + i), m = marks[d] || [], dt = parseD(d);
      const lbl = dt.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" }) + (m.length ? `: ${m.filter((x) => x.k === "a").length ? "Termine" : ""}${m.filter((x) => x.k === "a").length && m.filter((x) => x.k === "t").length ? " und " : ""}${m.filter((x) => x.k === "t").length ? "Aufgaben" : ""}` : "");
      cells += `<button class="wd ${d === t ? "today" : ""} ${d === S.planDay ? "on" : ""} ${d < t ? "past" : ""}" data-pday="${d}" aria-pressed="${d === S.planDay}" aria-label="${esc(lbl)}"><small>${WD[i]}</small><b>${dt.getDate()}</b><span class="dots">${m.map((x) => `<i class="${x.k}" style="--c:${x.s ? sCol(x.s) : "#8A9497"}"></i>`).join("")}</span></button>`;
    }
    const m1 = parseD(addDays(mon, w * 7)), m2 = parseD(addDays(mon, w * 7 + 6));
    pages += `<div class="wkp" aria-label="${esc(m1.toLocaleDateString("de-DE", { day: "numeric", month: "long" }) + " bis " + m2.toLocaleDateString("de-DE", { day: "numeric", month: "long" }))}">${cells}</div>`;
  }
  return `<div class="wkstrip" id="wkstrip" role="group" aria-label="Tag wählen – seitlich wischen für weitere Wochen">${pages}</div>`;
}
// ---------- Plan (auf der Startseite): Aufgaben + Termine als Liste (Heute / Morgen / Später), Neues über „+ Neu“ ----------
const planHead = () => `<div class="sec-h plan-h"><h2 class="hi">${sico("task")}<span>Plan</span></h2><span class="muted small">Neues über <b>+ Neu</b></span></div>`;
function planBody(opts = {}) {
  const t = today(), home = !!opts.home, sid = !home && S.taskSenior && senior(S.taskSenior) ? S.taskSenior : "", f = S.taskFilter === "mine" || S.taskFilter === "free" ? S.taskFilter : "open";
  const forS = opts.forS || ((x) => !sid || x.senior_id === sid);
  const mineOk = (x) => (f !== "mine" || x.assignee_id === S.uid) && (f !== "free" || !x.assignee_id);
  const upA = S.D.appts.filter((a) => forS(a) && (isoDay(a.starts_at) >= t || new Date(a.ends_at || a.starts_at) >= new Date(Date.now() - 3600e3)));
  const cnt = (k) => S.D.tasks.filter((x) => forS(x) && x.status !== "done" && (k === "mine" ? x.assignee_id === S.uid : !x.assignee_id)).length + upA.filter((a) => (k === "mine" ? a.assignee_id === S.uid : !a.assignee_id)).length;
  const pchips = !home && multiSen() ? `<div class="pchips" role="group" aria-label="Für wen?"><button class="pchip ${!sid ? "on" : ""}" data-ts="">Alle</button>${S.D.seniors.map((s) => `<button class="pchip ${sid === s.id ? "on" : ""}" data-ts="${s.id}" style="--pc:${sTone(s).c};--ps:${sTone(s).s};--pd:${sTone(s).d}">${sAva(s, "sm")}${esc(s.name)}</button>`).join("")}</div>` : "";
  const fchips = `<div class="chips fchips" role="group" aria-label="Plan filtern: wer ist zuständig?">${[["mine", "Für mich", "user"], ["free", "Offen", ""], ["open", "Alle", ""]].map(([k, l]) => { const n = k === "open" ? 0 : cnt(k); return `<button class="chip f-${k} ${f === k ? "on" : ""}" data-tf="${k}" aria-pressed="${f === k}">${k === "mine" ? ava(S.uid, "xs") : k === "free" ? '<i class="odot" aria-hidden="true"></i>' : ""}${l}${n ? ` <span class="cn">${n}</span>` : ""}</button>`; }).join("")}</div>`;
  const open = S.D.tasks.filter((x) => forS(x) && x.status !== "done" && mineOk(x));
  const items = [...open.map((x) => ({ d: x.due_date || "", k: x.due_time || "99:99", h: taskRow(x) })),
    ...upA.filter(mineOk).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map((a) => ({ d: isoDay(a.starts_at), k: hm(a.starts_at), h: apptRow(a) }))];
  // heute erledigt → unten in „Heute“ (dorthin gleitet ein abgehakter Eintrag)
  const doneToday = S.D.tasks.filter((x) => forS(x) && f !== "free" && mineOk(x) && x.status === "done" && x.completed_at && isoDay(x.completed_at) === t).sort((a, b) => (a.completed_at || "").localeCompare(b.completed_at || ""));
  const groups = [...(home ? [] : [["Überfällig", (x) => x.d && x.d < t, "late"], ["Heute", (x) => x.d === t, "today"]]), ["Morgen", (x) => x.d === addDays(t, 1), "tom"], ["Später", (x) => x.d > addDays(t, 1), "later"], ["Ohne Datum", (x) => !x.d, "nodate"]];
  const body = groups.map(([g, fn, cls]) => {
    const xs = items.filter(fn).sort((a, b) => a.d.localeCompare(b.d) || a.k.localeCompare(b.k)).map((x) => x.h);
    const dn = cls === "today" ? doneToday.map((x) => taskRow(x)) : [];
    if (!xs.length && !dn.length) return "";
    // Startseite (übernommen): „Später“ standardmäßig eingeklappt – nur Kopfzeile „Später · N“, Antippen klappt auf
    if (home && cls === "later") { const o = foldOpen("later"); return `<section class="pgrp later foldc ${o ? "open" : ""}"><h3 class="grp"><button type="button" class="fold-h" data-fold="later" aria-expanded="${o}" aria-controls="later-fold">Später <span class="muted">· ${xs.length}</span><span class="fchev" aria-hidden="true">${ICON.chev}</span></button></h3><div class="fold" id="later-fold" ${o ? "" : "inert"}><div class="fold-in"><div class="list">${xs.join("")}</div></div></div></section>`; }
    return `<section class="pgrp ${cls}"><h3 class="grp ${cls === "late" ? "late" : ""}">${cls === "late" ? sico("late", "xs") : ""}${g} <span class="muted">${xs.length || ""}</span></h3><div class="list">${cls === "later" || cls === "nodate" ? more(xs, 6) : xs.join("")}${dn.join("")}</div></section>`;
  }).join("");
  const done = S.D.tasks.filter((x) => forS(x) && x.status === "done" && !(x.completed_at && isoDay(x.completed_at) === t)).sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
  if (home) {
    // übernommene Person(en): „Heute“ steht schon oben – hier nur Demnächst + Früher erledigt (heute Erledigtes steht oben)
    const items2 = items.filter((x) => !(x.d && x.d <= t));
    const doneH = done.length ? `<details class="pdone"><summary>${sico("done", "xs")}Früher erledigt <span class="muted">${done.length} · letzte 30 Tage</span></summary><div class="list">${more(done.map((x) => taskRow(x)), 10)}</div></details>` : "";
    return `<div class="sec-h plan-h"><h2 class="hi">${sico("task")}<span>Demnächst</span></h2><span class="muted small">Neues über <b>+ Neu</b></span></div>${body || (items2.length ? "" : emptyBox("task", "Demnächst ist nichts geplant."))}${doneH}`;
  }
  if (S.planDay) {
    const d = S.planDay, da = S.D.appts.filter((a) => forS(a) && isoDay(a.starts_at) === d && mineOk(a)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const dt = S.D.tasks.filter((x) => forS(x) && mineOk(x) && x.due_date === d).sort((a, b) => (a.status === "done") - (b.status === "done") || sortTasks(a, b));
    const ttl = (d === t ? "Heute, " : d === addDays(t, 1) ? "Morgen, " : "") + parseD(d).toLocaleDateString("de-DE", { weekday: d === t || d === addDays(t, 1) ? undefined : "long", day: "numeric", month: "long" });
    return `${planHead()}${pchips}${weekStrip(forS)}${fchips}
      <section class="pgrp pday"><h3 class="grp today">${esc(ttl)} <span class="muted">${da.length + dt.filter((x) => x.status !== "done").length || ""}</span><button class="link small" data-pday="${d}">Alle Tage zeigen</button></h3>
      <div class="list">${da.map(apptRow).join("")}${dt.map((x) => taskRow(x)).join("")}${!da.length && !dt.length ? emptyBox("appt", "An diesem Tag ist nichts eingetragen.") : ""}</div></section>`;
  }
  const doneSec = done.length ? `<details class="pdone"><summary>${sico("done", "xs")}Früher erledigt <span class="muted">${done.length} · letzte 30 Tage</span></summary><div class="list">${more(done.map((x) => taskRow(x)), 10)}</div></details>` : "";
  return `${planHead()}${pchips}${weekStrip(forS)}${fchips}
    ${body || emptyBox("task", f === "mine" ? "Gerade ist nichts für dich eingeplant." : f === "free" ? "Alles ist verteilt – nichts offen." : "Gerade ist nichts geplant. Tippe unten auf „+ Neu“.", f === "open" ? "ok" : "")}${doneSec}`;
}
const emptyBox = (c, text, cls = "") => `<div class="card empty slim ${cls}"><p class="emp">${sico(c)}<span>${text}</span></p></div>`;
function newSheet() {
  const pg = route().page;
  const { sh, close } = openSheet(`<h2>Neu anlegen</h2><div class="choices">
    <button class="choice" data-new="appt">${sico("appt", "lg")}<b>Termin</b><small>Arzt, Pflege, Besuch …</small></button>
    <button class="choice" data-new="task">${sico("task", "lg")}<b>Aufgabe</b><small>Etwas, das jemand erledigen soll</small></button>
    ${S.D.seniors.length ? `<button class="choice" data-new="med">${sico("med", "lg")}<b>Medikament</b><small>Mit festen Uhrzeiten und Erinnerung</small></button>` : ""}
    ${S.D.seniors.length ? `<button class="choice" data-new="vital">${sico("vit", "lg")}<b>Wert messen</b><small>Blutdruck, Zucker, Gewicht, Temperatur …</small></button>` : ""}
    <button class="choice" data-new="contact">${sico("contact", "lg")}<b>Kontakt</b><small>Arzt, Apotheke, Pflegedienst – mit Adresse und Telefon</small></button></div>`);
  $$("[data-new]", sh).forEach((b) => (b.onclick = () => {
    close(); const k = b.dataset.new;
    const psid = pg === "person" && senior(route().id) ? route().id : visSen().length === 1 && focusIds() ? visSen()[0].id : null;
    const pd = pg === "home" && S.calOpen && S.calDay ? S.calDay : today();
    if (k === "task") taskForm({}, { senior_id: psid || (pg === "home" ? S.taskSenior : "") || null, due_date: pg === "home" ? pd : "" });
    else if (k === "vital") vitalForm(null, { senior_id: psid || (pg === "werte" ? vSid() : pg === "home" ? S.taskSenior : "") || null });
    else if (k === "appt") apptForm({}, { senior_id: psid || null, day: pd });
    else if (k === "contact") contactForm({}, { senior_id: psid || null });
    else medForm(null, psid ? { senior_id: psid } : {});
  }));
}
// ---------- Person: Übergabe, Medikamente, Profil und Verlauf an einem Ort ----------
const PTABS = [["heute", "Heute", "appt"], ["medis", "Medikamente", "med"], ["profil", "Profil", "info"], ["verlauf", "Verlauf", "journal"]];
function pageSenior(id, sub) {
  const s = senior(id);
  if (!s) return `<div class="card empty"><p>Person nicht gefunden.</p><a class="btn" href="#/">Zur Übersicht</a></div>`;
  S.pTab ||= {};
  const tab = S.pTab[id] || "heute";
  const h = curHandoff(id), me = h?.taken_by === S.uid;
  const body = tab === "medis" ? personMeds(s) : tab === "profil" ? personProfile(s) : tab === "verlauf" ? personLog(s) : personToday(s);
  return `<a href="#/" class="back">${ICON.back} Heute</a>
    <section class="ho-head" style="--c:${sTone(s).c}">
      <div class="ph-row">${sAva(s, "lg", true)}<div class="ph-t"><h1>${esc(s.name)}</h1>${respLine(id)}</div><div class="ph-a"><a class="sos-btn" href="#/notfall/${id}" aria-label="Notfallkarte für ${esc(s.name)}">${ICON.sos}<span>Notfall</span></a><button class="link small" data-act="edit-senior" data-id="${id}">Bearbeiten</button></div></div>
      ${me ? `<button class="btn block light" data-ho-end="${id}">👋 Ich gehe – Übergabe abschließen</button>` : `<button class="btn block light" data-ho-take="${id}">🙋 Ich bin jetzt da</button>`}
    </section>
    ${s.allergies ? `<div class="banner alert" role="note"><b>⚠️ Allergien:</b> ${esc(s.allergies)}</div>` : ""}
    <div class="tabs" role="tablist" aria-label="Bereiche">${PTABS.map(([k, l, c]) => `<button role="tab" data-ptab="${k}" class="k-${c} ${tab === k ? "on" : ""}" aria-selected="${tab === k}">${ICON[CAT[c][0]]}${l}</button>`).join("")}</div>
    ${body}`;
}
function personToday(s) {
  const id = s.id, all = medDoses(today(), id), tt = todayTasksOf(id), ap = upcomingAppts().find((a) => a.senior_id === id);
  const care = careOf(id, 24);
  return `<section><div class="sec-h">${h2i("care", "Kurz notiert")}<span class="muted small">letzte 24 Std.</span></div>
      <div class="card">${care.length ? `<ul class="care-list">${care.slice(0, 2).map((e) => careRow(e)).join("")}</ul>${care.length > 2 ? `<button class="link small" data-ptab="verlauf">Alle ${care.length} Einträge</button>` : ""}` : `<p class="muted small">Heute noch nichts notiert.</p>`}
      <p class="qlabel">Kurz notieren</p>${quickChips(id)}</div></section>
    ${all.length ? medMini(id).replace('data-go="#/medikamente"', `data-ptab="medis"`) : ""}
    ${vMini(id)}
    <section><div class="sec-h">${h2i("task", "Heute offen")}</div>
      <div class="list">${tt.length ? more(tt.map((t) => taskRow(t, { noSenior: true })), 4) : emptyBox("task", "Heute ist nichts mehr offen.")}</div></section>
    <section><div class="sec-h">${h2i("appt", "Nächster Termin")}</div><div class="list">${ap ? apptRow(ap) : `<p class="muted small">Kein Termin geplant.</p>`}</div>
      <button class="link-row" data-act="plan-for" data-sid="${id}"><span>Alle Aufgaben und Termine für ${esc(s.name)}</span>${ICON.chev}</button></section>`;
}
// Kleine Werte-Leiste in der Person: letzter Blutdruck und Zucker, „Messen“
function vMini(sid) {
  const xs = ["bp", "glucose"].map((k) => vOf(sid, k)[0]).filter(Boolean);
  return `<section><div class="sec-h">${h2i("vit", "Werte")}<a class="link small" href="#/werte/${sid}">Alle Werte</a></div><div class="vmini">${xs.map((v) => `<button class="vchip st-${vClass(v) || "none"}" data-vital="${v.kind}" data-sid="${sid}"><small>${VK[v.kind].n}</small><b>${vMain(v)} <small>${vUnit(v.kind)}</small></b><small>${esc(vWhen(v.measured_at))}</small></button>`).join("")}<button class="vchip add" data-act="new-vital" data-sid="${sid}">${ICON.plus}<small>Messen</small></button></div></section>`;
}
function personMeds(s) {
  return `${ringTile(s.id) || emptyBox("med", "Heute sind keine Einnahmen geplant.")}${medList(s.id)}`;
}
function personProfile(s) {
  const notes = S.D.notes.filter((n) => n.senior_id === s.id && !n.task_id);
  return `<section><div class="sec-h">${h2i("info", "Wichtig zu wissen")}</div>${profileCard(s)}</section>
    ${shiftSection(s)}
    <section class="sos-links"><div class="sec-h"><h2 class="hi"><span class="sico k-sos">${ICON.sos}</span><span>Notfall und Arztbesuch</span></h2></div>
      <div class="card list-card"><a class="link-row" href="#/notfall/${s.id}"><span class="lr-ic">${ICON.sos}</span><span><b>Notfallkarte</b><small>Medikamente, Allergien, Ärzte – groß lesbar, auch offline, zum Drucken</small></span>${ICON.chev}</a>
      <button class="link-row" data-act="report" data-sid="${s.id}"><span class="lr-ic">${ICON.report}</span><span><b>Arzt-Bericht als PDF</b><small>Werte, Einnahmetreue und Fragen für den nächsten Termin</small></span>${ICON.chev}</button></div></section>
    <section><div class="sec-h">${h2i("note", "Notizen")}</div><div class="card">${notesList(notes)}
      <form class="note-add" id="snote"><input class="inp" name="body" placeholder="z. B. Schlüssel liegt beim Nachbarn" maxlength="1000" required aria-label="Neue Notiz"><button class="btn" aria-label="Notiz speichern">${ICON.plus}</button></form></div></section>`;
}
function personLog(s) {
  return `${journalBody({ sid: s.id, embedded: true })}
    <button class="link-row" data-act="journal-for" data-sid="${s.id}"><span>Im Tagebuch öffnen (mit Wochenübersicht)</span>${ICON.chev}</button>${fabCtx("journal-add", "Eintrag", s.id)}`;
}
function pageHandoffPick(sid) {
  if (sid && senior(sid)) return pageSenior(sid);
  if (S.D.seniors.length === 1) return pageSenior(S.D.seniors[0].id);
  return `<a href="#/" class="back">${ICON.back} Heute</a><div class="page-h"><h1>Übergabe</h1><p class="muted">Für wen übernimmst du gerade?</p></div>
    <div class="list">${S.D.seniors.map((s) => `<a class="ho-pick" href="#/person/${s.id}" style="--c:${sTone(s).c}">${sAva(s)}<span><b>${esc(s.name)}</b>${respLine(s.id)}</span><span class="chev">${ICON.chev}</span></a>`).join("") || `<div class="card empty"><p>Lege zuerst eine Person an.</p><button class="btn" data-act="add-senior">Person anlegen</button></div>`}</div>`;
}
// ---------- Tagebuch: wer hat wann was gemacht (Zeitstrahl je Tag, Wochenübersicht) ----------
// Quelle sind die echten Daten (Kurz-Einträge, Gaben, Übergaben, erledigte Aufgaben, Termine) – nicht der Chat.
const JCAT = {
  med: { i: "💊", n: "Medikament" }, food: { i: "🍽️", n: "Essen" }, sleep: { i: "😴", n: "Schlaf" }, mood: { i: "😊", n: "Stimmung" },
  health: { i: "⚠️", n: "Gesundheit" }, handoff: { i: "🤝", n: "Übergabe" }, task: { i: "✅", n: "Aufgabe" }, appt: { i: "📅", n: "Termin" }, vit: { i: "🩺", n: "Werte" },
};
const JK = { med: "med", task: "task", appt: "appt", handoff: "handoff", vit: "vit" }; // Befinden-Einträge behalten ihr Emoji am Knoten
const CARE_CAT = { med: "med", ate_well: "food", ate_little: "food", slept_well: "sleep", slept_bad: "sleep", mood_good: "mood", mood_ok: "mood", mood_bad: "mood", restless: "mood", pain: "health", special: "health", help: "health" };
const JWIN = 7; // so viele Tage zurück lädt load() – ältere Tage holt das Tagebuch bei Bedarf nach
const jState = () => (S.j ||= { day: today(), view: "day", sen: "", mem: "", x: { care: [], doses: [], handoffs: [], tasks: [], appts: [], vitals: [] }, got: new Set(), busy: new Set() });
const uniqBy = (xs) => { const m = new Map(); for (const x of xs) m.set(x.id, x); return [...m.values()]; };
const jAll = (k) => uniqBy([...(S.D[k] || []), ...(jState().x[k] || [])]);
const dayBounds = (d) => [new Date(d + "T00:00:00").getTime(), new Date(addDays(d, 1) + "T00:00:00").getTime()];
const tod = (ms, d) => { const [a] = dayBounds(d); return Math.max(0, Math.min(100, ((ms - a) / 864e5) * 100)); };
const memColor = (uid) => (uid ? mHue(uid) : "#8A9497");
const medById = (id) => (S.D.meds || []).find((m) => m.id === id);
async function jEnsure(d) {
  const J = jState();
  if (d >= addDays(today(), -JWIN) || J.got.has(d) || J.busy.has(d) || !API.journal) return;
  J.busy.add(d);
  try { const r = await API.journal(S.fid, d); for (const k of Object.keys(J.x)) J.x[k] = uniqBy([...J.x[k], ...(r[k] || [])]); J.got.add(d); }
  catch (e) { toast(e.message, 4000); }
  J.busy.delete(d);
  if (route().page === "tagebuch" || route().page === "person") render(true);
}
// Wer war wann verantwortlich (Übergaben) – Abschnitte eines Tages je Person
function jSpans(d, sid) {
  const [a, b] = dayBounds(d), end = Math.min(b, Date.now());
  return jAll("handoffs").filter((h) => h.senior_id === sid).map((h) => ({ h, s: Math.max(a, new Date(h.created_at).getTime()), e: Math.min(end, hEnd(h) ?? end) }))
    .filter((x) => x.e > x.s).sort((x, y) => x.s - y.s);
}
const respAt = (sid, ms) => jAll("handoffs").find((h) => h.senior_id === sid && new Date(h.created_at).getTime() <= ms && (hEnd(h) === null || hEnd(h) > ms));
// Tagebuch: who = wer es gemacht hat (Mitglied); beim Pflegedienst who = null, carer = Name, ent = wer es eingetragen hat
const jDoer = (x, by) => isCarer(x) ? { who: null, carer: carerName(x), ent: by } : x?.done_by_kind === "member" && x.done_by_user ? { who: x.done_by_user, ent: by } : { who: by };
function jEvents(d, { sid = "", mem = "" } = {}) {
  const [a, b] = dayBounds(d), inD = (iso) => { const t = iso && new Date(iso).getTime(); return t >= a && t < b; };
  const ev = [];
  for (const e of jAll("care")) if (inD(e.created_at)) {
    const k = careK(e.kind);
    ev.push({ id: "c" + e.id, ts: e.created_at, cat: CARE_CAT[e.kind] || "mood", icon: k.e, ...jDoer(e, e.author_id), sid: e.senior_id, title: k.n, note: e.note, tone: k.imp ? "warn" : "", del: e.author_id === S.uid || isAdmin() ? e.id : null });
  }
  const seenMissed = new Set();
  for (const x of jAll("doses")) {
    const m = medById(x.medication_id); if (!m) continue;
    const name = m.name + (m.dosage ? " " + m.dosage : "");
    if (x.given_at && inD(x.given_at)) ev.push({ id: "g" + x.id, ts: x.given_at, cat: "med", icon: "💊", ...jDoer(x, x.given_by), sid: m.senior_id, title: `${m.name} gegeben`, note: `${m.dosage ? m.dosage + " · " : ""}geplant ${x.slot} Uhr${x.day !== isoDay(x.given_at) ? " (Vortag)" : ""}${x.missed_notified_at ? " · nachträglich" : ""}`, tone: "ok" });
    if (!x.given_at && x.day === d && x.missed_notified_at) { seenMissed.add(m.id + x.slot); ev.push({ id: "m" + x.id, ts: new Date(new Date(`${x.day}T${x.slot}:00`).getTime() + MED_GRACE_MIN * 60000).toISOString(), cat: "med", icon: "⏰", who: null, sid: m.senior_id, title: `${m.name} nicht gegeben`, note: `${name} · geplant ${x.slot} Uhr`, tone: "bad" }); }
  }
  if (d === today()) for (const x of medDoses(d)) if (x.status === "missed" && !x.dose?.missed_notified_at && !seenMissed.has(x.med.id + x.slot))
    ev.push({ id: "m" + x.med.id + x.slot, ts: new Date(x.sched + MED_GRACE_MIN * 60000).toISOString(), cat: "med", icon: "⏰", who: null, sid: x.med.senior_id, title: `${x.med.name} nicht gegeben`, note: `geplant ${x.slot} Uhr`, tone: "bad" });
  for (const h of jAll("handoffs")) {
    const o = h.open_snapshot || {}, n = (o.tasks?.length || 0) + (o.meds?.length || 0);
    if (inD(h.created_at)) ev.push({ id: "t" + h.id, ts: h.created_at, cat: "handoff", icon: "🤝", who: h.taken_by, sid: h.senior_id, title: (h.taken_by === S.uid ? (h.from_user ? "übernimmst von " : "bist jetzt da") : (h.from_user ? "übernimmt von " : "ist jetzt da")) + (h.from_user ? nmPlain(h.from_user) : ""), note: [h.note, n ? `Offen beim Übernehmen: ${n}` : ""].filter(Boolean).join(" · "), snap: o, start: true });
    const hE = hEnd(h) !== null ? new Date(hEnd(h)).toISOString() : null;
    if (hE && hEnd(h) <= Date.now() && inD(hE)) ev.push({ id: "e" + h.id, ts: hE, cat: "handoff", icon: "👋", who: h.taken_by, sid: h.senior_id, title: `${h.taken_by === S.uid ? "bist" : "ist"} gegangen (da seit ${hm(h.created_at)} Uhr)`, note: h.ended_note || "" });
  }
  // Pflegedienst-Einsätze laut Plan (berechnet, keine gespeicherten Zeilen): eine Zeile je Einsatz, sobald er begonnen hat
  for (const s of S.D.seniors || []) for (const w of carerWins(s.id, d)) if (w.s <= Date.now()) {
    const on = w.e > Date.now();
    ev.push({ id: "p" + w.r.id + d, ts: new Date(w.s).toISOString(), cat: "handoff", icon: "🤝", who: null, carer: w.c.name, sid: s.id, title: on ? `ist da seit ${hmMs(w.s)} (bis ${hmMs(w.e)})` : `da ${hmMs(w.s)}–${hmMs(w.e)}`, note: `${w.c.name} · laut Einsatzplan`, plan: true });
  }
  for (const t of jAll("tasks")) if (t.status === "done" && inD(t.completed_at)) ev.push({ id: "k" + t.id, ts: t.completed_at, cat: "task", icon: "✅", ...jDoer(t, t.completed_by), sid: t.senior_id, title: `${doerUid(t, t.completed_by) === S.uid && !isCarer(t) ? "hast" : "hat"} erledigt: ${t.title}`, note: "", tone: "ok" });
  for (const ap of jAll("appts")) if (inD(ap.starts_at)) ev.push({ id: "a" + ap.id, ts: ap.starts_at, cat: "appt", icon: KINDS[ap.kind]?.e || "📅", who: null, sid: ap.senior_id, title: ap.title, note: ap.location || "", appt: ap.id });
  for (const v of jAll("vitals")) if (inD(v.measured_at)) { const c = vClass(v); ev.push({ id: "v" + v.id, ts: v.measured_at, cat: "vit", icon: "🩺", ...jDoer(v, v.created_by), sid: v.senior_id, title: `${VK[v.kind]?.n || "Wert"}: ${vText(v)}`, note: [c ? VCL[c] : "", v.note || ""].filter(Boolean).join(" · "), tone: "" }); }
  return ev.filter((e) => (!sid || e.sid === sid || (!e.sid && e.cat !== "med")) && inFocus(e.sid) && (!mem || e.who === mem)).sort((x, y) => x.ts.localeCompare(y.ts));
}
// „Wer war da?“ als 24-Stunden-Band: farbige Abschnitte je Mitglied
function jRibbon(d, sid, { label = true, compact = false } = {}) {
  const s = senior(sid), sp = jSpans(d, sid), isT = d === today();
  const cw = carerWins(sid, d).map((w) => ({ ...w, e2: Math.min(w.e, Date.now()) })).filter((w) => w.e2 > w.s);
  const desc = sp.length || cw.length ? [...sp.map((x) => `${nmPlain(x.h.taken_by)} ${hm(new Date(x.s).toISOString())}–${x.h.ended_at || !isT ? hm(new Date(x.e).toISOString()) : "jetzt"}`), ...cw.map((w) => `${w.c.name} ${hmMs(w.s)}–${w.e2 < w.e ? "jetzt" : hmMs(w.e)}`)].join(", ") : "niemand eingetragen";
  return `<div class="rib ${compact ? "c" : ""}">${label ? `<span class="rib-l">${sDot(sid)}</span>` : ""}
    <div class="rib-bar" role="img" aria-label="${esc((s?.name || "") + ": " + desc)}">${[25, 50, 75].map((p) => `<i class="rib-tick" style="left:${p}%"></i>`).join("")}
      ${sp.map((x) => `<span class="seg-b" style="left:${tod(x.s, d)}%;width:${Math.max(1.2, tod(x.e, d) - tod(x.s, d))}%;--m:${memColor(x.h.taken_by)}" title="${esc(nmPlain(x.h.taken_by))}">${compact ? "" : `<em>${esc(initials(nmPlain(x.h.taken_by)))}</em>`}</span>`).join("")}
      ${cw.map((w) => `<span class="seg-b carer" style="left:${tod(w.s, d)}%;width:${Math.max(1.2, tod(w.e2, d) - tod(w.s, d))}%" title="${esc(w.c.name)}">${compact ? "" : `<em>${ICON.carer}</em>`}</span>`).join("")}
      ${isT ? `<i class="now" style="left:${tod(Date.now(), d)}%"></i>` : ""}</div></div>`;
}
const ribScale = () => `<div class="rib-scale" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>`;
function jSummary(d, ev, sids) {
  const given = ev.filter((e) => e.cat === "med" && e.tone === "ok").length, missed = ev.filter((e) => e.tone === "bad").length;
  const notes = ev.filter((e) => e.id[0] === "c").length, done = ev.filter((e) => e.cat === "task").length, vits = ev.filter((e) => e.cat === "vit").length;
  const per = new Map(); for (const e of ev) if (e.who) per.set(e.who, (per.get(e.who) || 0) + 1);
  const people = [...per.entries()].sort((a, b) => b[1] - a[1]);
  return `<section class="card jsum ${sids.length > 1 || multiSen() ? "lbl" : ""}">
    <div class="sec-h">${h2i("here", "Wer war da?")}</div>
    ${sids.map((sid) => jRibbon(d, sid, { label: sids.length > 1 || multiSen() })).join("")}${ribScale()}
    <div class="jstats">
      <span class="js ${missed ? "bad" : given ? "ok" : ""}"><b>💊 ${given}</b> gegeben${missed ? ` · <b>${missed}</b> verpasst` : ""}</span>
      <span class="js"><b>📝 ${notes}</b> ${notes === 1 ? "Eintrag" : "Einträge"}</span>
      <span class="js"><b>✅ ${done}</b> erledigt</span>${vits ? `<span class="js"><b>🩺 ${vits}</b> ${vits === 1 ? "Messwert" : "Messwerte"}</span>` : ""}</div>
    ${people.length ? `<div class="jwho" aria-label="Aktivität je Mitglied">${people.map(([u, n]) => `<button class="jw ${jState().mem === u ? "on" : ""}" data-jmem="${u}" aria-pressed="${jState().mem === u}" style="--m:${memColor(u)}">${ava(u, "xs")}<span>${esc(u === S.uid ? "Du" : nmPlain(u).split(" ")[0])}</span><b>${n}</b></button>`).join("")}</div>` : ""}
  </section>`;
}
function jItem(e, { showSen }) {
  const r = e.sid ? respAt(e.sid, new Date(e.ts).getTime()) : null;
  const who = e.carer ? `<b class="tl-who carer-tag" title="${esc(e.carer)}">${ICON.carer}<span>Pflegedienst</span></b>` : e.who ? `<b class="tl-who" style="--m:${memColor(e.who)}">${esc(e.who === S.uid ? "Du" : nmPlain(e.who))}</b>` : "";
  const ent = e.ent && (e.carer || e.ent !== e.who) ? `<span class="tl-ent">eingetragen von ${e.ent === S.uid ? "dir" : esc(nmPlain(e.ent))}</span>` : "";
  const snap = e.snap && ((e.snap.tasks?.length || 0) + (e.snap.meds?.length || 0) || e.snap.appt) ? `<details class="tl-more"><summary>Was war offen?</summary>${e.snap.tasks?.length ? `<p><b>Aufgaben:</b> ${e.snap.tasks.map(esc).join(" · ")}</p>` : ""}${e.snap.meds?.length ? `<p><b>Medikamente:</b> ${e.snap.meds.map(esc).join(" · ")}</p>` : ""}${e.snap.appt ? `<p><b>Nächster Termin:</b> ${esc(e.snap.appt)}</p>` : ""}</details>` : "";
  const title = e.cat === "handoff" || e.cat === "task" ? `${who} ${esc(e.title)}` : `${esc(e.title)}`;
  const by = e.cat === "handoff" || e.cat === "task" ? ent : e.who || e.carer ? `${who}${ent ? " " + ent : ""}` : e.tone === "bad" ? `<span class="muted">Automatisch erkannt</span>` : "";
  return `<li class="tl-i ${e.tone || ""} cat-${e.cat}" style="--r:${r ? memColor(r.taken_by) : "transparent"}">
    <time class="tl-t" datetime="${e.ts}">${hm(e.ts)}</time>
    <span class="tl-node${e.carer ? " carer" : ""}" style="--m:${memColor(e.who)}" aria-hidden="true">${e.carer ? ICON.carer : e.who ? esc(initials(nmPlain(e.who))) : e.icon}${e.who || e.carer ? `<i class="tl-cat">${e.icon}</i>` : ""}</span>
    <div class="tl-card"${e.appt ? ` data-appt="${e.appt}" role="button" tabindex="0"` : ""}>
      <p class="tl-h"><span class="sr">${hm(e.ts)} Uhr: </span>${title}</p>
      ${e.note ? `<p class="tl-n">${esc(e.note)}</p>` : ""}
      <p class="tl-m">${[by, (JK[e.cat] ? `<span class="tl-c ti k-${JK[e.cat]}">${ICON[CAT[JK[e.cat]][0]]}${JCAT[e.cat].n}</span>` : `<span class="tl-c">${JCAT[e.cat].n}</span>`), showSen && e.sid ? sDot(e.sid) : ""].filter(Boolean).join('<span class="sep">·</span>')}</p>
      ${e.del ? `<button class="tl-del" data-cdel="${e.del}" aria-label="Eintrag „${esc(e.title)}“ löschen" title="Löschen">×</button>` : ""}
      ${snap}</div></li>`;
}
function jTimeline(d, ev, { showSen }) {
  if (!ev.length) return emptyBox("journal", d === today() ? "Heute ist noch nichts eingetragen." : "An diesem Tag wurde nichts eingetragen.");
  const out = []; let lastH = -1, nowDone = d !== today();
  for (const e of ev) {
    if (!nowDone && new Date(e.ts).getTime() > Date.now()) { out.push(`<li class="tl-now" aria-label="Jetzt"><span>Jetzt · ${hm(new Date().toISOString())}</span></li>`); nowDone = true; }
    const h = new Date(e.ts).getHours(), part = h < 5 ? 0 : h < 11 ? 1 : h < 14 ? 2 : h < 18 ? 3 : 4;
    if (part !== lastH) { out.push(`<li class="tl-part" aria-hidden="true"><span>${["Nachts", "Morgens", "Mittags", "Nachmittags", "Abends"][part]}</span></li>`); lastH = part; }
    out.push(jItem(e, { showSen }));
  }
  return `<ol class="tl" aria-label="Zeitstrahl ${esc(dayLabel(d, true))}">${out.join("")}</ol>`;
}
function jDayNav(d) {
  const t = today();
  return `<div class="jnav"><button class="btn icon ghost" data-jd="-1" aria-label="Vorheriger Tag">${ICON.back}</button>
    <label class="jnav-d"><b>${esc(dayLabel(d, true))}</b><small class="muted">${d === t || d === addDays(t, -1) ? parseD(d).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" }) : "Datum wählen"}</small><input type="date" id="jdate" value="${d}" max="${t}" aria-label="Datum wählen"></label>
    <button class="btn icon ghost" data-jd="1" aria-label="Nächster Tag" ${d >= t ? "disabled" : ""}>${ICON.chev}</button></div>
    ${d !== t ? `<button class="link small jtoday" data-jd="0">Zurück zu heute</button>` : ""}`;
}
function jWeek(sids) {
  const t = today(), days = Array.from({ length: 7 }, (_, i) => addDays(t, -i));
  return `<section class="card jweek"><div class="sec-h">${h2i("journal", "Letzte 7 Tage")}<span class="muted small">Tippe auf einen Tag</span></div>
    ${days.map((d) => {
      const ev = jEvents(d, { sid: jState().sen }), missed = ev.filter((e) => e.tone === "bad").length;
      const per = new Map(); for (const e of ev) if (e.who) per.set(e.who, (per.get(e.who) || 0) + 1);
      return `<button class="wk" data-jday="${d}" aria-label="${esc(dayLabel(d, true))}: ${ev.length} Ereignisse${missed ? `, ${missed} verpasst` : ""}">
        <span class="wk-d"><b>${d === t ? "Heute" : parseD(d).toLocaleDateString("de-DE", { weekday: "short" })}</b><small>${parseD(d).toLocaleDateString("de-DE", { day: "numeric", month: "numeric" })}</small></span>
        <span class="wk-r">${sids.map((sid) => jRibbon(d, sid, { label: false, compact: true })).join("")}
          <span class="wk-dots">${[...per.entries()].map(([u, n]) => `<i style="--m:${memColor(u)}" title="${esc(nmPlain(u))}: ${n}">${n}</i>`).join("")}${missed ? `<i class="bad">⏰ ${missed}</i>` : ""}${!ev.length ? `<small class="muted">–</small>` : ""}</span></span></button>`;
    }).join("")}${ribScale()}
    <div class="legend">${S.D.members.map((m) => `<span><i style="--m:${memColor(m.user_id)}"></i>${esc(m.user_id === S.uid ? "Du" : m.display_name)}</span>`).join("")}</div></section>`;
}
function journalBody({ sid = "", embedded = false } = {}) {
  const J = jState(), d = J.day, fsid = sid || J.sen;
  jEnsure(d);
  const sids = fsid ? [fsid] : visSen().map((s) => s.id);
  if (!embedded && J.view === "week") return jWeek(sids);
  const loading = d < addDays(today(), -JWIN) && !J.got.has(d) && !!API.journal;
  const ev = jEvents(d, { sid: fsid, mem: J.mem });
  return `${jDayNav(d)}${loading ? `<p class="muted small center">Lädt …</p>` : `${jSummary(d, jEvents(d, { sid: fsid }), sids)}
    ${J.mem ? `<p class="small jfilter">Nur ${esc(J.mem === S.uid ? "deine" : "von " + nmPlain(J.mem))} Einträge · <button class="link small" data-jmem="">alle zeigen</button></p>` : ""}
    <section><div class="sec-h">${h2i("journal", "Zeitstrahl")}<span class="muted small">${ev.length} ${ev.length === 1 ? "Ereignis" : "Ereignisse"}</span></div>${jTimeline(d, ev, { showSen: !fsid && visSen().length > 1 })}</section>`}`;
}
function pageJournal() {
  const J = jState();
  if (J.sen && (!senior(J.sen) || !inFocus(J.sen))) J.sen = "";
  return `<div class="page-h"><h1>Tagebuch</h1><p class="muted small">Wer hat wann was gemacht – automatisch aus Einträgen, Medikamenten, Messwerten, Übergaben und Aufgaben.</p></div>
    <div class="seg small jv" role="group" aria-label="Ansicht"><button data-jv="day" class="${J.view !== "week" ? "on" : ""}" aria-pressed="${J.view !== "week"}">Tag</button><button data-jv="week" class="${J.view === "week" ? "on" : ""}" aria-pressed="${J.view === "week"}">Woche</button></div>
    ${focusHint()}${visSen().length > 1 ? `<div class="chips sub" role="group" aria-label="Person"><button class="chip ${!J.sen ? "on" : ""}" data-jsen="">Alle</button>${visSen().map((s) => `<button class="chip ${J.sen === s.id ? "on" : ""}" data-jsen="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : ""}
    ${journalBody()}${S.D.seniors.length ? fabCtx("journal-add", "Eintrag") : ""}`;
}
// Schnell-Eintrag aus dem Tagebuch: Person wählen → Kurz-Eintrag, Medikament abhaken oder Übergabe
function entrySheet(sid) {
  sid = senior(sid) && inFocus(sid) ? sid : (S.j?.sen && inFocus(S.j.sen) ? S.j.sen : visSen()[0].id);
  const h = curHandoff(sid), me = h?.taken_by === S.uid;
  const { sh, close } = openSheet(`<h2>Eintrag hinzufügen</h2>
    ${visSen().length > 1 ? `<div class="chips sub" role="group" aria-label="Für wen?">${visSen().map((s) => `<button class="chip ${s.id === sid ? "on" : ""}" data-es="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : `<p class="muted">${esc(senior(sid).name)} · ${hm(new Date().toISOString())} Uhr</p>`}
    ${quickChips(sid)}
    <div class="btns col"><button class="btn soft block" data-eho="${me ? "end" : "take"}">${me ? "👋 Ich gehe – Übergabe abschließen" : "🙋 Ich bin jetzt da"}</button></div>`);
  $$("[data-es]", sh).forEach((b) => (b.onclick = () => { close(); entrySheet(b.dataset.es); }));
  $$("[data-care]", sh).forEach((b) => (b.onclick = () => { close(); careSheet(b.dataset.care, sid); }));
  $("[data-eho]", sh).onclick = (e) => { close(); handoffSheet(sid, e.currentTarget.dataset.eho === "end"); };
}
function bindJournal(root) {
  const J = jState();
  $$("[data-jv]", root).forEach((b) => (b.onclick = () => { J.view = b.dataset.jv; render(true); }));
  $$("[data-jsen]", root).forEach((b) => (b.onclick = () => { J.sen = b.dataset.jsen; render(true); }));
  $$("[data-jmem]", root).forEach((b) => (b.onclick = () => { J.mem = J.mem === b.dataset.jmem ? "" : b.dataset.jmem; render(true); }));
  $$("[data-jd]", root).forEach((b) => (b.onclick = () => { const n = Number(b.dataset.jd); J.day = n === 0 ? today() : addDays(J.day, n) > today() ? today() : addDays(J.day, n); render(true); }));
  $$("[data-jday]", root).forEach((b) => (b.onclick = () => { J.day = b.dataset.jday; J.view = "day"; render(true); window.scrollTo(0, 0); }));
  const di = $("#jdate", root); if (di) di.onchange = () => { if (/^\d{4}-\d{2}-\d{2}$/.test(di.value)) { J.day = di.value > today() ? today() : di.value; render(true); } };
  $$(".tl-card[data-appt]", root).forEach((c) => (c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apptSheet(c.dataset.appt); } }));
}
// ---------- Einstellungen (Tipp auf das eigene Kürzel oben rechts): Personen, Mitglieder, Konto ----------
function settingsSheet() {
  const f = fam(), admin = isAdmin();
  const ms = [...S.D.members].sort((a, b) => (a.role === b.role ? a.display_name.localeCompare(b.display_name) : a.role === "admin" ? -1 : 1));
  const { sh, close } = openSheet(`<div class="sheet-head row set-head">${ava(S.uid, "lg")}<div><h2>${esc(S.me.display_name)}</h2><p class="muted">@${esc(S.me.username)} · ${esc(f.name)} · ${admin ? "Admin" : "Mithelfer"}</p></div></div>
    ${accList().length > 1 ? `<h3 class="sec">${sico("fam", "xs")} Konto wechseln</h3><div class="card list-card">${accRows(S.uid)}<button class="mrow add" data-sact="acc-add"><span class="ico plus">${ICON.plus}</span><span><b>Konto hinzufügen</b></span></button></div>` : ""}
    <h3 class="sec">${sico("care", "xs")} Personen</h3><div class="card list-card">${S.D.seniors.map((s) => `<a class="mrow" href="#/person/${s.id}">${sAva(s)}<span><b>${esc(s.name)}</b>${s.info ? `<small class="muted ell">${esc(s.info)}</small>` : ""}</span><span class="chev">${ICON.chev}</span></a>`).join("") || '<p class="muted small pad">Noch niemand angelegt.</p>'}
      <button class="mrow add" data-sact="add-senior"><span class="ico plus">${ICON.plus}</span><span><b>Person hinzufügen</b></span></button></div>
    <h3 class="sec">${sico("fam", "xs")} Mitglieder <span class="muted">${S.D.members.length}</span></h3><div class="card list-card">${ms.map((m) => `<button class="mrow" data-member="${m.user_id}">${ava(m.user_id)}<span><b>${esc(m.display_name)}${m.user_id === S.uid ? " (ich)" : ""}</b><small class="muted">@${esc(m.username)}</small></span>${m.role === "admin" ? '<span class="role admin">Admin</span>' : m.role === "senior" ? `<span class="role senior">Senior${senior(m.senior_id) ? " · " + esc(senior(m.senior_id).name) : ""}</span>` : ""}</button>`).join("")}
      <button class="mrow add" data-sact="invite"><span class="ico plus">${ICON.plus}</span><span><b>Mitglied einladen</b><small class="muted">Link oder Code teilen</small></span></button></div>
    <h3 class="sec">${sico("settings", "xs")} Einstellungen</h3><div class="card list-card">
      <button class="mrow" data-sact="aid"><span class="ico ln k-aid">${ICON.aid}</span><span><b>Hilfen &amp; Ansprüche</b><small class="muted">Was die Pflegekasse zahlt – kurz erklärt</small></span><span class="chev">${ICON.chev}</span></button>
      ${partners().length ? `<label class="mrow switch rec-row"><span class="ico ln">${ICON.heart}</span><span><b>Empfehlungen anzeigen</b><small class="muted">Anzeigen in „Hilfen &amp; Ansprüche“ · auf diesem Gerät</small></span><input type="checkbox" id="rec-sw" ${recOn() ? "checked" : ""}><i></i></label>` : ""}
      <button class="mrow" data-sact="notify"><span class="ico ln">${ICON.bell}</span><span><b>Benachrichtigungen</b><small class="muted">Push auf diesem Gerät, worüber</small></span><span class="chev">${ICON.chev}</span></button>
      <button class="mrow" data-sact="glu-unit"><span class="ico ln">${ICON.drop}</span><span><b>Blutzucker-Einheit</b><small class="muted">${gluU()} · auf diesem Gerät</small></span><span class="chev">${ICON.chev}</span></button>
      <button class="mrow" data-sact="rename-me"><span class="ico ln">${ICON.user}</span><span><b>Name ändern</b><small class="muted">${esc(S.me.display_name)}</small></span><span class="chev">${ICON.chev}</span></button>
      <button class="mrow" data-sact="password"><span class="ico ln">${ICON.key}</span><span><b>Passwort ändern</b><small class="muted">Altes bestätigen, neues festlegen</small></span><span class="chev">${ICON.chev}</span></button>
      ${admin ? `<button class="mrow" data-sact="rename-fam"><span class="ico ln">${ICON.pen}</span><span><b>Familie umbenennen</b><small class="muted">${esc(f.name)}</small></span></button>` : ""}
      ${S.fams.length > 1 ? `<button class="mrow" data-sact="switch"><span class="ico ln">${ICON.swap}</span><span><b>Familie wechseln</b></span></button>` : ""}
      <button class="mrow" data-sact="another"><span class="ico ln">${ICON.plus}</span><span><b>Weitere Familie gründen oder beitreten</b></span></button>
      ${accList().length > 1 ? "" : `<button class="mrow" data-sact="acc-add"><span class="ico ln">${ICON.swap}</span><span><b>Weiteres Konto auf diesem Gerät</b><small class="muted">Zum schnellen Wechseln, z. B. für Oma</small></span></button>`}
      <button class="mrow" data-sact="logout"><span class="ico ln">${ICON.logout}</span><span><b>Abmelden</b>${accList().length > 1 ? '<small class="muted">Entfernt dieses Konto vom Gerät</small>' : ""}</span></button></div>
    <details class="more zone"><summary>Familie verlassen oder Konto löschen</summary><div class="card list-card">
      <button class="mrow" data-sact="leave"><span class="ico ln">${ICON.door}</span><span><b>Familie verlassen</b></span></button>
      <button class="mrow danger-t" data-sact="delete-account"><span class="ico ln">${ICON.trash}</span><span><b>Konto löschen</b></span></button></div></details>
    <p class="muted small center pad">🔒 Nur Mitglieder dieser Familie sehen eure Daten. Tragt nur ein, was für die Pflege nötig ist. Pflegekreis ist kein Medizinprodukt.${DEMO ? `<br><button class="link" data-sact="demo-reset">Demo zurücksetzen</button>` : ""}</p>${LEGAL}
    <div class="btns"><button class="btn ghost" data-close>Schließen</button></div>`, "settings");
  $$("[data-sact]", sh).forEach((b) => (b.onclick = () => { close(); act(b.dataset.sact, b); }));
  if ($("#rec-sw", sh)) $("#rec-sw", sh).onchange = (e) => { recSet(e.target.checked); toast(e.target.checked ? "Empfehlungen werden angezeigt" : "Empfehlungen ausgeblendet"); };
  $$("[data-member]", sh).forEach((b) => (b.onclick = () => { close(); memberSheet(b.dataset.member); }));
  $$("[data-acc]", sh).forEach((b) => (b.onclick = () => { if (b.dataset.acc !== S.uid) { close(); accSwitch(b.dataset.acc); } }));
}
function inviteSheet() {
  const f = fam(), admin = isAdmin();
  const { sh, close } = openSheet(`<h2>Familie einladen</h2><p class="muted">Teile den Link oder nenne den Code. Neue Mitglieder sind Mithelfer.</p>
    <div class="codebox${invExpired(f) ? " expired" : ""}">${esc(f.invite_code)}</div>
    ${invNote(f, admin)}
    ${invExpired(f) ? (admin ? `<div class="btns"><button class="btn" id="inv-new">Neuen Code erzeugen</button></div>` : "")
      : `<div class="btns"><button class="btn" id="share">Link teilen</button><button class="btn ghost" id="copy">Link kopieren</button></div>
    ${admin ? `<p class="center"><button class="link small" id="inv-new">Neuen Code erzeugen</button></p>` : ""}`}`);
  bindInvite(f, sh);
  if ($("#inv-new", sh)) $("#inv-new", sh).onclick = async () => { close(); await act("new-code"); inviteSheet(); };
}
function notifySheet() {
  const p = { ...DEF_PREFS, ...(S.D.prefs || {}) };
  const { sh } = openSheet(`<h2>Benachrichtigungen</h2>
    <div class="card"><div class="push-state"><span id="pstate">Wird geprüft …</span><button class="btn small" id="pon">Aktivieren</button></div>
      <p class="muted small">Gilt für dieses Gerät. Auf dem iPhone: erst „Zum Home-Bildschirm“ hinzufügen, dann dort aktivieren.</p></div>
    <h3 class="sec">Worüber möchtest du informiert werden?</h3>
    <div class="card prefs">${PREFS.map(([k, l]) => `<label class="switch"><span>${l}</span><input type="checkbox" data-pref="${k}" ${p[k] ? "checked" : ""}><i></i></label>`).join("")}</div>
    <p class="center"><button class="link small" id="ptest">Test-Benachrichtigung senden</button></p>`);
  $$("[data-pref]", sh).forEach((c) => (c.onchange = async () => {
    const prefs = { ...DEF_PREFS }; $$("[data-pref]", sh).forEach((x) => (prefs[x.dataset.pref] = x.checked));
    try { await API.fn("prefs_save", { prefs }); S.D.prefs = prefs; toast("Gespeichert"); } catch (e) { toast(e.message); c.checked = !c.checked; }
  }));
  pushState();
  $("#pon", sh).onclick = async (e) => { const on = e.currentTarget.dataset.on === "1"; try { if (on) { await unsubscribePush(); toast("Benachrichtigungen aus"); } else { await enablePush(); toast("Benachrichtigungen aktiv"); } } catch (er) { toast(er.message, 5000); } pushState(); };
  $("#ptest", sh).onclick = async () => { try { const r = await API.fn("test_push"); toast(r.sent ? "Test gesendet" : "Kein aktives Gerät – bitte erst aktivieren"); } catch (e) { toast(e.message); } };
}


// ---------- Ereignisse ----------
// ---------- Notfallkarte und Arzt-Bericht (PDF, im Browser erzeugt) ----------
const BLOOD = ["0+", "0-", "A+", "A-", "B+", "B-", "AB+", "AB-"];
const ANTICOAG = /eliquis|apixaban|marcumar|phenprocoumon|falithrom|xarelto|rivaroxaban|pradaxa|dabigatran|lixiana|edoxaban|clopidogrel|plavix|prasugrel|efient|ticagrelor|brilique|heparin|clexane|enoxaparin|blutverd[üu]nn/i;
const fmtDate = (s) => (s ? parseD(s).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "");
const ageOf = (s) => { if (!s) return null; const b = parseD(s), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--; return a >= 0 && a < 130 ? a : null; };
const sMeds = (sid) => (S.D.meds || []).filter((m) => m.senior_id === sid && m.active !== false).sort((a, b) => ((a.times || [])[0] || "").localeCompare((b.times || [])[0] || "") || a.name.localeCompare(b.name, "de"));
const SPEC = [[/kardio/i, "Kardiologie"], [/diabet/i, "Diabetologie"], [/neuro/i, "Neurologie"], [/gastro/i, "Gastroenterologie"], [/nephro|niere/i, "Nephrologie"], [/pneumo|lunge/i, "Lungenarzt"], [/onko/i, "Onkologie"], [/urolog/i, "Urologie"], [/derma|haut/i, "Hautarzt"], [/gyn/i, "Gynäkologie"], [/orthop/i, "Orthopädie"], [/rheuma/i, "Rheumatologie"], [/geriat/i, "Geriatrie"], [/psych/i, "Psychiatrie"], [/augen/i, "Augenarzt"], [/hno|ohren/i, "HNO"], [/zahn/i, "Zahnarzt"]];
const specOf = (c) => c.category === "arzt" ? "Hausarzt" : (SPEC.find(([re]) => re.test(`${c.org || ""} ${c.name} ${c.note || ""}`)) || [0, "Facharzt"])[1];
function sosFlags(s, meds) {
  const txt = [s.diagnoses, s.info].filter(Boolean).join("\n"), out = [];
  const ac = meds.filter((m) => ANTICOAG.test(`${m.name} ${m.notes || ""}`));
  if (ac.length || /blutverd[üu]nn|antikoagul/i.test(txt)) out.push({ k: "ac", t: "Nimmt Blutverdünner", d: ac.map((m) => m.name + (m.dosage ? " " + m.dosage.split("·")[0].trim() : "")).join(", ") });
  const ins = meds.filter((m) => /insulin/i.test(m.name));
  if (ins.length || /diabet/i.test(txt)) out.push({ k: "dm", t: ins.length ? "Diabetes – spritzt Insulin" : "Diabetes", d: ins.map((m) => m.name + (m.dosage ? " " + m.dosage.split("·")[0].trim() : "")).join(", ") });
  if (/schrittmacher|defibrillator|\bicd\b/i.test(txt)) out.push({ k: "pm", t: "Herzschrittmacher / Defibrillator", d: "" });
  return out;
}
// Alles, was auf die Notfallkarte gehört – als einfache Daten (auch für die Offline-Kopie und das PDF)
function sosData(sid) {
  const s = senior(sid); if (!s) return null;
  const meds = sMeds(sid), cs = sortContacts((S.D.contacts || []).filter((c) => !c.senior_id || c.senior_id === sid));
  const allergies = (s.allergies || "").trim();
  return {
    id: s.id, name: s.name, color: s.color, birth: fmtDate(s.birthdate), birthdate: s.birthdate || "", age: ageOf(s.birthdate), blood: s.blood_type || "",
    allergies, allergiesHl: !!allergies && !/^(keine|nein|-|–)\b/i.test(allergies), diagnoses: (s.diagnoses || "").trim(), flags: sosFlags(s, meds),
    meds: meds.map((m) => ({ name: m.name, dosage: m.dosage || "", times: (m.times || []).join(" · "), notes: m.notes || "", hl: ANTICOAG.test(`${m.name} ${m.notes || ""}`) })),
    doctors: cs.filter((c) => c.category === "arzt" || c.category === "facharzt").map((c) => ({ id: c.id, role: specOf(c), name: c.name, org: c.org || "", phone: c.phone || "" })),
    contacts: cs.filter((c) => c.category === "familie" || c.category === "pflegedienst").sort((a, b) => (a.category === "familie" ? 0 : 1) - (b.category === "familie" ? 0 : 1)).map((c) => ({ id: c.id, name: c.name, org: c.org || (c.category === "pflegedienst" ? "Pflegedienst" : ""), phone: c.phone || "" })),
    mobility: (s.mobility || "").trim(), directive: (s.directive || "").trim(), info: (s.info || "").trim(),
    stand: `${fmtDate(today())}, ${hm(new Date().toISOString())} Uhr`,
  };
}
// Offline: Notfallkarten der aktuellen Familie liegen zusätzlich auf diesem Gerät (beim Abmelden gelöscht)
const SOS_KEY = "pf-sos";
function sosSave() { try { if (!S.D || !S.uid || !S.fid) return; localStorage.setItem(SOS_KEY, JSON.stringify({ v: 1, uid: S.uid, fid: S.fid, fam: fam()?.name || "", at: new Date().toISOString(), cards: S.D.seniors.map((s) => sosData(s.id)).filter(Boolean) })); } catch {} }
const sosSnap = () => { try { const j = JSON.parse(localStorage.getItem(SOS_KEY) || "null"); return j?.cards?.length ? j : null; } catch { return null; } };
const sosClear = () => { try { localStorage.removeItem(SOS_KEY); } catch {} };
function sosMissing(c) { return [!c.birth && "Geburtsdatum", !c.blood && "Blutgruppe", !c.diagnoses && "Diagnosen", !c.directive && "Patientenverfügung"].filter(Boolean); }
function sosHtml(c, { offline = false } = {}) {
  const row = (x, sub) => `<div class="sos-p"><div><small>${esc(sub)}</small><b>${esc(x.name)}</b>${x.org && sub !== x.org ? `<span>${esc(x.org)}</span>` : ""}${x.phone ? `<span class="sos-tel">${esc(x.phone)}</span>` : ""}</div>${x.phone ? `<a class="btn cact call" href="${telUrl(x.phone)}" aria-label="${esc(x.name)} anrufen">${ICON.phone}<span>Anrufen</span></a>` : ""}</div>`;
  const sec = (ic, t, body, cls = "") => `<section class="card sos-c ${cls}"><h2>${ICON[ic]}<span>${t}</span></h2>${body}</section>`;
  const miss = sosMissing(c);
  return `<section class="sos" data-sos="${esc(c.id)}">
    <div class="sos-head">
      <span class="sos-badge">${ICON.sos}Notfallkarte</span>
      <h1>${esc(c.name)}</h1>
      <p class="sos-id">${c.birth ? `geb. ${esc(c.birth)}${c.age != null ? ` · ${c.age} Jahre` : ""}` : `<span class="muted">Geburtsdatum nicht eingetragen</span>`}${c.blood ? ` · Blutgruppe <b>${esc(c.blood)}</b>` : ""}</p>
    </div>
    <a class="btn block big sos-112" href="tel:112">${ICON.phone}<span>Notruf 112</span><small>Rettungsdienst</small></a>
    ${c.flags.map((f) => `<div class="sos-flag" data-flag="${f.k}">${ICON.alert}<div><b>${esc(f.t)}</b>${f.d ? `<span>${esc(f.d)}</span>` : ""}</div></div>`).join("")}
    ${sec("alert", "Allergien / Unverträglichkeiten", `<p class="sos-big ${c.allergiesHl ? "hl" : ""}">${esc(c.allergies || "Keine bekannt")}</p>`)}
    ${c.diagnoses ? sec("shield", "Wichtige Diagnosen / Hinweise", `<p class="sos-big pre">${esc(c.diagnoses)}</p>`) : ""}
    ${sec("pill", "Aktuelle Medikamente", c.meds.length ? `<ul class="sos-meds">${c.meds.map((m) => `<li class="${m.hl ? "hl" : ""}"><div><b>${esc(m.name)}</b>${m.dosage ? `<span>${esc(m.dosage)}</span>` : ""}${m.notes ? `<small>${esc(m.notes)}</small>` : ""}</div><time>${esc(m.times)}</time></li>`).join("")}</ul>` : `<p class="muted">Keine Medikamente eingetragen.</p>`)}
    ${c.doctors.length ? sec("steth", "Ärztinnen und Ärzte", c.doctors.map((d) => row(d, d.role)).join("")) : ""}
    ${sec("fam", "Notfallkontakte", c.contacts.length ? c.contacts.map((x) => row(x, x.org || "Kontakt")).join("") : `<p class="muted small">Noch keine Kontakte der Kategorie „Familie & Nachbarn“ oder Pflegedienst.</p>`)}
    ${c.mobility ? sec("walk", "Mobilität", `<p class="sos-big">${esc(c.mobility)}</p>`) : ""}
    ${c.directive ? sec("note", "Patientenverfügung / Vollmacht", `<p class="sos-big">${esc(c.directive)}</p>`) : ""}
    ${c.info ? sec("pin", "Weitere Hinweise", `<p class="pre">${esc(c.info)}</p>`) : ""}
    <p class="muted small sos-stand">${ICON.done} Stand ${esc(c.stand)} · auf diesem Gerät auch ohne Internet abrufbar</p>
    <div class="btns sos-act"><button class="btn" data-act="sos-print" data-sid="${esc(c.id)}">${ICON.print}<span>Drucken / PDF</span></button>${offline ? "" : `<button class="btn ghost" data-act="edit-profile" data-id="${esc(c.id)}">Angaben ergänzen</button>`}</div>
    ${!offline && miss.length ? `<p class="muted small center">Noch nicht eingetragen: ${miss.join(", ")} · <button class="link small" data-act="edit-profile" data-id="${esc(c.id)}">ergänzen</button></p>` : ""}
  </section>`;
}
// Test-Haken (nur Anzeige, keine Daten): Offline-Ansicht und Termin-Blatt direkt öffnen
window.__pfSos = { offline: () => sosOffline(sosSnap()), appt: (id) => apptSheet(id) };
function pageSos(id) {
  const c = sosData(id);
  if (!c) return `<div class="card empty"><p>Person nicht gefunden.</p><a class="btn" href="#/">Zur Übersicht</a></div>`;
  return `<a href="#/person/${id}" class="back">${ICON.back} ${esc(c.name)}</a>${sosHtml(c)}`;
}
// Start ohne Verbindung: gespeicherte Notfallkarten trotzdem zeigen
function sosOffline(snap, sel) {
  const c = snap.cards.find((x) => x.id === sel) || null;
  app.innerHTML = `<main class="page sos-off">${c ? `<button class="back" id="sos-back">${ICON.back} Alle Notfallkarten</button>${sosHtml(c, { offline: true })}`
    : `<div class="page-h"><h1 class="hi"><span class="sico k-sos">${ICON.sos}</span><span>Notfallkarten</span></h1><p class="muted small">Offline gespeichert am ${esc(new Date(snap.at).toLocaleString("de-DE", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }))} Uhr${snap.fam ? ` · ${esc(snap.fam)}` : ""}</p></div>
      <div class="list">${snap.cards.map((x) => `<button class="link-row card sos-pick" data-sos-open="${esc(x.id)}"><span><b>${esc(x.name)}</b></span>${ICON.chev}</button>`).join("")}</div>
      <a class="btn block big sos-112" href="tel:112">${ICON.phone}<span>Notruf 112</span><small>Rettungsdienst</small></a>
      <div class="btns"><button class="btn ghost" onclick="location.reload()">Erneut verbinden</button></div>`}</main>`;
  $$("[data-sos-open]").forEach((b) => (b.onclick = () => sosOffline(snap, b.dataset.sosOpen)));
  const bk = $("#sos-back"); if (bk) bk.onclick = () => sosOffline(snap);
  $$("[data-act=sos-print]").forEach((b) => (b.onclick = () => sosPrintSheet(snap.cards.find((x) => x.id === b.dataset.sid))));
  window.scrollTo(0, 0);
}
// PDF-Bausteine erst bei Bedarf laden (lokal, vom Service Worker auch offline vorgehalten)
let pdfLib = null;
const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => no(new Error("PDF-Baustein konnte nicht geladen werden – bitte Verbindung prüfen")); document.head.appendChild(s); });
const needPdf = () => (pdfLib ||= (window.jspdf ? Promise.resolve() : loadScript("vendor/jspdf.umd.min.js")).then(() => (window.PF_PDF ? 0 : loadScript("pdf.js?v=1793564947"))).then(() => window.PF_PDF).catch((e) => { pdfLib = null; throw e; }));
const fileSafe = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Ergebnis: Teilen (iPhone: „In Dateien sichern“, AirDrop, Mail …), Öffnen, Herunterladen
function pdfOut(box, blob, name) {
  if (box.__url) URL.revokeObjectURL(box.__url);
  const url = (box.__url = URL.createObjectURL(blob)), file = typeof File === "function" ? new File([blob], name, { type: "application/pdf" }) : null;
  const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
  window.__pfLastPdf = { name, size: blob.size, blob };
  box.innerHTML = `<div class="pdf-ok" role="status"><span class="pdf-ico">${ICON.report}</span><div><b>PDF ist fertig</b><small>${esc(name)} · ${Math.max(1, Math.round(blob.size / 1024))} KB</small></div></div>
    <div class="pdf-btns">${canShare ? `<button class="btn" data-pdf-share>${ICON.share}<span>Teilen / Sichern</span></button>` : ""}<a class="btn ${canShare ? "ghost" : ""}" href="${url}" target="_blank" rel="noopener" data-pdf-open>${ICON.report}<span>Öffnen</span></a><a class="btn ghost" href="${url}" download="${esc(name)}" data-pdf-dl>${ICON.download}<span>Herunterladen</span></a></div>
    <p class="muted small">Zum Drucken das PDF öffnen und dort drucken${canShare ? " – oder über „Teilen“ an den Drucker, in Dateien oder per Mail senden" : ""}.</p>`;
  const sb = $("[data-pdf-share]", box);
  if (sb) sb.onclick = () => navigator.share({ files: [file], title: name.replace(/\.pdf$/, "") }).catch((e) => { if (e?.name !== "AbortError") toast("Teilen nicht möglich – bitte „Öffnen“ verwenden", 4200); });
  box.closest(".sheet")?.addEventListener("sheetclose", () => setTimeout(() => URL.revokeObjectURL(url), 60000), { once: true });
  box.scrollIntoView?.({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
}
function sosPrintSheet(c) {
  if (!c) return;
  let fmt = localStorage.getItem("pf-sos-fmt") === "sheet" ? "sheet" : "card";
  const { sh } = openSheet(`<div class="sheet-head row"><span class="sico k-sos">${ICON.sos}</span><div><h2>Notfallkarte drucken</h2><p class="muted small">${esc(c.name)} · als PDF zum Drucken oder Teilen</p></div></div>
    <div class="fmt-pick" role="radiogroup" aria-label="Format">
      <button role="radio" data-fmt="card"><i class="fmt-ill card" aria-hidden="true"><span></span><span></span><span></span></i><b>Scheckkarte zum Falten</b><small>A4 quer mit Schnittlinien, 2 Exemplare – passt in Geldbörse oder Rollatortasche</small></button>
      <button role="radio" data-fmt="sheet"><i class="fmt-ill sheet" aria-hidden="true"><span></span></i><b>A4-Notfallblatt</b><small>Groß lesbar – z. B. für Kühlschrank, Pflegemappe oder den Rettungsdienst</small></button>
    </div>
    <div id="pdf-out" class="pdf-out" aria-live="polite"></div>
    <div class="btns"><button class="btn ghost" data-close>Schließen</button><button class="btn" id="sos-mk">PDF erstellen</button></div>`, "sos-print");
  const mark = () => $$("[data-fmt]", sh).forEach((b) => { b.classList.toggle("on", b.dataset.fmt === fmt); b.setAttribute("aria-checked", String(b.dataset.fmt === fmt)); });
  $$("[data-fmt]", sh).forEach((b) => (b.onclick = () => { fmt = b.dataset.fmt; localStorage.setItem("pf-sos-fmt", fmt); mark(); $("#pdf-out", sh).innerHTML = ""; }));
  mark();
  $("#sos-mk", sh).onclick = (e) => busy(e.currentTarget, async () => {
    const L = await needPdf(), blob = fmt === "card" ? L.sosCard(c) : L.sosSheet(c);
    pdfOut($("#pdf-out", sh), blob, `${fmt === "card" ? "Notfallkarte" : "Notfallblatt"}-${fileSafe(c.name)}-${today()}.pdf`);
  }).catch(() => {});
}
// ---------- Arzt-Bericht ----------
const REP_SEC = [["basics", "Allergien, Diagnosen, Blutverdünner"], ["meds", "Medikamentenplan"], ["adh", "Einnahmetreue (vergessene Einnahmen)"], ["charts", "Werte: Diagramme und Min/Max/Durchschnitt"], ["table", "Messliste als Tabelle"], ["journal", "Befinden und Notizen aus dem Tagebuch"], ["questions", "Fragen an den Arzt"]];
const REP_DEF = { basics: true, meds: true, adh: true, charts: true, table: true, journal: true, questions: true };
const repSec = () => { try { return { ...REP_DEF, ...JSON.parse(localStorage.getItem("pf-rep-sec") || "{}") }; } catch { return { ...REP_DEF }; } };
const shortDay = (d) => parseD(d).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
function repAdherence(sid, fromDay, doses) {
  const meds = sMeds(sid), ids = new Set((S.D.meds || []).filter((m) => m.senior_id === sid).map((m) => m.id)), ds = doses.filter((d) => ids.has(d.medication_id));
  const foot = `„Vergessen“ heißt: bis ${MED_GRACE_MIN} Minuten nach der geplanten Zeit nicht als gegeben abgehakt – es kann auch nur die Eintragung fehlen.`;
  const first = ds.map((d) => d.day).sort()[0];
  if (!meds.length) return { rows: [], note: "Keine Medikamente im Plan.", foot };
  if (!first) return { rows: [], note: "Im Zeitraum wurden keine Einnahmen in Pflegekreis abgehakt.", foot };
  const start = first > fromDay ? first : fromDay, idx = new Map(ds.map((d) => [`${d.medication_id}|${d.day}|${d.slot}`, d])), now = Date.now(), t = today();
  const rows = meds.map((m) => {
    let planned = 0, given = 0, carer = 0; const miss = [];
    const s0 = ymd(new Date(m.created_at)) > start ? ymd(new Date(m.created_at)) : start;
    for (let day = s0; day <= t; day = addDays(day, 1)) for (const slot of m.times || []) {
      const sched = new Date(`${day}T${slot}:00`).getTime(), d = idx.get(`${m.id}|${day}|${slot}`);
      if (d?.given_at) { planned++; given++; if (d.done_by_kind === "carer") carer++; } else if (now > sched + MED_GRACE_MIN * 60000 && sched >= new Date(m.created_at).getTime() - 864e5) { planned++; miss.push(`${parseD(day).toLocaleDateString("de-DE", { day: "numeric", month: "numeric" })} ${slot}`); }
    }
    return { name: m.name, dosage: (m.dosage || "").split("·")[0].trim(), planned, given, carer, missed: miss.length, missedList: miss.length > 10 ? [...miss.slice(-10), `und ${miss.length - 10} weitere`] : miss };
  }).filter((r) => r.planned);
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const carerN = sum("carer");
  return { rows, planned: sum("planned"), given: sum("given"), carer: carerN, missed: sum("missed"), since: start > fromDay ? fmtDate(start) : "", foot: carerN ? foot + " „Pflegedienst“: vom Pflegedienst gegeben, von der Familie eingetragen." : foot };
}
function repVitals(sid, fromMs) {
  const T = vTargets(sid), out = [], cls = (x, r) => (!r || x == null ? "" : x > r[1] ? "hi" : x < r[0] ? "lo" : "in");
  const conv = (mg) => (gluMmol() ? mg / MMOL : mg), gd = gluMmol() ? 1 : 0;
  const st = (xs, label, f, dec = 0) => { const a = xs.map(f).filter((v) => v != null && v !== "").map(Number); return a.length ? { label, min: fmtN(Math.min(...a), dec), max: fmtN(Math.max(...a), dec), avg: fmtN(a.reduce((p, q) => p + q, 0) / a.length, dec) } : null; };
  const rng = (r, d = 0, f = (x) => x) => (r ? `${fmtN(f(r[0]), d)}–${fmtN(f(r[1]), d)}` : "");
  for (const k of VORDER) {
    const xs = vOf(sid, k).filter((v) => new Date(v.measured_at).getTime() >= fromMs).sort((a, b) => a.measured_at.localeCompare(b.measured_at));
    if (!xs.length) continue;
    const c = xs.map(vClass), dec = VK[k].d || 0, ms = (v) => new Date(v.measured_at).getTime();
    const o = { kind: k, name: VK[k].n, unit: k === "glucose" ? gluU() : k === "spo2" ? "% SpO2" : VK[k].u, n: xs.length, nout: c.filter((x) => x === "hi" || x === "lo").length, stats: [], series: [], band: null, band2: null, dash: [], target: "" };
    if (k === "bp") {
      o.stats = [st(xs, "oben (systolisch)", (v) => v.v1), st(xs, "unten (diastolisch)", (v) => v.v2), st(xs, "Puls", (v) => v.pulse)].filter(Boolean);
      o.series = [{ label: "oben (systolisch)", color: "#0F6B63", pts: xs.map((v) => [ms(v), Number(v.v1), cls(Number(v.v1), T.bp_sys)]) }, { label: "unten (diastolisch)", color: "#6C8FB8", pts: xs.map((v) => [ms(v), Number(v.v2), cls(Number(v.v2), T.bp_dia)]) }];
      o.band = T.bp_sys; o.band2 = T.bp_dia; o.bandLabel = "Zielbereiche"; o.target = `${rng(T.bp_sys)} / ${rng(T.bp_dia)} mmHg`;
    } else if (k === "glucose") {
      const pre = xs.filter((v) => gluKey(v.context) === "glu_pre"), post = xs.filter((v) => gluKey(v.context) === "glu_post");
      o.stats = [st(xs, "alle Messungen", (v) => conv(v.v1), gd), st(pre, "nüchtern / vor dem Essen", (v) => conv(v.v1), gd), st(post, "nach dem Essen / abends", (v) => conv(v.v1), gd)].filter(Boolean);
      o.series = [{ label: "nüchtern / vor dem Essen", color: "#0F6B63", pts: pre.map((v) => [ms(v), conv(v.v1), vClass(v)]) }, { label: "nach dem Essen / abends", color: "#6C8FB8", pts: post.map((v) => [ms(v), conv(v.v1), vClass(v)]) }].filter((s) => s.pts.length);
      o.band = T.glu_pre ? T.glu_pre.map(conv) : null; o.bandLabel = "Ziel nüchtern"; if (T.glu_post) { o.dash = [conv(T.glu_post[1])]; o.dashLabel = "Grenze nach dem Essen"; }
      o.target = [T.glu_pre && `nüchtern ${rng(T.glu_pre, gd, conv)}`, T.glu_post && `nach dem Essen bis ${fmtN(conv(T.glu_post[1]), gd)}`].filter(Boolean).join(" · ") + ` ${gluU()}`;
    } else {
      const r = T[k];
      o.stats = [st(xs, VK[k].n, (v) => v.v1, dec), k === "spo2" ? st(xs, "Puls", (v) => v.pulse) : null].filter(Boolean);
      o.series = [{ label: VK[k].n, color: "#0F6B63", pts: xs.map((v) => [ms(v), Number(v.v1), vClass(v)]) }];
      o.band = r || null; o.target = r ? `${rng(r, dec)} ${o.unit}` : "";
    }
    o.rows = xs.slice().reverse().map((v, i) => { const cc = vClass(v); return { d: shortDay(isoDay(v.measured_at)), t: hm(v.measured_at), val: k === "bp" ? `${fmtN(v.v1)}/${fmtN(v.v2)}` : k === "glucose" ? gluShow(v.v1) : fmtN(v.v1, dec), pulse: v.pulse ? String(v.pulse) : "", ctx: k === "glucose" ? GCTX[v.context || "other"] : "", cls: cc ? VCL[cc] : "–", out: cc === "hi" || cc === "lo", note: [isCarer(v) ? "durch Pflegedienst" : "", v.note || ""].filter(Boolean).join(" · ") }; });
    out.push(o);
  }
  return out;
}
function repJournal(sid, care, fromIso) {
  const xs = (care || []).filter((e) => e.senior_id === sid && e.created_at >= fromIso).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const cnt = {}; for (const e of xs) cnt[e.kind] = (cnt[e.kind] || 0) + 1;
  return { summary: Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${careK(k).n || k} ${n}×`).join(" · "),
    rows: xs.slice(0, 80).map((e) => ({ when: `${shortDay(isoDay(e.created_at))}, ${hm(e.created_at)}`, label: e.kind === "med" ? "Medikament (Bedarf / extra)" : careK(e.kind).n || e.kind, note: [e.note || "", isCarer(e) ? "(durch Pflegedienst)" : ""].filter(Boolean).join(" "), imp: !!careK(e.kind).imp })), more: Math.max(0, xs.length - 80) };
}
function reportModel(sid, days, sec, R, appt) {
  const s = senior(sid), c = sosData(sid), t = today(), fromDay = addDays(t, -(days - 1)), fromMs = new Date(fromDay + "T00:00:00").getTime(), fromIso = new Date(fromMs).toISOString();
  const ac = appt?.contact_id ? contact(appt.contact_id) : null, J = sec.journal ? repJournal(sid, R.care, fromIso) : null;
  return {
    person: { name: s.name, birth: c.birth, age: c.age, blood: c.blood },
    range: { from: fromMs, to: Date.now(), days, label: `${fmtDate(fromDay)} – ${fmtDate(t)} (${days} Tage)` },
    created: `${fmtDate(t)}, ${hm(new Date().toISOString())} Uhr${S.me?.display_name ? " von " + S.me.display_name : ""}`,
    appt: appt ? `${appt.title} am ${dayLabel(isoDay(appt.starts_at), true)}, ${hm(appt.starts_at)} Uhr${ac ? ` · ${ac.name}${ac.org ? " (" + ac.org + ")" : ""}` : ""}` : null,
    basics: sec.basics ? { allergies: c.allergies, diagnoses: c.diagnoses, flags: c.flags } : null,
    meds: sec.meds ? c.meds : null,
    adh: sec.adh ? repAdherence(sid, fromDay, R.doses || []) : null,
    vit: sec.charts || sec.table ? repVitals(sid, fromMs) : null, vitCharts: !!sec.charts, vitTable: !!sec.table,
    journal: J ? J.rows : null, journalSummary: J?.summary || "", journalMore: J?.more || 0,
    questions: sec.questions ? s.doctor_questions || "" : null,
  };
}
function reportSheet(sid, apptId = null) {
  sid = senior(sid) ? sid : vSid(); const s = senior(sid); if (!s) return;
  const appt = apptId ? S.D.appts.find((a) => a.id === apptId) : null;
  let days = 30; const sec = repSec();
  const { sh } = openSheet(`<div class="sheet-head row"><span class="sico k-vit">${ICON.report}</span><div><h2>Arzt-Bericht</h2><p class="muted small">PDF für den Arztbesuch – mit Werten, Medikamenten und euren Fragen</p></div></div>
    ${multiSen() && !appt ? `<div class="pchips" role="group" aria-label="Für wen?">${S.D.seniors.map((x) => `<button class="pchip ${sid === x.id ? "on" : ""}" data-rs="${x.id}" aria-pressed="${sid === x.id}" style="--pc:${sTone(x).c};--ps:${sTone(x).s};--pd:${sTone(x).d}">${sAva(x, "sm")}${esc(x.name)}</button>`).join("")}</div>` : `<p class="rep-for">${sChip(sid)}</p>`}
    ${appt ? `<p class="rep-appt">${ICON.cal}<span>Für den Termin <b>${esc(appt.title)}</b> · ${esc(dayLabel(isoDay(appt.starts_at), true))}, ${hm(appt.starts_at)} Uhr</span></p>` : ""}
    <label class="f">Zeitraum</label>
    <div class="seg small" role="group" aria-label="Zeitraum">${[7, 30, 90].map((d) => `<button type="button" data-rd="${d}" class="${d === days ? "on" : ""}" aria-pressed="${d === days}">${d} Tage</button>`).join("")}</div>
    <p class="muted small rep-cnt" id="rep-cnt"></p>
    <label class="f">Was soll in den Bericht?</label>
    <div class="card prefs rep-secs">${REP_SEC.map(([k, l]) => `<label class="switch"><span>${l}</span><input type="checkbox" data-rsec="${k}" ${sec[k] ? "checked" : ""}><i></i></label>`).join("")}</div>
    <div class="rep-q ${sec.questions ? "" : "hidden"}" id="rep-qbox"><label class="f" for="rep-q">Fragen an den Arzt</label>
      <textarea class="inp" id="rep-q" rows="4" maxlength="1500" placeholder="Eine Frage pro Zeile, z. B.&#10;Blutdruck morgens oft über 140 – Dosis anpassen?&#10;Wadenkrämpfe nachts – was hilft?">${esc(s.doctor_questions || "")}</textarea>
      <p class="muted small">Wird für ${esc(s.name)} gespeichert – die Familie kann die Fragen bis zum Termin ergänzen.</p></div>
    <p class="vnote">${ICON.shield}<span>Der Bericht fasst eure Einträge zusammen und markiert Werte außerhalb eurer Zielbereiche neutral – <b>keine Diagnose, kein Ersatz für ärztlichen Rat</b>.</span></p>
    <div id="pdf-out" class="pdf-out" aria-live="polite"></div>
    <div class="btns"><button class="btn ghost" data-close>Schließen</button><button class="btn" id="rep-mk">${ICON.report}<span>PDF erstellen</span></button></div>`, "tall rep");
  const ta = $("#rep-q", sh), out = $("#pdf-out", sh);
  const count = () => {
    const from = new Date(addDays(today(), -(days - 1)) + "T00:00:00").getTime(), n = (S.D.vitals || []).filter((v) => v.senior_id === sid && new Date(v.measured_at).getTime() >= from).length;
    $("#rep-cnt", sh).textContent = `${fmtDate(addDays(today(), -(days - 1)))} – ${fmtDate(today())} · ${n} ${n === 1 ? "Messung" : "Messungen"} · ${sMeds(sid).length} Medikamente im Plan`;
  };
  count();
  $$("[data-rd]", sh).forEach((b) => (b.onclick = () => { days = Number(b.dataset.rd); $$("[data-rd]", sh).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); }); count(); out.innerHTML = ""; }));
  $$("[data-rsec]", sh).forEach((i) => (i.onchange = () => { sec[i.dataset.rsec] = i.checked; localStorage.setItem("pf-rep-sec", JSON.stringify(sec)); $("#rep-qbox", sh).classList.toggle("hidden", !sec.questions); out.innerHTML = ""; }));
  const saveQ = async () => { const q = ta.value.trim(); if (q === (s.doctor_questions || "").trim()) return; await call("profile_save", { id: sid, doctor_questions: q }); s.doctor_questions = q || null; };
  ta.addEventListener("change", () => saveQ().catch((e) => toast(e.message, 4200)));
  $$("[data-rs]", sh).forEach((b) => (b.onclick = async () => { if (b.dataset.rs === sid) return; await saveQ().catch(() => {}); sh.__close(); reportSheet(b.dataset.rs); }));
  $("#rep-mk", sh).onclick = (e) => busy(e.currentTarget, async () => {
    if (!Object.values(sec).some(Boolean)) throw new Error("Bitte mindestens einen Abschnitt auswählen");
    if (sec.questions) await saveQ();
    const fromDay = addDays(today(), -(days - 1)), fromIso = new Date(fromDay + "T00:00:00").toISOString();
    const [L, R] = await Promise.all([needPdf(), sec.adh || sec.journal ? API.report(S.fid, fromIso, fromDay, (S.D.meds || []).filter((m) => m.senior_id === sid).map((m) => m.id)) : { doses: [], care: [] }]);
    const blob = L.report(reportModel(sid, days, sec, R, appt));
    pdfOut(out, blob, `Arzt-Bericht-${fileSafe(s.name)}-${today()}-${days}Tage.pdf`);
  }).catch(() => {});
}
function bindTaskRows(root, closeFirst) {
  $$("[data-tick]", root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); tick(b.dataset.tick, b); }));
  $$("[data-task]", root).forEach((el) => {
    el.onclick = () => { closeFirst?.(); taskSheet(el.dataset.task); };
    el.onkeydown = (e) => { if (e.key === "Enter" && e.target === el) el.onclick(); };
  });  bindAssign(root);
}
function bindPage(pg, id) {
  const root = $("#page");
  bindTaskRows(root); bindAssign(root);
  $$("[data-appt]", root).forEach((b) => (b.onclick = () => apptSheet(b.dataset.appt)));
  $$("div.appt[data-appt]", root).forEach((b) => (b.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === b) { e.preventDefault(); apptSheet(b.dataset.appt); } }));
  $$("[data-contact]", root).forEach((b) => (b.onclick = () => contactSheet(b.dataset.contact)));
  $$("[data-go]", root).forEach((el) => { el.onclick = (e) => { if (e.target.closest("button,a") && e.target.closest("button,a") !== el) return; location.hash = el.dataset.go; }; el.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); location.hash = el.dataset.go; } }; });
  const cs = $("#csearch", root); if (cs) cs.oninput = () => { const q = cs.value.trim().toLowerCase(); let n = 0; $$(".crow", root).forEach((r) => { const hit = !q || r.dataset.q.includes(q); r.hidden = !hit; n += hit ? 1 : 0; }); $$(".cgroup", root).forEach((g) => (g.hidden = !$$(".crow", g).some((r) => !r.hidden))); $("#c-none", root).hidden = n > 0; };
  bindNotes(root); bindDoses(root); bindHandoff(root); bindJournal(root);
  if (pg === "home") bindHome(root);
  $$("[data-act]", root).forEach((b) => (b.onclick = () => act(b.dataset.act, b)));
  $$("[data-tf]", root).forEach((b) => (b.onclick = () => { S.taskFilter = b.dataset.tf; localStorage.setItem("pf-plan-f", b.dataset.tf); render(true); }));
  $$("[data-ts]", root).forEach((b) => (b.onclick = () => { S.taskSenior = b.dataset.ts; render(true); }));
  $$("[data-vs]", root).forEach((b) => (b.onclick = () => { S.vSen = b.dataset.vs; render(true); }));
  $$("[data-vital]", root).forEach((b) => (b.onclick = () => vitalSheet(b.dataset.sid, b.dataset.vital)));
  $$("[data-pday]", root).forEach((b) => (b.onclick = () => { S.planDay = S.planDay === b.dataset.pday ? "" : b.dataset.pday; render(true); }));
  const ws = $("#wkstrip", root);
  if (ws) { ws.scrollLeft = S.wkScroll || 0; ws.addEventListener("scroll", () => (S.wkScroll = ws.scrollLeft), { passive: true }); }
  if ($("#push-on")) {
    $("#push-on").onclick = () => enablePush().then(() => { localStorage.setItem("pf-pushhint", "1"); S.pushMove = false; toast("Benachrichtigungen aktiv"); render(true); }).catch((e) => toast(e.message, 5000));
    $("#push-later").onclick = () => { localStorage.setItem("pf-pushhint", "1"); render(true); };
  }
  $$("[data-ptab]", root).forEach((b) => (b.onclick = () => { (S.pTab ||= {})[id] = b.dataset.ptab; render(true); $(".tabs")?.scrollIntoView({ block: "nearest" }); }));
  if (pg === "person") {
    const f = $("#snote"); if (f) f.onsubmit = (e) => { e.preventDefault(); const body = fd(f).body; busy(f.querySelector("button"), async () => { await call("note_save", { senior_id: id, body }); await reload(); }).catch(() => {}); };
  }
}
async function act(a, el) {
  switch (a) {
    case "new-any": return newSheet();
    case "new-task": return taskForm({}, { senior_id: el.dataset.sid || S.taskSenior || null, due_date: today() });
    case "new-appt": return apptForm({}, { senior_id: el.dataset.sid || null, day: today() });
    case "new-contact": return contactForm({}, {});
    case "new-med-any": return S.D.seniors.length ? medForm(null, {}) : seniorForm();
    case "settings": return settingsSheet();
    case "plan-for": S.taskSenior = el.dataset.sid || ""; S.taskFilter = "open"; S.planDay = ""; if (!myCare().length) { S.calOpen = true; S.calDay = ""; } location.hash = "#/plan"; return;
    case "new-vital": return vitalForm(null, { senior_id: el.dataset.sid || vSid(), kind: el.dataset.kind || undefined });
    case "vtargets": return vTargetsForm(el.dataset.sid || vSid());
    case "glu-unit": return gluUnitSheet();
    case "aid": return aidSheet();
    case "journal-add": return entrySheet(el.dataset.sid || (route().page === "person" ? route().id : ""));
    case "journal-for": { const J = jState(); J.sen = el.dataset.sid || ""; J.view = "day"; J.mem = ""; location.hash = "#/tagebuch"; return; }
    case "invite": return inviteSheet();
    case "notify": return notifySheet();
    case "add-senior": return seniorForm();
    case "new-med": return medForm(null, { senior_id: el.dataset.sid });
    case "edit-senior": return seniorForm(senior(el.dataset.id));
    case "edit-profile": return profileForm(senior(el.dataset.id));
    case "report": return reportSheet(el.dataset.sid || vSid());
    case "sos-print": return sosPrintSheet(sosData(el.dataset.sid));
    case "new-code": if (await confirmSheet("Neuen Code erzeugen?", "Der alte Einladungslink funktioniert danach nicht mehr.", "Neuer Code", false)) { await busy(null, () => call("new_invite_code")).catch(() => {}); await reload(); } return;
    case "password": return passwordSheet();
    case "rename-me": return promptSheet("Dein Name", S.me.display_name, 40, async (v) => { await API.fn("update_profile", { display_name: v }); S.me.display_name = v; await reload(); });
    case "rename-fam": return promptSheet("Name der Familie", fam().name, 60, async (v) => { await call("rename_family", { name: v }); await reload(); });
    case "switch": return famSwitcher();
    case "another": S.unsub?.(); S.unsub = null; return renderOnboarding(2);
    case "leave": {
      const alone = S.D.members.length === 1;
      if (!(await confirmSheet("Familie verlassen?", alone ? "Du bist das letzte Mitglied – die Familie und alle ihre Daten werden gelöscht." : "Du siehst die Daten dieser Familie danach nicht mehr.", "Verlassen"))) return;
      const ok = await busy(null, () => call("remove_member", { user_id: S.uid })).catch(() => null);
      if (!ok) return;
      S.fams = await API.families(S.uid); location.hash = "#/";
      if (S.fams.length) return openFamily(S.fams[0].id);
      S.D = null; S.unsub?.(); return renderOnboarding(2);
    }
    case "logout": return logout();
    case "acc-add": return accAdd();
    case "delete-account": return deleteAccount();
    case "demo-reset": if (await confirmSheet("Demo zurücksetzen?", "Alle Demo-Daten in diesem Browser werden gelöscht.", "Zurücksetzen")) { API.reset(); history.replaceState(null, "", location.pathname); location.reload(); } return;
  }
}
function promptSheet(title, value, max, save) {
  const { sh, close } = openSheet(`<h2>${esc(title)}</h2><form id="pf" class="form"><input class="inp" name="v" required maxlength="${max}" value="${esc(value)}"><div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn" type="submit">Speichern</button></div></form>`);
  $("#pf", sh).onsubmit = async (e) => { e.preventDefault(); const v = fd(e.target).v.trim(); const ok = await busy(e.target.querySelector("[type=submit]"), () => save(v)).then(() => true).catch(() => false); if (ok) { close(); toast("Gespeichert"); } };
}
function seniorForm(s) {
  s = s || { color: S.D.seniors.length % 8 };
  const { sh, close } = openSheet(`<h2>${s.id ? "Person bearbeiten" : "Person hinzufügen"}</h2>
    <form id="sf" class="form">
      <label class="f" for="sf-n">Name</label><input class="inp" id="sf-n" name="name" required maxlength="60" value="${esc(s.name || "")}" placeholder="z. B. Opa Werner">
      <label class="f" for="sf-a">Adresse / Haushalt (optional)</label><input class="inp" id="sf-a" name="address" maxlength="120" list="sf-al" value="${esc(s.address || "")}" placeholder="z. B. Ahornweg 12, 50667 Köln" autocomplete="off">
      <datalist id="sf-al">${[...new Set(S.D.seniors.map((x) => x.address).filter(Boolean))].map((a) => `<option value="${esc(a)}">`).join("")}</datalist>
      <p class="muted small">Personen mit derselben Adresse erscheinen auf der Startseite zusammen als ein Haushalt.</p>
      <label class="f" for="sf-i">Wichtige Hinweise (optional)</label>
      <textarea class="inp" id="sf-i" name="info" rows="3" maxlength="1000" placeholder="z. B. Adresse, Telefon Hausarzt, Schlüssel bei Nachbarin Frau Kurz">${esc(s.info || "")}</textarea>
      <p class="muted small">Diagnosen, Geburtsdatum und Blutgruppe gehören ins Care-Profil (Person → Profil) – von dort kommen sie auf die Notfallkarte.</p>
      <label class="f">Farbe</label><div class="colors">${SENIOR_COLORS.map((c, i) => `<label><input type="radio" name="color" value="${i}" ${Number(s.color) === i ? "checked" : ""}><span style="background:${c}"></span></label>`).join("")}</div>
      <p class="muted small">Tipp: Heißt die Person „Oma …“ oder „Opa …“, zeigt Pflegekreis eine kleine Illustration statt der Initialen.</p>
      <div class="btns">${s.id && isAdmin() ? `<button type="button" class="btn ghost danger-t" id="sf-del">Löschen</button>` : `<button type="button" class="btn ghost" data-close>Abbrechen</button>`}<button class="btn" type="submit">Speichern</button></div>
    </form>`);
  $("#sf", sh).onsubmit = async (e) => { e.preventDefault(); const v = fd(e.target); const r = await busy(e.target.querySelector("[type=submit]"), () => call("senior_save", { id: s.id, ...v })).catch(() => null); if (r) { close(); toast("Gespeichert"); await reload(); } };
  if ($("#sf-del", sh)) $("#sf-del", sh).onclick = async () => { if (await confirmSheet(`${s.name} löschen?`, "Notizen zu dieser Person werden gelöscht, Aufgaben, Termine und Kontakte bleiben ohne Zuordnung erhalten.")) { close(); await busy(null, () => call("senior_delete", { id: s.id })).catch(() => {}); location.hash = "#/"; await reload(); } };
}
function memberSheet(uid) {
  const m = member(uid); if (!m) return;
  const admin = isAdmin(), self = uid === S.uid;
  const open = openTasks().filter((t) => t.assignee_id === uid);
  const { sh, close } = openSheet(`<div class="sheet-head row">${ava(uid, "lg")}<div><h2>${esc(m.display_name)}</h2><p class="muted">@${esc(m.username)} · ${roleName(m)} · dabei seit ${new Date(m.joined_at).toLocaleDateString("de-DE")}</p></div></div>
    <h3 class="sec">Zuständig für</h3><div class="list">${open.map((t) => taskRow(t)).join("") || '<p class="muted small">Gerade keine offenen Aufgaben.</p>'}</div>
    ${admin && !self ? `<div class="btns col"><button class="btn ghost" id="m-pw"><span class="ico ln">${ICON.key}</span> Passwort zurücksetzen</button><button class="btn ghost" id="m-role"><span class="ico ln">${ICON.user}</span> Rolle: ${roleName(m)} – ändern</button><button class="btn ghost danger-t" id="m-rm">Aus Familie entfernen</button></div>` : ""}
    <p class="muted small">Admins verwalten Mitglieder und Personen und können den Einladungscode erneuern. Mithelfer können Aufgaben, Termine, Kontakte und Notizen anlegen.</p>`);
  bindTaskRows(sh, close);
  if ($("#m-pw", sh)) $("#m-pw", sh).onclick = () => resetMemberPw(m, close);
  if ($("#m-role", sh)) $("#m-role", sh).onclick = () => { close(); roleSheet(m); };
  if ($("#m-rm", sh)) $("#m-rm", sh).onclick = async () => { if (await confirmSheet(`${m.display_name} entfernen?`, "Die Person sieht die Daten dieser Familie danach nicht mehr.", "Entfernen")) { close(); await busy(null, () => call("remove_member", { user_id: uid })).catch(() => {}); await reload(); } };
}
const roleName = (m) => m.role === "admin" ? "Admin" : m.role === "senior" ? `Senior${senior(m.senior_id) ? " · " + senior(m.senior_id).name : ""}` : "Mithelfer";
// Admin: Rolle eines Mitglieds wählen – Admin, Mithelfer oder Senior (große, vereinfachte Ansicht für die gepflegte Person selbst)
function roleSheet(m) {
  let r = m.role, sid = m.senior_id || (S.D.seniors.length === 1 ? S.D.seniors[0].id : "");
  const R = [["admin", "Admin", "Verwaltet Mitglieder, Personen und Einladungen"], ["helper", "Mithelfer", "Aufgaben, Termine, Medikamente, Kontakte, Tagebuch"],
    ["senior", "Senior", "Große, einfache Ansicht für die gepflegte Person selbst: eigene Medikamente abhaken, Befinden, Werte, Anrufen, Notfallkarte"]];
  const draw = () => `<h2>Rolle von ${esc(m.display_name)}</h2>
    <div class="card list-card role-pick">${R.map(([k, l, d]) => `<label class="mrow rp"><input type="radio" name="role" value="${k}" ${r === k ? "checked" : ""}><span><b>${l}</b><small class="muted">${d}</small></span></label>`).join("")}</div>
    ${r === "senior" ? `<label class="f" for="rp-sid">Wer benutzt dieses Konto?</label><select class="inp" id="rp-sid"><option value="">Bitte wählen …</option>${S.D.seniors.map((s) => opt(s.id, s.name, s.id === sid)).join("")}</select>
      <p class="muted small">Im Senioren-Modus sieht ${esc(m.display_name)} nur das Nötigste in großer Schrift und kann nur für sich selbst eintragen. Plan, Kontakte und Einstellungen bleiben bei euch. Über „Hilfe holen“ bekommt ihr eine Benachrichtigung.</p>` : ""}
    <p class="err"></p><div class="btns"><button class="btn ghost" data-close>Abbrechen</button><button class="btn" id="rp-ok">Speichern</button></div>`;
  const { sh, close } = openSheet(draw(), "role-sheet");
  const bind = () => {
    $$("[name=role]", sh).forEach((x) => (x.onchange = () => { r = x.value; const st = sh.scrollTop; sh.innerHTML = `<div class="grab" aria-hidden="true"><i></i></div>` + draw(); sh.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => sh.__close())); bind(); sh.scrollTop = st; }));
    if ($("#rp-sid", sh)) $("#rp-sid", sh).onchange = (e) => (sid = e.target.value);
    $("#rp-ok", sh).onclick = async (e) => {
      if (r === "senior" && !sid) { $(".err", sh).textContent = "Bitte die Person wählen"; return; }
      const ok = await busy(e.currentTarget, () => call("set_role", { user_id: m.user_id, role: r, senior_id: r === "senior" ? sid : null }), true).then(() => true).catch((er) => { $(".err", sh).textContent = er.message; return false; });
      if (ok) { close(); toast(r === "senior" ? `${m.display_name} nutzt jetzt den Senioren-Modus` : "Rolle gespeichert"); await reload(); }
    };
  };
  bind();
}
function deleteAccount() {
  const { sh, close } = openSheet(`<h2>Konto löschen?</h2><p class="muted">Dein Konto und deine Mitgliedschaften werden gelöscht. Familien, in denen du allein bist, werden komplett gelöscht. Tippe zur Bestätigung deinen Benutzernamen <b>${esc(S.me.username)}</b>:</p>
    <form id="df" class="form"><input class="inp" name="c" required autocapitalize="none"><div class="btns"><button type="button" class="btn ghost" data-close>Abbrechen</button><button class="btn danger" type="submit">Endgültig löschen</button></div></form>`);
  $("#df", sh).onsubmit = async (e) => { e.preventDefault(); const ok = await busy(e.target.querySelector("[type=submit]"), () => API.fn("delete_account", { confirm: fd(e.target).c })).catch(() => null); if (ok) { close(); await logout(); toast("Konto gelöscht"); } };
}

// ---------- Push ----------
let swReg = null;
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { swReg = await navigator.serviceWorker.register("sw.js", { scope: "./" }); swReg.update().catch(() => {}); } catch (e) { console.warn(e); }
}
const b64ToU8 = (b) => { const p = "=".repeat((4 - (b.length % 4)) % 4); const s = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function enablePush() {
  if (DEMO) throw new Error("Im Demo-Modus gibt es keine Push-Benachrichtigungen");
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches;
    throw new Error(ios ? "Auf dem iPhone: Teilen → „Zum Home-Bildschirm“, dann die App von dort öffnen und aktivieren." : "Dieser Browser unterstützt keine Push-Benachrichtigungen.");
  }
  const perm = await Notification.requestPermission(); // direkt im Tap aufrufen (iOS)
  if (perm !== "granted") throw new Error("Benachrichtigungen wurden nicht erlaubt (Browser-Einstellungen prüfen).");
  if (!swReg) swReg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(C.vapidPublicKey) });
  await API.fn("subscribe", { subscription: sub.toJSON() });
}
// Push sanft erneuern (z. B. nach Umzug auf die eigene Domain – Push-Abos hängen an der Web-Adresse):
// Erlaubnis da → Abo still anlegen/auffrischen; sonst prüfen, ob es Abos von der alten Adresse gibt → Hinweis „neu einschalten“
async function pushRefresh() {
  if (DEMO || S.pushChecked || !("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator) || !C.vapidPublicKey) return;
  S.pushChecked = true;
  try {
    if (Notification.permission === "granted") {
      if (!swReg) swReg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(C.vapidPublicKey) }));
      await API.fn("subscribe", { subscription: sub.toJSON() });
    } else if (Notification.permission === "default") {
      const st = await API.fn("push_status");
      if (st.elsewhere > 0 && st.here === 0 && !S.pushMove) { S.pushMove = true; render(true); }
    }
  } catch {}
}
async function unsubscribePush(quiet = false) {
  if (DEMO) return;
  try { const reg = swReg || (await navigator.serviceWorker?.getRegistration()); const sub = await reg?.pushManager?.getSubscription(); if (sub) { await API.fn("unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); if (!quiet) await sub.unsubscribe(); } } catch {}
}
async function pushState() {
  const el = $("#pstate"), b = $("#pon"); if (!el) return;
  let on = false;
  try { if (window.Notification && Notification.permission === "granted") { const reg = swReg || (await navigator.serviceWorker.getRegistration()); on = !!(await reg?.pushManager.getSubscription()); } } catch {}
  el.innerHTML = DEMO ? "Im Demo-Modus nicht verfügbar" : on ? "🔔 <b>Aktiv</b> auf diesem Gerät" : window.Notification?.permission === "denied" ? "🔕 Im Browser blockiert" : "🔕 Aus auf diesem Gerät";
  b.textContent = on ? "Ausschalten" : "Aktivieren"; b.dataset.on = on ? "1" : "0"; b.classList.toggle("ghost", on); b.disabled = DEMO;
}
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "open" && e.data.url) { const u = new URL(e.data.url); location.hash = u.hash || "#/"; } });

window.addEventListener("hashchange", () => { resetKeyboard(true); $$(".sheet,.backdrop").forEach((x) => x.remove()); document.body.classList.remove("noscroll"); sheetRefresh = null; render(); clearStaleLayers(); });
// ---------- Update-Check: neue Version erkennen (Start, Rückkehr in den Vordergrund, alle 20 Min.) ----------
// iOS hält Home-Bildschirm-Apps oft tagelang im Speicher – ohne Neuladen bliebe die alte Oberfläche stehen.
let updLast = 0, updBusy = false, updNew = "";
function updSafe() { const a = document.activeElement; return !document.querySelector(".sheet") && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && !S.loggingOut; }
function updBanner() {
  if (document.querySelector("#upd-bar")) return;
  const b = document.createElement("button"); b.id = "upd-bar"; b.type = "button"; b.innerHTML = "<b>Neue Version</b> – tippen zum Neuladen";
  b.onclick = () => updReload(true); document.body.appendChild(b);
}
async function updReload(force) {
  try { const tried = sessionStorage.getItem("pf-upd-try"); if (!force && tried === updNew) return updBanner(); sessionStorage.setItem("pf-upd-try", updNew); } catch {}
  try { const reg = swReg || (await navigator.serviceWorker?.getRegistration()); await Promise.race([reg?.update(), sleep(2500)]); } catch {}
  location.reload();
}
async function checkUpdate(why) {
  if (updBusy || APP_V === "dev" || APP_V === "1" || Date.now() - updLast < 20000) return; updBusy = true; updLast = Date.now();
  try {
    const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" }); if (!r.ok) return;
    const v = String((await r.json()).v || ""); if (!v || v === APP_V) return;
    updNew = v;
    if (why === "start" || (why === "resume" && updSafe())) return updReload(false);
    updSafe() ? updReload(false) : updBanner();
  } catch {} finally { updBusy = false; }
}
window.__pfUpd = { check: (w) => { updLast = 0; return checkUpdate(w || "resume"); }, v: () => APP_V };
setTimeout(() => checkUpdate("start"), 1200);
setInterval(() => document.visibilityState === "visible" && checkUpdate("timer"), 20 * 60 * 1000);
window.addEventListener("pageshow", (e) => { if (e.persisted) checkUpdate("resume"); });
document.addEventListener("visibilitychange", () => {
  // Beim Wechsel in den Hintergrund schließt iOS die Tastatur, meldet das aber nicht immer → Zustand vorher sauber auflösen
  if (document.visibilityState === "hidden") { resetKeyboard(true); return; }
  resetKeyboard(); clearStaleLayers(); [250, 700].forEach((t) => setTimeout(updateViewport, t));
  if (S.D) reload().catch(() => {});
  checkUpdate("resume");
});
boot();
})();
