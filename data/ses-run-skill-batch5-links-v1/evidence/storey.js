() => {
  // READ-ONLY. Reads the source-evidenced storey/construction facts off a LOCKED
  // Prime roof report. Never clicks, never fills, never dispatches events.
  const t = document.body.innerText || "";
  const pick = (label) => {
    const m = t.match(new RegExp("\\n" + label + "\\s*\\n\\s*([^\\n]{1,60})", "i"));
    return m ? m[1].trim() : null;
  };
  const nOfN = t.match(/\b(\d{1,3})\s+of\s+(\d{1,3})\b/);
  return ({
    jobNo: (t.match(/Job Number\s*\n\s*([A-Z0-9][A-Z0-9\-\/]{2,30})/i)||[null,null])[1],
    locked: /this form has been locked/i.test(t),
    answered: nOfN ? Number(nOfN[1]) : null,
    total: nOfN ? Number(nOfN[2]) : null,
    storeys: pick("Number of Storeys"),
    construction: pick("Construction Type"),
    roofType: pick("Roof Type"),
    inspectionBy: pick("Inspection By"),
    inspectedOn: pick("Date of Inspection"),
  });
}
