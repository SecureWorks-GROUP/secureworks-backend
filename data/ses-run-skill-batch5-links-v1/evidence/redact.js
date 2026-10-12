(() => {
  // PII redaction + VERIFICATION. Additive overlays only: never mutates page
  // text and never touches a form input, so autosave cannot fire.
  //
  // Returns ok:false when the page still shows a client-identifying label that
  // was not covered. The driver refuses to screenshot on ok:false — a leaked
  // screenshot is unrecoverable once written.
  const PII_LABEL =
    /^(Customer|Site Address|Client|Address|Contact|Phone|Email|Owner|Insured)$/i;

  document.querySelectorAll("[data-audit-redaction]").forEach((n) =>
    n.remove()
  );

  const boxes = [];
  const covered = [];
  const uncovered = [];

  document.querySelectorAll("div.prime-flex, .prime-flex").forEach((row) => {
    const t = row.querySelector(".item-title");
    if (!t) return;
    const label = (t.textContent || "").replace(/\s+/g, " ").trim();
    if (!PII_LABEL.test(label)) return;
    let got = false;
    [...row.children].forEach((ch) => {
      if (ch === t) return;
      const r = ch.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) {
        boxes.push([r.left + scrollX, r.top + scrollY, r.width, r.height]);
        got = true;
      }
    });
    (got ? covered : uncovered).push(label);
  });

  if (boxes.length) {
    const frag = document.createDocumentFragment();
    boxes.forEach(([l, t, w, h]) => {
      const d = document.createElement("div");
      d.setAttribute("data-audit-redaction", "1");
      d.style.cssText = `position:absolute;left:${l - 2}px;top:${t - 2}px;` +
        `width:${w + 4}px;height:${
          h + 4
        }px;background:#111;z-index:2147483647;border-radius:3px;`;
      frag.appendChild(d);
    });
    document.body.appendChild(frag);
  }

  // Independent verification. "Found no PII labels" is NOT a pass on its own:
  // a page still spinning also has no labels, and it was exactly that false
  // pass that let a client name and street address into a screenshot once.
  // A rendered FORM page must therefore prove it redacted something.
  const text = document.body.innerText || "";
  const html = document.body.innerHTML || "";
  const labelsPresent = [
    ...text.matchAll(/^(Customer|Site Address|Client|Contact|Phone|Email)$/gim),
  ]
    .map((m) => m[1]);
  const formRendered = html.length > 20000;
  const deadShell = html.length < 20000 &&
    /this link is no longer active or has expired/i.test(text);

  let ok, reason;
  if (uncovered.length) {
    ok = false;
    reason = `uncovered PII labels: ${uncovered.join(",")}`;
  } else if (deadShell) {
    ok = true; // expired page carries no client data at all
    reason = "dead-link shell, no client data present";
  } else if (formRendered) {
    ok = covered.length >= 1 && labelsPresent.length <= covered.length;
    reason = ok
      ? `form rendered, ${covered.length} PII region(s) covered`
      : `form rendered but only ${covered.length} region(s) covered for ${labelsPresent.length} label(s)`;
  } else {
    ok = false; // still loading — never screenshot a page mid-render
    reason = `page not settled (bodyHtml=${html.length}b); refusing to capture`;
  }

  return {
    ok,
    reason,
    covered: covered.length,
    uncovered,
    labelsPresent: labelsPresent.length,
    boxes: boxes.length,
  };
});
