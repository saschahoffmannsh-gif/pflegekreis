/* Pflegekreis – „Empfehlungen“ im Bereich „Hilfen & Ansprüche“ (Einstellungen › Hilfen & Ansprüche)
 *
 * Solange enabled:false ist oder items leer ist, sehen Nutzer davon NICHTS (kein Abschnitt, kein Schalter).
 * Höchstens 2 Einträge werden angezeigt, jeweils deutlich als „Anzeige“ gekennzeichnet.
 * Ein Tipp öffnet nur den Link in einem neuen Fenster (ohne Referrer). Es werden keine Daten an Partner
 * übertragen und keine Tracking-Skripte geladen – bitte auch keine Tracking-Parameter mit Personen-/Gesundheitsbezug in die URL schreiben.
 *
 * Vor dem Einschalten: Satz zu Partnerlinks in public/datenschutz.html ergänzen.
 *
 * Beispiel:
 *   window.PF_PARTNERS = { enabled: true, items: [
 *     { title: "Pflegebox", text: "Pflegehilfsmittel monatlich nach Hause – Abrechnung mit der Pflegekasse.", url: "https://example.org/?ref=pflegekreis", cta: "Zum Angebot", icon: "box" },
 *   ] };
 * icon: box | bell | home | euro | heart | aid (optional)
 */
window.PF_PARTNERS = { enabled: false, items: [] };
