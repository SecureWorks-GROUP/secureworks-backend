import type { ClientSignoffForm } from "./client_signoff_form_data.ts";

/** Bytes only. This blank paper form records no approval and sends nothing. */
export async function renderClientSignoffForm(form: ClientSignoffForm): Promise<Uint8Array> {
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const dark = "#293C46", orange = "#F15A29", mid = "#4C6A7C";
  // Standard PDF fonts cannot carry arbitrary Unicode. Refuse unsupported
  // identity text rather than silently removing part of a client name/address.
  const plain = (v: string) => {
    const normalized = v.replace(/[\u2010-\u2015]/g, "-").replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"').normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    if (/[^\x20-\x7e\n]/.test(normalized)) throw new Error("This name or address needs a font review before printing. No form was produced.");
    return normalized;
  };
  function text(v: string, x: number, y: number, size = 10, bold = false) {
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(size);
    doc.setTextColor(dark); doc.text(plain(v), x, y);
  }
  function ruled(label: string, y: number, count: number) {
    text(label, 18, y, 11, true); doc.setDrawColor("#BCC8CE"); doc.setLineWidth(0.2);
    for (let i = 0; i < count; i++) doc.line(18, y + 9 + i * 8, 192, y + 9 + i * 8);
  }
  doc.setFillColor(orange); doc.rect(0, 0, 210, 5, "F");
  text("SecureWorks Group", 18, 18, 11, true);
  text("Job completion sign-off", 18, 31, 20, true);
  text("Job: " + form.job_number, 18, 44, 11, true);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  const address = doc.splitTextToSize(plain("Address: " + form.address), 174);
  if (address.length > 3) throw new Error("The address is too long for this paper form. The office must review it before printing.");
  doc.text(address, 18, 52);
  const client = doc.splitTextToSize(plain("Client: " + form.client_name), 174);
  if (client.length > 2) throw new Error("The client name is too long for this paper form. The office must review it before printing.");
  doc.text(client, 18, 68);
  ruled("Work completed", 83, 5);
  ruled("Outstanding items or comments", 137, 3);
  text("Does the client accept the work described above?", 18, 180, 11, true);
  doc.setDrawColor(mid); doc.rect(18, 186, 4, 4); text("Yes", 25, 189.5);
  doc.rect(57, 186, 4, 4); text("No", 64, 189.5);
  text("Client signature", 18, 205, 11, true); doc.line(18, 222, 192, 222);
  text("Client's name", 18, 234, 10, true); doc.line(51, 235, 192, 235);
  text("Date signed", 18, 247, 10, true); doc.line(51, 248, 115, 248);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(mid);
  doc.text(doc.splitTextToSize("Return the signed copy to the office. The office records it on the job, including any outstanding items. This blank form is not a recorded sign-off.", 174), 18, 265);
  return new Uint8Array(doc.output("arraybuffer"));
}
