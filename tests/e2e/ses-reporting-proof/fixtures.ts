import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CAPTAIN_EMAIL, type ProofFixture, type ProofRunContext } from './types'

interface FixtureDefinition {
  fate: ProofFixture['fate']
  label: string
  expected: ProofFixture['expected']
  body: string
}

const DEFINITIONS: FixtureDefinition[] = [
  {
    fate: 'confirmed_live_job',
    label: 'Clean work order',
    expected: { boardStage: 'New / Unallocated', blocker: null, person: 'Hugo', reasonCode: null },
    body: 'A complete synthetic instruction with client, site, contact and work-order identity.',
  },
  {
    fate: 'blocked_live_job',
    label: 'Visible blocked work order',
    expected: { boardStage: 'New / Unallocated', blocker: 'missing_client_phone', person: 'Hugo', reasonCode: 'missing_required_identity' },
    body: 'A genuine instruction whose deliberately absent client phone must remain visible and blocked.',
  },
  {
    fate: 'reason_coded_exception',
    label: 'Ambiguous instruction',
    expected: { boardStage: 'Intake Exception', blocker: 'ambiguous_work_order', person: 'Hugo', reasonCode: 'ambiguous_work_order' },
    body: 'Two deliberately conflicting references force a visible reason-coded exception.',
  },
  {
    fate: 'revision_existing_job',
    label: 'Revision to existing work order',
    expected: { boardStage: 'Trade Report In', blocker: null, person: 'Hugo', reasonCode: 'revision_attached' },
    body: 'A corrected PDF for the exact existing work order must attach as revision two, never mint a sibling job.',
  },
  {
    fate: 'accounted_non_work',
    label: 'Accounted non-work copy',
    expected: { boardStage: null, blocker: null, person: 'System', reasonCode: 'own_domain_copy' },
    body: 'A synthetic own-domain copy must be accounted as non-work and must not become a board job.',
  },
]

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

export function renderDeterministicPdf(lines: string[]): Buffer {
  const text = lines
    .map((line, index) => `${index === 0 ? '' : '0 -19 Td '}(${escapePdfText(line)}) Tj`)
    .join('\n')
  const stream = `BT\n/F1 12 Tf\n50 770 Td\n${text}\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n% SWG TEST PDF\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'ascii')
}

function renderEml(input: {
  marker: string
  fixtureId: string
  subject: string
  workOrder: string
  body: string
  pdf: Buffer
}): Buffer {
  const boundary = `swg-proof-${input.fixtureId}`
  const lines = [
    `From: Synthetic Builder <builder-${input.fixtureId}@example.invalid>`,
    `To: ${CAPTAIN_EMAIL}`,
    `Subject: ${input.subject}`,
    'Date: Mon, 01 Jan 2024 00:00:00 +0000',
    `Message-ID: <${input.fixtureId}@ses-proof.example.invalid>`,
    `X-SecureWorks-Synthetic-Marker: ${input.marker}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    `${input.marker}`,
    `Work order: ${input.workOrder}`,
    input.body,
    'This message is synthetic test evidence. It is not client work.',
    '',
    `--${boundary}`,
    'Content-Type: application/pdf; name="synthetic-work-order.pdf"',
    'Content-Disposition: attachment; filename="synthetic-work-order.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    input.pdf.toString('base64').match(/.{1,76}/g)?.join('\r\n') || '',
    `--${boundary}--`,
    '',
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8')
}

export async function generateFixtures(context: ProofRunContext): Promise<ProofFixture[]> {
  const fixtureRoot = path.join(context.runRoot, 'fixtures')
  await fs.mkdir(fixtureRoot, { recursive: true })

  const fixtures: ProofFixture[] = []
  for (let index = 0; index < DEFINITIONS.length; index += 1) {
    const definition = DEFINITIONS[index]
    const stable = sha256(`${context.seed}:${definition.fate}`).slice(0, 12).toUpperCase()
    const fixtureId = `fate-${index + 1}-${stable.toLowerCase()}`
    const workOrder = `SWGTEST-${stable}`
    const subject = `[${context.marker}] ${definition.label} ${workOrder}`
    const pdf = renderDeterministicPdf([
      context.marker,
      'SYNTHETIC BUILDER WORK ORDER',
      `Fate: ${definition.fate}`,
      `Work order: ${workOrder}`,
      definition.body,
      'TEST ONLY. NOT A REAL CLIENT OR SITE.',
    ])
    const eml = renderEml({
      marker: context.marker,
      fixtureId,
      subject,
      workOrder,
      body: definition.body,
      pdf,
    })
    const pdfPath = path.join(fixtureRoot, `${fixtureId}.pdf`)
    const emlPath = path.join(fixtureRoot, `${fixtureId}.eml`)
    await Promise.all([fs.writeFile(pdfPath, pdf), fs.writeFile(emlPath, eml)])

    fixtures.push({
      fixtureId,
      fate: definition.fate,
      subject,
      workOrder,
      expected: definition.expected,
      emlPath,
      pdfPath,
      emlBase64: eml.toString('base64'),
      pdfBase64: pdf.toString('base64'),
      sha256: { eml: sha256(eml), pdf: sha256(pdf) },
    })
  }

  await fs.writeFile(
    path.join(fixtureRoot, 'manifest.json'),
    `${JSON.stringify(fixtures.map(({ emlBase64: _eml, pdfBase64: _pdf, ...fixture }) => fixture), null, 2)}\n`,
  )
  return fixtures
}
