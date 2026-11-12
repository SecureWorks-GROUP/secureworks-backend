// The customer's site line names the suburb once: left off only when the street line already
// ends with it as its own comma part (director, 13 Nov 2026), never by a substring test.
// Run: deno test --allow-read --allow-env supabase/functions/_shared/customer_site_line_test.ts
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { customerSiteLine } from './customer_site_line.ts'

Deno.test("site line: the director's six cases", () => {
  assertEquals(customerSiteLine('5 Baldivis Road', 'Baldivis'), '5 Baldivis Road, Baldivis')
  assertEquals(customerSiteLine('ZZTEST 3 Test St, Baldivis', 'Baldivis'), 'ZZTEST 3 Test St, Baldivis')
  assertEquals(customerSiteLine('3 Test St, Baldivis WA 6171', 'Baldivis'), '3 Test St, Baldivis WA 6171')
  assertEquals(customerSiteLine('12 Smith St', 'Rockingham'), '12 Smith St, Rockingham')
  assertEquals(customerSiteLine('', 'Baldivis'), 'Baldivis')
  assertEquals(customerSiteLine('8 Lake Rd', ''), '8 Lake Rd')
})

Deno.test('site line: a street named after its suburb still gets the suburb', () => {
  assertEquals(customerSiteLine('12 Rockingham Road', 'Rockingham'), '12 Rockingham Road, Rockingham')
  assertEquals(customerSiteLine('40 Mandurah Road', 'mandurah'), '40 Mandurah Road, mandurah')
  assertEquals(customerSiteLine('3 Test St Baldivis', 'Baldivis'), '3 Test St Baldivis, Baldivis')
})

Deno.test('site line: a last comma part that is the suburb prints it once, any case or spacing', () => {
  assertEquals(customerSiteLine('  3 Test St, BALDIVIS  ', ' Baldivis '), '3 Test St, BALDIVIS')
  assertEquals(customerSiteLine('3 Test St, Baldivis, WA 6171', 'Baldivis'), '3 Test St, Baldivis, WA 6171')
  assertEquals(customerSiteLine('3 Test St, Baldivis 6171', 'Baldivis'), '3 Test St, Baldivis 6171')
  assertEquals(customerSiteLine('3 Test St, Port  Kennedy WA', 'Port Kennedy'), '3 Test St, Port  Kennedy WA')
})

Deno.test('site line: a street without the suburb gets it added', () => {
  assertEquals(customerSiteLine('3 Test St', 'Baldivis'), '3 Test St, Baldivis')
  assertEquals(customerSiteLine('', 'Baldivis'), 'Baldivis')
  assertEquals(customerSiteLine(null, 'Baldivis'), 'Baldivis')
  assertEquals(customerSiteLine('3 Test St', ''), '3 Test St')
  assertEquals(customerSiteLine('3 Test St', null), '3 Test St')
  assertEquals(customerSiteLine(undefined, undefined), '')
  assertEquals(customerSiteLine('3 Test St', 'Baldivis', ' '), '3 Test St Baldivis')
})

Deno.test('site line: an ordinary fence or patio address is byte for byte the old join', () => {
  const sites: Array<[string | null, string | null]> = [
    ['12 Smith Street', 'Rockingham'],
    ['4/27 Ocean Drive', 'Mandurah'],
    ['', 'Baldivis'],
    ['8 Lake Rd', ''],
    [null, null],
  ]
  for (const [street, suburb] of sites) {
    assertEquals(customerSiteLine(street, suburb), [street, suburb].filter(Boolean).join(', '))
    assertEquals(customerSiteLine(street, suburb, ' '), `${street || ''} ${suburb || ''}`.trim())
  }
})
