/* Pflegekreis – Demo-Backend: gleiche Schnittstelle wie Supabase, Daten nur im localStorage dieses Browsers */
window.PF_DEMO_BACKEND = function (C) {
  "use strict";
  const KEY = "pf-demo-db", SKEY = "pf-demo-session";
  const blank = () => ({ users: [], families: [], members: [], seniors: [], tasks: [], appts: [], contacts: [], vitals: [], messages: [], notes: [], meds: [], doses: [], care: [], handoffs: [], shifts: [], prefs: [], photos: {} });
  let db; try { db = JSON.parse(localStorage.getItem(KEY)) || blank(); } catch { db = blank(); }
  if (!db.messages || !db.meds || !db.care) { db = blank(); localStorage.removeItem(KEY); } // alte Demo-Daten (v1 mit Updates) verwerfen
  if (!db.contacts) db.contacts = []; // Demo-Daten von vor den Kontakten weiterverwenden
  if (!db.vitals) db.vitals = []; // … und von vor den Messwerten
  if (!db.shifts) db.shifts = []; // … und von vor dem Pflegedienst-Einsatzplan
  const listeners = new Set();
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("pf-demo") : null;
  if (bc) bc.onmessage = () => { try { db = JSON.parse(localStorage.getItem(KEY)) || blank(); } catch {} listeners.forEach((f) => f()); };
  const save = (notify = true) => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { throw new Error("Speicher voll – bitte Demo zurücksetzen"); } if (!notify) return; bc?.postMessage(1); listeners.forEach((f) => f()); };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
  const now = () => new Date().toISOString();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
  const normCode = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const exp14 = () => new Date(Date.now() + 14 * 864e5).toISOString();
  const findInv = (c) => { const f = db.families.find((x) => x.invite_code === normCode(c)); if (!f) fail("Einladungscode unbekannt"); if (f.invite_expires_at && new Date(f.invite_expires_at) < new Date()) fail("Dieser Einladungscode ist abgelaufen – bitte um einen neuen Code bitten."); return f; };
  const code = () => Array.from({ length: 10 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
  const fail = (m) => { throw new Error(m); };
  const must = (v, max, label) => { const s = String(v ?? "").trim().slice(0, max); if (!s) fail(`${label} fehlt`); return s; };
  const str = (v, max) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
  const hash = (s) => [...String(s)].reduce((a, c) => ((a * 31 + c.charCodeAt(0)) | 0), 7).toString(36);
  const sess = () => { try { return JSON.parse(localStorage.getItem(SKEY)); } catch { return null; } };
  const role = (fid, uid) => { const m = db.members.find((x) => x.family_id === fid && x.user_id === uid); if (!m) fail("Kein Zugriff auf diese Familie"); return m.role; };
  const admin = (fid, uid) => { if (role(fid, uid) !== "admin") fail("Nur Admins dürfen das"); };
  // „Erledigt von“ (wie Edge Function): self (Standard) · carer (Pflegedienst-Kontakt, ohne Konto) · member (anderes Mitglied)
  const DONE0 = { done_by_kind: null, carer_contact_id: null, done_by_user: null };
  const doneBy = (fid, uid, raw) => {
    if (!raw || typeof raw !== "object") return { ...DONE0 };
    const r = role(fid, uid), k = String(raw.kind ?? "self");
    if (r === "senior" || k === "self") return { ...DONE0 };
    if (k === "carer") {
      if (!raw.carer_contact_id) return { ...DONE0, done_by_kind: "carer" };
      const c = db.contacts.find((x) => x.id === raw.carer_contact_id && x.family_id === fid);
      if (!c || c.category !== "pflegedienst") fail("Bitte einen Pflegedienst aus den Kontakten wählen");
      return { ...DONE0, done_by_kind: "carer", carer_contact_id: c.id };
    }
    if (k === "member") {
      if (!raw.user_id || raw.user_id === uid) return { ...DONE0 };
      if (!db.members.some((m) => m.family_id === fid && m.user_id === raw.user_id)) fail("Person ist kein Familienmitglied");
      return { ...DONE0, done_by_kind: "member", done_by_user: raw.user_id };
    }
    fail("„Erledigt von“ ungültig");
  };
  const inFam = (list, id, fid) => { if (!id) return null; if (!db[list].some((x) => x.id === id && x.family_id === fid)) fail("Nicht gefunden"); return id; };
  const isMem = (fid, uid) => { if (!uid) return null; if (!db.members.some((m) => m.family_id === fid && m.user_id === uid)) fail("Person ist kein Mitglied"); return uid; };
  // Demo-Ersatz für den pg_cron-Job: nicht markierte Einnahmen nach 30 Min. als „verpasst“ markieren (→ Tagebuch, Heute)
  const medCheck = (fid) => {
    const t = Date.now();
    for (const med of db.meds.filter((m) => m.family_id === fid)) for (const day of [addDays(today(), -1), today()]) for (const slot of med.times) {
      const dl = new Date(`${day}T${slot}:00`).getTime() + 30 * 60000;
      if (dl > t || dl < t - 12 * 3600e3 || dl < new Date(med.created_at).getTime()) continue;
      let d = db.doses.find((x) => x.medication_id === med.id && x.day === day && x.slot === slot);
      if (d && (d.given_at || d.missed_notified_at)) continue;
      if (!d) { d = { id: uuid(), family_id: fid, medication_id: med.id, day, slot, scheduled_at: new Date(`${day}T${slot}:00`).toISOString(), given_by: null, given_at: null, created_at: now() }; db.doses.push(d); }
      d.missed_notified_at = new Date(Math.min(t, dl + 60000)).toISOString();
    }
  };
  const CARE = { med: ["💊", "Medikament gegeben"], ate_well: ["🍽️", "Hat gut gegessen"], ate_little: ["🥄", "Wenig gegessen"], slept_well: ["😴", "Gut geschlafen"], slept_bad: ["🌙", "Schlecht geschlafen"], mood_good: ["😊", "Gute Laune"], mood_ok: ["😐", "Geht so"], mood_bad: ["☹️", "Fühlt sich nicht gut", 1], help: ["🔔", "Hat um Hilfe gebeten", 1], restless: ["😟", "War unruhig", 1], pain: ["🤕", "Hat Schmerzen", 1], special: ["⚠️", "Besonderheit heute", 1] };
  // Übernahmen enden um Mitternacht (Ortszeit): offene Einträge von früheren Tagen schließen (Ende = Mitternacht nach Beginn)
  const staleHandoffs = (fid) => {
    const t = today();
    for (const h of db.handoffs) if (h.family_id === fid && !h.ended_at && ymd(new Date(h.created_at)) < t) { const d = new Date(h.created_at); d.setHours(24, 0, 0, 0); h.ended_at = d.toISOString(); }
  };
  const snapshot = (fid, sid) => {
    const t = today(), n = Date.now();
    const tasks = db.tasks.filter((x) => x.family_id === fid && (x.senior_id === sid || !x.senior_id) && x.status !== "done" && ((x.due_date && x.due_date <= t) || x.status === "in_progress"))
      .map((x) => `${x.title}${x.due_time ? " · " + x.due_time.slice(0, 5) : ""}${x.due_date && x.due_date < t ? " (überfällig)" : ""}${x.status === "in_progress" ? " (in Arbeit)" : ""}`);
    const meds = [];
    for (const m of db.meds.filter((x) => x.family_id === fid && x.senior_id === sid && x.active)) for (const sl of m.times) {
      if (db.doses.some((d) => d.medication_id === m.id && d.day === t && d.slot === sl && d.given_at)) continue;
      meds.push(`${sl} ${m.name}${m.dosage ? " " + m.dosage : ""}${new Date(`${t}T${sl}:00`).getTime() + 30 * 60000 < n ? " (verpasst)" : ""}`);
    }
    const ap = db.appts.filter((a) => a.family_id === fid && a.senior_id === sid && new Date(a.starts_at).getTime() > n - 3600e3).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
    return { tasks, meds: meds.sort(), appt: ap ? `${new Date(ap.starts_at).toLocaleString("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${ap.title}` : null };
  };
  const dropMsgs = (fn) => { db.messages = db.messages.filter((m) => { if (fn(m)) { if (m.media_path) delete db.photos[m.media_path]; return false; } return true; }); };
  const delFamily = (fid) => {
    for (const u of db.messages.filter((x) => x.family_id === fid && x.media_path)) delete db.photos[u.media_path];
    for (const k of ["members", "seniors", "tasks", "appts", "contacts", "vitals", "messages", "notes", "meds", "doses", "care", "handoffs", "shifts"]) db[k] = db[k].filter((x) => x.family_id !== fid);
    db.families = db.families.filter((f) => f.id !== fid);
  };

  function action(a, b) {
    if (a === "config") return { vapidPublicKey: "", emailDomain: C.emailDomain };
    if (a === "invite_info") { const f = findInv(b.code); return { name: f.name, expires_at: f.invite_expires_at }; }
    if (a === "signup") {
      const username = String(b.username || "").trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,24}$/.test(username)) fail("Benutzername: 3–24 Zeichen, nur a–z, 0–9, _ . -");
      if (String(b.password || "").length < 8) fail("Passwort braucht mindestens 8 Zeichen");
      if (!b.consent) fail("Bitte der Datenschutz-Information zustimmen");
      if (!b.consent_health) fail("Bitte der Verarbeitung von Gesundheitsdaten zustimmen – ohne sie kann Pflegekreis nicht genutzt werden");
      if (db.users.some((u) => u.username === username)) fail("Benutzername ist schon vergeben – bitte einen anderen wählen");
      db.users.push({ id: uuid(), username, display_name: String(b.display_name || "").trim().slice(0, 40) || username, pw: hash(b.password), consent_health_at: now() });
      save(); return { ok: true };
    }
    const s = sess(); if (!s) fail("Bitte neu anmelden");
    const me = db.users.find((u) => u.id === s.uid); if (!me) fail("Bitte neu anmelden");
    const fid = b.family_id;
    // Senioren-Modus wie in der Edge Function: nur wenige Aktionen, nur für die eigene Person
    const sm = fid && db.members.find((x) => x.family_id === fid && x.user_id === me.id);
    if (sm?.role === "senior") {
      if (!["dose_give", "dose_undo", "vital_save", "vital_delete", "care_add", "care_delete", "help_request", "prefs_save", "subscribe", "unsubscribe", "push_status", "test_push", "change_password", "consent_save", "update_profile", "delete_account"].includes(a)) fail("Im Senioren-Modus nicht möglich");
      const own = sm.senior_id;
      if (a === "dose_give" && db.meds.find((m) => m.id === b.medication_id)?.senior_id !== own) fail("Nur deine eigenen Medikamente");
      if (a === "dose_undo") { const d = db.doses.find((x) => x.id === b.id); if (d && db.meds.find((m) => m.id === d.medication_id)?.senior_id !== own) fail("Nur deine eigenen Medikamente"); }
      if (["vital_save", "care_add", "help_request"].includes(a) && b.senior_id !== own) fail("Nur für dich selbst eintragen");
      if (a === "vital_save" && b.id) fail("Im Senioren-Modus können Messwerte nur neu eingetragen werden");
    }
    if (me.must_change_password && !["set_new_password", "consent_save", "delete_account"].includes(a)) fail("Bitte zuerst ein eigenes Passwort festlegen");
    const pwOk = (v) => { const p = String(v || ""); if (p.length < 8) fail("Das neue Passwort braucht mindestens 8 Zeichen"); if (p.length > 72) fail("Das neue Passwort darf höchstens 72 Zeichen haben"); return p; };
    switch (a) {
      case "change_password": {
        if (!b.old_password) fail("Bitte dein bisheriges Passwort eingeben");
        const np = pwOk(b.new_password);
        if (np === b.old_password) fail("Das neue Passwort muss sich vom bisherigen unterscheiden");
        if (hash(b.old_password) !== me.pw) fail("Das bisherige Passwort stimmt nicht");
        me.pw = hash(np); (db.audit ||= []).push({ at: now(), actor: me.id, target: me.id, action: "pw_change" }); break;
      }
      case "set_new_password": {
        if (!me.must_change_password) fail("Dein Passwort muss nicht neu gesetzt werden – nutze „Passwort ändern“");
        if (me.pw_reset_expires_at && new Date(me.pw_reset_expires_at) < new Date()) fail("Das Einmal-Passwort ist abgelaufen – bitte den Admin deiner Familie um ein neues");
        const np = pwOk(b.new_password);
        if (hash(np) === me.pw) fail("Bitte ein eigenes, neues Passwort wählen – nicht das Einmal-Passwort");
        me.pw = hash(np); me.must_change_password = false; me.pw_reset_expires_at = null; (db.audit ||= []).push({ at: now(), actor: me.id, target: me.id, action: "pw_set_after_reset" }); break;
      }
      case "reset_member_password": {
        admin(fid, me.id);
        if (b.user_id === me.id) fail("Dein eigenes Passwort änderst du unter Einstellungen › „Passwort ändern“. Hast du es vergessen, kann ein anderer Admin deiner Familie es zurücksetzen.");
        isMem(fid, b.user_id);
        for (const m of db.members.filter((x) => x.user_id === b.user_id && x.family_id !== fid)) if (!db.members.some((x) => x.family_id === m.family_id && x.user_id === me.id && x.role === "admin")) fail("Diese Person ist noch in einer anderen Familie, in der du kein Admin bist. Aus Sicherheitsgründen kann ihr Passwort dann nur dort zurückgesetzt werden.");
        const t = db.users.find((u) => u.id === b.user_id), abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const r = Array.from({ length: 12 }, () => abc[Math.floor(Math.random() * 32)]).join(""), temp = `${r.slice(0, 4)}-${r.slice(4, 8)}-${r.slice(8)}`;
        t.pw = hash(temp); t.must_change_password = true; t.pw_reset_expires_at = new Date(Date.now() + 3 * 864e5).toISOString();
        (db.audit ||= []).push({ at: now(), family_id: fid, actor: me.id, target: t.id, action: "pw_reset" });
        save(); return { temp_password: temp, expires_at: t.pw_reset_expires_at, sessions_ended: 0, name: t.display_name };
      }
      case "update_profile": me.display_name = must(b.display_name, 40, "Name"); break;
      case "create_family": { const f = { id: uuid(), name: must(b.name, 60, "Familienname"), invite_code: code(), invite_expires_at: exp14(), created_by: me.id, created_at: now() }; db.families.push(f); db.members.push({ family_id: f.id, user_id: me.id, role: "admin", joined_at: now() }); save(); return { family: f }; }
      case "join_family": {
        const f = findInv(b.code);
        const ex = db.members.some((m) => m.family_id === f.id && m.user_id === me.id);
        if (!ex) db.members.push({ family_id: f.id, user_id: me.id, role: "helper", joined_at: now() });
        save(); return { family: { id: f.id, name: f.name }, joined: !ex };
      }
      case "rename_family": admin(fid, me.id); db.families.find((f) => f.id === fid).name = must(b.name, 60, "Familienname"); break;
      case "new_invite_code": { admin(fid, me.id); const f = db.families.find((x) => x.id === fid); f.invite_code = code(); f.invite_expires_at = exp14(); save(); return { invite_code: f.invite_code, invite_expires_at: f.invite_expires_at }; }
      case "consent_save": if (!b.consent_health) fail("Bitte zustimmen"); me.consent_health_at = now(); break;
      case "set_role": {
        admin(fid, me.id); const m = db.members.find((x) => x.family_id === fid && x.user_id === b.user_id); if (!m) fail("Person ist kein Mitglied");
        if (b.role !== "admin" && m.role === "admin" && db.members.filter((x) => x.family_id === fid && x.role === "admin").length <= 1) fail("Es muss mindestens einen Admin geben");
        const r = b.role === "admin" ? "admin" : b.role === "senior" ? "senior" : "helper";
        if (r === "senior") { if (b.user_id === me.id) fail("Den Senioren-Modus bitte für ein anderes Konto einschalten"); if (!db.seniors.some((x) => x.id === b.senior_id && x.family_id === fid)) fail("Bitte die Person wählen, die dieses Konto benutzt"); }
        m.role = r; m.senior_id = r === "senior" ? b.senior_id : null; break;
      }
      case "remove_member": {
        const my = role(fid, me.id), uid = isMem(fid, b.user_id);
        if (uid !== me.id && my !== "admin") fail("Nur Admins dürfen Mitglieder entfernen");
        const ms = db.members.filter((x) => x.family_id === fid), admins = ms.filter((x) => x.role === "admin");
        if (admins.length === 1 && admins[0].user_id === uid && ms.length > 1) fail("Bitte zuerst eine andere Person zum Admin machen");
        db.members = db.members.filter((x) => !(x.family_id === fid && x.user_id === uid));
        for (const t of db.tasks) if (t.family_id === fid && t.assignee_id === uid && t.status !== "done") t.assignee_id = null;
        for (const a of db.appts) if (a.family_id === fid && a.assignee_id === uid) a.assignee_id = null;
        if (ms.length <= 1) delFamily(fid); break;
      }
      case "delete_family": admin(fid, me.id); delFamily(fid); break;
      case "senior_save": {
        role(fid, me.id); const row = { name: must(b.name, 60, "Name"), info: str(b.info, 1000), color: Math.max(0, Math.min(7, Number(b.color) || 0)) };
        if ("address" in b) row.address = str(b.address, 120);
        if (b.id) { inFam("seniors", b.id, fid); Object.assign(db.seniors.find((x) => x.id === b.id), row); save(); return { id: b.id }; }
        const id = uuid(); db.seniors.push({ id, family_id: fid, created_at: now(), ...row }); save(); return { id };
      }
      case "senior_delete": {
        admin(fid, me.id); inFam("seniors", b.id, fid);
        db.seniors = db.seniors.filter((x) => x.id !== b.id);
        db.notes = db.notes.filter((x) => x.senior_id !== b.id);
        const gone = db.meds.filter((m) => m.senior_id === b.id).map((m) => m.id);
        db.care = db.care.filter((x) => x.senior_id !== b.id); db.vitals = db.vitals.filter((x) => x.senior_id !== b.id); db.handoffs = db.handoffs.filter((x) => x.senior_id !== b.id); db.shifts = db.shifts.filter((x) => x.senior_id !== b.id);
        db.meds = db.meds.filter((m) => m.senior_id !== b.id); db.doses = db.doses.filter((d) => !gone.includes(d.medication_id));
        for (const t of [...db.tasks, ...db.appts, ...db.contacts]) if (t.senior_id === b.id) t.senior_id = null;
        break;
      }
      case "task_save": {
        role(fid, me.id);
        const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || "") ? b.due_date : null, tm = /^[0-2]\d:[0-5]\d$/.test(b.due_time || "") ? b.due_time : null;
        const rec = ["daily", "weekly"].includes(b.recurrence) ? b.recurrence : "none";
        const row = { title: must(b.title, 120, "Titel"), notes: str(b.notes, 1000), senior_id: inFam("seniors", b.senior_id || null, fid), appointment_id: inFam("appts", b.appointment_id || null, fid), assignee_id: isMem(fid, b.assignee_id || null), due_date: rec !== "none" && !due ? today() : due, due_time: tm, recurrence: rec, updated_at: now() };
        if (b.id) { const t = db.tasks.find((x) => x.id === b.id && x.family_id === fid); if (!t) fail("Aufgabe nicht gefunden"); Object.assign(t, row); save(); return { id: b.id }; }
        const id = uuid(); db.tasks.push({ id, family_id: fid, status: "open", created_by: me.id, created_at: now(), started_by: null, completed_by: null, completed_at: null, ...row }); save(); return { id };
      }
      case "task_status": {
        role(fid, me.id); const st = b.status; if (!["open", "in_progress", "done"].includes(st)) fail("Status ungültig");
        const t = db.tasks.find((x) => x.id === b.id && x.family_id === fid); if (!t) fail("Aufgabe nicht gefunden");
        let next = null;
        if (st !== "done" && t.status === "done" && b.undo_next) { // „Rückgängig“: eben angelegte Wiederholung wieder entfernen
          const nx = db.tasks.find((x) => x.id === b.undo_next && x.family_id === fid && x.status !== "done" && x.title === t.title && x.recurrence !== "none");
          if (nx) { t.recurrence = nx.recurrence; for (const m of db.messages) if (m.task_id === nx.id) m.task_id = t.id; db.tasks = db.tasks.filter((x) => x.id !== nx.id); }
        }
        if (st === "done" && t.status !== "done" && t.recurrence !== "none") {
          const step = t.recurrence === "daily" ? 1 : 7; let nd = addDays(t.due_date || today(), step); while (nd < today()) nd = addDays(nd, step);
          next = uuid(); db.tasks.push({ ...t, id: next, appointment_id: null, due_date: nd, status: "open", started_by: null, completed_by: null, completed_at: null, created_at: now(), updated_at: now() });
          t.recurrence = "none";
          for (const m of db.messages) if (m.task_id === t.id) m.task_id = next;
        }
        Object.assign(t, { status: st, updated_at: now(), completed_by: st === "done" ? me.id : null, completed_at: st === "done" ? now() : null }, st === "done" ? doneBy(fid, me.id, b.done_by) : DONE0);
        if (st === "in_progress") t.started_by = me.id; else if (st === "open") t.started_by = null;
        save(); return { ok: true, next };
      }
      case "task_delete": role(fid, me.id); inFam("tasks", b.id, fid); dropMsgs((m) => m.task_id === b.id); db.tasks = db.tasks.filter((x) => x.id !== b.id); break;
      case "appt_save": {
        role(fid, me.id); const st = new Date(b.starts_at || ""); if (isNaN(+st)) fail("Datum/Uhrzeit fehlt"); const en = b.ends_at ? new Date(b.ends_at) : null;
        const row = { title: must(b.title, 120, "Titel"), kind: ["arzt", "pflege", "besuch", "sonstiges"].includes(b.kind) ? b.kind : "sonstiges", senior_id: inFam("seniors", b.senior_id || null, fid), starts_at: st.toISOString(), ends_at: en && en > st ? en.toISOString() : null, location: str(b.location, 200), notes: str(b.notes, 1000), contact_id: inFam("contacts", b.contact_id || null, fid) };
        if ("assignee_id" in b) row.assignee_id = isMem(fid, b.assignee_id || null);
        if (b.id) { inFam("appts", b.id, fid); Object.assign(db.appts.find((x) => x.id === b.id), row); save(); return { id: b.id }; }
        const id = uuid(); db.appts.push({ id, family_id: fid, created_by: me.id, created_at: now(), assignee_id: null, ...row }); save(); return { id };
      }
      case "assign": {
        role(fid, me.id); const k = b.what === "appt" ? "appts" : b.what === "task" ? "tasks" : fail("Art ungültig");
        const uid = isMem(fid, b.assignee_id || null), x = db[k].find((y) => y.id === b.id && y.family_id === fid);
        if (!x) fail(k === "appts" ? "Termin nicht gefunden" : "Aufgabe nicht gefunden");
        if (b.only_if_open && x.assignee_id && x.assignee_id !== uid) fail("Das hat inzwischen schon jemand anderes übernommen");
        x.assignee_id = uid; if (k === "tasks") x.updated_at = now(); save(); return { ok: true, assignee_id: uid };
      }
      case "appt_delete": role(fid, me.id); inFam("appts", b.id, fid); dropMsgs((m) => m.appointment_id === b.id); db.appts = db.appts.filter((x) => x.id !== b.id); for (const t of db.tasks) if (t.appointment_id === b.id) t.appointment_id = null; break;
      case "msg_post": role(fid, me.id); fail("Der Chat ist nicht mehr verfügbar"); break; // Chat ausgeblendet, alte Nachrichten bleiben
      case "contact_save": {
        role(fid, me.id);
        const cat = ["arzt", "facharzt", "apotheke", "pflegedienst", "familie", "sonstiges"].includes(b.category) ? b.category : "sonstiges";
        const phone = str(b.phone, 40), email = str(b.email, 120);
        if (phone && !/^[0-9+()\/.\s-]{3,40}$/.test(phone)) fail("Telefonnummer: nur Ziffern, Leerzeichen und + ( ) / - .");
        if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) fail("E-Mail-Adresse sieht nicht gültig aus");
        const row = { name: must(b.name, 80, "Name"), category: cat, org: str(b.org, 120), address: str(b.address, 300), phone, email, note: str(b.note, 500), senior_id: inFam("seniors", b.senior_id || null, fid), updated_at: now() };
        if (b.id) { inFam("contacts", b.id, fid); const c = db.contacts.find((x) => x.id === b.id); Object.assign(c, row); save(); return { id: b.id, contact: c }; }
        const c = { id: uuid(), family_id: fid, created_by: me.id, created_at: now(), ...row }; db.contacts.push(c); save(); return { id: c.id, contact: c };
      }
      case "contact_delete": role(fid, me.id); inFam("contacts", b.id, fid); db.contacts = db.contacts.filter((x) => x.id !== b.id); db.shifts = db.shifts.filter((x) => x.contact_id !== b.id); for (const a of db.appts) if (a.contact_id === b.id) a.contact_id = null; break;
      case "msg_delete": {
        const my = role(fid, me.id), m = db.messages.find((x) => x.id === b.id && x.family_id === fid); if (!m) fail("Nachricht nicht gefunden");
        if (m.author_id !== me.id && my !== "admin") fail("Nur eigene Nachrichten löschen");
        dropMsgs((x) => x.id === b.id); break;
      }
      case "media_urls":
      case "photo_urls": role(fid, me.id); return { urls: Object.fromEntries((b.paths || []).filter((p) => db.photos[p]).map((p) => [p, db.photos[p]])) };
      case "note_save": {
        role(fid, me.id); const sid = inFam("seniors", b.senior_id || null, fid), tid = inFam("tasks", b.task_id || null, fid);
        if (!sid && !tid) fail("Notiz braucht eine Person oder Aufgabe");
        const id = uuid(); db.notes.push({ id, family_id: fid, senior_id: sid, task_id: tid, author_id: me.id, body: must(b.body, 1000, "Text"), created_at: now() }); save(); return { id };
      }
      case "note_delete": {
        const my = role(fid, me.id), n = db.notes.find((x) => x.id === b.id && x.family_id === fid); if (!n) fail("Notiz nicht gefunden");
        if (n.author_id !== me.id && my !== "admin") fail("Nur eigene Notizen löschen"); db.notes = db.notes.filter((x) => x.id !== b.id); break;
      }
      case "med_save": {
        role(fid, me.id);
        const times = [...new Set((b.times || []).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, 8);
        if (!times.length) fail("Mindestens eine Uhrzeit angeben");
        const row = { family_id: fid, senior_id: inFam("seniors", b.senior_id, fid) || fail("Für wen ist das Medikament?"), name: str(b.name, 80) || fail("Name des Medikaments fehlt"), dosage: str(b.dosage, 80), times, notes: str(b.notes, 500), updated_at: now() };
        if (b.id) { Object.assign(db.meds.find((m) => m.id === b.id && m.family_id === fid) || fail("Nicht gefunden"), row); save(); return { id: b.id }; }
        const m = { id: uuid(), active: true, created_by: me.id, created_at: now(), ...row }; db.meds.push(m); save(); return { id: m.id };
      }
      case "med_delete": role(fid, me.id); inFam("meds", b.id, fid); db.meds = db.meds.filter((m) => m.id !== b.id); db.doses = db.doses.filter((d) => d.medication_id !== b.id); break;
      case "dose_give": {
        role(fid, me.id);
        const med = db.meds.find((m) => m.id === b.medication_id && m.family_id === fid) || fail("Medikament nicht gefunden");
        if (![today(), addDays(today(), -1)].includes(b.day) || !med.times.includes(b.slot)) fail("Ungültige Einnahme");
        let d = db.doses.find((x) => x.medication_id === med.id && x.day === b.day && x.slot === b.slot);
        if (d?.given_at) fail("Wurde schon gegeben");
        if (!d) { d = { id: uuid(), family_id: fid, medication_id: med.id, day: b.day, slot: b.slot, scheduled_at: new Date(`${b.day}T${b.slot}:00`).toISOString(), missed_notified_at: null, created_at: now() }; db.doses.push(d); }
        Object.assign(d, { given_by: me.id, given_at: now() }, doneBy(fid, me.id, b.done_by));
        save(); return { dose: d };
      }
      case "done_by_set": {
        const my = role(fid, me.id);
        const T = { dose: ["doses", "given_by", "given_at"], task: ["tasks", "completed_by", "completed_at"], vital: ["vitals", "created_by", "created_at"], care: ["care", "author_id", "created_at"] }[b.what] || fail("Unbekannter Eintrag");
        const e = db[T[0]].find((x) => x.id === b.id && x.family_id === fid);
        if (!e || !e[T[2]] || (T[0] === "tasks" && e.status !== "done")) fail("Eintrag nicht gefunden");
        if (e[T[1]] !== me.id && my !== "admin") fail("Nur wer es eingetragen hat (oder ein Admin) kann das ändern");
        Object.assign(e, doneBy(fid, me.id, b.done_by ?? { kind: "self" })); save(); return { row: e };
      }
      case "dose_undo": {
        const my = role(fid, me.id), d = db.doses.find((x) => x.id === b.id && x.family_id === fid && x.given_at) || fail("Keine Gabe gefunden");
        if (d.given_by !== me.id && my !== "admin") fail("Nur wer es eingetragen hat (oder ein Admin)");
        d.given_by = null; d.given_at = null; Object.assign(d, DONE0); break;
      }
      case "profile_save": {
        role(fid, me.id); inFam("seniors", b.id, fid);
        const up = {};
        for (const [k, n] of [["allergies", 500], ["mobility", 500], ["likes", 500], ["dislikes", 500], ["diagnoses", 800], ["directive", 300], ["doctor_questions", 1500]]) if (k in b) up[k] = str(b[k], n);
        if ("birthdate" in b) { const v = String(b.birthdate ?? "").trim(); if (v && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < "1900-01-01" || v > today())) fail("Geburtsdatum bitte als gültiges Datum eintragen"); up.birthdate = v || null; }
        if ("blood_type" in b) { const v = String(b.blood_type ?? "").trim().toUpperCase().replace(/^O/, "0"); if (v && !["0+", "0-", "A+", "A-", "B+", "B-", "AB+", "AB-"].includes(v)) fail("Unbekannte Blutgruppe"); up.blood_type = v || null; }
        if (!Object.keys(up).length) fail("Nichts zu speichern");
        if (Object.keys(up).some((k) => k !== "doctor_questions")) Object.assign(up, { profile_updated_by: me.id, profile_updated_at: now() });
        Object.assign(db.seniors.find((x) => x.id === b.id), up); break;
      }
      case "vital_save": {
        const my = role(fid, me.id); inFam("seniors", b.senior_id, fid); if (!b.senior_id) fail("Für wen wurde gemessen?");
        const R = { bp: [50, 260], glucose: [10, 700], weight: [20, 300], temp: [33, 43], spo2: [50, 100] }, NM = { bp: "Oberer Wert (systolisch)", glucose: "Blutzucker", weight: "Gewicht", temp: "Temperatur", spo2: "Sauerstoff" };
        if (!R[b.kind]) fail("Unbekannte Messart");
        const num = (v, lo, hi, what, dec) => { if (v == null || String(v).trim() === "") return null; const n = Number(String(v).trim().replace(",", ".")); if (!isFinite(n) || n < lo || n > hi) fail(`${what}: bitte einen Wert zwischen ${String(lo).replace(".", ",")} und ${String(hi).replace(".", ",")} eintragen`); const f = 10 ** dec; return Math.round(n * f) / f; };
        const dec = b.kind === "weight" || b.kind === "temp" ? 1 : 0;
        const v1 = num(b.v1, ...R[b.kind], NM[b.kind], dec); if (v1 == null) fail(NM[b.kind] + " fehlt");
        let v2 = null, pulse = null, context = null;
        if (b.kind === "bp") { v2 = num(b.v2, 30, 160, "Unterer Wert (diastolisch)", 0); if (v2 == null) fail("Unterer Wert (diastolisch) fehlt"); if (v1 <= v2) fail("Der obere Wert muss größer als der untere sein"); }
        if (b.kind === "bp" || b.kind === "spo2") pulse = num(b.pulse, 25, 230, "Puls", 0);
        if (b.kind === "glucose") context = ["fasting", "before_meal", "after_meal", "bedtime", "other"].includes(b.context) ? b.context : "other";
        const at = b.measured_at ? new Date(b.measured_at) : new Date(); if (isNaN(at)) fail("Zeitpunkt ungültig");
        if (at.getTime() > Date.now() + 10 * 60000) fail("Der Zeitpunkt liegt in der Zukunft");
        if (at.getTime() < Date.now() - 366 * 864e5) fail("Der Zeitpunkt liegt mehr als ein Jahr zurück");
        const row = { senior_id: b.senior_id, kind: b.kind, v1, v2, pulse, context, note: str(b.note, 300), measured_at: at.toISOString(), updated_at: now(), ...("done_by" in b ? doneBy(fid, me.id, b.done_by) : {}) };
        if (b.id) { const e = db.vitals.find((x) => x.id === b.id && x.family_id === fid); if (!e) fail("Messwert nicht gefunden"); if (e.created_by !== me.id && my !== "admin") fail("Nur eigene Messwerte ändern"); Object.assign(e, row); save(); return { vital: e }; }
        const v = { id: uuid(), family_id: fid, created_by: me.id, created_at: now(), ...row }; db.vitals.push(v); save(); return { vital: v };
      }
      case "vital_delete": {
        const my = role(fid, me.id); const e = db.vitals.find((x) => x.id === b.id && x.family_id === fid); if (!e) fail("Messwert nicht gefunden");
        if (e.created_by !== me.id && my !== "admin") fail("Nur eigene Messwerte löschen"); db.vitals = db.vitals.filter((x) => x.id !== b.id); break;
      }
      case "vital_targets_save": {
        role(fid, me.id); inFam("seniors", b.senior_id, fid);
        const K = { bp_sys: [60, 250], bp_dia: [30, 150], pulse: [25, 230], glu_pre: [20, 600], glu_post: [20, 600], weight: [20, 300], temp: [33, 43], spo2: [50, 100] }, out = {};
        for (const [k, [lo, hi]] of Object.entries(K)) { const v = b.targets?.[k]; if (v == null) continue; const a = Number(String(v[0]).replace(",", ".")), c = Number(String(v[1]).replace(",", "."));
          if (!isFinite(a) || !isFinite(c) || a < lo || c > hi || a >= c) fail("Zielbereich: „von“ muss kleiner als „bis“ sein"); out[k] = [a, c]; }
        db.seniors.find((x) => x.id === b.senior_id).vital_targets = Object.keys(out).length ? out : null; save(); return { ok: true };
      }
      case "care_add": {
        role(fid, me.id); inFam("seniors", b.senior_id, fid);
        const k = CARE[b.kind]; if (!k || b.kind === "help") fail("Unbekannte Kategorie");
        const note = str(b.note, 280); if (b.kind === "special" && !note) fail("Bitte kurz schreiben, was besonders ist");
        const e = { id: uuid(), family_id: fid, senior_id: b.senior_id, kind: b.kind, note, author_id: me.id, created_at: now(), ...doneBy(fid, me.id, b.done_by) }; db.care.push(e);
        save(); return { entry: e };
      }
      case "help_request": {
        if (role(fid, me.id) !== "senior") fail("„Hilfe holen“ gibt es in der Senioren-Ansicht"); inFam("seniors", b.senior_id, fid);
        const e = { id: uuid(), family_id: fid, senior_id: b.senior_id, kind: "help", note: str(b.note, 280), author_id: me.id, created_at: now() }; db.care.push(e);
        save(); return { entry: e, notified: db.members.filter((x) => x.family_id === fid && x.role !== "senior" && x.user_id !== me.id).length, sent: 0 };
      }
      case "care_delete": {
        const my = role(fid, me.id); const e = db.care.find((x) => x.id === b.id && x.family_id === fid); if (!e) fail("Eintrag nicht gefunden");
        if (e.author_id !== me.id && my !== "admin") fail("Nur eigene Einträge löschen"); db.care = db.care.filter((x) => x.id !== b.id); break;
      }
      // Startseite: Person oder Haushalt übernehmen (parallel erlaubt), Abgeben; Übernahmen enden um Mitternacht
      case "care_take": {
        role(fid, me.id); staleHandoffs(fid);
        const sids = [...new Set(Array.isArray(b.senior_ids) ? b.senior_ids : [b.senior_id])].slice(0, 12);
        if (!sids.length) fail("Bitte eine Person wählen");
        const out = [];
        for (const sid of sids) {
          inFam("seniors", sid, fid);
          const mine = db.handoffs.find((h) => h.senior_id === sid && !h.ended_at && h.taken_by === me.id);
          if (mine) { out.push(mine); continue; }
          const h = { id: uuid(), family_id: fid, senior_id: sid, taken_by: me.id, from_user: null, note: str(b.note, 500), open_snapshot: snapshot(fid, sid), created_at: now(), ended_at: null, ended_note: null };
          db.handoffs.push(h); out.push(h);
        }
        save(); return { handoffs: out };
      }
      case "care_release": {
        role(fid, me.id); staleHandoffs(fid);
        const only = Array.isArray(b.senior_ids) && b.senior_ids.length ? b.senior_ids : null;
        const open = db.handoffs.filter((h) => h.family_id === fid && h.taken_by === me.id && !h.ended_at && (!only || only.includes(h.senior_id)));
        for (const h of open) Object.assign(h, { ended_at: now(), ended_note: str(b.note, 500), open_snapshot: { ...h.open_snapshot, at_end: snapshot(fid, h.senior_id) } });
        save(); return { ended: open.length };
      }
      case "handoff_take": {
        role(fid, me.id); inFam("seniors", b.senior_id, fid);
        const cur = db.handoffs.filter((h) => h.senior_id === b.senior_id && !h.ended_at).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
        if (cur?.taken_by === me.id) fail("Du bist schon eingetragen");
        const snap = snapshot(fid, b.senior_id), note = str(b.note, 500);
        if (cur) for (const h of db.handoffs) if (h.senior_id === b.senior_id && !h.ended_at) h.ended_at = now();
        const h = { id: uuid(), family_id: fid, senior_id: b.senior_id, taken_by: me.id, from_user: cur?.taken_by || null, note, open_snapshot: snap, created_at: now(), ended_at: null, ended_note: null }; db.handoffs.push(h);
        save(); return { handoff: h };
      }
      case "handoff_end": {
        role(fid, me.id); inFam("seniors", b.senior_id, fid);
        const cur = db.handoffs.filter((h) => h.senior_id === b.senior_id && !h.ended_at).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
        if (!cur || cur.taken_by !== me.id) fail("Du bist gerade nicht als verantwortlich eingetragen");
        const snap = snapshot(fid, b.senior_id), note = str(b.note, 500);
        Object.assign(cur, { ended_at: now(), ended_note: note, open_snapshot: { ...cur.open_snapshot, at_end: snap } });
        break;
      }
      // Pflegedienst-Einsatzplan (wie Edge Function)
      case "shift_save": {
        role(fid, me.id); const sid = inFam("seniors", b.senior_id || null, fid); if (!sid) fail("Für wen? Bitte eine Person wählen");
        const c = db.contacts.find((x) => x.id === b.contact_id && x.family_id === fid); if (!c || c.category !== "pflegedienst") fail("Bitte einen Pflegedienst aus den Kontakten wählen");
        const re = /^([01]\d|2[0-3]):[0-5]\d$/, st = String(b.start_time || ""), en = String(b.end_time || "");
        if (!re.test(st) || !re.test(en)) fail("Uhrzeit fehlt"); if (en <= st) fail("„Bis“ muss nach „Von“ liegen (gleicher Tag)");
        const kind = b.kind === "once" ? "once" : "weekly", days = kind === "weekly" ? [...new Set((b.days || []).map(Number).filter((d) => d >= 1 && d <= 7))].sort() : [];
        if (kind === "weekly" && !days.length) fail("Bitte mindestens einen Wochentag wählen");
        const on = kind === "once" ? String(b.on_date || "") : null; if (kind === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(on)) fail("Datum fehlt");
        if (kind === "once" && on < addDays(today(), -1)) fail("Einzeltermine nur ab heute");
        const row = { senior_id: sid, contact_id: c.id, kind, days, on_date: on, shift_id: null, start_time: st, end_time: en, note: str(b.note, 200) };
        if (b.id) { const x = db.shifts.find((y) => y.id === b.id && y.family_id === fid && y.kind !== "skip"); if (!x) fail("Einsatz nicht gefunden"); Object.assign(x, row); if (kind !== "weekly") db.shifts = db.shifts.filter((y) => y.shift_id !== x.id); save(); return { shift: x }; }
        const x = { id: uuid(), family_id: fid, created_by: me.id, created_at: now(), ...row }; db.shifts.push(x); save(); return { shift: x };
      }
      case "shift_delete": role(fid, me.id); inFam("shifts", b.id, fid); db.shifts = db.shifts.filter((x) => x.id !== b.id && x.shift_id !== b.id); break;
      case "shift_skip": {
        role(fid, me.id); const x = db.shifts.find((y) => y.id === b.shift_id && y.family_id === fid && y.kind === "weekly"); if (!x) fail("Einsatz nicht gefunden");
        const on = String(b.on_date || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on < addDays(today(), -1)) fail("Datum ungültig");
        db.shifts = db.shifts.filter((y) => !(y.shift_id === x.id && y.on_date === on)); if (b.undo) break;
        const k = { id: uuid(), family_id: fid, senior_id: x.senior_id, contact_id: x.contact_id, kind: "skip", days: [], on_date: on, shift_id: x.id, start_time: x.start_time, end_time: x.end_time, note: null, created_by: me.id, created_at: now() };
        db.shifts.push(k); save(); return { shift: k };
      }
      case "prefs_save": db.prefs = db.prefs.filter((p) => p.user_id !== me.id); db.prefs.push({ user_id: me.id, ...b.prefs }); break;
      case "subscribe": case "unsubscribe": return { ok: true };
      case "test_push": return { sent: 0 };
      case "delete_account": {
        if (String(b.confirm || "").trim().toLowerCase() !== me.username) fail("Bitte deinen Benutzernamen zur Bestätigung eingeben");
        for (const m of db.members.filter((x) => x.user_id === me.id)) {
          const others = db.members.filter((x) => x.family_id === m.family_id && x.user_id !== me.id);
          if (!others.length) delFamily(m.family_id); else if (m.role === "admin" && !others.some((o) => o.role === "admin")) others[0].role = "admin";
        }
        db.members = db.members.filter((x) => x.user_id !== me.id); db.users = db.users.filter((u) => u.id !== me.id); db.prefs = db.prefs.filter((p) => p.user_id !== me.id);
        break;
      }
      default: fail("Unbekannte Aktion");
    }
    save(); return { ok: true };
  }

  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 60));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const B = {
    demo: true,
    async session() { const s = sess(); return s && db.users.some((u) => u.id === s.uid) ? s : null; },
    async signIn(username, password) {
      const u = db.users.find((x) => x.username === String(username).toLowerCase());
      if (!u || u.pw !== hash(password)) throw new Error("Benutzername oder Passwort stimmt nicht");
      localStorage.setItem(SKEY, JSON.stringify({ uid: u.id }));
    },
    async signOut() { localStorage.removeItem(SKEY); },
    rawSession() { return localStorage.getItem(SKEY); },
    useRawSession(raw) { if (raw) localStorage.setItem(SKEY, raw); else localStorage.removeItem(SKEY); },
    async fn(a, body = {}) { return delay(clone(action(a, body))); },
    async me(uid) { const u = db.users.find((x) => x.id === uid); return u ? { id: u.id, username: u.username, display_name: u.display_name, consent_health_at: u.consent_health_at, must_change_password: !!u.must_change_password } : null; },
    async families(uid) { return db.members.filter((m) => m.user_id === uid).map((m) => ({ ...db.families.find((f) => f.id === m.family_id), role: m.role, senior_id: m.senior_id || null })).filter((f) => f.id); },
    async load(fid, uid) {
      if (!db.members.some((m) => m.family_id === fid && m.user_id === uid)) throw new Error("Kein Zugriff");
      medCheck(fid); staleHandoffs(fid); save(false); // still speichern: sonst löst jedes Laden ein neues Laden aus (Endlosschleife)
      const since = new Date(Date.now() - 30 * 864e5).toISOString(), f = (k) => db[k].filter((x) => x.family_id === fid);
      return clone({
        members: f("members").map((m) => { const u = db.users.find((x) => x.id === m.user_id) || {}; return { ...m, display_name: u.display_name || "?", username: u.username || "" }; }),
        seniors: f("seniors"),
        tasks: f("tasks").filter((t) => t.status !== "done" || t.completed_at >= since),
        appts: f("appts").sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
        contacts: f("contacts").sort((a, b) => a.name.localeCompare(b.name, "de")),
        vitals: f("vitals").filter((v) => v.measured_at >= new Date(Date.now() - 92 * 864e5).toISOString()).sort((a, b) => b.measured_at.localeCompare(a.measured_at)),
        messages: f("messages").filter((m) => !m.sys_kind).sort((a, b) => a.created_at.localeCompare(b.created_at)),
        notes: f("notes").filter((n) => n.senior_id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
        prefs: db.prefs.find((p) => p.user_id === uid) || null,
        meds: f("meds"), doses: f("doses").filter((d) => d.day >= addDays(today(), -7)),
        care: f("care").filter((c) => c.created_at >= new Date(Date.now() - 8 * 864e5).toISOString()).sort((a, b) => b.created_at.localeCompare(a.created_at)),
        handoffs: f("handoffs").sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100),
        shifts: f("shifts"),
      });
    },
    async journal(fid, day) {
      if (!db.members.some((m) => m.family_id === fid && m.user_id === sess()?.uid)) throw new Error("Kein Zugriff");
      const A = new Date(day + "T00:00:00").toISOString(), Bs = new Date(addDays(day, 1) + "T00:00:00").toISOString(), f = (k) => db[k].filter((x) => x.family_id === fid), inR = (t) => t && t >= A && t < Bs;
      return delay(clone({ care: f("care").filter((c) => inR(c.created_at)), doses: f("doses").filter((d) => d.day === day || inR(d.given_at)),
        handoffs: f("handoffs").filter((h) => h.created_at < Bs && (!h.ended_at || h.ended_at >= A)), tasks: f("tasks").filter((t) => t.status === "done" && inR(t.completed_at)), appts: f("appts").filter((a) => inR(a.starts_at)), vitals: f("vitals").filter((v) => inR(v.measured_at)) }));
    },
    // Arzt-Bericht: Einnahmen und Befinden für einen längeren Zeitraum (nur lesen)
    async report(fid, fromIso, fromDay) {
      if (!db.members.some((m) => m.family_id === fid && m.user_id === sess()?.uid)) throw new Error("Kein Zugriff");
      const f = (k) => db[k].filter((x) => x.family_id === fid);
      return delay(clone({ doses: f("doses").filter((d) => d.day >= fromDay), care: f("care").filter((c) => c.created_at >= fromIso).sort((a, b) => b.created_at.localeCompare(a.created_at)) }));
    },
    realtime(fid, cb) { const f = () => cb(); listeners.add(f); return () => listeners.delete(f); },
    async photoUrls(fid, paths) { return (await B.fn("media_urls", { family_id: fid, paths })).urls; },
    reset() { localStorage.removeItem(KEY); localStorage.removeItem(SKEY); localStorage.removeItem("pf-fid"); db = blank(); },

    // Beispielfamilie zum Ausprobieren (Anmeldung: sascha / demo1234)
    async seedDemo() {
      B.reset();
      const pw = hash("demo1234"), U = (username, display_name) => { const u = { id: uuid(), username, display_name, pw }; db.users.push(u); return u.id; };
      const sa = U("sascha", "Sascha"), ka = U("katharina", "Katharina"), jo = U("jonas", "Jonas");
      const fid = uuid(), ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
      db.families.push({ id: fid, name: "Familie Hammel", invite_code: "HAM7QX4KPZ", invite_expires_at: new Date(Date.now() + 14 * 864e5).toISOString(), created_by: sa, created_at: ago(24 * 20) });
      db.members.push({ family_id: fid, user_id: sa, role: "admin", joined_at: ago(480) }, { family_id: fid, user_id: ka, role: "helper", joined_at: ago(470) }, { family_id: fid, user_id: jo, role: "helper", joined_at: ago(300) });
      const hi = uuid(), we = uuid();
      db.seniors.push({ id: hi, family_id: fid, name: "Oma Hilde", address: "Ahornweg 12, 50667 Köln", info: "Ahornweg 12, 1. OG\nHausarzt: Dr. Weber, Tel. 0221 123456\nErsatzschlüssel bei Nachbarin Frau Kurz", color: 0, created_at: ago(480),
          allergies: "Penicillin, Pflaster (Hautrötung)", mobility: "Rollator in der Wohnung, draußen nur mit Begleitung. Treppe langsam, Handlauf rechts.", likes: "Morgens Tee statt Kaffee, Schlager im Radio, Spaziergang im Park", dislikes: "Laute Musik, zu warmes Essen, wenn man sie hetzt", profile_updated_by: ka, profile_updated_at: ago(30),
          birthdate: "1941-03-14", blood_type: "A+", diagnoses: "Diabetes Typ 2 (Tabletten)\nBluthochdruck\nLeichte Demenz – braucht Ruhe und kurze Sätze", directive: "Patientenverfügung im blauen Ordner, Wohnzimmerschrank. Vorsorgevollmacht: Sascha", doctor_questions: "Blutdruck morgens öfter über 140 – Ramipril anpassen?\nWadenkrämpfe nachts – Magnesium weiter nehmen?" },
        { id: we, family_id: fid, name: "Opa Werner", address: "Ahornweg 12, 50667 Köln", info: "Wohnt mit Oma Hilde im Ahornweg 12\nTagespflege „Am Park“ Mo–Fr 9–16 Uhr", color: 1, created_at: ago(470),
          allergies: null, mobility: "Rollstuhl, kann kurz stehen", likes: "Fußball, Kreuzworträtsel", dislikes: null, profile_updated_by: jo, profile_updated_at: ago(100),
          birthdate: "1938-11-02", blood_type: null, diagnoses: "Vorhofflimmern – nimmt Blutverdünner\nHerzschwäche", directive: null, doctor_questions: null });
      // Zweiter Haushalt: Tante Gerda lebt allein in der Lindenstraße
      const ge = uuid();
      db.seniors.push({ id: ge, family_id: fid, name: "Tante Gerda", address: "Lindenstr. 4, 50668 Köln", info: "Lebt allein, 1. OG – Klingel „Brandt“", color: 2, created_at: ago(200),
        allergies: null, mobility: "Geht am Stock, Treppe mit Hilfe", likes: "Kreuzworträtsel, Kaffee mit Milch", dislikes: null, profile_updated_by: sa, profile_updated_at: ago(150),
        birthdate: "1947-05-20", blood_type: null, diagnoses: "Beginnende Demenz", directive: null, doctor_questions: null });
      const t0 = today(), at = (d, h, m = 0) => { const x = new Date(addDays(t0, d) + "T12:00:00"); x.setHours(h, m, 0, 0); return x.toISOString(); };
      const a1 = uuid(), a2 = uuid(), a3 = uuid();
      const K = (o) => { const c = { id: uuid(), family_id: fid, org: null, address: null, phone: null, email: null, note: null, senior_id: null, created_by: sa, created_at: ago(200), updated_at: ago(200), ...o }; db.contacts.push(c); return c.id; };
      const kWeber = K({ name: "Dr. Weber", category: "arzt", org: "Hausarztpraxis Dr. Weber", address: "Hauptstraße 5, 50667 Köln", phone: "0221 123456", email: "praxis@weber-beispiel.de", note: "Sprechstunde Mo–Fr 8–12 Uhr, Rezepte telefonisch bestellen", senior_id: hi });
      K({ name: "Dr. Yılmaz", category: "facharzt", org: "Kardiologie am Ring", address: "Hohenzollernring 40, 50672 Köln", phone: "0221 778899", senior_id: we });
      K({ name: "Apotheke am Markt", category: "apotheke", address: "Marktplatz 2, 50667 Köln", phone: "0221 445566", note: "Liefert Mo–Sa nach Hause" });
      const kSonne = K({ name: "Pflegedienst Sonnenschein", category: "pflegedienst", org: "Ambulante Pflege", address: "Lindenallee 9, 50668 Köln", phone: "0221 990011", email: "team@sonnenschein-beispiel.de", senior_id: hi });
      const kPark = K({ name: "Tagespflege Am Park", category: "pflegedienst", address: "Parkweg 3, 50670 Köln", phone: "0221 334455", note: "Mo–Fr 9–16 Uhr, Abholung 8:30 Uhr", senior_id: we });
      const kLinde = K({ name: "Pflegedienst Lindenhof", category: "pflegedienst", org: "Häusliche Pflege", address: "Lindenstr. 30, 50668 Köln", phone: "0221 556677", senior_id: ge });
      // Einsatzplan: Sonnenschein bei Oma morgens Mo–Fr + abends täglich, Tagespflege holt Opa Mo–Fr, Lindenhof täglich bei Gerda
      const SH = (senior_id, contact_id, days, start_time, end_time) => db.shifts.push({ id: uuid(), family_id: fid, senior_id, contact_id, kind: "weekly", days, on_date: null, shift_id: null, start_time, end_time, note: null, created_by: sa, created_at: ago(200) });
      SH(hi, kSonne, [1, 2, 3, 4, 5], "07:30", "08:15"); SH(hi, kSonne, [1, 2, 3, 4, 5, 6, 7], "19:00", "19:30");
      SH(we, kPark, [1, 2, 3, 4, 5], "08:30", "16:00"); SH(ge, kLinde, [1, 2, 3, 4, 5, 6, 7], "09:00", "09:30");
      K({ name: "Frau Kurz", category: "familie", org: "Nachbarin", phone: "0176 1234567", note: "Hat den Ersatzschlüssel", senior_id: hi });
      db.appts.push({ id: a1, family_id: fid, senior_id: hi, title: "Hausarzt Dr. Weber", kind: "arzt", starts_at: at(1, 9, 30), ends_at: at(1, 10, 30), location: "Hauptstraße 5, 50667 Köln", contact_id: kWeber, notes: "Versichertenkarte mitnehmen", assignee_id: sa, created_by: sa, created_at: ago(50) },
        { id: a2, family_id: fid, senior_id: we, title: "Geburtstagskaffee", kind: "besuch", starts_at: at(3, 15), ends_at: at(3, 17), location: "Ahornweg 12", notes: null, assignee_id: ka, created_by: ka, created_at: ago(40) },
        { id: a3, family_id: fid, senior_id: hi, title: "Fußpflege", kind: "pflege", starts_at: at(6, 11), ends_at: null, location: null, notes: null, assignee_id: null, created_by: ka, created_at: ago(30) });
      db.appts.push({ id: uuid(), family_id: fid, senior_id: ge, title: "Pflegedienst", kind: "pflege", starts_at: at(0, 9), ends_at: at(0, 9, 30), location: "Lindenstr. 4", notes: "Kommt jeden Morgen", assignee_id: null, created_by: sa, created_at: ago(60) },
        { id: uuid(), family_id: fid, senior_id: we, title: "Physiotherapie", kind: "pflege", starts_at: at(0, 11), ends_at: at(0, 11, 45), location: "Praxis Lenz", notes: null, assignee_id: jo, created_by: jo, created_at: ago(60) });
      const T = (o) => db.tasks.push({ id: uuid(), family_id: fid, senior_id: null, appointment_id: null, notes: null, assignee_id: null, status: "open", due_date: null, due_time: null, recurrence: "none", created_by: sa, created_at: ago(30), updated_at: ago(30), started_by: null, completed_by: null, completed_at: null, ...o });
      T({ title: "Medikament geben (morgens)", senior_id: hi, assignee_id: ka, due_date: t0, due_time: "08:00", recurrence: "daily", status: "done", completed_by: ka, completed_at: ago(3) });
      T({ title: "Medikament geben (abends)", senior_id: hi, assignee_id: sa, due_date: t0, due_time: "19:00", recurrence: "daily" });
      T({ title: "Einkaufen: Milch, Brot, Obst", senior_id: hi, assignee_id: jo, due_date: t0, status: "in_progress", started_by: jo, notes: "Liste hängt am Kühlschrank" });
      T({ title: "Rezept in der Apotheke abholen", senior_id: we, due_date: t0 });
      T({ title: "Begleitung: Hausarzt Dr. Weber", senior_id: hi, appointment_id: a1, assignee_id: sa, due_date: addDays(t0, 1), due_time: "09:00" });
      T({ title: "Geschenk besorgen", senior_id: we, appointment_id: a2, assignee_id: ka, due_date: addDays(t0, 2) });
      T({ title: "Besuch machen", senior_id: we, assignee_id: jo, due_date: addDays(t0, 4), recurrence: "weekly" });
      T({ title: "Pflegekasse anrufen (Antrag)", senior_id: hi, created_by: ka });
      T({ title: "Einkauf bringen", senior_id: ge, assignee_id: sa, due_date: t0, due_time: "16:30" });
      T({ title: "Blutdruck messen", senior_id: ge, due_date: t0 });
      T({ title: "Blumen gießen", senior_id: hi, due_date: addDays(t0, -1), status: "done", completed_by: jo, completed_at: ago(20) });
      const tasks = db.tasks;
      db.notes.push({ id: uuid(), family_id: fid, senior_id: hi, task_id: null, author_id: ka, body: "Oma mag morgens lieber Tee als Kaffee.", created_at: ago(70) });
      const M = (o) => db.messages.push({ id: uuid(), family_id: fid, task_id: null, appointment_id: null, media_path: null, media_kind: null, media_mime: null, duration_s: null, ...o });
      M({ task_id: tasks[1].id, author_id: ka, body: "Abends 1 Tablette Ramipril 5 mg und eine halbe Metformin – liegen in der Wochenbox im Küchenschrank.", created_at: ago(28) });
      M({ task_id: tasks[1].id, author_id: sa, body: "Danke! Ich mach das heute. 👍", created_at: ago(27) });
      M({ task_id: tasks[2].id, author_id: jo, body: "Bin um 16 Uhr da.", created_at: ago(1) });
      M({ appointment_id: a1, author_id: ka, body: "Bitte Medikamentenplan und Versichertenkarte mitnehmen.", created_at: ago(20) });
      M({ author_id: sa, body: "Wichtig: Der Termin beim Hausarzt wurde auf morgen 9:30 verschoben.", created_at: ago(30) });
      M({ author_id: jo, body: "Opa hat nach euch gefragt und freut sich auf den Geburtstagskaffee am Samstag.", created_at: ago(26) });
      M({ author_id: ka, body: "War heute Vormittag bei Oma – sie hatte einen guten Tag, wir waren eine Runde im Park. 🌷", created_at: ago(2) });
      M({ author_id: sa, body: "Super, danke dir! Ich übernehme morgen die Begleitung zum Arzt.", created_at: ago(1.5) });
      // Medikamente: relativ zur aktuellen Uhrzeit – eine gegeben, eine verpasst, eine offen (egal wann man die Demo öffnet)
      const hh = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const q = (min) => { const d = new Date(Date.now() + min * 60000); d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0); return d; };
      const sameDay = (d) => ymd(d) === t0;
      const gSlot = sameDay(q(-180)) ? q(-180) : new Date(`${t0}T00:00:00`);
      const mSlot = sameDay(q(-75)) ? q(-75) : new Date(`${t0}T00:15:00`);
      const oSlot = sameDay(q(105)) ? q(105) : new Date(`${t0}T23:45:00`);
      const Med = (o) => { const m = { id: uuid(), family_id: fid, active: true, notes: null, created_by: sa, created_at: ago(24 * 10), updated_at: ago(24 * 10), ...o }; db.meds.push(m); return m; };
      const ram = Med({ senior_id: hi, name: "Ramipril", dosage: "5 mg · 1 Tablette", times: [...new Set([hh(gSlot), hh(oSlot)])].sort(), notes: "Liegt in der Wochenbox im Küchenschrank" });
      Med({ senior_id: hi, name: "Vitamin D", dosage: "1000 IE", times: [hh(mSlot)] });
      const Give = (med, slot, by, msg, carer = null) => {
        const at = new Date(new Date(`${t0}T${slot}:00`).getTime() + 8 * 60000).toISOString();
        const d = { id: uuid(), family_id: fid, medication_id: med.id, day: t0, slot, scheduled_at: new Date(`${t0}T${slot}:00`).toISOString(), given_by: by, given_at: at, missed_notified_at: null, created_at: at, ...(carer ? { done_by_kind: "carer", carer_contact_id: carer } : {}) };
        db.doses.push(d);
      };
      Give(ram, hh(gSlot), ka, `💊 Katharina hat Ramipril 5 mg · 1 Tablette (${hh(gSlot)} Uhr) für Oma Hilde gegeben.`);
      const met = Med({ senior_id: we, name: "Metformin", dosage: "500 mg", times: ["08:00", "18:00"], notes: "Gibt die Tagespflege – nur zur Info" });
      for (const sl of met.times) if (new Date(`${t0}T${sl}:00`).getTime() < Date.now()) Give(met, sl, jo, null, sl === "08:00" ? kPark : null);
      Med({ senior_id: ge, name: "Donepezil", dosage: "5 mg", times: ["20:00"], notes: "Abends vor dem Schlafen" });
      // Übergabe: Kurz-Einträge + Protokoll
      const E = (sid, kind, note, by, h) => db.care.push({ id: uuid(), family_id: fid, senior_id: sid, kind, note, author_id: by, created_at: ago(h) });
      E(hi, "slept_well", null, ka, 5.5); E(hi, "ate_well", "Haferbrei mit Apfel", ka, 5); E(hi, "restless", "Hat zweimal nach Opa gefragt", ka, 3.2);
      E(hi, "special", "Rechtes Knie etwas geschwollen – bitte beobachten", ka, 2.8); E(we, "mood_good", null, jo, 26);
      db.handoffs.push({ id: uuid(), family_id: fid, senior_id: hi, taken_by: ka, from_user: jo, note: null, open_snapshot: { tasks: ["Einkaufen: Milch, Brot, Obst", "Medikament geben (morgens) · 08:00"], meds: [`${hh(gSlot)} Ramipril 5 mg · 1 Tablette`], appt: null }, created_at: ago(6), ended_at: null, ended_note: null });
      // Tagebuch der letzten 6 Tage: wer war wann da, was wurde notiert, gegeben, erledigt (feste Uhrzeiten, damit es realistisch aussieht)
      const AT = (d, h, m = 0) => { const x = new Date(addDays(t0, d) + "T00:00:00"); x.setHours(h, m, 0, 0); return x.toISOString(); };
      const vit = db.meds.find((m) => m.name === "Vitamin D");
      const plan = [ // [Tag, wer, von, bis, Einträge …]
        [-1, sa, 8, 12.5, [["slept_bad", "War nachts zweimal wach", 8.25], ["ate_little", "Nur ein halbes Brötchen", 8.75], ["mood_good", "Kreuzworträtsel zusammen gemacht", 11]]],
        [-1, jo, 15, 19, [["ate_well", "Kartoffelsuppe", 18], ["restless", "Wollte nach Hause zu Opa", 17.5]]],
        [-2, ka, 7.5, 11, [["slept_well", null, 7.75], ["ate_well", "Rührei", 8.25]]],
        [-2, sa, 16, 20, [["pain", "Rücken – Wärmekissen geholfen", 16.5], ["mood_good", null, 19]]],
        [-3, jo, 9, 13, [["ate_well", null, 12], ["special", "Neue Brille abgeholt", 10.5]]],
        [-3, ka, 17, 21, [["slept_well", null, 20.5]]],
        [-4, ka, 8, 12, [["mood_good", "Gesungen beim Frühstück", 8.5], ["ate_well", null, 8.4]]],
        [-5, sa, 10, 14, [["ate_little", null, 12.5], ["restless", null, 13]]],
        [-5, jo, 17, 20, [["ate_well", "Nudeln", 18.5]]],
        [-6, ka, 8, 13, [["slept_well", null, 8.1], ["ate_well", null, 8.6], ["mood_good", null, 11.5]]],
      ];
      const hr = (d, f) => AT(d, Math.floor(f), Math.round((f % 1) * 60));
      for (const [d, who, from, to, es] of [...plan].sort((a, b) => a[0] - b[0] || a[2] - b[2])) {
        db.handoffs.push({ id: uuid(), family_id: fid, senior_id: hi, taken_by: who, from_user: null, note: null, open_snapshot: { tasks: [], meds: [], appt: null }, created_at: hr(d, from), ended_at: hr(d, to), ended_note: es.length > 1 ? "Alles ruhig, Tabletten für abends liegen bereit." : null });
        for (const [kind, note, h] of es) db.care.push({ id: uuid(), family_id: fid, senior_id: hi, kind, note, author_id: who, created_at: hr(d, h) });
      }
      // Gaben der Vortage: wer gerade da war, hat abgehakt – vorgestern abends wurde Vitamin D vergessen
      const pres = (d, h) => plan.find((x) => x[0] === d && h >= x[2] - 0.5 && h <= x[3] + 1)?.[1] || ka;
      for (let d = -6; d <= -1; d++) for (const m of [ram, vit]) for (const sl of m.times) {
        const day = addDays(t0, d), hh_ = Number(sl.slice(0, 2)) + Number(sl.slice(3)) / 60, sched = new Date(`${day}T${sl}:00`).toISOString();
        if (d === -2 && m === vit) { db.doses.push({ id: uuid(), family_id: fid, medication_id: m.id, day, slot: sl, scheduled_at: sched, given_by: null, given_at: null, missed_notified_at: new Date(new Date(sched).getTime() + 31 * 60000).toISOString(), created_at: sched }); continue; }
        const g = new Date(new Date(sched).getTime() + (6 + ((d * 7) % 11)) * 60000).toISOString();
        const sonne = m === ram && (d === -4 || d === -6) && sl === ram.times[0]; // an zwei Tagen (erste Gabe) hat der Pflegedienst Ramipril gegeben
        db.doses.push({ id: uuid(), family_id: fid, medication_id: m.id, day, slot: sl, scheduled_at: sched, given_by: pres(d, hh_), given_at: g, missed_notified_at: null, created_at: g, ...(sonne ? { done_by_kind: "carer", carer_contact_id: kSonne } : {}) });
      }
      for (let d = -6; d <= -1; d++) for (const sl of met.times) { // Metformin gibt die Tagespflege – Jonas hakt nach dem Anruf ab
        const day = addDays(t0, d), sched = new Date(`${day}T${sl}:00`).toISOString(), g = new Date(new Date(sched).getTime() + 25 * 60000).toISOString();
        db.doses.push({ id: uuid(), family_id: fid, medication_id: met.id, day, slot: sl, scheduled_at: sched, given_by: jo, given_at: g, missed_notified_at: null, created_at: g, ...(sl === "08:00" ? { done_by_kind: "carer", carer_contact_id: kPark } : {}) });
      }
      for (const [d, title, by, h] of [[-1, "Wäsche waschen", jo, 18.2], [-2, "Rezept abholen", sa, 17], [-3, "Fenster putzen", jo, 11.5], [-4, "Arzt anrufen", ka, 9], [-5, "Einkaufen", sa, 11], [-6, "Bettwäsche wechseln", ka, 10]])
        T({ title, senior_id: hi, status: "done", due_date: addDays(t0, d), completed_by: by, completed_at: hr(d, h), created_at: hr(d - 1, 12) });
      for (const [d, who, from, to, kind, note] of [[-1, ka, 14, 15.5, "mood_good", "Fußball geschaut, gut gelaunt"], [-3, sa, 15, 17, "ate_well", "Kuchen zum Kaffee"], [-5, jo, 14.5, 16, "slept_bad", "Laut Pflegekraft unruhige Nacht"]]) {
        db.handoffs.push({ id: uuid(), family_id: fid, senior_id: we, taken_by: who, from_user: null, note: "Besuch", open_snapshot: { tasks: [], meds: [], appt: null }, created_at: hr(d, from), ended_at: hr(d, to), ended_note: null });
        db.care.push({ id: uuid(), family_id: fid, senior_id: we, kind, note, author_id: who, created_at: hr(d, from + 0.5) });
      }
      // Messwerte: Oma Hilde (Diabetes Typ 2) – Blutdruck morgens, Zucker 2–3× täglich; Opa Werner Blutdruck + Gewicht
      { let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const VT = (sid, kind, d, h, o, by) => { const at = hr(d, h); if (new Date(at).getTime() > Date.now()) return; db.vitals.push({ id: uuid(), family_id: fid, senior_id: sid, kind, v1: o.v1, v2: o.v2 ?? null, pulse: o.pulse ?? null, context: o.context ?? null, note: o.note ?? null, measured_at: at, created_by: by, created_at: at, updated_at: at }); };
        const whoAt = (d, h) => (d === 0 ? (h < 12 ? ka : sa) : pres(d, h));
        for (let d = -89; d <= 0; d++) {
          const w = Math.sin(d / 9) * 6;
          if (d % 2 === 0 || d > -14) VT(hi, "bp", d, 8.2, { v1: Math.round(134 + w + rnd() * 12 - 4 + (d === -1 ? 14 : 0)), v2: Math.round(82 + w / 2 + rnd() * 8 - 3), pulse: Math.round(70 + rnd() * 10) }, whoAt(d, 8));
          if (d > -45 || d % 3 === 0) {
            VT(hi, "glucose", d, 7.6, { v1: Math.round(112 + rnd() * 26 - 6 + (d === -2 ? 32 : 0)), context: "fasting" }, whoAt(d, 7.6));
            if (d % 2 === 0 || d > -10) VT(hi, "glucose", d, 13.5, { v1: Math.round(150 + rnd() * 50 - 15 + (d === -3 ? 45 : 0)), context: "after_meal", note: d === -3 ? "Nach Kuchen" : null }, whoAt(d, 13.5));
            if (d > -7) VT(hi, "glucose", d, 21.3, { v1: Math.round(128 + rnd() * 30 - 10), context: "bedtime" }, whoAt(d, 21));
          }
          if (d % 7 === 0) VT(hi, "weight", d, 8.4, { v1: Math.round((68.4 - d * 0.01 + rnd() * 0.6) * 10) / 10 }, whoAt(d, 8));
          if (d % 3 === 0) VT(we, "bp", d, 15, { v1: Math.round(128 + rnd() * 14 - 5), v2: Math.round(78 + rnd() * 8 - 3), pulse: Math.round(66 + rnd() * 8) }, jo);
          if (d % 14 === 0) VT(we, "weight", d, 15.2, { v1: Math.round((81.5 + rnd() * 0.8) * 10) / 10 }, jo);
        }
        VT(hi, "temp", -1, 9, { v1: 37.1 }, sa); VT(hi, "temp", -4, 8.5, { v1: 36.7 }, ka); VT(hi, "spo2", -1, 9.1, { v1: 96, pulse: 74 }, sa);
      }
      db.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
      localStorage.setItem(SKEY, JSON.stringify({ uid: sa })); localStorage.setItem("pf-fid", fid); localStorage.setItem("pf-known", "1");
      save();
    },
  };
  return B;
};
