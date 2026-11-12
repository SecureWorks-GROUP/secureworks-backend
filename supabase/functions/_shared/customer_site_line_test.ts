// The customer's site line names the suburb once (scope-engine jobsystem.ts jobCustomer rule).
// Run: deno test --allow-read --allow-env supabase/functions/_shared/customer_site_line_test.ts
import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { customerSiteLine } from './customer_site_line.ts'

Deno.test('site line: a street that already names the suburb prints it once', () => {
  assertEquals(customerSiteLine('ZZTEST 3 Test St, Baldivis', 'Baldivis'), 'ZZTEST 3 Test St, Baldivis')
  assertEquals(customerSiteLine('3 Test St Baldivis', 'baldivis'), '3 Test St Baldivis')
  assertEquals(customerSiteLine('  3 Test St, BALDIVIS  ', ' Baldivis '), '3 Test St, BALDIVIS')
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
