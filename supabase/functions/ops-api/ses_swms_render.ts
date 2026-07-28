import {
  SES_SWMS_DOC_CODE,
  SES_SWMS_HRCW_ITEMS,
  type SesSwmsGenerationPlan,
} from "./ses_swms_template.ts";

export interface RenderedSesSwms {
  file_name: string;
  media_type: "application/pdf";
  bytes: Uint8Array;
  render_hash: string;
  provenance: Record<string, unknown>;
}

const ORANGE: [number, number, number] = [241, 90, 41];
const NAVY: [number, number, number] = [26, 39, 46];
const MID: [number, number, number] = [76, 106, 124];
const LIGHT: [number, number, number] = [238, 241, 243];
const GRID: [number, number, number] = [190, 200, 206];
const BODY: [number, number, number] = [34, 34, 34];
const WHITE: [number, number, number] = [255, 255, 255];
const LOW: [number, number, number] = [212, 237, 218];
const MEDIUM: [number, number, number] = [255, 243, 205];
const HIGH: [number, number, number] = [248, 215, 218];
const EXTREME: [number, number, number] = [245, 183, 177];

const PAGE_W = 297;
const MARGIN = 9;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY_TOP = 30;
const BODY_BOTTOM = 196;

// These are the sealed template signatures bundled with the reporting skill.
// Source hashes:
// Marnin 53c70f4524e1eb3e7e1bded9c15b4f204a84bca065222861730507b17d49710f
// Jan    6c1c91a8b71af02c3661c8ecbb30a381058453067f4b4393fc4c591345108634
const MARNIN_SIGNATURE =
  "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";
const JAN_SIGNATURE =
  "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";

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/[—–]/g, "-")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n");
}

function riskColour(risk: string): [number, number, number] {
  if (risk === "Low") return LOW;
  if (risk === "Medium") return MEDIUM;
  if (risk === "High") return HIGH;
  return EXTREME;
}

export function sesSwmsRenderHashInput(plan: SesSwmsGenerationPlan): string {
  return JSON.stringify({
    contract_version: plan.contract_version,
    template_version: plan.template_version,
    template: plan.template,
    output_file_name: plan.output_file_name,
    job: plan.job,
    provenance: plan.provenance,
  });
}

export async function sesSwmsRenderHash(
  plan: SesSwmsGenerationPlan,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sesSwmsRenderHashInput(plan)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function renderSesSwmsPdf(
  plan: SesSwmsGenerationPlan,
): Promise<RenderedSesSwms> {
  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const renderHash = await sesSwmsRenderHash(plan);
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
    compress: false,
  });
  const submittedAt = new Date(plan.provenance.trade_report_submitted_at);
  doc.setCreationDate(
    Number.isNaN(submittedAt.getTime())
      ? new Date("2000-01-01T00:00:00.000Z")
      : submittedAt,
  );
  doc.setFileId(renderHash.slice(0, 32).toUpperCase());
  doc.setProperties({
    title: plan.output_file_name,
    subject: `${plan.template.label} - ${plan.job.builder_reference}`,
    author: "SecureWorks Group Pty Ltd",
    creator: "SecureWorks ops-api deterministic SWMS generator",
  });

  const setFill = (colour: [number, number, number]): void => {
    doc.setFillColor(...colour);
  };
  const setText = (colour: [number, number, number]): void => {
    doc.setTextColor(...colour);
  };
  const setDraw = (colour: [number, number, number]): void => {
    doc.setDrawColor(...colour);
  };
  const lines = (value: unknown, width: number): string[] =>
    doc.splitTextToSize(clean(value), width) as string[];

  const headerFooter = (page: number): void => {
    setFill(ORANGE);
    doc.rect(0, 0, PAGE_W, 4, "F");
    setText(NAVY);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("SAFE WORK METHOD STATEMENT (SWMS)", MARGIN, 13);
    doc.setFontSize(11);
    doc.text("SecureWorks", PAGE_W - MARGIN, 13, { align: "right" });
    setText(MID);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.text(
      `${SES_SWMS_DOC_CODE} | ${plan.job.revision} | Authorised by: Marnin (Director)`,
      MARGIN,
      18,
    );
    doc.text(
      `${clean(plan.job.builder_reference)} | ${clean(plan.job.address)}`,
      MARGIN,
      22,
    );
    setDraw(GRID);
    doc.setLineWidth(0.25);
    doc.line(MARGIN, 25, PAGE_W - MARGIN, 25);
    doc.line(MARGIN, 199, PAGE_W - MARGIN, 199);
    doc.setFontSize(6);
    doc.text(
      `${SES_SWMS_DOC_CODE} | SAFE WORK METHOD STATEMENT | ${plan.job.revision}`,
      MARGIN,
      203,
    );
    doc.text(
      "SecureWorks Group Pty Ltd | ABN 64 689 223 416",
      PAGE_W / 2,
      203,
      { align: "center" },
    );
    doc.text(`Page ${page} of 4`, PAGE_W - MARGIN, 203, { align: "right" });
  };

  const section = (title: string, y: number): number => {
    setFill(ORANGE);
    doc.rect(MARGIN, y, 2.2, 6, "F");
    setFill(NAVY);
    doc.rect(MARGIN + 2.2, y, CONTENT_W - 2.2, 6, "F");
    setText(WHITE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.4);
    doc.text(clean(title).toUpperCase(), MARGIN + 5, y + 4.1);
    return y + 7;
  };

  const keyValueRows = (
    rows: Array<[string, string]>,
    y: number,
    labelWidth = 48,
    fontSize = 6.5,
  ): number => {
    doc.setFontSize(fontSize);
    for (const [label, value] of rows) {
      const valueLines = lines(value, CONTENT_W - labelWidth - 5);
      const height = Math.max(7, valueLines.length * (fontSize * 0.38) + 3);
      setFill(LIGHT);
      doc.rect(MARGIN, y, labelWidth, height, "F");
      setDraw(GRID);
      doc.rect(MARGIN, y, CONTENT_W, height);
      doc.line(MARGIN + labelWidth, y, MARGIN + labelWidth, y + height);
      setText(NAVY);
      doc.setFont("helvetica", "bold");
      doc.text(clean(label), MARGIN + 2.5, y + 4.5);
      setText(BODY);
      doc.setFont("helvetica", "normal");
      doc.text(valueLines, MARGIN + labelWidth + 2.5, y + 4.5);
      y += height;
    }
    return y;
  };

  const bulletColumns = (items: string[], y: number): number => {
    const half = Math.ceil(items.length / 2);
    const columns = [items.slice(0, half), items.slice(half)];
    const colWidth = CONTENT_W / 2;
    const rowCount = Math.max(columns[0].length, columns[1].length);
    const height = Math.max(10, rowCount * 4.2 + 3);
    setDraw(GRID);
    doc.rect(MARGIN, y, CONTENT_W, height);
    doc.line(MARGIN + colWidth, y, MARGIN + colWidth, y + height);
    setText(BODY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(5.8);
    columns.forEach((column, columnIndex) => {
      column.forEach((item, index) => {
        doc.text(
          `- ${clean(item)}`,
          MARGIN + columnIndex * colWidth + 2.5,
          y + 4.5 + index * 4.2,
        );
      });
    });
    return y + height;
  };

  const checkboxGrid = (
    items: Array<{ label: string; required: boolean }>,
    y: number,
    columns = 5,
  ): number => {
    const colWidth = CONTENT_W / columns;
    const rows = Math.ceil(items.length / columns);
    const rowHeight = 8;
    setDraw(GRID);
    doc.rect(MARGIN, y, CONTENT_W, rows * rowHeight);
    doc.setFontSize(5.6);
    items.forEach((item, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const x = MARGIN + column * colWidth;
      const top = y + row * rowHeight;
      doc.rect(x + 1.5, top + 1.5, 3, 3);
      if (item.required) {
        setText(ORANGE);
        doc.setFont("helvetica", "bold");
        doc.text("X", x + 2.15, top + 4);
      }
      setText(BODY);
      doc.setFont("helvetica", "normal");
      doc.text(
        lines(item.label, colWidth - 7).slice(0, 2),
        x + 5.5,
        top + 3.4,
        { lineHeightFactor: 1.05 },
      );
    });
    return y + rows * rowHeight;
  };

  const hrcwGrid = (y: number): number => {
    const columns = 3;
    const rows = Math.ceil(SES_SWMS_HRCW_ITEMS.length / columns);
    const colWidth = CONTENT_W / columns;
    const rowHeight = 6.4;
    const selected = new Set(plan.template.hrcw_ticked);
    setDraw(GRID);
    doc.rect(MARGIN, y, CONTENT_W, rows * rowHeight);
    doc.setFontSize(5.2);
    SES_SWMS_HRCW_ITEMS.forEach((item, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const x = MARGIN + column * colWidth;
      const top = y + row * rowHeight;
      doc.rect(x + 1.3, top + 1.6, 3, 3);
      if (selected.has(item)) {
        setText(ORANGE);
        doc.setFont("helvetica", "bold");
        doc.text("X", x + 1.95, top + 4.1);
      }
      setText(BODY);
      doc.setFont("helvetica", "normal");
      doc.text(clean(item), x + 5.3, top + 4.2);
    });
    return y + rows * rowHeight;
  };

  const note = (value: string, y: number): number => {
    setText(MID);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(5.6);
    const wrapped = lines(value, CONTENT_W - 4);
    doc.text(wrapped, MARGIN + 2, y + 3);
    return y + wrapped.length * 2.7 + 3;
  };

  const workMethodTable = (y: number): number => {
    const headers = [
      "#",
      "Job Step / Activity",
      "Potential Hazards",
      "Initial Risk",
      "Control Measures",
      "Residual Risk",
      "Responsible",
    ];
    const widths = [7, 34, 44, 16, 120, 16, 42];
    const xPositions = widths.reduce<number[]>(
      (positions, width) => [...positions, positions.at(-1)! + width],
      [MARGIN],
    );
    const headerHeight = 8;
    setFill(NAVY);
    doc.rect(MARGIN, y, CONTENT_W, headerHeight, "F");
    setText(WHITE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(5.2);
    headers.forEach((header, index) => {
      doc.text(
        lines(header, widths[index] - 2),
        xPositions[index] + 1,
        y + 3.3,
      );
    });
    y += headerHeight;
    doc.setFontSize(4.7);
    plan.template.steps.forEach((step, rowIndex) => {
      const values = [
        step.number,
        step.activity,
        step.hazards,
        step.initial_risk,
        step.controls,
        step.residual_risk,
        step.responsible,
      ];
      const wrapped = values.map((value, index) =>
        lines(value, widths[index] - 2)
      );
      const height = Math.max(
        8,
        ...wrapped.map((value) => value.length * 2.35 + 3),
      );
      setFill(rowIndex % 2 ? LIGHT : WHITE);
      doc.rect(MARGIN, y, CONTENT_W, height, "F");
      setFill(riskColour(step.initial_risk));
      doc.rect(xPositions[3], y, widths[3], height, "F");
      setFill(riskColour(step.residual_risk));
      doc.rect(xPositions[5], y, widths[5], height, "F");
      setDraw(GRID);
      doc.rect(MARGIN, y, CONTENT_W, height);
      xPositions.slice(1, -1).forEach((x) => doc.line(x, y, x, y + height));
      wrapped.forEach((value, index) => {
        setText(BODY);
        doc.setFont(
          "helvetica",
          index === 0 || index === 3 || index === 5 ? "bold" : "normal",
        );
        doc.text(value, xPositions[index] + 1, y + 3.3);
      });
      y += height;
    });
    return y;
  };

  const riskMatrix = (y: number): number => {
    const likelihood = [
      "Almost Certain",
      "Likely",
      "Possible",
      "Unlikely",
      "Rare",
    ];
    const consequence = [
      "Insignificant",
      "Minor",
      "Moderate",
      "Major",
      "Catastrophic",
    ];
    const values = [
      ["M", "H", "H", "EX", "EX"],
      ["M", "M", "H", "H", "EX"],
      ["L", "M", "M", "H", "H"],
      ["L", "L", "M", "M", "H"],
      ["L", "L", "L", "M", "M"],
    ];
    const labelWidth = 45;
    const cellWidth = (CONTENT_W - labelWidth) / 5;
    const rowHeight = 8;
    const x = MARGIN;
    setFill(NAVY);
    doc.rect(x, y, CONTENT_W, rowHeight, "F");
    setText(WHITE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(5.6);
    doc.text("Likelihood / Consequence", x + 2, y + 5);
    consequence.forEach((label, index) =>
      doc.text(
        label,
        x + labelWidth + index * cellWidth + cellWidth / 2,
        y + 5,
        {
          align: "center",
        },
      )
    );
    for (let row = 0; row < 5; row++) {
      const top = y + rowHeight * (row + 1);
      setFill(MID);
      doc.rect(x, top, labelWidth, rowHeight, "F");
      setText(WHITE);
      doc.text(likelihood[row], x + 2, top + 5);
      for (let column = 0; column < 5; column++) {
        const value = values[row][column];
        setFill(
          value === "L"
            ? LOW
            : value === "M"
            ? MEDIUM
            : value === "H"
            ? HIGH
            : EXTREME,
        );
        doc.rect(
          x + labelWidth + column * cellWidth,
          top,
          cellWidth,
          rowHeight,
          "F",
        );
        setText(BODY);
        doc.text(
          value,
          x + labelWidth + column * cellWidth + cellWidth / 2,
          top + 5,
          { align: "center" },
        );
      }
    }
    setDraw(WHITE);
    doc.setLineWidth(0.3);
    for (let row = 0; row <= 6; row++) {
      doc.line(x, y + row * rowHeight, x + CONTENT_W, y + row * rowHeight);
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(5.5);
    setText(BODY);
    doc.text(
      "L = Low | M = Medium | H = High | EX = Extreme - immediate action / stop work",
      MARGIN,
      y + 6 * rowHeight + 4,
    );
    return y + 6 * rowHeight + 7;
  };

  // Page 1 - company, job facts and standard requirements.
  headerFooter(1);
  let y = section("Company Details", BODY_TOP);
  y = keyValueRows([
    ["Company Name", "SecureWorks Group Pty Ltd"],
    ["ABN", "64 689 223 416"],
    ["Registered Address", "Wangara WA 6065"],
  ], y);
  y = section("Task Name / Activity and Site / Project Name", y + 2);
  y = keyValueRows([
    ["Task / Activity", plan.job.task_activity],
    [
      "Site / Project",
      `${plan.job.builder_reference} - ${plan.job.address} (for ${plan.job.builder_label})`,
    ],
    ["Site Contact", plan.job.site_contact],
    [
      "Date of Works",
      `${plan.job.works_date} | Arrived ${plan.job.arrival} | Crew: ${plan.job.crew}`,
    ],
  ], y);
  y = section(
    "Applicable Legislation, Codes of Practice or Other Guidance Material",
    y + 2,
  );
  y = bulletColumns(plan.template.legislation, y);
  y = section("Personal Protective Equipment (PPE)", y + 2);
  y = checkboxGrid(plan.template.ppe, y);
  y = section("Required Licences, Certificates or Competencies", y + 2);
  bulletColumns(plan.template.licences, y);

  // Page 2 - HRCW selection and sealed work method.
  doc.addPage();
  headerFooter(2);
  y = section("High Risk Construction Work (tick all that apply)", BODY_TOP);
  y = hrcwGrid(y);
  y = note(plan.template.hrcw_note, y + 1);
  y = section("Work Method and Risk Assessment", y + 1);
  setFill(LIGHT);
  doc.rect(MARGIN, y, CONTENT_W, 7, "F");
  setText(NAVY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(5.8);
  doc.text(
    "Hierarchy of controls: 1 Eliminate | 2 Substitute | 3 Isolate | 4 Engineering | 5 Administrative | 6 PPE (last resort)",
    MARGIN + 2,
    y + 4.5,
  );
  workMethodTable(y + 8);

  // Page 3 - risk matrix, emergency response and monitoring.
  doc.addPage();
  headerFooter(3);
  y = section("Risk Rating Matrix", BODY_TOP);
  y = riskMatrix(y);
  y = section("Emergency Procedures and Site Information", y + 2);
  y = keyValueRows(plan.template.emergency, y, 52, 5.8);
  y = section("Monitoring for Compliance", y + 2);
  keyValueRows(
    [
      [
        "Ongoing monitoring and review of control measures",
        "Marnin (Director) - sealed template signature on file",
      ],
      [
        "Ongoing supervision to ensure compliance with this SWMS",
        "Jan (Director) - sealed template signature on file",
      ],
    ],
    y,
    95,
    5.8,
  );

  // Page 4 - consultation, record keeping and sealed authorisers.
  doc.addPage();
  headerFooter(4);
  y = section("Consultation, Review and Record-Keeping", BODY_TOP);
  y = keyValueRows(
    [
      [
        "Developed in consultation with",
        `On-site trade report for attendance cycle ${plan.provenance.attendance_cycle_id}; field report ${plan.provenance.trade_report_id}.`,
      ],
      [
        "Prepared by / Date prepared",
        `Marnin (Director) / ${plan.job.authorised_date}`,
      ],
      [
        "SWMS review triggers",
        "Review if work or site conditions change, an incident or near-miss occurs, or control measures are revised. Retain all revised versions.",
      ],
      ["Record-keeping", plan.template.record_keeping],
      ["Next scheduled review", "________________________________"],
    ],
    y,
    62,
    6.2,
  );
  y = section("Person Authorising Use of SWMS", y + 3);
  const widths = [145, 82, 52];
  const x = [MARGIN, MARGIN + widths[0], MARGIN + widths[0] + widths[1]];
  setFill(NAVY);
  doc.rect(MARGIN, y, CONTENT_W, 8, "F");
  setText(WHITE);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6.5);
  doc.text("Name / Role", MARGIN + 2, y + 5);
  doc.text("Signature", x[1] + 2, y + 5);
  doc.text("Date", x[2] + 2, y + 5);
  y += 8;
  const authorisers: Array<[string, string]> = [
    ["Marnin - Director, SecureWorks Group", MARNIN_SIGNATURE],
    ["Jan - Director, SecureWorks Group", JAN_SIGNATURE],
  ];
  authorisers.forEach(([name, signature], index) => {
    const height = 23;
    setFill(index % 2 ? LIGHT : WHITE);
    doc.rect(MARGIN, y, CONTENT_W, height, "F");
    setDraw(GRID);
    doc.rect(MARGIN, y, CONTENT_W, height);
    doc.line(x[1], y, x[1], y + height);
    doc.line(x[2], y, x[2], y + height);
    setText(BODY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.text(name, MARGIN + 2, y + 13);
    doc.addImage(
      `data:image/png;base64,${signature}`,
      "PNG",
      x[1] + 5,
      y + 3,
      18,
      14,
    );
    doc.text(plan.job.authorised_date, x[2] + 2, y + 13);
    y += height;
  });
  setText(MID);
  doc.setFontSize(5.8);
  doc.text(
    `Generated from ${
      clean(plan.provenance.source_instruction_id)
    } and trade report ${clean(plan.provenance.trade_report_id)} using ${
      clean(plan.template_version)
    } / ${clean(plan.template.kind)}.`,
    MARGIN,
    Math.min(y + 7, BODY_BOTTOM),
  );

  const bytes = new Uint8Array(doc.output("arraybuffer"));
  return {
    file_name: plan.output_file_name,
    media_type: "application/pdf",
    bytes,
    render_hash: renderHash,
    provenance: {
      generator: "ops-api:ses_swms_render",
      generation_plan_version: plan.contract_version,
      template_version: plan.template_version,
      template_kind: plan.template.kind,
      template_source_sha256: plan.template.source_sha256,
      source_instruction_id: plan.provenance.source_instruction_id,
      source_content_hash: plan.provenance.source_content_hash,
      work_order_pointers: plan.provenance.work_order_pointers,
      trade_report_id: plan.provenance.trade_report_id,
      trade_report_submitted_at: plan.provenance.trade_report_submitted_at,
      attendance_cycle_id: plan.provenance.attendance_cycle_id,
      hrcw_categories: plan.provenance.hrcw_categories,
      source_hazard_terms: plan.provenance.source_hazard_terms,
      job_fact_sources: plan.provenance.job_fact_sources,
    },
  };
}
