// Guard: Marco's model-facing COVERAGE prose must name exactly the countries whose ports he
// actually serves. The relay single-sources its port list from src/config/italy-ferries.data.json
// (scripts/ais-relay.cjs), so when a commercial port in a NEW country lands there, this test fails
// until the coverage claims are updated — otherwise the model treats that country's ports as out of
// scope and skips the freight tools (the "Rotterdam" bug fixed in #59). Covers the shared brain:
// DEFAULT_SYSTEM, MARCO_PERSONA, and the two freight tool descriptions the model reads when deciding
// whether a port is in scope. (The onboarding/landing/legal copy is left to human review.)
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { DEFAULT_SYSTEM } from './agent.mjs';
import { freightTools } from './tools/freight.mjs';
import { MARCO_PERSONA } from './slack/onboarding.mjs';

// Port `country` code (Italian ports carry none) -> the token the coverage prose must contain.
// Add an entry when the port data gains a new country.
const COUNTRY_TOKEN = { IT: 'Italy', GB: 'UK', ES: 'Spain', NL: 'Netherlands' };

const { ports } = JSON.parse(
  readFileSync(new URL('../src/config/italy-ferries.data.json', import.meta.url)),
);
const covered = new Set(ports.filter((p) => p.commercial).map((p) => p.country || 'IT'));

const desc = (name) => freightTools.find((t) => t.name === name).description;
const COVERAGE = {
  DEFAULT_SYSTEM,
  MARCO_PERSONA,
  get_port_congestion: desc('get_port_congestion'),
  find_freight_vessels: desc('find_freight_vessels'),
};

test('every covered commercial-port country has a display-token mapping', () => {
  for (const code of covered) {
    assert.ok(
      COUNTRY_TOKEN[code],
      `Port data has commercial ports in country "${code}" with no COUNTRY_TOKEN entry. ` +
        `Add "${code}": "<Name>" here AND name it across Marco's coverage prose (agent.mjs ` +
        `DEFAULT_SYSTEM, freight.mjs tool descriptions, MARCO_PERSONA, onboarding/landing/legal copy).`,
    );
  }
});

for (const [label, str] of Object.entries(COVERAGE)) {
  test(`coverage prose "${label}" names exactly the covered countries`, () => {
    for (const [code, token] of Object.entries(COUNTRY_TOKEN)) {
      assert.equal(
        str.includes(token),
        covered.has(code),
        `${label}: "${token}" in prose=${str.includes(token)} but covered in port data=${covered.has(code)} — ` +
          `these must match. Update the coverage wording (and the sibling onboarding/landing/legal copy).`,
      );
    }
  });
}
