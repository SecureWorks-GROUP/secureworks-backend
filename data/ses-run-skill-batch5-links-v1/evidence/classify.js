(() => {
  // READ-ONLY portal classifier + PII redactor.
  // Never clicks, never fills, never dispatches input/change events.
  // Redaction is additive overlay divs + a style tag; the page's own DOM text
  // and every form input value are left untouched, so autosave cannot fire.
  const body = document.body;
  const text = body.innerText || "";
  const html = body.innerHTML || "";

  // ---- signals -------------------------------------------------------------
  const LOCK_RE =
    /locked and is no longer available for editing or submission|this form (?:has been|is) locked|no longer available for editing/i;
  const AVAIL_RE = /This link is available until\s+([^\n]+)/i;
  // Prime's exact dead-link copy, confirmed by screenshot on 47170013:
  //   "This link is no longer active or has expired"
  const EXPIRED_RE =
    /this link is no longer active or has expired|link (?:has )?expired|no longer active|link is not valid|invalid link|link has been revoked/i;
  const SHELL_RE = /This link has been created by/i;

  const locked = LOCK_RE.test(text);
  const availMatch = text.match(AVAIL_RE);
  const availableUntil = availMatch ? availMatch[1].trim() : null;
  const expiredText = EXPIRED_RE.test(text);

  const buttons = [...document.querySelectorAll("button,a")]
    .map((b) => (b.innerText || "").trim()).filter(Boolean);
  const hasSubmit = buttons.some((b) => /^submit$/i.test(b));
  const hasSave = buttons.some((b) => /^save$/i.test(b));
  const autosave = /Autosave enabled/i.test(text);

  // question counter, e.g. "21 of 23"
  const nOfN = text.match(/\b(\d{1,3})\s+of\s+(\d{1,3})\b/) ||
    [null, null, null];
  const answered = nOfN[1] ? Number(nOfN[1]) : null;
  const total = nOfN[2] ? Number(nOfN[2]) : null;

  // job number binds the screenshot to the card (NOT client-identifying)
  const jobNo =
    (text.match(/Job Number\s*\n\s*([A-Z0-9][A-Z0-9\-\/]{2,30})/i) ||
      [null, null])[1];

  // form title
  const titleM = text.match(
    /\n(Roof Report|Photo Schedule|Assessment Report|Make Safe Report|Quote[^\n]*|[A-Z][^\n]{3,60}Report[^\n]*)\n/,
  );
  const formTitle = titleM ? titleM[1].trim() : null;

  const formPresent = (hasSubmit || hasSave || autosave || total !== null) &&
    html.length > 20000;

  // ---- classification ------------------------------------------------------
  // Four-way, mutually exclusive. "shell only" is NOT treated as not-submitted:
  // that conflation is the defect this replaces.
  let state, why;
  if (locked) {
    state = "present-and-locked";
    why = "lock banner present" +
      (answered !== null ? ` (${answered} of ${total} answered)` : "");
  } else if (formPresent) {
    state = "present-but-not-submitted";
    why =
      `editable form rendered (submit=${hasSubmit}, save=${hasSave}, autosave=${autosave}` +
      (answered !== null ? `, ${answered} of ${total} answered` : "") +
      (availableUntil ? `, link live until ${availableUntil}` : "") + ")";
  } else if (expiredText) {
    state = "expired";
    why = "explicit expiry/invalid message and no form rendered";
  } else if (SHELL_RE.test(text) && html.length < 20000) {
    // NOT expired. "This link has been created by <builder>" is Prime's
    // PRE-FORM consent/landing shell, which a live link shows for several
    // seconds before the form mounts. The inherited classifier mapped this
    // branch to `expired`, and it misread share 2ef11c67 — a link that in fact
    // renders a locked, submitted form at 20 of 23 — as a dead link. Only the
    // explicit expiry copy proves expiry. Keep polling; never guess.
    state = "indeterminate";
    why =
      `pre-form consent shell, form not yet mounted (bodyHtml=${html.length}b, innerText=${text.length}c)`;
  } else if (
    /\/not-found/.test(location.pathname) ||
    /unfortunately this page could not be loaded/i.test(text)
  ) {
    // Prime's generic not-found. This is NOT admissible as proof of expiry:
    // navigating straight to /resource/site-form/<id> lands here even for a
    // link whose own /share/<id> entry point states it has expired, and it
    // would land here for an unrelated routing fault too. The stored /share/
    // URL is the authoritative entry point; re-enter through it.
    state = "resource-not-found";
    why =
      "Prime generic /not-found page — not evidence of expiry; re-enter via the stored /share/ URL";
  } else {
    state = "indeterminate";
    why =
      `unrecognised page shape (bodyHtml=${html.length}b, innerText=${text.length}c)`;
  }

  // ---- redaction (additive overlays only) ----------------------------------
  const redacted = [];
  const boxes = [];
  document.querySelectorAll("div.prime-flex").forEach((row) => {
    const t = row.querySelector(".item-title");
    if (!t) return;
    const label = (t.innerText || "").trim();
    if (
      !/^(Customer|Site Address|Client|Address|Contact|Phone|Email)$/i.test(
        label,
      )
    ) return;
    [...row.children].forEach((ch) => {
      if (ch === t) return;
      const r = ch.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        boxes.push([r.left + scrollX, r.top + scrollY, r.width, r.height]);
        redacted.push(label);
      }
    });
  });
  if (boxes.length) {
    const frag = document.createDocumentFragment();
    boxes.forEach(([l, t, w, h]) => {
      const d = document.createElement("div");
      d.setAttribute("data-audit-redaction", "1");
      d.style.cssText =
        `position:absolute;left:${l}px;top:${t}px;width:${w}px;height:${h}px;` +
        `background:#111;z-index:2147483647;border-radius:3px;`;
      frag.appendChild(d);
    });
    document.body.appendChild(frag);
  }

  // sanitized text for the evidence file: drop the two PII rows entirely
  const safeText = text
    .replace(/Customer\n[^\n]*\n/g, "Customer\n[REDACTED]\n")
    .replace(/Site Address\n[^\n]*\n/g, "Site Address\n[REDACTED]\n");

  return {
    url: location.href,
    state,
    why,
    locked,
    formPresent,
    availableUntil,
    answered,
    total,
    jobNo,
    formTitle,
    hasSubmit,
    hasSave,
    autosave,
    bodyHtmlLen: html.length,
    innerTextLen: text.length,
    redactedRegions: redacted.length,
    safeHead: safeText.slice(0, 700),
  };
});
